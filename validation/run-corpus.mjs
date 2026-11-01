// Analyze every corpus repo: write plans to validation/work/plans and print timing and a one-line summary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(here, 'corpus.json'), 'utf8')).repos;
const out = path.join(here, 'work', 'plans');
fs.mkdirSync(out, { recursive: true });
const rows = [];
for (const r of corpus) {
  const dir = path.join(here, 'repos', r.id);
  const times = [];
  let plan;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    plan = analyze(dir);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  fs.writeFileSync(path.join(out, `${r.id}.json`), JSON.stringify(plan, null, 2));
  rows.push({
    id: r.id, group: r.group, ms: Math.round(times[2]), cold: Math.round(times[4]), entries: plan.meta.stats.entriesSeen, read: plan.meta.stats.filesRead,
    projects: plan.summary.projects, steps: plan.summary.steps, conflicts: plan.summary.conflicts, unknowns: plan.summary.unknowns, support: plan.summary.support,
    truncated: plan.meta.stats.truncated, parseErrors: plan.meta.stats.parseErrors.length,
  });
}
console.table(rows);
fs.writeFileSync(path.join(here, 'work', 'timings.json'), JSON.stringify(rows, null, 2));
