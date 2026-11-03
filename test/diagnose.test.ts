// A command that fails says why: what it printed is matched against known messages, then the exit code. Start
// targets, setup steps and the doctor's .NET runtime check, which catches the most common one before anything runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnose, exitText } from '../src/runner/diagnose.js';
import { announcedUrl, startTargets, type StartEvent } from '../src/runner/start.js';
import { runSetup } from '../src/runner/runner.js';
import { runDoctor } from '../src/doctor/doctor.js';
import type { ProbeHost } from '../src/doctor/probes.js';
import type { SpawnFn } from '../src/runner/exec.js';
import { analyze } from '../src/core/analyze.js';
import { SCHEMA_VERSION, type Plan, type RunTarget, type Step } from '../src/core/schema.js';

// What `dotnet run` prints for a net9.0 app on a machine with only .NET 10 (Windows, .NET 10 host).
const DOTNET_MISSING = `Using launch settings from Properties\\launchSettings.json...
Building...
You must install or update .NET to run this application.

App: C:\\proj\\bin\\Debug\\net9.0\\HomeOwners.exe
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '9.0.0' (x64)
.NET location: C:\\Program Files\\dotnet

The following frameworks were found:
  10.0.9 at [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]

Learn more:
https://aka.ms/dotnet/app-launch-failed

To install missing framework, download:
https://aka.ms/dotnet-core-applaunch?framework=Microsoft.NETCore.App&framework_version=9.0.0&arch=x64&rid=win-x64&os=win10
`;

const win = (output: string, code: number | null = 1) => diagnose({ code, output, platform: 'win32' });
const linux = (output: string, code: number | null = 1) => diagnose({ code, output, platform: 'linux' });

