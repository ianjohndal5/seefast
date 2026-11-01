// Terminal front end for automated setup and start: shows the whole plan first, asks per step, streams output.
import readline from 'node:readline';
import type { Plan } from '../core/schema.js';
import { renderAction, type ShellKind } from '../render/shell.js';
import { colors } from '../render/text.js';
import { runSetup, selectSteps, type ConsentRequest, type Decision } from './runner.js';
import { startTargets, selectTargets } from './start.js';
import { TOOL_NAME } from '../brand.js';

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY: boolean;
}

type Flags = Record<string, string | boolean | undefined>;

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, (a) => resolve(a.trim().toLowerCase())));
  } finally {
    rl.close();
  }
}

export async function runSetupCli(plan: Plan, root: string, o: Flags, io: Io, ui: { color: boolean; shell: ShellKind }): Promise<number> {
  const c = colors(ui.color);
  if (o.approve && o.approve !== plan.digest) {
    io.err(c.red(`The plan changed since it was approved.\n  approved: ${o.approve}\n  current:  ${plan.digest}\nReview it again (${TOOL_NAME} guide) and approve the new digest.\n`));
    return 6;
  }
  const interactive = io.isTTY && Boolean(process.stdin.isTTY) && !o.yes && !o.approve;
  const approveAll = Boolean(o.yes || o.approve);
  if (!interactive && !approveAll && !o['dry-run']) {
    io.err(`${TOOL_NAME} setup needs consent. Run it in a terminal to approve each step, or pass --yes (approve the plan shown) or --approve ${plan.digest}.\nSee every command first with: ${TOOL_NAME} setup --dry-run\n`);
    return 5;
  }
  const only = typeof o.only === 'string' ? o.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const steps = selectSteps(plan, { only, from: o.from as string | undefined });
  io.out(c.bold(`${o['dry-run'] ? 'Dry run: nothing will be executed.' : 'Automated setup'} · ${plan.meta.rootName} · plan ${plan.digest.slice(0, 19)}…\n`));
  io.out(c.dim('Every command, in order (network = downloads; outside = changes things outside the project):\n'));
  steps.forEach((s, i) => {
    const flags = [s.network ? 'network' : '', s.outsideProject ? 'outside' : '', s.optional ? 'optional' : '', s.action.type === 'manual' ? 'by hand' : ''].filter(Boolean).join(', ');
    io.out(`  ${String(i + 1).padStart(2)}. ${c.dim(s.cwd === '.' ? '' : s.cwd + '/ ')}${c.cyan(renderAction(s.action, ui.shell))}${flags ? c.dim(`  [${flags}]`) : ''}\n`);
  });
  io.out('\n');
  const consent = interactive
    ? async (req: ConsentRequest): Promise<Decision> => {
        const why = req.reason === 'outside-project' ? c.yellow(' (changes things outside the project)') : req.reason === 'optional' ? c.dim(' (optional)') : '';
        if (req.reason === 'manual' && req.step.action.type === 'manual') {
          io.out(`${c.yellow('→')} ${req.step.action.text}\n`);
          const a = await ask('  Done? [y]es, [s]kip, [q]uit: ');
          return a.startsWith('q') ? 'quit' : a.startsWith('s') || a.startsWith('n') ? 'skip' : 'yes';
        }
        const a = await ask(`${c.bold(req.step.title)}${why}\n  ${c.cyan(req.command)}  ${c.dim(req.step.cwd === '.' ? '' : `in ${req.step.cwd}`)}\n  Run it? [y]es, [s]kip, [a]ll remaining, [q]uit: `);
        if (a.startsWith('a')) return 'all';
        if (a.startsWith('y')) return 'yes';
        if (a.startsWith('s') || a.startsWith('n')) return 'skip';
        return 'quit';
      }
    : undefined;
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once('SIGINT', onSig);
  try {
    const res = await runSetup(plan, {
      root, dryRun: Boolean(o['dry-run']), approveAll, allowOutside: Boolean(o['allow-outside']), includeOptional: Boolean(o['include-optional']),
      only, from: o.from as string | undefined, resume: Boolean(o.resume), consent, signal: ac.signal, shell: ui.shell,
      onEvent: (e) => {
        if (e.type === 'warning') io.out(c.yellow(`! ${e.message}\n`));
        else if (e.type === 'step-start' && !o['dry-run']) io.out(`\n${c.bold(`[${e.index + 1}/${e.total}] ${e.step.title}`)}\n${c.dim('$')} ${c.cyan(e.command)}\n`);
        else if (e.type === 'output') io.out(e.chunk);
        else if (e.type === 'manual' && !interactive) io.out(`${c.yellow('→ by hand:')} ${e.text}\n`);
        else if (e.type === 'step-end') {
          const tag = e.status === 'done' || e.status === 'already-done' ? c.green('✓') : e.status === 'dry-run' ? c.dim('·') : e.status === 'skipped' ? c.yellow('–') : c.red('✗');
          io.out(`${tag} ${e.step.id}${e.message ? c.dim(` (${e.message})`) : ''}${e.ms > 1000 ? c.dim(` ${(e.ms / 1000).toFixed(1)} s`) : ''}${e.log ? c.dim(` · log: ${e.log}`) : ''}\n`);
        }
      },
    });
    io.out('\n');
    if (res.status === 'success') io.out(c.green(`Setup finished.`) + ` Next: ${TOOL_NAME} start\n`);
    else if (res.status === 'dry-run') io.out(c.dim(`Nothing was executed. Run it: ${TOOL_NAME} setup${o['include-optional'] ? ' --include-optional' : ''}\n`));
    else if (res.status === 'failed') io.out(c.red(`Stopped: step ${res.failed} failed.`) + ` Fix it, then continue with: ${TOOL_NAME} setup --resume\n`);
    else io.out(c.yellow(`Stopped before ${res.failed ?? 'the end'}.`) + ` Continue later with: ${TOOL_NAME} setup --resume\n`);
    return res.status === 'success' || res.status === 'dry-run' ? 0 : res.status === 'failed' ? 4 : 5;
  } finally {
    process.off('SIGINT', onSig);
  }
}

