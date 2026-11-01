// Starting the plan's commands: argv only, no shell. Windows .cmd/.bat shims go through cmd.exe with strict
// argument checks, because Node refuses to spawn them directly (CVE-2024-27980) and cmd.exe has its own parsing.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Action } from '../core/schema.js';
import { which, type ProbeHost } from '../doctor/probes.js';

/** Programs that elevate privileges. The plan never contains them; the runner refuses them anyway. */
const ELEVATORS = new Set(['sudo', 'doas', 'su', 'runas', 'pkexec', 'gsudo', 'sudo.exe', 'runas.exe', 'gsudo.exe']);

export class RefusedError extends Error {}

export interface Resolved {
  file: string;
  args: string[];
  /** For logs and the UI: what is being run. */
  display: string;
  windowsVerbatimArguments?: boolean;
}

export function argvForPlatform(action: Extract<Action, { type: 'exec' }>, platform: NodeJS.Platform): string[] {
  return platform === 'win32' && action.windowsArgv ? action.windowsArgv : action.argv;
}

/** Characters cmd.exe interprets even inside quotes, or that would end the quoted argument. */
const CMD_UNSAFE = /["%!^&|<>\r\n]/;

/** Resolve argv[0] (PATH, PATHEXT, or a path relative to cwd) and wrap .cmd/.bat for cmd.exe. */
export function resolveCommand(argv: string[], cwd: string, root: string, host: Pick<ProbeHost, 'platform' | 'env' | 'isFile'>): Resolved {
  if (!argv.length) throw new RefusedError('empty command');
  const base = path.basename(argv[0]).toLowerCase();
  if (ELEVATORS.has(base)) throw new RefusedError(`refusing to run ${argv[0]}: this tool never elevates privileges`);
  let file: string | null;
  if (/[\\/]/.test(argv[0])) {
    file = path.resolve(cwd, argv[0]);
    if (!file.startsWith(root + path.sep) && file !== root) throw new RefusedError(`refusing to run ${argv[0]}: it is outside the project folder`);
    if (host.platform === 'win32' && !host.isFile(file)) {
      for (const ext of ['.exe', '.cmd', '.bat']) if (host.isFile(file + ext)) file += ext;
    }
    if (!host.isFile(file)) file = null;
  } else {
    file = which(argv[0], host as ProbeHost);
  }
  if (!file) throw new RefusedError(`${argv[0]} was not found${/[\\/]/.test(argv[0]) ? '' : ' on PATH'}. Run the doctor for install advice.`);
  const args = argv.slice(1);
  const display = argv.join(' ');
  if (host.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const bad = args.find((a) => CMD_UNSAFE.test(a));
    if (bad) throw new RefusedError(`refusing to pass ${JSON.stringify(bad)} through cmd.exe (it would be reinterpreted); run this step by hand`);
    const quoted = [file, ...args].map((a) => (/[\s()]/.test(a) || a === '' ? `"${a}"` : a));
    return { file: host.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${quoted.join(' ')}"`], display, windowsVerbatimArguments: true };
  }
  return { file, args, display };
}

export interface Spawned {
  child: ChildProcess;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
}

export type SpawnFn = (r: Resolved, opts: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }) => Spawned;

export const realSpawn: SpawnFn = (r, opts) => {
  const child = spawn(r.file, r.args, {
    cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
    windowsVerbatimArguments: r.windowsVerbatimArguments, detached: opts.detached && process.platform !== 'win32',
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, done };
};

/** Stop a process and its children: the process group on POSIX, taskkill /T on Windows. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Environment for steps: the user's, plus no interactive Corepack prompt (it would hang with no stdin). */
export function stepEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
}

export function insideRoot(root: string, p: string): boolean {
  const r = path.resolve(p);
  return r === root || r.startsWith(root + path.sep);
}

export function fileExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