describe('diagnose: what the output says', () => {
  it('a missing .NET runtime: which one, what is installed, and the fix', () => {
    const d = win(DOTNET_MISSING, 2147516566);
    expect(d.reason).toBe('The app needs the .NET 9.0 runtime (Microsoft.NETCore.App 9.0.0), but this machine only has 10.0.9. .NET does not run an app on a newer major version unless the project allows it.');
    expect(d.advice[0]).toBe('winget install Microsoft.DotNet.SDK.9');
    expect(d.advice[1]).toMatch(/^Or run it on \.NET 10: add <RollForward>Major<\/RollForward>/);
    expect(d.output.at(-1)).toMatch(/^https:\/\/aka\.ms\/dotnet-core-applaunch/);
    expect(linux(DOTNET_MISSING).advice[0]).toBe('Install the .NET 9 SDK or runtime: https://dotnet.microsoft.com/download/dotnet/9.0');
  });
  it('the older .NET host wording, with no runtime at all', () => {
    const d = linux("It was not possible to find any compatible framework version\nThe framework 'Microsoft.AspNetCore.App', version '8.0.0' (x64) was not found.\n  - No frameworks were found.\n");
    expect(d.reason).toBe('The app needs the ASP.NET Core 8.0 runtime (Microsoft.AspNetCore.App 8.0.0), but it is not installed.');
    expect(d.advice).toHaveLength(1);
  });
  it('a .NET build error names the first error', () => {
    const d = win('C:\\p\\Program.cs(1,11): error CS0103: The name \'WebApplication\' does not exist in the current context [C:\\p\\X.csproj]\nThe build failed. Fix the build errors and run again.\n');
    expect(d.reason).toBe("It does not build: Program.cs(1,11) CS0103: The name 'WebApplication' does not exist in the current context");
  });
  it('a busy port, from Node.js and from ASP.NET Core, with how to find who holds it', () => {
    expect(win('Error: listen EADDRINUSE: address already in use :::3000\n')).toMatchObject({ reason: expect.stringMatching(/^Port 3000 is already in use/), advice: ['netstat -ano | findstr :3000', expect.any(String)] });
    expect(linux('crit: Failed to bind to address http://127.0.0.1:5242: address already in use.\n').advice[0]).toBe('lsof -i :5242');
    // Vite moving to the next port is not a failure.
    expect(linux('Port 5173 is in use, trying another one...\n').reason).toBeUndefined();
  });
  it('missing programs and packages', () => {
    expect(win("'next' is not recognized as an internal or external command,\noperable program or batch file.\n").reason).toMatch(/^next was not found/);
    expect(linux('sh: 1: vite: not found\n').reason).toMatch(/^vite was not found/);
    expect(linux("Error: Cannot find module 'express'\nRequire stack:\n").reason).toMatch(/package express is not installed/);
    expect(win("Error: Cannot find module 'C:\\app\\node_modules\\@nestjs\\core\\index.js'\n").reason).toMatch(/package @nestjs\/core is not installed/);
    expect(linux("Error: Cannot find module './dist/server.js'\n").reason).toMatch(/^A file the app loads is missing: \.\/dist\/server\.js/);
    expect(linux("PHP Warning:  require(/app/vendor/autoload.php): Failed to open stream: No such file or directory\n").advice).toEqual(['composer install']);
    expect(linux("ModuleNotFoundError: No module named 'django.core'\n").reason).toMatch(/Python package django is not installed/);
  });
  it('services the app could not reach', () => {
    expect(linux('Error: connect ECONNREFUSED 127.0.0.1:5432\n').reason).toBe('The app could not connect to PostgreSQL on port 5432: nothing is listening there. Start it, then try again.');
    expect(win('Microsoft.Data.SqlClient.SqlException (0x80131904): A network-related or instance-specific error occurred while establishing a connection to SQL Server.\n').reason).toMatch(/could not connect to SQL Server/);
  });
  it('colour codes and progress rewrites do not hide a match, and the output shown is the last 15 lines', () => {
    const noisy = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n\x1b[31mError: Cannot find module \'next\'\x1b[0m\n';
    const d = linux(noisy);
    expect(d.reason).toMatch(/package next/);
    expect(d.output).toHaveLength(15);
    expect(d.output.at(-1)).toBe("Error: Cannot find module 'next'");
    expect(linux('downloading 10%\rdownloading 100%\n').output).toEqual(['downloading 100%']);
  });
});

describe('diagnose: the exit code when the output says nothing known', () => {
  it('Windows status codes and .NET host errors', () => {
    expect(win('', 2147516566).reason).toMatch(/\.NET runtime version the app needs is not installed/);
    expect(win('', 3221225781).reason).toMatch(/DLL/);
    expect(win('', -1073741515).reason).toMatch(/DLL/); // the same code, read as signed
    expect(exitText(2147516566, null, 'win32')).toBe('exited with 0x80008096');
    expect(exitText(1, null, 'win32')).toBe('exited with 1');
  });
  it('POSIX codes and signals', () => {
    expect(linux('', 127).reason).toMatch(/not found/);
    expect(diagnose({ code: null, signal: 'SIGKILL', output: '', platform: 'linux' }).reason).toMatch(/out of memory/);
    expect(exitText(null, 'SIGKILL', 'linux')).toBe('was killed by SIGKILL');
  });
  it('nothing known: no reason, the output speaks', () => {
    expect(linux('Something odd happened\n', 3)).toEqual({ reason: undefined, advice: [], output: ['Something odd happened'] });
  });
});

describe('announced addresses', () => {
  it('reads the address dev servers print', () => {
    expect(announcedUrl('info: Microsoft.Hosting.Lifetime[14]\n      Now listening on: http://localhost:5242\n')).toBe('http://localhost:5242');
    expect(announcedUrl('  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:5173/\x1b[39m\n')).toBe('http://localhost:5173');
    expect(announcedUrl('   INFO  Server running on [http://127.0.0.1:8000].\n')).toBe('http://127.0.0.1:8000');
    expect(announcedUrl('compiling...\n')).toBeUndefined();
  });
});

// ---- Start targets and setup steps --------------------------------------------------------------------------------

function mkPlan(over: Partial<Plan>): Plan {
  return {
    schemaVersion: SCHEMA_VERSION, tool: { name: 'seefast', version: 't' }, digest: 'sha256:test',
    summary: { support: 'full', projects: 1, steps: 0, conflicts: 0, unknowns: 0, lowestStepConfidence: 'high' },
    projects: [], requirements: [], services: [], env: [], steps: [], run: [], tasks: [], conflicts: [], unknowns: [],
    meta: { generatedAt: '', durationMs: 0, timings: {}, rootName: 'x', knowledgeBase: '', stats: { entriesSeen: 0, filesRead: 0, secretFilesNotRead: [], skipped: {}, parseErrors: [], readmeCommandsIgnored: 0, codeFilesScanned: 0, truncated: false }, inputs: [] },
    ...over,
  };
}

function mkTarget(over: Partial<RunTarget> = {}): RunTarget {
  return {
    id: 'root.run', project: 'root', name: 'run', kind: 'dev', primary: true, title: 'Start', cwd: '.',
    action: { type: 'exec', argv: ['tool', 'run'] }, ports: [], needs: [], after: [], readiness: { type: 'stays-up', seconds: 20 },
    confidence: 'low', why: '', evidence: [], ...over,
  };
}

/** A fake spawn: prints `output` on stderr, then exits with `code`. */
function printsAndExits(output: string, code: number): SpawnFn {
  return () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, pid: undefined });
    const done = new Promise<{ code: number; signal: null }>((resolve) => {
      setTimeout(() => {
        child.stderr.end(output);
        child.stdout.end();
        setTimeout(() => resolve({ code, signal: null }), 5);
      }, 5);
    });
    return { child: child as never, done };
  };
}

