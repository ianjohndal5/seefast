// start: run the plan's run targets together, in dependency order (services → backends → frontends), each one
// waiting for what it needs to be ready. Readiness levels: listening (TCP connect to the port), responding (any
// HTTP response), stays-up (no port known: still alive after N seconds), exited (a target that is meant to end).
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import type { Plan, RunTarget } from '../core/schema.js';
import { realHost, type ProbeHost } from '../doctor/probes.js';
import { argvForPlatform, insideRoot, killTree, RefusedError, realSpawn, resolveCommand, stepEnv, type SpawnFn, type Spawned } from './exec.js';
import { diagnose, exitText, outputLines, OUTPUT_KEPT, type Diagnosis } from './diagnose.js';

export type Readiness = 'responding' | 'listening' | 'stays-up' | 'exited-ok' | 'failed' | 'timeout' | 'not-started';

export type StartEvent =
  | { type: 'start'; target: RunTarget; command: string }
  | { type: 'output'; target: RunTarget; stream: 'stdout' | 'stderr'; chunk: string }
  /** `diagnosis` when it failed or timed out: why, in words, and the last lines it printed. */
  | { type: 'ready'; target: RunTarget; level: Readiness; ms: number; detail: string; diagnosis?: Diagnosis }
  | { type: 'exit'; target: RunTarget; code: number | null }
  | { type: 'service'; id: string; reachable: boolean; port?: number }
  | { type: 'warning'; message: string };

export interface StartOptions {
  root: string;
  /** Target ids or names; default: every primary dev and worker target. */
  targets?: string[];
  /** Readiness timeout per target in seconds (default: the plan's). */
  timeoutSec?: number;
  onEvent?: (e: StartEvent) => void;
  signal?: AbortSignal;
  host?: Pick<ProbeHost, 'platform' | 'env' | 'isFile'>;
  spawn?: SpawnFn;
  /** Stop everything once all targets are ready (validation harness). */
  stopWhenReady?: boolean;
}

export interface StartResult {
  targets: { id: string; level: Readiness; ms: number; detail: string; diagnosis?: Diagnosis }[];
  ok: boolean;
}

export function selectTargets(plan: Plan, wanted?: string[]): RunTarget[] {
  let chosen: RunTarget[];
  if (wanted?.length) {
    chosen = wanted.map((w) => {
      const t = plan.run.find((r) => r.id === w) ?? plan.run.find((r) => r.name === w && r.primary) ?? plan.run.find((r) => r.name === w);
      if (!t) throw new Error(`No run target "${w}". Targets: ${plan.run.map((r) => r.id).join(', ')}`);
      return t;
    });
  } else chosen = plan.run.filter((r) => r.primary && (r.kind === 'dev' || r.kind === 'worker'));
  // Add what they need, transitively.
  const all = new Map(chosen.map((t) => [t.id, t]));
  const queue = [...chosen];
  while (queue.length) {
    const t = queue.shift()!;
    for (const n of t.needs) {
      const dep = plan.run.find((r) => r.id === n);
      if (dep && !all.has(dep.id)) {
        all.set(dep.id, dep);
        queue.push(dep);
      }
    }
  }
  // Order: dependencies first, then plan order.
  const out: RunTarget[] = [];
  const visit = (t: RunTarget, seen: Set<string>) => {
    if (out.includes(t) || seen.has(t.id)) return;
    seen.add(t.id);
    for (const n of t.needs) {
      const d = all.get(n);
      if (d) visit(d, seen);
    }
    out.push(t);
  };
  for (const t of plan.run.filter((r) => all.has(r.id))) visit(t, new Set());
  return out;
}

export function tcpReachable(port: number, timeoutMs = 1000): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  return tryHost('127.0.0.1').then((ok) => ok || tryHost('::1'));
}

export function httpResponds(port: number, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.once('error', () => resolve(null));
  });
}

/** The address a dev server says it serves ("Now listening on: http://localhost:5242", "Local: http://localhost:5173/"). */
export function announcedUrl(output: string): string | undefined {
  const lines = outputLines(output);
  for (const l of lines) {
    const m = /(?:listening on|Local|running (?:on|at)|server at|started server on|available (?:on|at))[:\s]+\[?(https?:\/\/[^\s,'"\]]+)/i.exec(l);
    if (m) return m[1].replace(/\/$/, '');
  }
  return undefined;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      r();
    });
  });

