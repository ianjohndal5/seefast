// Score each plan against its independently written ground truth (validation/ground-truth/<id>.json), and score
// the README alone the same way (its literal setup commands, as recorded by the ground-truth author).
// Output: validation/results.json and a Markdown summary on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { classifyLine } from '../dist/core/commands.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SET = (process.argv.find((a) => a.startsWith('--set=')) ?? '--set=dev').slice(6); // dev | heldout | all
const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? `results-${SET}.json`;
const corpus = JSON.parse(fs.readFileSync(path.join(here, 'corpus.json'), 'utf8')).repos.filter((r) => SET === 'all' || (SET === 'heldout' ? r.heldOut : !r.heldOut));

/** Plan step → ground-truth step kind. */
function planKind(step, plan) {
  const a = step.action;
  const local = step.id.slice(step.project.length + 1);
  if (a.type === 'copy') return 'env-copy';
  if (a.type === 'touch') return 'other:sqlite-file';
  if (a.type === 'env-names') return 'env-manual';
  if (a.type === 'manual') return local === 'env' ? 'env-manual' : `manual:${local.replace(/^service-/, '')}`;
  if (local === 'services' || /^services-\d+$/.test(local)) return 'compose-up';
  if (local === 'submodules') return 'submodules';
  if (local === 'lfs') return 'other:lfs';
  if (local === 'prisma-generate') return 'prisma:generate';
  if (local === 'prisma-migrate' || local === 'prisma-push') return 'prisma:migrate';
  if (local === 'migrate' && a.argv[0] !== 'php') return 'db:migrate';
  if (local === 'build') {
    const proj = plan.projects.find((p) => p.id === step.project);
    if (proj?.frameworks.some((f) => f.id === 'laravel')) return 'build-assets';
    return 'workspace-build';
  }
  return argvKind(a.argv);
}

/** A command line → ground-truth step kind (shared by plan steps and README commands). */
function argvKind(argv) {
  // Installs through a pinned package manager or a lock refresh are still installs.
  if (argv[0] === 'npx' && /^pnpm@/.test(argv.find((a) => /^pnpm@/.test(a)) ?? '') && argv.includes('install')) return 'install:pnpm';
  if (argv[0] === 'composer' && argv[1] === 'update') return 'install:composer';
  const sig = classifyLine(argv.map((x) => (/\s/.test(x) ? `'${x}'` : x)).join(' '))[0];
  if (!sig) return null;
  if (sig.kind === 'install') return `install:${sig.tool === 'bundler' ? 'bundler' : sig.tool}`;
  if (sig.kind === 'artisan') return sig.key;
  if (sig.kind === 'copy') return /\.env/.test(sig.key) ? 'env-copy' : 'other:copy';
  if (sig.kind === 'compose-up') return 'compose-up';
  if (sig.kind === 'submodule') return 'submodules';
  if (sig.kind === 'exec') {
    if (/^exec:prisma generate/.test(sig.key)) return 'prisma:generate';
    if (/^exec:prisma (migrate|db push)/.test(sig.key)) return 'prisma:migrate';
    if (/^exec:(drizzle-kit|knex|sequelize)/.test(sig.key)) return 'db:migrate';
  }
  if (sig.kind === 'script') {
    if (/^script:(build|production|prod)$/.test(sig.key)) return 'build-assets';
    if (/^script:(dev|start|serve|watch)$/.test(sig.key)) return null; // running, not setup
    if (/^script:(db:migrate|migrate|db:push)/.test(sig.key)) return 'db:migrate';
    return sig.key.replace(/^composer-script:/, 'script:');
  }
  if (sig.kind === 'task') return `script:${sig.key.split(':').slice(1).join(':')}`;
  if (argv[0] === 'go' && argv[1] === 'build') return 'install:go';
  if (argv[0] === 'cargo' && (argv[1] === 'build' || argv[1] === 'install')) return 'install:cargo';
  if (/^python[0-9.]*$/.test(argv[0]) && argv.includes('migrate')) return 'db:migrate';
  return null;
}

const category = (k) => (/^install:(npm|pnpm|yarn|bun)$/.test(k) ? 'install:node' : /^install:(pip|poetry|uv|pipenv)$/.test(k) ? 'install:python' : k === 'env-copy' || k === 'env-manual' ? 'env' : k);
/** Kinds that count as the same step: Laravel's build vs a generic workspace build, Django migrate vs db:migrate. */
// A plan's "start a MySQL/PostgreSQL server ... create the database it names" step covers manual:create-database.
const same = (a, b) => a === b || (category(a) === category(b) && category(a) === 'env') || (/^manual:(mysql|postgres|sqlserver)$/.test(a) && /^manual:create-database/.test(b)) || (/^manual:(mysql|postgres|sqlserver)$/.test(b) && /^manual:create-database/.test(a));

