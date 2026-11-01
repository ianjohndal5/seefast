// The overview's Quick start: README-style commands derived from the plan. It may shorten the setup, but it must
// never hide a required step or offer a block to paste whole when that block would skip something.
import { describe, expect, it } from 'vitest';
import { quickStart, type QuickStart } from '../src/render/quickstart.js';
import type { Plan } from '../src/core/schema.js';
import { analyzeFixture, fixtureNames } from './helpers.js';

const kinds = (q: QuickStart) => q.lines.map((l) => l.kind);
const texts = (q: QuickStart) => q.lines.flatMap((l) => ('text' in l ? [l.text] : []));

describe('quick start', () => {
  it('is the whole setup, ready to paste, for a simple project', () => {
    const q = quickStart(analyzeFixture('readme-npm-pnpm-lock'), { shell: 'posix' });
    expect(texts(q)).toEqual(['pnpm install --frozen-lockfile --config.strict-dep-builds=false', 'pnpm run dev']);
    expect(q.lines.at(-1)).toMatchObject({ kind: 'start', port: 5173 });
    expect(q.skipped).toBe(0);
    expect(q.text).toBe('pnpm install --frozen-lockfile --config.strict-dep-builds=false\npnpm run dev');
  });

  it('starts with cd into the folder, home as ~ and quoted when needed', () => {
    const plan = analyzeFixture('readme-npm-pnpm-lock');
    expect(quickStart(plan, { shell: 'posix', root: '/home/u/my app', home: '/home/u' }).lines[0]).toEqual({ kind: 'cd', text: "cd ~/'my app'" });
    expect(quickStart(plan, { shell: 'posix', root: '/srv/app', home: '/home/u' }).lines[0]).toEqual({ kind: 'cd', text: 'cd /srv/app' });
    expect(quickStart(plan, { shell: 'powershell', root: 'C:\\Users\\u\\my app', home: 'C:\\Users\\u' }).lines[0]).toEqual({ kind: 'cd', text: "cd 'C:\\Users\\u\\my app'" });
  });

  it('counts every required step it leaves out, before the start commands', () => {
    const plan = analyzeFixture('laravel-next-monorepo');
    const q = quickStart(plan, { shell: 'posix', root: '/p' });
    expect(texts(q)).toEqual(['cd /p/api', 'composer install', 'npm ci', 'cd ../web', 'pnpm install --frozen-lockfile', 'cd ../api', 'composer run dev', 'cd /p/web', 'pnpm run dev']);
    expect(kinds(q)).toEqual(['cd', 'step', 'step', 'cd', 'step', 'more-steps', 'cd', 'start', 'terminal', 'cd', 'start']);
    const gap = q.lines.find((l) => l.kind === 'more-steps');
    expect(gap).toEqual({ kind: 'more-steps', count: 6, what: ['env files', 'config', 'services', 'database', 'build'] });
    // Pasting it whole would skip steps and block on the first server: no "Copy all".
    expect(q.text).toBeNull();
  });

  it('never drops a required step and only offers the whole block when it is complete, for every fixture', () => {
    for (const name of fixtureNames()) {
      const plan = analyzeFixture(name);
      const q = quickStart(plan, { shell: 'posix' });
      const shown = q.lines.filter((l) => l.kind === 'step').length;
      expect(shown + q.skipped, name).toBe(plan.steps.filter((s) => !s.optional).length);
      const starts = q.lines.filter((l) => l.kind === 'start').length;
      if (q.text !== null) expect(q.skipped === 0 && starts <= 1, name).toBe(true);
      expect(q.noStart, name).toBe(starts === 0);
    }
  });

  it('shows a second start command only when it belongs with the first', () => {
    const plan = analyzeFixture('laravel-next-monorepo');
    // Without "web needs api" the two are unrelated: one is shown, the other counted.
    const unrelated: Plan = { ...plan, run: plan.run.map((t) => ({ ...t, needs: t.needs.filter((n) => !n.startsWith('api.')) })) };
    const q = quickStart(unrelated, { shell: 'posix' });
    expect(q.lines.filter((l) => l.kind === 'start').map((l) => (l.kind === 'start' ? l.id : ''))).toEqual(['api.composer-dev']);
    expect(q.moreTargets).toBe(1);
  });

  it('says so when there is no start command', () => {
    const q = quickStart(analyzeFixture('no-manifest'), { shell: 'posix' });
    expect(q).toMatchObject({ lines: [], noStart: true, skipped: 0 });
  });
});
