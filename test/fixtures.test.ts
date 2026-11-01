// Every fixture produces its expected plan (test/expected/<name>.json; regenerate with UPDATE_EXPECTED=1 after
// reviewing the diff), and the assertions below pin the answer to each trap independently of the golden files.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeFixture, argv, EXPECTED, fixtureNames, req, stable, step } from './helpers.js';
import { checkPlan } from '../src/core/schema.js';

describe('golden plans', () => {
  for (const name of fixtureNames()) {
    it(name, () => {
      const plan = stable(analyzeFixture(name));
      expect(checkPlan(plan)).toBeNull();
      const file = path.join(EXPECTED, `${name}.json`);
      const json = JSON.stringify(plan, null, 2) + '\n';
      if (process.env.UPDATE_EXPECTED || !fs.existsSync(file)) {
        fs.mkdirSync(EXPECTED, { recursive: true });
        fs.writeFileSync(file, json);
      }
      expect(json).toBe(fs.readFileSync(file, 'utf8'));
    });
  }
});

describe('trap: README says npm, the lockfile says pnpm', () => {
  const plan = analyzeFixture('readme-npm-pnpm-lock');
  it('uses pnpm with the lockfile respected', () => {
    expect(plan.projects[0].packageManagers[0]).toMatchObject({ name: 'pnpm', confidence: 'high' });
    expect(argv(plan, 'root.install')).toBe('pnpm install --frozen-lockfile --config.strict-dep-builds=false');
    expect(step(plan, 'root.install').notes.join(' ')).toMatch(/pnpm approve-builds/);
  });
  it('explains the stale README in plain language', () => {
    const c = plan.conflicts.find((x) => x.subject === 'pm:node@root');
    expect(c?.severity).toBe('info');
    expect(c?.message).toBe('README.md says "npm install", but pnpm-lock.yaml exists; using pnpm.');
    expect(c?.alternatives[1].evidence[0]).toMatchObject({ file: 'README.md', line: 6, role: 'contradicts' });
  });
});

describe('trap: Laravel backend + Next.js frontend monorepo', () => {
  const plan = analyzeFixture('laravel-next-monorepo');
  it('finds both projects and the frontend → backend dependency', () => {
    expect(plan.projects.map((p) => [p.id, p.frameworks.map((f) => f.id)])).toEqual([['api', ['laravel']], ['web', ['nextjs']]]);
    const web = plan.projects.find((p) => p.id === 'web')!;
    expect(web.dependsOn).toEqual([expect.objectContaining({ project: 'api', kind: 'runtime' })]);
    expect(plan.projects.find((p) => p.id === 'api')!.dependsOn).toEqual([]);
  });
  it('orders the backend first and puts Laravel steps in a working order', () => {
    const ids = plan.steps.filter((s) => !s.optional).map((s) => s.id);
    expect(ids.indexOf('api.composer-install')).toBeLessThan(ids.indexOf('api.key'));
    expect(ids.indexOf('api.env')).toBeLessThan(ids.indexOf('api.key'));
    expect(ids.indexOf('root.services') >= 0 || ids.indexOf('api.services') >= 0).toBe(true);
    const services = ids.find((i) => i.endsWith('.services'))!;
    expect(ids.indexOf(services)).toBeLessThan(ids.indexOf('api.migrate'));
    expect(ids.indexOf('api.migrate')).toBeLessThan(ids.indexOf('web.install'));
  });
  it('reads requirements from the lockfiles, version files and recipes', () => {
    expect(req(plan, 'runtime:php')).toMatchObject({ range: '>=8.2.0 <9.0.0-0', recommended: '8.3' });
    expect(req(plan, 'runtime:node')).toMatchObject({ rangeText: '>= 20', recommended: '20.18.0' });
    const exts = plan.requirements.filter((r) => r.kind === 'extension' && !r.optional).map((r) => r.name);
    expect(exts).toEqual(expect.arrayContaining(['pdo_mysql', 'mbstring', 'openssl', 'redis', 'fileinfo']));
    expect(exts).not.toContain('xdebug');
  });
  it('starts only the services the app uses, and flags DB_HOST=mysql', () => {
    expect(plan.services.filter((s) => !s.optional).map((s) => s.name)).toEqual(['mysql', 'redis']);
    expect(plan.services.find((s) => s.name === 'mailpit')?.optional).toBe(true);
    const up = plan.steps.find((s) => s.id.endsWith('.services'))!;
    expect(up.action).toEqual({ type: 'exec', argv: ['docker', 'compose', 'up', '-d', 'mysql', 'redis'] });
    expect(up.outsideProject).toBe(true);
    expect(plan.conflicts.some((c) => c.id === 'env-host:api:DB_HOST' && c.severity === 'warning')).toBe(true);
  });
  it('generates APP_KEY, asks for DB_PASSWORD, and keeps AWS keys optional', () => {
    const env = plan.env.find((e) => e.project === 'api')!;
    const fill = Object.fromEntries(env.vars.map((v) => [v.name, v.fill]));
    expect(fill).toMatchObject({ APP_KEY: 'generated', DB_PASSWORD: 'user', AWS_ACCESS_KEY_ID: 'optional', DB_CONNECTION: 'default', SENTRY_LARAVEL_DSN: 'unknown' });
    expect(env.vars.find((v) => v.name === 'APP_KEY')?.generatedBy).toBe('api.key');
  });
  it('uses the dev script and runs the frontend after the backend', () => {
    const dev = plan.run.filter((r) => r.primary && r.kind === 'dev').map((r) => r.id);
    expect(dev).toEqual(['api.composer-dev', 'web.dev']);
    expect(plan.run.find((r) => r.id === 'web.dev')!.needs).toEqual(['api.composer-dev']);
  });
});

