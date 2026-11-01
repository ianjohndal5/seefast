// Automated mode never runs a command without consent, honours dry runs, asks separately before changing
// anything outside the project, stops at the first failure, never elevates, and resumes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetup, type RunnerOptions } from '../src/runner/runner.js';
import type { SpawnFn, Resolved } from '../src/runner/exec.js';
import type { Plan, Step } from '../src/core/schema.js';
import { SCHEMA_VERSION } from '../src/core/schema.js';
import { main } from '../src/cli.js';

function mkStep(id: string, over: Partial<Step> = {}): Step {
  return {
    id, project: 'root', phase: 'install', title: id, cwd: '.', action: { type: 'exec', argv: ['tool', id] },
    network: false, thirdPartyCode: false, outsideProject: false, optional: false, after: [], requires: [],
    confidence: 'high', why: '', notes: [], evidence: [], ...over,
  };
}

function mkPlan(steps: Step[]): Plan {
  return {
    schemaVersion: SCHEMA_VERSION, tool: { name: 'seefast', version: 't' }, digest: 'sha256:test',
    summary: { support: 'full', projects: 1, steps: steps.length, conflicts: 0, unknowns: 0, lowestStepConfidence: 'high' },
    projects: [], requirements: [], services: [], env: [], steps, run: [], tasks: [], conflicts: [], unknowns: [],
    meta: { generatedAt: '', durationMs: 0, timings: {}, rootName: 'x', knowledgeBase: '', stats: { entriesSeen: 0, filesRead: 0, secretFilesNotRead: [], skipped: {}, parseErrors: [], readmeCommandsIgnored: 0, codeFilesScanned: 0, truncated: false }, inputs: [] },
  };
}

/** A fake spawn that records every call and exits with the given code per argv. */
function fakeSpawn(codes: Record<string, number> = {}): { spawn: SpawnFn; calls: Resolved[] } {
  const calls: Resolved[] = [];
  const spawn: SpawnFn = (r) => {
    calls.push(r);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, pid: undefined });
    const code = codes[r.args.join(' ')] ?? 0;
    const done = Promise.resolve().then(() => {
      child.stdout.end(`ran ${r.args.join(' ')}\n`);
      return { code, signal: null };
    });
    return { child: child as never, done };
  };
  return { spawn, calls };
}