let root: string;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));
const tmp = () => (root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-diag-')));
const host = (platform: NodeJS.Platform) => ({ platform, env: { PATH: '/fakebin' }, isFile: (p: string) => /^\/fakebin\/tool(\.exe)?$/i.test(p.replace(/\\/g, '/')) });

describe('a start target that fails says why, at once', () => {
  it('reports the reason, the fix and the last lines as soon as it exits, not after the readiness wait', async () => {
    const events: StartEvent[] = [];
    const t0 = Date.now();
    const res = await startTargets(mkPlan({ run: [mkTarget()] }), { root: tmp(), host: host('win32'), spawn: printsAndExits(DOTNET_MISSING, 2147516566), onEvent: (e) => events.push(e) });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.ok).toBe(false);
    const ready = events.find((e) => e.type === 'ready');
    expect(ready).toMatchObject({ level: 'failed', detail: 'exited with 0x80008096 within 20 s' });
    expect(ready?.type === 'ready' && ready.diagnosis?.reason).toMatch(/needs the \.NET 9\.0 runtime/);
    expect(res.targets[0].diagnosis?.advice[0]).toBe('winget install Microsoft.DotNet.SDK.9');
  });
  it('a program that is not installed fails that target with the reason, instead of erroring out', async () => {
    const res = await startTargets(mkPlan({ run: [mkTarget({ action: { type: 'exec', argv: ['dotnet', 'run'] } })] }), { root: tmp(), host: host('linux'), spawn: printsAndExits('', 0) });
    expect(res.targets[0]).toMatchObject({ level: 'failed', detail: 'not started', diagnosis: { reason: expect.stringMatching(/^dotnet was not found on PATH/) } });
  });
});

describe('a setup step that fails says why', () => {
  it('the step message carries the reason, and the step its fix', async () => {
    const step: Step = {
      id: 'root.install', project: 'root', phase: 'install', title: 'Install', cwd: '.', action: { type: 'exec', argv: ['tool', 'install'] },
      network: false, thirdPartyCode: false, outsideProject: false, optional: false, after: [], requires: [], confidence: 'high', why: '', notes: [], evidence: [],
    };
    const res = await runSetup(mkPlan({ steps: [step] }), { root: tmp(), host: host('linux'), approveAll: true, spawn: printsAndExits('Error: listen EADDRINUSE: address already in use 0.0.0.0:8080\n', 1) });
    expect(res.steps[0]).toMatchObject({ status: 'failed', message: expect.stringMatching(/^exited with 1: Port 8080 is already in use/), advice: ['lsof -i :8080', expect.any(String)] });
  });
});