describe('trap: no .env.example', () => {
  const plan = analyzeFixture('no-env-template');
  it('lists the variables the code reads, marked unknown, and says so', () => {
    const env = plan.env[0];
    expect(env.template).toBeNull();
    expect(env.vars.map((v) => [v.name, v.fill, v.secret])).toEqual([
      ['DATABASE_URL', 'unknown', false],
      ['JWT_SECRET', 'unknown', true],
      ['STRIPE_SECRET_KEY', 'unknown', true],
    ]);
    expect(plan.unknowns.some((u) => u.id === 'env-no-template:root')).toBe(true);
    // With no template it offers to create the file from the names alone: no values, nothing marked required.
    expect(step(plan, 'root.env')).toMatchObject({ optional: true, confidence: 'low', action: { type: 'env-names', path: '.env', names: ['DATABASE_URL', 'JWT_SECRET', 'STRIPE_SECRET_KEY'], required: [] } });
  });
  it('finds the port from the code', () => {
    expect(plan.run.find((r) => r.primary && r.kind === 'dev')?.ports[0]).toMatchObject({ port: 4000, evidence: [expect.objectContaining({ file: 'server.js', line: 7 })] });
  });
});

describe('trap: .nvmrc disagrees with engines', () => {
  const plan = analyzeFixture('nvmrc-vs-engines');
  it('keeps the constraint and warns about the pin', () => {
    expect(req(plan, 'runtime:node')).toMatchObject({ range: '>=20.9.0', status: 'ok' });
    expect(req(plan, 'runtime:node').recommended).toBeUndefined();
    const c = plan.conflicts.find((x) => x.subject === 'runtime:node@root');
    expect(c?.severity).toBe('warning');
    expect(c?.message).toBe('.nvmrc pins Node.js 18 (lts/hydrogen), but package.json engines.node requires ">=20.9.0"; using Node.js >= 20.9. Installs may fail on Node.js 18; consider updating .nvmrc.');
  });
});

describe('trap: CI matrix with several versions', () => {
  const plan = analyzeFixture('ci-matrix');
  it('recommends the newest tested version within engines, without calling the matrix a conflict', () => {
    expect(req(plan, 'runtime:node')).toMatchObject({ range: '>=18.0.0', recommended: '22.x', confidence: 'high' });
    expect(plan.conflicts).toEqual([]);
  });
});

describe('trap: two lockfiles', () => {
  const plan = analyzeFixture('two-lockfiles');
  it('lets CI break the tie and says which lockfile is stale', () => {
    expect(argv(plan, 'root.install')).toBe('yarn install --frozen-lockfile');
    const c = plan.conflicts.find((x) => x.subject === 'pm:node@root')!;
    expect(c.severity).toBe('warning');
    expect(c.message).toContain('package-lock.json is probably stale');
    expect(plan.projects[0].packageManagers[0].confidence).toBe('medium');
  });
});

