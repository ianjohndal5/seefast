// The "Quick start" block: the few commands that take a fresh clone to a running app, README style
// (`cd`, install, start), derived from the plan. It keeps the plan's honesty: every required step it leaves out is
// counted in a "more steps first" line, and it only offers to copy the block as a whole when nothing was left out
// and one terminal is enough.
import path from 'node:path';
import type { Confidence, Plan, RunTarget, Step } from '../core/schema.js';
import { selectTargets } from '../runner/start.js';
import { quotePosix, quotePowerShell, renderAction, toWindowsPath, type ShellKind } from './shell.js';

export type QuickStartLine =
  /** Change directory: absolute for the first one in a terminal (when the folder is known), relative after that. */
  | { kind: 'cd'; text: string }
  /** An install (or prepare) step. */
  | { kind: 'step'; text: string; id: string; title: string; confidence: Confidence }
  /** A start command; `port` is where it serves, when known. */
  | { kind: 'start'; text: string; id: string; title: string; confidence: Confidence; port: number | null; portConfidence: Confidence | null }
  /** Required steps left out of the block, which must run before the start commands. */
  | { kind: 'more-steps'; count: number; what: string[] }
  /** The next start command needs its own terminal (the previous one keeps running). */
  | { kind: 'terminal'; n: number };

export interface QuickStart {
  lines: QuickStartLine[];
  /** Required steps not in the block (counted in the `more-steps` line). */
  skipped: number;
  /** Start targets not in the block (the block shows at most two). */
  moreTargets: number;
  /** No start command was found for this project. */
  noStart: boolean;
  /** The block as text, to paste as a whole; null when steps were left out or it needs more than one terminal. */
  text: string | null;
}

export interface QuickStartOptions {
  shell: ShellKind;
  /** The analyzed folder; the block then starts with `cd` into it. */
  root?: string;
  /** The home directory, written as `~` in POSIX shells. */
  home?: string;
}

const MAX_SETUP = 3;
const MAX_START = 2;

export function quickStart(plan: Plan, opts: QuickStartOptions): QuickStart {
  const { shell } = opts;
  const required = plan.steps.filter((s) => !s.optional);
  const targets = selectTargets(plan);
  // The first dev target, and a second one only when it belongs with it: same project (a server plus its asset
  // watcher) or one needs the other (a frontend and its API). Unrelated ones in big monorepos are counted, not shown.
  const starts: RunTarget[] = [];
  for (const t of targets) {
    if (t.kind !== 'dev' || t.action.type === 'manual' || starts.length >= MAX_START) continue;
    if (!starts.length || starts.some((c) => c.project === t.project || c.needs.includes(t.id) || t.needs.includes(c.id))) starts.push(t);
  }

  // Installs for the projects that start, plus the root project (workspace installs live there), in plan order.
  // Installs and repo preparation come first in every project's setup, so showing them before the rest keeps the order.
  const rootProject = plan.projects.find((p) => p.root === '.')?.id;
  const wanted = new Set([...starts.map((t) => t.project), ...(rootProject ? [rootProject] : [])]);
  const isSetup = (s: Step) => (s.phase === 'prepare' || s.phase === 'install') && s.action.type === 'exec' && (!starts.length || wanted.has(s.project));
  const shown = required.filter(isSetup).slice(0, MAX_SETUP);
  const skipped = required.filter((s) => !shown.includes(s));

  const lines: QuickStartLine[] = [];
  let cur: string | null = null; // the current folder, relative to the root; null: not in the project yet
  const goTo = (cwd: string) => {
    if (cur === cwd) return;
    if (cur === null && opts.root) lines.push({ kind: 'cd', text: `cd ${absolute(opts.root, cwd, shell, opts.home)}` });
    else {
      const rel = path.posix.relative(cur ?? '.', cwd);
      if (rel) lines.push({ kind: 'cd', text: `cd ${(shell === 'powershell' ? quotePowerShell : quotePosix)(shell === 'powershell' ? toWindowsPath(rel) : rel)}` });
    }
    cur = cwd;
  };

  for (const s of shown) {
    goTo(s.cwd);
    lines.push({ kind: 'step', text: renderAction(s.action, shell), id: s.id, title: s.title, confidence: s.confidence });
  }
  if (skipped.length) lines.push({ kind: 'more-steps', count: skipped.length, what: summarize(skipped) });
  starts.forEach((t, i) => {
    if (i > 0) {
      lines.push({ kind: 'terminal', n: i + 1 });
      cur = null;
    }
    goTo(t.cwd);
    const port = t.ports[0] ?? null;
    lines.push({ kind: 'start', text: renderAction(t.action, shell), id: t.id, title: t.title, confidence: t.confidence, port: port?.port ?? null, portConfidence: port?.confidence ?? null });
  });

  const whole = !skipped.length && starts.length <= 1;
  return {
    lines,
    skipped: skipped.length,
    moreTargets: targets.length - starts.length,
    noStart: !starts.length,
    text: whole ? lines.flatMap((l) => ('text' in l ? [l.text] : [])).join('\n') : null,
  };
}

/** What the left-out steps are, in a few words and in plan order ("env files, database, build"). */
function summarize(steps: Step[]): string[] {
  const envFiles = steps.filter((s) => s.action.type === 'copy' || s.action.type === 'env-names').length;
  const words = steps.map((s) =>
    s.action.type === 'copy' || s.action.type === 'env-names'
      ? envFiles > 1 ? 'env files' : 'env file'
      : { prepare: 'repo setup', install: 'more installs', configure: 'config', services: 'services', generate: 'code generation', database: 'database', build: 'build' }[s.phase]);
  return [...new Set(words)];
}

/** The folder as an absolute path for `cd`, with the home directory as `~` in POSIX shells. */
function absolute(root: string, cwd: string, shell: ShellKind, home?: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root);
  if (shell === 'powershell') return quotePowerShell(windows ? path.win32.join(root, toWindowsPath(cwd)) : path.posix.join(root, cwd));
  const full = windows ? path.win32.join(root, cwd).replace(/\\/g, '/') : path.posix.join(root, cwd);
  if (home && !windows && (full === home || full.startsWith(home.replace(/\/$/, '') + '/'))) {
    const rest = full.slice(home.replace(/\/$/, '').length + 1);
    return rest ? `~/${quotePosix(rest)}` : '~';
  }
  return quotePosix(full);
}