/** The promise's value, or null once `ms` pass or the signal aborts; no timer is left running either way. */
function until<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | null> {
  return new Promise((resolve) => {
    const done = (v: T | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => done(null);
    const timer = setTimeout(onAbort, ms);
    signal?.addEventListener('abort', onAbort);
    void p.then(done);
  });
}

export async function startTargets(plan: Plan, opts: StartOptions): Promise<StartResult> {
  const root = path.resolve(opts.root);
  const host = opts.host ?? realHost;
  const spawnFn = opts.spawn ?? realSpawn;
  const emit = opts.onEvent ?? (() => {});
  const targets = selectTargets(plan, opts.targets);
  type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
  const running: { t: RunTarget; sp: Spawned; exited: Exit | null }[] = [];
  const results: StartResult['targets'] = [];
  const stopAll = () => {
    for (const r of [...running].reverse()) killTree(r.sp.child);
  };
  opts.signal?.addEventListener('abort', stopAll);

  // Services are not started here (that is a setup step); check they are reachable.
  for (const sid of [...new Set(targets.flatMap((t) => t.needs.filter((n) => n.startsWith('service:'))))]) {
    const s = plan.services.find((x) => x.id === sid);
    const port = s?.ports[0];
    const ok = port ? await tcpReachable(port) : false;
    emit({ type: 'service', id: sid, reachable: ok, port });
    if (!ok) emit({ type: 'warning', message: `${sid.slice(8)} is not reachable on port ${port ?? '?'}; targets that need it may fail. Run its setup step first.` });
  }

  try {
    for (const t of targets) {
      if (opts.signal?.aborted) break;
      if (t.action.type !== 'exec') continue;
      const cwd = path.resolve(root, ...t.cwd.split('/'));
      if (!insideRoot(root, cwd)) throw new Error(`${t.id}: working directory outside the project`);
      let resolved;
      try {
        resolved = resolveCommand(argvForPlatform(t.action, host.platform), cwd, root, host);
      } catch (e) {
        // A missing program is this target failing to start, with the reason, not the whole run erroring out.
        if (!(e instanceof RefusedError)) throw e;
        const diagnosis: Diagnosis = { reason: e.message, advice: [], output: [] };
        results.push({ id: t.id, level: 'failed', ms: 0, detail: 'not started', diagnosis });
        emit({ type: 'ready', target: t, level: 'failed', ms: 0, detail: 'not started', diagnosis });
        break;
      }
      emit({ type: 'start', target: t, command: resolved.display });
      const sp = spawnFn(resolved, { cwd, env: stepEnv(host.env), detached: true });
      const entry = { t, sp, exited: null as Exit | null };
      running.push(entry);
      // The last part of what it printed, to say why when it fails.
      let printed = '';
      const onData = (stream: 'stdout' | 'stderr') => (b: Buffer) => {
        const chunk = b.toString();
        printed = (printed + chunk).slice(-OUTPUT_KEPT);
        emit({ type: 'output', target: t, stream, chunk });
      };
      sp.child.stdout?.on('data', onData('stdout'));
      sp.child.stderr?.on('data', onData('stderr'));
      void sp.done.then((r) => {
        entry.exited = r;
        emit({ type: 'exit', target: t, code: r.code });
      });
      const t0 = performance.now();
      const ms = () => Math.round(performance.now() - t0);
      const exitOf = (x: Exit) => exitText(x.code, x.signal, host.platform, x.error);
      const rd = t.readiness;
      let level: Readiness = 'timeout';
      let detail = '';
      if (rd.type === 'port') {
        const deadline = Date.now() + (opts.timeoutSec ?? rd.timeoutSec) * 1000;
        while (Date.now() < deadline && !opts.signal?.aborted) {
          if (entry.exited) {
            level = 'failed';
            detail = `${exitOf(entry.exited)} before listening on ${rd.port}`;
            break;
          }
          if (await tcpReachable(rd.port, 500)) {
            const status = await httpResponds(rd.port);
            level = status !== null ? 'responding' : 'listening';
            detail = status !== null ? `HTTP ${status} on http://localhost:${rd.port}/` : `accepting connections on port ${rd.port}`;
            break;
          }
          await sleep(500, opts.signal);
        }
        if (level === 'timeout') detail = `nothing listened on port ${rd.port} within ${opts.timeoutSec ?? rd.timeoutSec} s`;
      } else if (rd.type === 'stays-up') {
        // An exit ends the wait: a target that fails at once is reported at once.
        await until(sp.done, rd.seconds * 1000, opts.signal);
        level = entry.exited ? 'failed' : 'stays-up';
        const url = announcedUrl(printed);
        detail = entry.exited ? `${exitOf(entry.exited)} within ${rd.seconds} s` : url ? `running at ${url}` : `still running after ${rd.seconds} s (no port to check)`;
      } else {
        const r = await until(sp.done, (opts.timeoutSec ?? rd.timeoutSec) * 1000, opts.signal);
        level = r === null ? 'timeout' : r.code === 0 ? 'exited-ok' : 'failed';
        detail = r === null ? 'did not finish in time' : exitOf(r);
      }
      let diagnosis: Diagnosis | undefined;
      if (level === 'failed' && entry.exited) diagnosis = diagnose({ ...entry.exited, output: printed, platform: host.platform });
      else if (level === 'timeout' && !opts.signal?.aborted) {
        // Still running, but not where it was expected: often it picked or was configured for another port.
        const url = announcedUrl(printed);
        const elsewhere = url && rd.type === 'port' && !new RegExp(`:${rd.port}(?:/|$)`).test(url);
        diagnosis = { reason: elsewhere ? `It is running, but at ${url} instead of port ${rd.port}.` : undefined, advice: [], output: outputLines(printed).slice(-15) };
      }
      results.push({ id: t.id, level, ms: ms(), detail, ...(diagnosis ? { diagnosis } : {}) });
      emit({ type: 'ready', target: t, level, ms: ms(), detail, ...(diagnosis ? { diagnosis } : {}) });
      if (level === 'failed' || level === 'timeout') break;
    }
    const ok = results.length === targets.filter((t) => t.action.type === 'exec').length && results.every((r) => ['responding', 'listening', 'stays-up', 'exited-ok'].includes(r.level));
    if (opts.stopWhenReady || !ok) stopAll();
    else {
      // Keep running until interrupted.
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) return resolve();
        opts.signal?.addEventListener('abort', () => resolve());
        void Promise.all(running.map((r) => r.sp.done)).then(() => resolve());
      });
      stopAll();
    }
    for (const t of targets) if (!results.some((r) => r.id === t.id)) results.push({ id: t.id, level: 'not-started', ms: 0, detail: '' });
    return { targets: results, ok };
  } catch (e) {
    stopAll();
    throw e;
  } finally {
    opts.signal?.removeEventListener('abort', stopAll);
  }
}
