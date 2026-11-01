#!/usr/bin/env node
// Command line. Every command analyzes the folder into a plan (or reads a saved one with --plan) and renders,
// checks or executes that plan; nothing re-analyzes on its own.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { analyze } from './core/analyze.js';
import { checkPlan, type Plan } from './core/schema.js';
import { renderGuide } from './render/guide.js';
import { renderExplain } from './render/explain.js';
import { renderSetupMd } from './render/setupmd.js';
import { diffPlans } from './render/diff.js';
import { defaultShell, type ShellKind } from './render/shell.js';
import { TOOL_NAME, PLAN_FILE } from './brand.js';
import { TOOL_VERSION } from './version.js';
import { runDoctor, renderDoctor } from './doctor/doctor.js';
import { runSetupCli, runStartCli } from './runner/cli.js';
import { supportCatalog } from './core/support.js';
import { renderSupport } from './render/support.js';

export const EXIT = { ok: 0, error: 1, doctorGaps: 3, stepFailed: 4, declined: 5, planChanged: 6 } as const;

const HELP = `${TOOL_NAME} ${TOOL_VERSION}: from a fresh clone to a running app. Offline; analysis never runs project code.

Usage
  ${TOOL_NAME} [path]                     the setup guide (same as \`guide\`)
  ${TOOL_NAME} guide [path]               projects, requirements, conflicts, ordered steps, run commands
  ${TOOL_NAME} plan [path] [-o file]      the plan as JSON (stdout, or a file)
  ${TOOL_NAME} explain [path] [id]        why each step / requirement exists, with the files that say so
  ${TOOL_NAME} doctor [path]              check this machine against the plan (fixed, read-only commands)
  ${TOOL_NAME} setup [path]               run the steps, asking before each one
  ${TOOL_NAME} start [path] [target...]   start the dev targets (services, backends, frontends) with readiness checks
  ${TOOL_NAME} setup-md [path] [--write]  SETUP.md to stdout, or written into the project with --write
  ${TOOL_NAME} diff <old-plan.json> [path]   what changed in the setup since a saved plan
  ${TOOL_NAME} support                    languages, frameworks, services and files it can read

Options
  --plan <file>         use a saved plan instead of analyzing
  --shell <posix|powershell>   commands for this shell (default: ${defaultShell()})
  --json                machine-readable output (guide, doctor, support)
  -v, --verbose         show evidence references
  --no-color
  setup:  --dry-run  --yes  --approve <digest>  --allow-outside  --include-optional  --only <ids>  --from <id>  --resume
  start:  --timeout <s>  --until-ready (stop everything once all targets are ready; exit 0 if they were)
  -h, --help  --version

Exit codes: 0 ok · 1 error · 3 doctor found missing requirements · 4 a step failed · 5 declined or stopped · 6 the plan changed since it was approved`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY: boolean;
}

function loadPlanFile(file: string): Plan {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const problem = checkPlan(raw, TOOL_NAME);
  if (problem) throw new Error(problem.message);
  return raw as Plan;
}

export async function main(argv: string[], io: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), isTTY: Boolean(process.stdout.isTTY) }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        plan: { type: 'string' }, shell: { type: 'string' }, json: { type: 'boolean' }, verbose: { type: 'boolean', short: 'v' },
        'no-color': { type: 'boolean' }, out: { type: 'string', short: 'o' }, write: { type: 'boolean' },
        'dry-run': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, approve: { type: 'string' }, 'allow-outside': { type: 'boolean' },
        'include-optional': { type: 'boolean' }, only: { type: 'string' }, from: { type: 'string' }, resume: { type: 'boolean' },
        timeout: { type: 'string' }, 'no-services': { type: 'boolean' }, 'until-ready': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}\n`);
    return EXIT.error;
  }
  const { values: o, positionals } = parsed;
  if (o.help) {
    io.out(HELP + '\n');
    return EXIT.ok;
  }
  if (o.version) {
    io.out(TOOL_VERSION + '\n');
    return EXIT.ok;
  }
  const commands = ['guide', 'plan', 'explain', 'doctor', 'setup', 'start', 'setup-md', 'diff', 'support'];
  const cmd = commands.includes(positionals[0]) ? positionals.shift()! : 'guide';
  const color = io.isTTY && !o['no-color'] && !process.env.NO_COLOR;
  if (cmd === 'support') {
    // About the tool itself: no folder is analyzed.
    const cat = supportCatalog();
    io.out(o.json ? JSON.stringify(cat, null, 2) + '\n' : renderSupport(cat, { color }));
    return EXIT.ok;
  }
  const shell = (o.shell ?? defaultShell()) as ShellKind;
  if (shell !== 'posix' && shell !== 'powershell') {
    io.err(`--shell must be posix or powershell\n`);
    return EXIT.error;
  }
  try {
    let diffBase: Plan | null = null;
    if (cmd === 'diff') {
      const file = positionals.shift();
      if (!file) throw new Error(`diff needs a saved plan: ${TOOL_NAME} diff ${PLAN_FILE} [path]`);
      diffBase = loadPlanFile(file);
    }
    const target = positionals[0] ?? '.';
    if (!o.plan && !fs.existsSync(target)) throw new Error(`No such folder: ${target}`);
    const root = path.resolve(o.plan ? path.dirname(path.resolve(o.plan)) : target);
    const plan = o.plan ? loadPlanFile(o.plan) : analyze(target);
    switch (cmd) {
      case 'guide':
        io.out(o.json ? JSON.stringify(plan, null, 2) + '\n' : renderGuide(plan, { shell, color, verbose: o.verbose }));
        return EXIT.ok;
      case 'plan': {
        const json = JSON.stringify(plan, null, 2) + '\n';
        if (o.out) {
          fs.writeFileSync(o.out, json);
          io.err(`Wrote ${o.out} (${plan.steps.length} steps, digest ${plan.digest.slice(0, 19)}…)\n`);
        } else io.out(json);
        return EXIT.ok;
      }
      case 'explain':
        io.out(renderExplain(plan, { shell, color, filter: positionals[1] }));
        return EXIT.ok;
      case 'setup-md': {
        const md = renderSetupMd(plan);
        if (o.write) {
          const file = path.join(root, 'SETUP.md');
          if (fs.existsSync(file) && !/^# Setting up /.test(fs.readFileSync(file, 'utf8'))) throw new Error(`${file} exists and was not written by ${TOOL_NAME}; not overwriting it. Use: ${TOOL_NAME} setup-md > OTHER.md`);
          fs.writeFileSync(file, md);
          io.err(`Wrote ${file}\n`);
        } else io.out(md);
        return EXIT.ok;
      }
      case 'diff': {
        const d = diffPlans(diffBase!, plan);
        io.out(d.lines.join('\n') + '\n');
        return EXIT.ok;
      }
      case 'doctor': {
        const report = await runDoctor(plan, { root });
        io.out(o.json ? JSON.stringify(report, null, 2) + '\n' : renderDoctor(report, plan, { color, shell }));
        return report.summary.missingRequired > 0 ? EXIT.doctorGaps : EXIT.ok;
      }
      case 'setup':
        return await runSetupCli(plan, root, o, io, { color, shell });
      case 'start':
        return await runStartCli(plan, root, positionals.slice(1), o, io, { color, shell });
    }
    return EXIT.error;
  } catch (e) {
    io.err(`${TOOL_NAME}: ${(e as Error).message}\n`);
    return EXIT.error;
  }
}

const isMain = Boolean(process.argv[1]) && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