// ---- Catching it before anything runs: the ASP.NET Core runtime ------------------------------------------------

let dir: string;
function project(files: Record<string, string>): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-dotnet-'));
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
  return dir;
}
afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
const csproj = (extra = '') => `<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup>\n    <TargetFramework>net9.0</TargetFramework>${extra}\n  </PropertyGroup>\n</Project>\n`;

describe('an ASP.NET Core app needs the runtime of the major version it targets', () => {
  it('the plan asks for ASP.NET Core 9.x, besides an SDK >= 9 to build it', () => {
    const plan = analyze(project({ 'Web.csproj': csproj(), 'Program.cs': '' }));
    expect(plan.requirements.find((r) => r.id === 'runtime:dotnet')?.range).toBe('>=9.0.0');
    expect(plan.requirements.find((r) => r.id === 'tool:aspnetcore-runtime')).toMatchObject({ range: '>=9.0.0 <10.0.0-0', rangeText: '9.x', optional: false });
  });
  it('RollForward Major lets newer runtimes run it', () => {
    const plan = analyze(project({ 'Web.csproj': csproj('\n    <RollForward>Major</RollForward>'), 'Program.cs': '' }));
    expect(plan.requirements.find((r) => r.id === 'tool:aspnetcore-runtime')?.range).toBe('>=9.0.0');
  });

  const machine = (runtimes: string): ProbeHost => ({
    platform: 'win32', env: { PATH: 'C:\\dotnet', PATHEXT: '.EXE' }, isFile: (p) => p === 'C:\\dotnet\\dotnet.exe',
    run: async (_f, args) => ({ code: 0, stdout: args[0] === '--version' ? '10.0.301' : runtimes, stderr: '' }),
  });
  const only10 = 'Microsoft.AspNetCore.App 10.0.9 [C:\\dotnet\\shared\\Microsoft.AspNetCore.App]\nMicrosoft.NETCore.App 10.0.9 [C:\\dotnet\\shared\\Microsoft.NETCore.App]\n';
  it('the doctor flags a machine with only .NET 10, though its SDK satisfies >= 9', async () => {
    const plan = analyze(project({ 'Web.csproj': csproj(), 'Program.cs': '' }));
    const r = await runDoctor(plan, { host: machine(only10), osRelease: null, portInUse: async () => false });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(by['runtime:dotnet']).toMatchObject({ status: 'ok', found: '10.0.301' });
    expect(by['tool:aspnetcore-runtime']).toMatchObject({ status: 'wrong-version', found: '10.0.9', message: expect.stringMatching(/^Found Microsoft\.AspNetCore\.App 10\.0\.9, but the app runs on 9\.x/) });
    expect(by['tool:aspnetcore-runtime'].advice).toEqual(['winget install Microsoft.DotNet.SDK.9', expect.stringMatching(/^or run it on \.NET 10: add <RollForward>Major<\/RollForward> to Web\.csproj/)]);
  });
  it('and passes it once the 9.x runtimes are there', async () => {
    const plan = analyze(project({ 'Web.csproj': csproj(), 'Program.cs': '' }));
    const with9 = only10 + 'Microsoft.AspNetCore.App 9.0.3 [C:\\dotnet\\shared\\Microsoft.AspNetCore.App]\nMicrosoft.NETCore.App 9.0.3 [C:\\dotnet\\shared\\Microsoft.NETCore.App]\n';
    const r = await runDoctor(plan, { host: machine(with9), osRelease: null, portInUse: async () => false });
    expect(r.checks.find((c) => c.id === 'tool:aspnetcore-runtime')).toMatchObject({ status: 'ok', found: '9.0.3' });
  });
});