function scoreSteps(gtSteps, gtOptional, planKinds) {
  const G = [...new Set(gtSteps.map((s) => s.kind))];
  const opt = new Set(gtOptional.map((s) => s.kind));
  const P = [...new Set(planKinds.filter(Boolean))];
  const correct = G.filter((g) => P.some((p) => same(p, g)));
  const wrong = G.filter((g) => !correct.includes(g) && P.some((p) => category(p) === category(g) && category(g) !== g));
  const missing = G.filter((g) => !correct.includes(g) && !wrong.includes(g));
  const extra = P.filter((p) => !G.some((g) => same(p, g) || category(p) === category(g)));
  return { gt: G.length, plan: P.length, correct, wrong, missing, extraOptionalInGt: extra.filter((e) => opt.has(e)), extra: extra.filter((e) => !opt.has(e)) };
}

const nodePmOf = (plan, root = '.') => plan.projects.find((p) => p.root === root)?.packageManagers.find((m) => m.ecosystem === 'node')?.name ?? plan.projects.flatMap((p) => p.packageManagers).find((m) => m.ecosystem === 'node')?.name;

function versionAgrees(planReq, gtVersion) {
  if (!gtVersion) return 'not-stated';
  if (!planReq || (!planReq.range && !planReq.recommended)) return 'unknown';
  const gt = semver.coerce(gtVersion);
  const rec = planReq.recommended ? semver.coerce(planReq.recommended) : null;
  let min = null;
  try {
    min = planReq.range ? semver.minVersion(planReq.range) : null;
  } catch {
    min = null;
  }
  if (min && gt && min.major === gt.major && (gtVersion.split('.').length < 2 || min.minor === gt.minor)) return 'same';
  if (rec && gt && rec.major === gt.major) return 'same';
  if (min && gt && semver.satisfies(gt, planReq.range)) return 'compatible';
  return 'differs';
}

const normCmd = (c) => c.trim().replace(/\s+/g, ' ').replace(/^(pnpm|yarn|bun|composer) (?!run |install|add|exec|dlx|x |run-script )([\w:-]+)/, '$1 run $2').replace(/^composer run-script /, 'composer run ').replace(/^npm start$/, 'npm run start');

const rows = [];
for (const r of corpus) {
  const gtFile = path.join(here, 'ground-truth', `${r.id}.json`);
  const planFile = path.join(here, 'work', 'plans', `${r.id}.json`);
  if (!fs.existsSync(gtFile) || !fs.existsSync(planFile)) {
    rows.push({ id: r.id, group: r.group, missingGroundTruth: !fs.existsSync(gtFile) });
    continue;
  }
  const gt = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const required = plan.steps.filter((s) => !s.optional);
  const planKinds = required.map((s) => planKind(s, plan));
  const steps = scoreSteps(gt.steps ?? [], gt.optionalSteps ?? [], planKinds);
  const readmeKinds = (gt.readmeCommands ?? []).flatMap((c) => classifyLine(c).map((s) => argvKind(s.argv)));
  const readme = scoreSteps(gt.steps ?? [], gt.optionalSteps ?? [], readmeKinds);
  const gtPms = (gt.projects ?? []).flatMap((p) => p.packageManagers ?? []).filter((m) => /^(npm|pnpm|yarn|bun)$/.test(m));
  const planPm = nodePmOf(plan);
  const pm = gtPms.length ? (planPm && gtPms.includes(planPm) ? 'correct' : planPm ? 'wrong' : 'missing') : 'n/a';
  const readmePmCmds = readmeKinds.filter((k) => /^install:(npm|pnpm|yarn|bun)$/.test(k ?? '')).map((k) => k.split(':')[1]);
  const readmePm = gtPms.length ? (readmePmCmds.length ? (gtPms.includes(readmePmCmds[0]) ? 'correct' : 'wrong') : 'not-stated') : 'n/a';
  const runtimes = {};
  for (const [tool, v] of Object.entries(gt.runtimes ?? {})) {
    const req = plan.requirements.find((q) => q.kind === 'runtime' && q.name === tool) ?? plan.requirements.find((q) => q.name === tool);
    runtimes[tool] = versionAgrees(req, String(v));
  }
  const canon = (n) => (n === 'mariadb' ? 'mysql' : n === 'mailhog' ? 'mailpit' : n === 'valkey' ? 'redis' : n);
  const gtServices = new Set((gt.services ?? []).map(canon));
  const planServices = new Set(plan.services.filter((s) => !s.optional).map((s) => canon(s.name)));
  const services = {
    gt: [...gtServices], plan: [...planServices],
    found: [...gtServices].filter((s) => planServices.has(s)), missed: [...gtServices].filter((s) => !planServices.has(s)), extra: [...planServices].filter((s) => !gtServices.has(s)),
  };
  const devCmds = plan.run.filter((x) => x.primary && x.kind === 'dev').map((x) => normCmd([...x.action.argv].join(' ')));
  const gtDev = (gt.dev ?? [])[0];
  const dev = gtDev ? (devCmds.includes(normCmd(gtDev.command)) ? 'correct' : devCmds.length ? 'different' : 'missing') : 'n/a';
  const devPort = gtDev?.port ? (plan.run.some((x) => x.primary && x.ports.some((p) => p.port === gtDev.port)) ? 'correct' : 'different') : 'n/a';
  rows.push({ id: r.id, group: r.group, steps, readme, pm, readmePm, runtimes, services, dev, devPort, unknowns: plan.unknowns.length, conflicts: plan.conflicts.length, notes: gt.notes });
}

