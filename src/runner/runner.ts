// Automated setup: execute the plan's steps with consent. Shows every command before it runs, asks per step (or
// takes an approval of the whole reviewed plan), supports a dry run, stops at the first failure, never elevates,
// asks separately before anything that changes the machine outside the project, and can resume.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Plan, Step } from '../core/schema.js';
import { canonicalJson } from '../core/plan.js';
import { STATE_DIR } from '../brand.js';
import { renderAction, type ShellKind } from '../render/shell.js';
import { realHost, type ProbeHost } from '../doctor/probes.js';
import { argvForPlatform, fileExists, insideRoot, realSpawn, RefusedError, resolveCommand, stepEnv, killTree, type SpawnFn } from './exec.js';

export type Decision = 'yes' | 'skip' | 'all' | 'quit';

export interface ConsentRequest {
  step: Step;
  command: string;
  /** Why this one needs a separate answer even after "approve all". */
  reason?: 'outside-project' | 'optional' | 'manual';
}

export type StepStatus = 'done' | 'failed' | 'skipped' | 'declined' | 'already-done' | 'dry-run' | 'refused';

export type RunnerEvent =
  | { type: 'warning'; message: string }
  | { type: 'step-start'; step: Step; command: string; index: number; total: number }
  | { type: 'output'; step: Step; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'step-end'; step: Step; status: StepStatus; code?: number | null; ms: number; message?: string; log?: string }
  | { type: 'manual'; step: Step; text: string }
  | { type: 'done'; status: RunStatus; failed?: string };

export type RunStatus = 'success' | 'failed' | 'declined' | 'stopped' | 'dry-run';

export interface RunnerOptions {
  root: string;
  dryRun?: boolean;
  /** Approve every step that does not need a separate answer (--yes, or --approve with the matching digest). */
  approveAll?: boolean;
  allowOutside?: boolean;
  includeOptional?: boolean;
  only?: string[];
  from?: string;
  resume?: boolean;
  /** Asked for every step not covered by approveAll. Absent: non-interactive, unapproved steps are not run. */
  consent?: (req: ConsentRequest) => Promise<Decision>;
  onEvent?: (e: RunnerEvent) => void;
  signal?: AbortSignal;
  shell?: ShellKind;
  host?: Pick<ProbeHost, 'platform' | 'env' | 'isFile'>;
  spawn?: SpawnFn;
  /** Per-step timeout in seconds (default 1800). */
  timeoutSec?: number;
}

export interface RunResult {
  status: RunStatus;
  steps: { id: string; status: StepStatus; code?: number | null; ms: number; message?: string; log?: string }[];
  failed?: string;
}

interface State {
  planDigest: string;
  steps: Record<string, { status: StepStatus; hash: string; at: string; log?: string }>;
}

export function stepHash(s: Step): string {
  return createHash('sha256').update(canonicalJson({ cwd: s.cwd, action: s.action })).digest('hex').slice(0, 16);
}

function statePaths(root: string) {
  const dir = path.join(root, STATE_DIR);
  return { dir, state: path.join(dir, 'state.json'), logs: path.join(dir, 'logs') };
}

export function readState(root: string): State | null {
  try {
    return JSON.parse(fs.readFileSync(statePaths(root).state, 'utf8')) as State;
  } catch {
    return null;
  }
}

function writeState(root: string, state: State): void {
  const p = statePaths(root);
  fs.mkdirSync(p.logs, { recursive: true });
  // Keep the runner's own files out of `git status`.
  const gi = path.join(p.dir, '.gitignore');
  if (!fileExists(gi)) fs.writeFileSync(gi, '*\n');
  fs.writeFileSync(p.state, JSON.stringify(state, null, 2) + '\n');
}