export async function runStartCli(plan: Plan, root: string, names: string[], o: Flags, io: Io, ui: { color: boolean; shell: ShellKind }): Promise<number> {
  const c = colors(ui.color);
  const targets = selectTargets(plan, names);
  if (!targets.length) {
    io.err('No run targets in the plan.\n');
    return 1;
  }
  io.out(c.bold('Starting (this runs the project\'s own code):\n'));
  for (const t of targets) io.out(`  ${t.id.padEnd(24)} ${c.dim(t.cwd === '.' ? '' : t.cwd + '/ ')}${c.cyan(renderAction(t.action, ui.shell))}${t.ports.length ? c.dim(` → :${t.ports[0].port}`) : ''}\n`);
  if (!o.yes) {
    if (!(io.isTTY && process.stdin.isTTY)) {
      io.err('start runs the project; pass --yes to confirm when not in a terminal.\n');
      return 5;
    }
    const a = await ask('Start them? [y/N] ');
    if (!a.startsWith('y')) return 5;
  }
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once('SIGINT', onSig);
  const width = Math.max(...targets.map((t) => t.id.length));
  const palette = [c.cyan, c.blue, c.green, c.yellow];
  try {
    const res = await startTargets(plan, {
      root, targets: names.length ? names : undefined, signal: ac.signal, stopWhenReady: Boolean(o['until-ready']),
      timeoutSec: typeof o.timeout === 'string' ? Number(o.timeout) : undefined,
      onEvent: (e) => {
        if (e.type === 'output') {
          const i = targets.findIndex((t) => t.id === e.target.id);
          for (const line of e.chunk.split(/\r?\n/)) if (line.trim()) io.out(`${palette[i % palette.length](e.target.id.padEnd(width))} │ ${line}\n`);
        } else if (e.type === 'ready') io.out(`${e.level === 'failed' || e.level === 'timeout' ? c.red('✗') : c.green('✓')} ${e.target.id}: ${e.level} (${e.detail}, ${(e.ms / 1000).toFixed(1)} s)\n`);
        else if (e.type === 'warning') io.out(c.yellow(`! ${e.message}\n`));
        else if (e.type === 'exit') io.out(c.dim(`${e.target.id} exited (${e.code})\n`));
      },
    });
    return res.ok ? 0 : 4;
  } finally {
    process.off('SIGINT', onSig);
  }
}