// ---- Aggregate ----
const scored = rows.filter((x) => x.steps);
const sum = (f) => scored.reduce((a, x) => a + f(x), 0);
const agg = (key) => ({
  gt: sum((x) => x[key].gt), correct: sum((x) => x[key].correct.length), wrong: sum((x) => x[key].wrong.length), missing: sum((x) => x[key].missing.length),
  extra: sum((x) => x[key].extra.length), extraOptionalInGt: sum((x) => x[key].extraOptionalInGt.length), planSteps: sum((x) => x[key].plan),
});
const count = (f, v) => scored.filter((x) => f(x) === v).length;
const runtimeCounts = {};
for (const x of scored) for (const v of Object.values(x.runtimes)) runtimeCounts[v] = (runtimeCounts[v] ?? 0) + 1;
const summary = {
  repos: corpus.length, scored: scored.length,
  steps: agg('steps'), readme: agg('readme'),
  packageManager: { correct: count((x) => x.pm, 'correct'), wrong: count((x) => x.pm, 'wrong'), missing: count((x) => x.pm, 'missing'), applicable: scored.filter((x) => x.pm !== 'n/a').length },
  readmePackageManager: { correct: count((x) => x.readmePm, 'correct'), wrong: count((x) => x.readmePm, 'wrong'), notStated: count((x) => x.readmePm, 'not-stated') },
  runtimes: runtimeCounts,
  services: { gt: sum((x) => x.services.gt.length), found: sum((x) => x.services.found.length), missed: sum((x) => x.services.missed.length), extra: sum((x) => x.services.extra.length) },
  dev: { correct: count((x) => x.dev, 'correct'), different: count((x) => x.dev, 'different'), missing: count((x) => x.dev, 'missing'), applicable: scored.filter((x) => x.dev !== 'n/a').length },
  devPort: { correct: count((x) => x.devPort, 'correct'), different: count((x) => x.devPort, 'different'), applicable: scored.filter((x) => x.devPort !== 'n/a').length },
};
fs.writeFileSync(path.join(here, OUT), JSON.stringify({ set: SET, summary, rows }, null, 2) + '\n');

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const o = [];
o.push(`| Repo | Group | GT steps | Correct | Wrong | Missing | Extra | README covers | PM | Runtimes | Services found/missed/extra | Dev cmd | Port |`);
o.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const x of rows) {
  if (!x.steps) {
    o.push(`| ${x.id} | ${x.group} | no ground truth | | | | | | | | | | |`);
    continue;
  }
  const s = x.steps;
  o.push(`| ${x.id} | ${x.group} | ${s.gt} | ${s.correct.length} | ${s.wrong.join(', ') || 0} | ${s.missing.join(', ') || 0} | ${s.extra.join(', ') || 0} | ${x.readme.correct.length}/${s.gt}${x.readme.wrong.length ? ` (wrong: ${x.readme.wrong.join(', ')})` : ''} | ${x.pm} | ${Object.entries(x.runtimes).map(([k, v]) => `${k}: ${v}`).join(', ') || '–'} | ${x.services.found.length}/${x.services.missed.length}/${x.services.extra.length} | ${x.dev} | ${x.devPort} |`);
}
o.push('');
const st = summary.steps;
const rd = summary.readme;
o.push(`**Steps (required, ${st.gt} in ground truth across ${summary.scored} repos):** plan correct ${st.correct} (${pct(st.correct, st.gt)}), wrong ${st.wrong}, missing ${st.missing}; ${st.extra} extra steps not in the ground truth (${st.extraOptionalInGt} more listed there as optional).`);
o.push(`**README alone:** covers ${rd.correct} (${pct(rd.correct, rd.gt)}), wrong ${rd.wrong}, missing ${rd.missing}.`);
o.push(`**Package manager:** ${summary.packageManager.correct}/${summary.packageManager.applicable} correct, ${summary.packageManager.wrong} wrong. README: ${summary.readmePackageManager.correct} correct, ${summary.readmePackageManager.wrong} wrong, ${summary.readmePackageManager.notStated} not stated.`);
o.push(`**Runtime versions:** ${JSON.stringify(summary.runtimes)}.`);
o.push(`**Services:** ${summary.services.found}/${summary.services.gt} found, ${summary.services.missed} missed, ${summary.services.extra} extra.`);
o.push(`**Dev command:** ${summary.dev.correct}/${summary.dev.applicable} identical, ${summary.dev.different} different, ${summary.dev.missing} missing. **Port:** ${summary.devPort.correct}/${summary.devPort.applicable}.`);
console.log(o.join('\n'));