/** The steps a run would consider, in plan order, after --only / --from / optional filtering. */
export function selectSteps(plan: Plan, opts: Pick<RunnerOptions, 'only' | 'from' | 'includeOptional'>): Step[] {
  let steps = plan.steps;
  if (opts.only?.length) {
    const unknown = opts.only.filter((id) => !steps.some((s) => s.id === id));
    if (unknown.length) throw new Error(`No such step: ${unknown.join(', ')}. Steps: ${steps.map((s) => s.id).join(', ')}`);
    steps = steps.filter((s) => opts.only!.includes(s.id));
  }
  if (opts.from) {
    const i = steps.findIndex((s) => s.id === opts.from);
    if (i < 0) throw new Error(`No such step: ${opts.from}`);
    steps = steps.slice(i);
  }
  return steps;
}

export async function runSetup(plan: Plan, opts: RunnerOptions): Promise<RunResult> {
  const root = path.resolve(opts.root);
  const host = opts.host ?? realHost;
  const spawnFn = opts.spawn ?? realSpawn;
  const emit = opts.onEvent ?? (() => {});
  const shell = opts.shell ?? (host.platform === 'win32' ? 'powershell' : 'posix');
  const steps = selectSteps(plan, opts);
  const results: RunResult['steps'] = [];
  const prev = opts.resume ? readState(root) : null;
  const state: State = { planDigest: plan.digest, steps: { ...(prev?.steps ?? {}) } };
  if (opts.resume && prev && prev.planDigest !== plan.digest) {
    emit({ type: 'warning', message: 'The plan changed since the last run; only steps whose command and folder are unchanged count as already done.' });
  }
  let approveAll = Boolean(opts.approveAll);
  let warnedThirdParty = false;
  const finish = (status: RunStatus, failed?: string): RunResult => {
    emit({ type: 'done', status, failed });
    return { status, steps: results, failed };
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (opts.signal?.aborted) return finish('stopped');
    const command = renderAction(step.action, shell);
    const record = (status: StepStatus, extra: Partial<RunResult['steps'][number]> = {}) => {
      const r = { id: step.id, status, ms: 0, ...extra };
      results.push(r);
      emit({ type: 'step-end', step, status, code: r.code, ms: r.ms, message: r.message, log: r.log });
      if (!opts.dryRun && status !== 'dry-run') {
        state.steps[step.id] = { status, hash: stepHash(step), at: new Date().toISOString(), log: r.log };
        writeState(root, state);
      }
    };
    const done = prev?.steps[step.id];
    if (opts.resume && done?.status === 'done' && done.hash === stepHash(step)) {
      record('already-done', { message: 'completed in an earlier run' });
      continue;
    }
    // Safety checks before asking anyone.
    const cwd = path.resolve(root, ...step.cwd.split('/'));
    if (!insideRoot(root, cwd)) {
      record('refused', { message: `working directory ${step.cwd} is outside the project` });
      return finish('failed', step.id);
    }
    if (step.thirdPartyCode && step.action.type === 'exec' && !warnedThirdParty) {
      warnedThirdParty = true;
      emit({ type: 'warning', message: 'Installing dependencies runs code from their authors (install scripts, Composer scripts) and the project\'s own scripts, with your user\'s permissions. Only continue for projects you trust.' });
    }
    // Consent.
    let reason: ConsentRequest['reason'];
    if (step.outsideProject && !opts.allowOutside) reason = 'outside-project';
    else if (step.optional && !opts.includeOptional) reason = 'optional';
    else if (step.action.type === 'manual') reason = 'manual';
    const covered = approveAll && !reason;
    if (opts.dryRun) {
      emit({ type: 'step-start', step, command, index: i, total: steps.length });
      if (step.optional && !opts.includeOptional) record('skipped', { message: 'optional; use --include-optional' });
      else if (step.outsideProject && !opts.allowOutside) record('dry-run', { message: 'changes things outside the project: needs --allow-outside or a separate yes' });
      else record('dry-run');
      continue;
    }
    if (!covered) {
      if (!opts.consent) {
        const message =
          reason === 'outside-project' ? 'changes things outside the project; not approved (use --allow-outside)'
            : reason === 'optional' ? 'optional; not included (use --include-optional)'
              : reason === 'manual' ? 'needs you to do something by hand'
                : 'not approved';
        if (reason === 'manual' && step.action.type === 'manual') emit({ type: 'manual', step, text: step.action.text });
        record(reason ? 'skipped' : 'declined', { message });
        if (!reason) return finish('declined', step.id);
        continue;
      }
      const d = await opts.consent({ step, command, reason });
      if (d === 'quit') {
        record('declined', { message: 'stopped by you' });
        return finish('declined', step.id);
      }
      if (d === 'skip') {
        record('skipped', { message: 'skipped by you' });
        continue;
      }
      if (d === 'all' && !reason) approveAll = true;
    }
    // Execute.
    emit({ type: 'step-start', step, command, index: i, total: steps.length });
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    try {
      if (step.action.type === 'manual') {
        emit({ type: 'manual', step, text: step.action.text });
        record('done', { ms: ms(), message: 'confirmed' });
        continue;
      }
      if (step.action.type === 'copy') {
        const from = path.resolve(cwd, step.action.from);
        const to = path.resolve(cwd, step.action.to);
        if (!insideRoot(root, from) || !insideRoot(root, to)) throw new RefusedError('copy outside the project');
        if (fileExists(to)) record('done', { ms: ms(), message: `${step.action.to} already exists; left unchanged` });
        else {
          fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
          record('done', { ms: ms(), message: `created ${step.action.to}` });
        }
        continue;
      }
      if (step.action.type === 'touch') {
        const p = path.resolve(cwd, step.action.path);
        if (!insideRoot(root, p)) throw new RefusedError('file outside the project');
        if (fileExists(p)) record('done', { ms: ms(), message: `${step.action.path} already exists` });
        else {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, '', { flag: 'wx' });
          record('done', { ms: ms(), message: `created ${step.action.path}` });
        }
        continue;
      }
      const resolved = resolveCommand(argvForPlatform(step.action, host.platform), cwd, root, host);
      const logs = statePaths(root).logs;
      fs.mkdirSync(logs, { recursive: true });
      writeState(root, state);
      const logFile = path.join(logs, `${String(i + 1).padStart(2, '0')}-${step.id.replace(/[^\w.-]/g, '_')}.log`);
      const log = fs.openSync(logFile, 'w');
      fs.writeSync(log, `$ ${resolved.display}\n# in ${cwd}\n\n`);
      const sp = spawnFn(resolved, { cwd, env: stepEnv(host.env), detached: true });
      const onData = (stream: 'stdout' | 'stderr') => (b: Buffer) => {
        const chunk = b.toString();
        fs.writeSync(log, chunk);
        emit({ type: 'output', step, stream, chunk });
      };
      sp.child.stdout?.on('data', onData('stdout'));
      sp.child.stderr?.on('data', onData('stderr'));
      const timeout = setTimeout(() => killTree(sp.child), (opts.timeoutSec ?? 1800) * 1000);
      const onAbort = () => killTree(sp.child);
      opts.signal?.addEventListener('abort', onAbort);
      const r = await sp.done;
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
      fs.writeSync(log, `\n# exit ${r.code ?? r.signal ?? r.error?.message}\n`);
      fs.closeSync(log);
      const rel = path.relative(root, logFile).split(path.sep).join('/');
      if (opts.signal?.aborted) {
        record('failed', { ms: ms(), code: r.code, message: 'stopped', log: rel });
        return finish('stopped', step.id);
      }
      if (r.code !== 0) {
        record('failed', { ms: ms(), code: r.code, message: r.error ? r.error.message : `exited with ${r.code ?? r.signal}`, log: rel });
        return finish('failed', step.id);
      }
      record('done', { ms: ms(), code: 0, log: rel });
    } catch (e) {
      record(e instanceof RefusedError ? 'refused' : 'failed', { ms: ms(), message: (e as Error).message });
      return finish('failed', step.id);
    }
  }
  return finish(opts.dryRun ? 'dry-run' : 'success');
}
