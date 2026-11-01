import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/core/analyze.js';
import type { Plan } from '../src/core/schema.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(REPO, 'fixtures');
export const EXPECTED = path.join(REPO, 'test', 'expected');

export function fixtureNames(): string[] {
  return fs.readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

const FIXED_NOW = () => new Date('2026-01-01T00:00:00.000Z');

export function analyzeFixture(name: string): Plan {
  return analyze(path.join(FIXTURES, name), { now: FIXED_NOW });
}

/** The plan without the fields that legitimately vary between runs (time and timings). */
export function stable(plan: Plan): Omit<Plan, 'meta'> & { meta: Omit<Plan['meta'], 'generatedAt' | 'durationMs' | 'timings'> } {
  const { generatedAt: _g, durationMs: _d, timings: _t, ...meta } = plan.meta;
  void _g;
  void _d;
  void _t;
  return { ...plan, meta };
}

export function step(plan: Plan, id: string) {
  const s = plan.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}; steps: ${plan.steps.map((x) => x.id).join(', ')}`);
  return s;
}

export function req(plan: Plan, id: string) {
  const r = plan.requirements.find((x) => x.id === id);
  if (!r) throw new Error(`no requirement ${id}; requirements: ${plan.requirements.map((x) => x.id).join(', ')}`);
  return r;
}

export function argv(plan: Plan, id: string): string {
  const a = step(plan, id).action;
  return a.type === 'exec' ? a.argv.join(' ') : JSON.stringify(a);
}
