// End-to-end runs in a clean container (validation/e2e/Dockerfile): for each repo, a fresh copy is set up
//   plan:   `seefast setup --yes` then `seefast start --yes --until-ready`
//   readme: the README's literal setup commands (from the ground truth), then its dev command, with the same
//           readiness check (the port answers, or the process stays up for 30 s when no port is known)
// No database servers run in the container; repos that need one are not in the e2e set (see VALIDATION.md).
// Usage: node validation/e2e/run.mjs [--mode=plan|readme|both] id...
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const workRoot = path.join(here, '..', 'work', 'e2e');
fs.mkdirSync(workRoot, { recursive: true });
const args = process.argv.slice(2);
const mode = (args.find((a) => a.startsWith('--mode=')) ?? '--mode=both').slice(7);
const ids = args.filter((a) => !a.startsWith('--'));
const IMAGE = 'seefast-e2e:1';

function sh(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (out += b));
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function freshCopy(id, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-${id}-${label}-`));
  await sh('cp', ['-a', path.join(here, '..', 'repos', id) + '/.', dir]);
  return dir;
}

function readmeScript(gt) {
  const port = gt.dev?.[0]?.port;
  const devCmd = gt.dev?.[0]?.command;
  const lines = ['set -u', 'unset CI'];
  const isServer = (c) => /\b(dev|serve|start|up|watch|runserver|run)\b/.test(c) && !/\b(install|build|migrate|seed|key:generate|generate)\b/.test(c);
  let started = false;
  for (const c of gt.readmeCommands ?? []) {
    if (/^git clone|^cd \S*$|<[^>]+>|^(brew|apt|sudo|winget|scoop|nvm|open|start |code )/.test(c.trim()) && !/^cd (api|web|apps|packages|examples|src|backend|frontend)\b/.test(c.trim())) continue;
    if (isServer(c)) {
      lines.push(`( ${c} ) > /tmp/dev.log 2>&1 &`);
      started = true;
      break;
    }
    lines.push(`echo "+ ${c.replace(/"/g, '\\"')}"`, `${c} || { echo "README step failed: ${c.replace(/"/g, '\\"')}"; exit 10; }`);
  }
  if (!started && devCmd) lines.push(`( ${devCmd} ) > /tmp/dev.log 2>&1 &`);
  if (!started && !devCmd) lines.push('echo "README gives no start command"; exit 11');
  lines.push('DEV=$!');
  if (port) {
    lines.push(`for i in $(seq 1 240); do if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then echo "READY listening ${port}"; kill $DEV 2>/dev/null; exit 0; fi; if ! kill -0 $DEV 2>/dev/null; then echo "dev command exited"; tail -30 /tmp/dev.log; exit 12; fi; sleep 1; done; echo "TIMEOUT"; tail -30 /tmp/dev.log; exit 13`);
  } else {
    lines.push('sleep 30; if kill -0 $DEV 2>/dev/null; then echo "READY stays-up"; kill $DEV; exit 0; else echo "dev command exited"; tail -30 /tmp/dev.log; exit 12; fi');
  }
  return lines.join('\n');
}

async function runOne(id, which) {
  const dir = await freshCopy(id, which);
  const t0 = Date.now();
  let script;
  if (which === 'plan') {
    script = [
      'set -u',
      'node /tool/dist/cli.js setup /work --yes --shell posix --no-color; S=$?',
      'echo "SETUP_EXIT=$S"',
      'if [ $S -ne 0 ]; then exit 20; fi',
      'node /tool/dist/cli.js start /work --yes --until-ready --timeout 240 --no-color; R=$?',
      'echo "START_EXIT=$R"',
      'exit $R',
    ].join('\n');
  } else {
    const gt = JSON.parse(fs.readFileSync(path.join(here, '..', 'ground-truth', `${id}.json`), 'utf8'));
    script = readmeScript(gt);
  }
  const r = await sh('docker', ['run', '--rm', '-v', `${repoRoot}:/tool:ro`, '-v', `${dir}:/work`, '-w', '/work', IMAGE, 'bash', '-c', script], { timeout: 45 * 60 * 1000 });
  const ms = Date.now() - t0;
  const log = path.join(workRoot, `${id}-${which}.log`);
  fs.writeFileSync(log, r.out);
  await sh('docker', ['run', '--rm', '-v', `${dir}:/work`, IMAGE, 'bash', '-c', 'chmod -R u+rwX /work 2>/dev/null; true']);
  fs.rmSync(dir, { recursive: true, force: true });
  const ready = /READY|✓ .*: (responding|listening|stays-up)/.test(r.out) && r.code === 0;
  const failedStep = /Stopped: step (\S+) failed/.exec(r.out)?.[1] ?? /README step failed: (.*)/.exec(r.out)?.[1];
  const level = /: (responding|listening|stays-up) \(/.exec(r.out)?.[1] ?? (/READY (listening|stays-up)/.exec(r.out)?.[1]);
  return { id, which, exit: r.code, ready, level: level ?? null, failedStep: failedStep ?? null, minutes: Math.round(ms / 600) / 100, log: path.relative(repoRoot, log) };
}

const results = [];
for (const id of ids) {
  const modes = mode === 'both' ? ['plan', 'readme'] : [mode];
  for (const m of modes) {
    const r = await runOne(id, m);
    results.push(r);
    console.log(JSON.stringify(r));
  }
}
const file = path.join(workRoot, 'results.jsonl');
fs.appendFileSync(file, results.map((r) => JSON.stringify({ ...r, at: new Date().toISOString() })).join('\n') + '\n');
