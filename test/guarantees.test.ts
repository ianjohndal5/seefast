// The non-negotiable guarantees of the analysis: deterministic, portable across line endings and byte-order
// marks, never spawns a process or opens a socket, never reads or outputs secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analyze.js';
import { renderGuide } from '../src/render/guide.js';
import { renderExplain } from '../src/render/explain.js';
import { renderSetupMd } from '../src/render/setupmd.js';
import { analyzeFixture, FIXTURES, fixtureNames, REPO, stable } from './helpers.js';

const require = createRequire(import.meta.url);

describe('determinism', () => {
  for (const name of fixtureNames()) {
    it(`${name}: two runs give identical output apart from time and timings`, () => {
      const a = analyzeFixture(name);
      const b = analyzeFixture(name);
      expect(JSON.stringify(stable(a))).toBe(JSON.stringify(stable(b)));
      expect(a.digest).toBe(b.digest);
    });
  }
  it('the plan does not depend on the absolute location of the folder', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-loc-'));
    const copy = path.join(tmp, 'laravel-next-monorepo');
    fs.cpSync(path.join(FIXTURES, 'laravel-next-monorepo'), copy, { recursive: true });
    try {
      expect(analyze(copy).digest).toBe(analyzeFixture('laravel-next-monorepo').digest);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** Copy a folder converting every text file to CRLF with a UTF-8 BOM. */
function crlfCopy(from: string, to: string): void {
  for (const rel of fs.readdirSync(from, { recursive: true }) as string[]) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    if (fs.statSync(src).isDirectory()) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, '﻿' + fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n'));
  }
}

describe('portability: Windows line endings and byte-order marks', () => {
  it('the committed CRLF + BOM fixture gives the same plan as its LF original', () => {
    const lf = analyzeFixture('laravel-next-monorepo');
    const crlf = analyzeFixture('crlf-bom');
    expect(crlf.digest).toBe(lf.digest);
    expect(crlf.meta.inputs).toEqual(lf.meta.inputs);
    const raw = fs.readFileSync(path.join(FIXTURES, 'crlf-bom', 'api', 'composer.json'));
    expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.includes(Buffer.from('\r\n'))).toBe(true);
  });
  for (const name of fixtureNames().filter((n) => n !== 'crlf-bom')) {
    it(`${name}: converted on the fly gives the same digest`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-crlf-'));
      try {
        crlfCopy(path.join(FIXTURES, name), path.join(tmp, name));
        expect(analyze(path.join(tmp, name)).digest).toBe(analyzeFixture(name).digest);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

describe('the analysis never spawns a process or opens a connection', () => {
  const FORBIDDEN = ['child_process', 'net', 'http', 'https', 'http2', 'dgram', 'dns', 'tls', 'worker_threads', 'cluster', 'inspector'];
  it('no module under src/core imports a process or network module', () => {
    const dir = path.join(REPO, 'src', 'core');
    const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/from\s+['"](?:node:)?([\w/]+)['"]|require\(\s*['"](?:node:)?([\w/]+)['"]\s*\)|import\(\s*['"](?:node:)?([\w/]+)['"]/g)) {
        const mod = m[1] ?? m[2] ?? m[3];
        expect(FORBIDDEN.includes(mod), `${f} imports ${mod}`).toBe(false);
      }
    }
  });

  const saved: [object, string, unknown][] = [];
  const calls: string[] = [];
  beforeAll(() => {
    const trap = (mod: Record<string, unknown>, modName: string, fns: string[]) => {
      for (const fn of fns) {
        saved.push([mod, fn, mod[fn]]);
        mod[fn] = (...args: unknown[]) => {
          calls.push(`${modName}.${fn}(${String(args[0]).slice(0, 40)})`);
          throw new Error(`analysis called ${modName}.${fn}`);
        };
      }
    };
    trap(require('node:child_process'), 'child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
    trap(require('node:net'), 'net', ['connect', 'createConnection', 'createServer']);
    trap(require('node:http'), 'http', ['request', 'get']);
    trap(require('node:https'), 'https', ['request', 'get']);
    trap(require('node:dns'), 'dns', ['lookup', 'resolve']);
    syncBuiltinESMExports();
  });
  afterAll(() => {
    for (const [mod, fn, orig] of saved) (mod as Record<string, unknown>)[fn] = orig;
    syncBuiltinESMExports();
  });
  it('analyzing every fixture with process and network functions booby-trapped succeeds and calls none', () => {
    for (const name of fixtureNames()) analyzeFixture(name);
    expect(calls).toEqual([]);
  });
  it('the traps work (negative control: the doctor, which may spawn, is caught)', async () => {
    const { realHost } = await import('../src/doctor/probes.js');
    await expect(realHost.run('/bin/true', [], { cwd: os.tmpdir(), env: {} })).rejects.toThrow(/analysis called child_process.execFile/);
    calls.length = 0;
  });
});

describe('secrets', () => {
  const root = path.join(FIXTURES, 'secrets');
  it('never opens real env files, keys or credential files', () => {
    const opened: string[] = [];
    const orig = fs.readFileSync;
    (fs as { readFileSync: unknown }).readFileSync = (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.startsWith(root)) opened.push(path.relative(root, p).split(path.sep).join('/'));
      return (orig as (...a: unknown[]) => unknown)(p, ...rest);
    };
    let plan;
    try {
      plan = analyze(root);
    } finally {
      (fs as { readFileSync: unknown }).readFileSync = orig;
    }
    for (const f of ['.env', '.env.local', '.env.production', 'auth.json', 'id_rsa', 'config/credentials.json']) expect(opened).not.toContain(f);
    expect(opened).toContain('.env.example');
    expect(plan.meta.stats.secretFilesNotRead).toEqual(expect.arrayContaining(['.env', '.env.local', '.env.production', 'auth.json', 'id_rsa', 'config/credentials.json']));
  });
  it('no secret value reaches the plan or any rendered output', () => {
    const plan = analyze(root);
    const outputs = [
      JSON.stringify(plan),
      renderGuide(plan, { shell: 'posix', color: false, verbose: true }),
      renderGuide(plan, { shell: 'powershell', color: false, verbose: true }),
      renderExplain(plan, { shell: 'posix', color: false }),
      renderSetupMd(plan),
    ];
    for (const o of outputs) expect(o).not.toMatch(/CANARY/);
  });
  it('keeps the variable names and marks them as secrets', () => {
    const plan = analyze(root);
    const vars = Object.fromEntries(plan.env[0].vars.map((v) => [v.name, v]));
    expect(vars.SESSION_SECRET.secret).toBe(true);
    expect(vars.STRIPE_SECRET.secret).toBe(true);
    expect(vars.APP_URL.secret).toBe(false);
    expect(plan.env[0].exists).toBe(true);
  });
});
