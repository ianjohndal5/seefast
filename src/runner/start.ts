// start: run the plan's run targets together, in dependency order (services → backends → frontends), each one
// waiting for what it needs to be ready. Readiness levels: listening (TCP connect to the port), responding (any
// HTTP response), stays-up (no port known: still alive after N seconds), exited (a target that is meant to end).
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import type { Plan, RunTarget } from '../core/schema.js';
import { realHost, type ProbeHost } from '../doctor/probes.js';
import { argvForPlatform, insideRoot, killTree, realSpawn, resolveCommand, stepEnv, type SpawnFn, type Spawned } from './exec.js';

export type Readiness = 'responding' | 'listening' | 'stays-up' | 'exited-ok' | 'failed' | 'timeout' | 'not-started';

export type StartEvent =
  | { type: 'start'; target: RunTarget; command: string }
  | { type: 'output'; target: RunTarget; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'ready'; target: RunTarget; level: Readiness; ms: number; detail: string }
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
  targets: { id: string; level: Readiness; ms: number; detail: string }[];
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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      r();
    });
  });

export async function startTargets(plan: Plan, opts: StartOptions): Promise<StartResult> {
  const root = path.resolve(opts.root);
  const host = opts.host ?? realHost;
  const spawnFn = opts.spawn ?? realSpawn;
  const emit = opts.onEvent ?? (() => {});
  const targets = selectTargets(plan, opts.targets);
  const running: { t: RunTarget; sp: Spawned; exited: { code: number | null } | null }[] = [];
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
      const resolved = resolveCommand(argvForPlatform(t.action, host.platform), cwd, root, host);
      emit({ type: 'start', target: t, command: resolved.display });
      const sp = spawnFn(resolved, { cwd, env: stepEnv(host.env), detached: true });
      const entry = { t, sp, exited: null as { code: number | null } | null };
      running.push(entry);
      sp.child.stdout?.on('data', (b: Buffer) => emit({ type: 'output', target: t, stream: 'stdout', chunk: b.toString() }));
      sp.child.stderr?.on('data', (b: Buffer) => emit({ type: 'output', target: t, stream: 'stderr', chunk: b.toString() }));
      void sp.done.then((r) => {
        entry.exited = { code: r.code };
        emit({ type: 'exit', target: t, code: r.code });
      });
      const t0 = performance.now();
      const ms = () => Math.round(performance.now() - t0);
      const rd = t.readiness;
      let level: Readiness = 'timeout';
      let detail = '';
      if (rd.type === 'port') {
        const deadline = Date.now() + (opts.timeoutSec ?? rd.timeoutSec) * 1000;
        while (Date.now() < deadline && !opts.signal?.aborted) {
          if (entry.exited) {
            level = 'failed';
            detail = `exited with ${entry.exited.code} before listening on ${rd.port}`;
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
        await sleep(rd.seconds * 1000, opts.signal);
        level = entry.exited ? 'failed' : 'stays-up';
        detail = entry.exited ? `exited with ${entry.exited.code} within ${rd.seconds} s` : `still running after ${rd.seconds} s (no port to check)`;
      } else {
        const r = await Promise.race([sp.done, sleep((opts.timeoutSec ?? rd.timeoutSec) * 1000, opts.signal).then(() => null)]);
        level = r === null ? 'timeout' : r.code === 0 ? 'exited-ok' : 'failed';
        detail = r === null ? 'did not finish in time' : `exited with ${r.code}`;
      }
      results.push({ id: t.id, level, ms: ms(), detail });
      emit({ type: 'ready', target: t, level, ms: ms(), detail });
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
