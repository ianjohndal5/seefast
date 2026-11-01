// Traps found by end-to-end runs on real repositories (docs/VALIDATION.md), as small generated projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analyze.js';
import { matchServer } from '../src/core/kb.js';

let dir: string;
function project(files: Record<string, unknown>): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-rw-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
const argvOf = (plan: ReturnType<typeof analyze>, id: string) => {
  const a = plan.steps.find((s) => s.id === id)?.action;
  return a?.type === 'exec' ? a.argv.join(' ') : undefined;
};

describe('lockfiles', () => {
  it('a composer.lock that does not satisfy composer.json → composer update, with a warning (linkstack)', () => {
    const plan = analyze(project({
      'composer.json': { require: { php: '>=8.0', 'symfony/yaml': '^6.0', 'nunomaduro/collision': '^6.1' } },
      'composer.lock': { packages: [{ name: 'symfony/yaml', version: 'v7.4.1' }], 'packages-dev': [{ name: 'nunomaduro/collision', version: 'v6.4.0' }] },
    }));
    expect(argvOf(plan, 'root.composer-install')).toBe('composer update');
    expect(plan.conflicts.find((c) => c.rule === 'a stale lockfile cannot be installed exactly')?.message).toMatch(/nunomaduro\/collision, symfony\/yaml/);
  });
  it('a package-lock.json missing a dependency → npm install', () => {
    const plan = analyze(project({
      'package.json': { name: 'x', dependencies: { express: '^4', pg: '^8' } },
      'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: { express: '^4' } } } },
    }));
    expect(argvOf(plan, 'root.install')).toBe('npm install');
  });
  it('pnpm lockfile format 6.0 without a pin → pnpm 8 through npx for every pnpm command (taxonomy)', () => {
    const plan = analyze(project({
      'package.json': { name: 'x', scripts: { dev: 'next dev', build: 'next build' }, dependencies: { next: '13.4.0', '@prisma/client': '5' }, devDependencies: { prisma: '5' } },
      'pnpm-lock.yaml': "lockfileVersion: '6.0'\n",
      'prisma/schema.prisma': 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n',
    }));
    expect(argvOf(plan, 'root.install')).toBe('npx --yes pnpm@8 install --frozen-lockfile');
    expect(argvOf(plan, 'root.prisma-generate')).toBe('npx --yes pnpm@8 exec prisma generate');
    expect(plan.run.find((r) => r.id === 'root.dev')?.action).toEqual({ type: 'exec', argv: ['npx', '--yes', 'pnpm@8', 'run', 'dev'] });
    expect(plan.requirements.find((r) => r.id === 'package-manager:pnpm')?.rangeText).toBe('8.x');
  });
  it('pnpm without build approvals skips unapproved build scripts instead of stopping (commerce)', () => {
    const plan = analyze(project({ 'package.json': { name: 'x', dependencies: { next: '15' } }, 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" }));
    expect(argvOf(plan, 'root.install')).toBe('pnpm install --frozen-lockfile --config.strict-dep-builds=false');
    const approved = analyze(project({ 'package.json': { name: 'x', pnpm: { onlyBuiltDependencies: ['esbuild'] } }, 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" }));
    expect(argvOf(approved, 'root.install')).toBe('pnpm install --frozen-lockfile');
  });
});

describe('env files and start commands', () => {
  it('a README that creates .env.local cannot win when Prisma only reads .env (taxonomy)', () => {
    const plan = analyze(project({
      'package.json': { name: 'x', dependencies: { next: '14', '@prisma/client': '5' }, devDependencies: { prisma: '5' } },
      'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: { next: '14', '@prisma/client': '5' }, devDependencies: { prisma: '5' } } } },
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      '.env.example': 'DATABASE_URL=\n',
      'README.md': '## Getting started\n\n```sh\ncp .env.example .env.local\n```\n',
    }));
    expect(plan.steps.find((s) => s.id === 'root.env')?.action).toEqual({ type: 'copy', from: '.env.example', to: '.env' });
    expect(plan.conflicts.filter((c) => c.subject === 'envTarget@root').map((c) => c.message)).toEqual(['README.md creates .env.local, but Prisma only reads .env; using .env, which every tool here reads.']);
  });
  it('the docs\' production start command never becomes the dev target (next-auth-example)', () => {
    const plan = analyze(project({
      'package.json': { name: 'x', scripts: { dev: 'next', build: 'next build', start: 'next start' }, dependencies: { next: '15' } },
      'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: { next: '15' } } } },
      'README.md': '## Run\n\n```sh\nnpm run build\nnpm run start\n```\n',
    }));
    expect(plan.run.filter((r) => r.primary && r.kind === 'dev').map((r) => r.id)).toEqual(['root.dev']);
    expect(matchServer(['next'])).toMatchObject({ kind: 'dev', port: 3000 });
  });
  it('an artisan command from a package that is not installed stays optional (laravel skeleton)', () => {
    const plan = analyze(project({
      'composer.json': { require: { 'laravel/framework': '^12.0' } }, artisan: '<?php',
      'README.md': '## Agentic Development\n\n```bash\nphp artisan boost:install\n```\n\n## Installation\n\n```bash\nphp artisan app:init\n```\n',
      'app/Console/Commands/Init.php': "<?php\nclass Init { protected $signature = 'app:init'; }\n",
    }));
    expect(plan.steps.find((s) => s.id === 'root.docs-boost-install')).toMatchObject({ optional: true });
    expect(plan.steps.find((s) => s.id === 'root.docs-app-init')).toMatchObject({ optional: false, confidence: 'low' });
  });
});

describe('ports', () => {
  const next = (name: string) => ({ name, scripts: { dev: 'next dev' }, dependencies: { next: '15.1.0', react: '19.0.0' } });
  it('three projects on one port are one warning naming all three, not one per pair (HomesPH)', () => {
    const plan = analyze(project({ 'alpha/package.json': next('alpha'), 'beta/package.json': next('beta'), 'gamma/package.json': next('gamma') }));
    const clashes = plan.conflicts.filter((c) => c.subject === 'port:3000');
    expect(clashes).toHaveLength(1);
    expect(clashes[0].message).toMatch(/^alpha, beta and gamma all start on port 3000; only the first one started gets it/);
    expect(clashes[0].alternatives.map((a) => a.value)).toEqual(['alpha', 'beta', 'gamma']);
  });
  it('two projects on one port keep the two-project wording', () => {
    const plan = analyze(project({ 'alpha/package.json': next('alpha'), 'beta/package.json': next('beta') }));
    expect(plan.conflicts.filter((c) => c.subject === 'port:3000').map((c) => c.message)).toEqual([
      'alpha and beta both start on port 3000; the second one will fail or pick another port. Start one at a time, or change one port.',
    ]);
  });
});