let root: string;
const host: RunnerOptions['host'] = { platform: 'linux', env: { PATH: '/fakebin' }, isFile: (p) => p === '/fakebin/tool' || fs.existsSync(p) };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-consent-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('consent', () => {
  it('without consent and without approval, nothing runs', async () => {
    const { spawn, calls } = fakeSpawn();
    const res = await runSetup(mkPlan([mkStep('a'), mkStep('b')]), { root, spawn, host });
    expect(calls).toEqual([]);
    expect(res.status).toBe('declined');
  });
  it('declining every step runs nothing', async () => {
    const { spawn, calls } = fakeSpawn();
    const asked: string[] = [];
    const res = await runSetup(mkPlan([mkStep('a'), mkStep('b')]), { root, spawn, host, consent: async (r) => (asked.push(r.step.id), 'skip') });
    expect(asked).toEqual(['a', 'b']);
    expect(calls).toEqual([]);
    expect(res.steps.map((s) => s.status)).toEqual(['skipped', 'skipped']);
  });
  it('quitting at the first prompt runs nothing and stops', async () => {
    const { spawn, calls } = fakeSpawn();
    const res = await runSetup(mkPlan([mkStep('a'), mkStep('b')]), { root, spawn, host, consent: async () => 'quit' });
    expect(calls).toEqual([]);
    expect(res.status).toBe('declined');
  });
  it('a dry run executes nothing, even when approved', async () => {
    const { spawn, calls } = fakeSpawn();
    const res = await runSetup(mkPlan([mkStep('a'), mkStep('env', { action: { type: 'copy', from: 'x', to: 'y' } })]), { root, spawn, host, dryRun: true, approveAll: true, allowOutside: true });
    expect(calls).toEqual([]);
    expect(res.status).toBe('dry-run');
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('"approve all remaining" covers later steps, but not outside-project or optional ones', async () => {
    const { spawn, calls } = fakeSpawn();
    const asked: string[] = [];
    const steps = [mkStep('a'), mkStep('b'), mkStep('compose', { outsideProject: true }), mkStep('seed', { optional: true })];
    await runSetup(mkPlan(steps), { root, spawn, host, consent: async (r) => (asked.push(`${r.step.id}:${r.reason ?? ''}`), r.step.id === 'a' ? 'all' : 'skip') });
    expect(asked).toEqual(['a:', 'compose:outside-project', 'seed:optional']);
    expect(calls.map((c) => c.args[0])).toEqual(['a', 'b']);
  });
  it('approved non-interactively, outside-project steps are skipped unless allowed', async () => {
    const { spawn, calls } = fakeSpawn();
    const steps = [mkStep('a'), mkStep('compose', { outsideProject: true })];
    const res = await runSetup(mkPlan(steps), { root, spawn, host, approveAll: true });
    expect(calls.map((c) => c.args[0])).toEqual(['a']);
    expect(res.steps[1]).toMatchObject({ id: 'compose', status: 'skipped' });
    const again = fakeSpawn();
    await runSetup(mkPlan(steps), { root, spawn: again.spawn, host, approveAll: true, allowOutside: true });
    expect(again.calls.map((c) => c.args[0])).toEqual(['a', 'compose']);
  });
  it('runs argv directly, without a shell', async () => {
    const { spawn, calls } = fakeSpawn();
    await runSetup(mkPlan([mkStep('a', { action: { type: 'exec', argv: ['tool', 'a; rm -rf ~', '$(whoami)'] } })]), { root, spawn, host, approveAll: true });
    expect(calls[0]).toMatchObject({ file: '/fakebin/tool', args: ['a; rm -rf ~', '$(whoami)'] });
  });
});

describe('safety', () => {
  it('stops at the first failure and resumes from it', async () => {
    const steps = [mkStep('a'), mkStep('b'), mkStep('c')];
    const first = fakeSpawn({ b: 1 });
    const r1 = await runSetup(mkPlan(steps), { root, spawn: first.spawn, host, approveAll: true });
    expect(r1).toMatchObject({ status: 'failed', failed: 'b' });
    expect(first.calls.map((c) => c.args[0])).toEqual(['a', 'b']);
    expect(fs.readFileSync(path.join(root, '.seefast', '.gitignore'), 'utf8')).toBe('*\n');
    expect(fs.readFileSync(path.join(root, '.seefast', 'logs', '02-b.log'), 'utf8')).toContain('ran b');
    const second = fakeSpawn();
    const r2 = await runSetup(mkPlan(steps), { root, spawn: second.spawn, host, approveAll: true, resume: true });
    expect(r2.status).toBe('success');
    expect(second.calls.map((c) => c.args[0])).toEqual(['b', 'c']);
    expect(r2.steps[0]).toMatchObject({ id: 'a', status: 'already-done' });
  });
  it('never elevates', async () => {
    const { spawn, calls } = fakeSpawn();
    const res = await runSetup(mkPlan([mkStep('x', { action: { type: 'exec', argv: ['sudo', 'apt', 'install', 'php'] } })]), { root, spawn, host: { ...host!, isFile: () => true }, approveAll: true });
    expect(calls).toEqual([]);
    expect(res.steps[0]).toMatchObject({ status: 'refused' });
  });
  it('refuses working directories and files outside the project', async () => {
    const { spawn, calls } = fakeSpawn();
    const r1 = await runSetup(mkPlan([mkStep('x', { cwd: '../elsewhere' })]), { root, spawn, host, approveAll: true });
    expect(r1.steps[0].status).toBe('refused');
    const r2 = await runSetup(mkPlan([mkStep('y', { action: { type: 'copy', from: 'a', to: '../../escaped' } })]), { root, spawn, host, approveAll: true });
    expect(r2.steps[0].status).toBe('refused');
    expect(calls).toEqual([]);
  });
  it('copies an env file but never overwrites one', async () => {
    fs.writeFileSync(path.join(root, '.env.example'), 'A=1\n');
    const plan = mkPlan([mkStep('env', { action: { type: 'copy', from: '.env.example', to: '.env' } })]);
    await runSetup(plan, { root, host, approveAll: true });
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=1\n');
    fs.writeFileSync(path.join(root, '.env'), 'MINE=1\n');
    const r = await runSetup(plan, { root, host, approveAll: true });
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('MINE=1\n');
    expect(r.steps[0].message).toMatch(/already exists/);
  });
  it('warns once that installs run third-party code', async () => {
    const { spawn } = fakeSpawn();
    const warnings: string[] = [];
    await runSetup(mkPlan([mkStep('a', { thirdPartyCode: true }), mkStep('b', { thirdPartyCode: true })]), {
      root, spawn, host, approveAll: true, onEvent: (e) => e.type === 'warning' && warnings.push(e.message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/runs code from their authors/);
  });
});

describe('CLI consent', () => {
  const io = () => {
    const out: string[] = [];
    return { out, io: { out: (s: string) => void out.push(s), err: (s: string) => void out.push(s), isTTY: false } };
  };
  it('setup outside a terminal without --yes or --approve refuses (exit 5)', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x","scripts":{"dev":"node x.js"}}');
    const { out, io: i } = io();
    expect(await main(['setup', root], i)).toBe(5);
    expect(out.join('')).toMatch(/needs consent/);
    expect(fs.existsSync(path.join(root, '.seefast'))).toBe(false);
  });
  it('--approve with a digest that does not match the current plan refuses (exit 6)', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    const { out, io: i } = io();
    expect(await main(['setup', root, '--approve', 'sha256:0000'], i)).toBe(6);
    expect(out.join('')).toMatch(/plan changed/);
  });
  it('--dry-run prints every command and writes nothing', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    const { out, io: i } = io();
    expect(await main(['setup', root, '--dry-run', '--shell', 'posix'], i)).toBe(0);
    expect(out.join('')).toContain('npm ci');
    expect(fs.readdirSync(root).sort()).toEqual(['package-lock.json', 'package.json']);
  });
});