describe('Laravel on SQLite', () => {
  const plan = analyzeFixture('laravel-sqlite');
  it('creates the database file before migrating and builds the Vite assets', () => {
    expect(step(plan, 'root.sqlite').action).toEqual({ type: 'touch', path: 'database/database.sqlite' });
    expect(step(plan, 'root.migrate').after).toEqual(expect.arrayContaining(['root.sqlite', 'root.key']));
    expect(step(plan, 'root.build')).toMatchObject({ optional: false });
    expect(plan.services).toEqual([]);
  });
  it('prefers composer run dev and demotes the parts it already runs', () => {
    expect(plan.run.filter((r) => r.primary && r.kind !== 'test').map((r) => r.id)).toEqual(['root.composer-dev']);
  });
});

describe('pnpm + turbo workspace', () => {
  const plan = analyzeFixture('pnpm-turbo-monorepo');
  it('installs once at the root and builds the shared package the apps import', () => {
    expect(plan.steps.filter((s) => s.phase === 'install').map((s) => s.id)).toEqual(['root.install']);
    expect(step(plan, 'packages/ui.build')).toMatchObject({ optional: false });
    expect(plan.projects.find((p) => p.id === 'apps/web')!.dependsOn).toEqual([expect.objectContaining({ project: 'packages/ui', kind: 'build' })]);
  });
  it('starts the workspace through turbo, with the apps\' ports', () => {
    const dev = plan.run.filter((r) => r.primary && r.kind === 'dev');
    expect(dev.map((r) => r.id)).toEqual(['root.dev']);
    expect(dev[0].ports.map((p) => p.port)).toEqual([3000, 3001]);
  });
});

describe('Prisma + Postgres', () => {
  const plan = analyzeFixture('prisma-postgres');
  it('writes .env because the Prisma CLI does not read .env.local', () => {
    expect(step(plan, 'root.env').action).toEqual({ type: 'copy', from: '.env.example', to: '.env' });
    expect(plan.conflicts.find((c) => c.rule === 'env file every framework reads')?.message).toBe('Next.js reads .env.local, but Prisma only reads .env; using .env, which every tool here reads.');
  });
  it('starts Postgres, generates the client, applies migrations', () => {
    const ids = plan.steps.filter((s) => !s.optional).map((s) => s.id);
    expect(ids).toEqual(['root.install', 'root.env', 'root.services', 'root.prisma-generate', 'root.prisma-migrate']);
    expect(argv(plan, 'root.prisma-migrate')).toBe('npx prisma migrate deploy');
  });
});

describe('generic: Django', () => {
  const plan = analyzeFixture('python-django');
  it('is marked generic and uses a virtual environment with per-OS paths', () => {
    expect(plan.summary.support).toBe('generic');
    expect(step(plan, 'root.install').action).toMatchObject({ argv: ['.venv/bin/python', '-m', 'pip', 'install', '-r', 'requirements.txt'], windowsArgv: ['.venv\\Scripts\\python.exe', '-m', 'pip', 'install', '-r', 'requirements.txt'] });
    expect(req(plan, 'runtime:python')).toMatchObject({ recommended: '3.12' });
    expect(plan.steps.every((s) => s.confidence === 'low' || s.id === 'root.env')).toBe(true);
  });
});

describe('generic: Makefile only, with submodules and LFS', () => {
  const plan = analyzeFixture('makefile-only');
  it('fetches submodules and LFS files, then falls back to the repo\'s own setup task', () => {
    expect(plan.steps.map((s) => s.id)).toEqual(['root.submodules', 'root.lfs', 'root.task-setup']);
    expect(step(plan, 'root.task-setup')).toMatchObject({ confidence: 'low', action: { type: 'exec', argv: ['make', 'setup'] } });
    expect(plan.run[0]).toMatchObject({ id: 'root.task-run', confidence: 'low' });
  });
});

describe('no manifest at all', () => {
  const plan = analyzeFixture('no-manifest');
  it('says so instead of guessing', () => {
    expect(plan.projects).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.summary.support).toBe('none');
    expect(plan.unknowns.map((u) => u.id)).toEqual(['no-project']);
  });
});
