// The doctor's probes: a fixed list of read-only version and capability commands (docs/DOCTOR.md). Nothing the
// project defines is ever run. Each probe:
//   * is looked up on PATH without spawning anything (missing tools cost nothing);
//   * runs by absolute path, without a shell, with a 5 s timeout;
//   * runs from an empty temporary directory, so Composer cannot load the project's plugins, Corepack cannot
//     switch versions from packageManager, and Go / rustup cannot download a toolchain the project pins;
//   * runs with an environment that disables network and prompts where the tool allows it.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ProbeDef {
  id: string;
  bin: string;
  args: string[];
  /** Only on this platform. */
  platform?: NodeJS.Platform;
  /** Extract a version from stdout+stderr. */
  version?: RegExp;
}

/** The complete list. Adding a probe means adding it here and to docs/DOCTOR.md. */
export const PROBES: ProbeDef[] = [
  { id: 'node', bin: 'node', args: ['--version'] },
  { id: 'npm', bin: 'npm', args: ['--version'] },
  { id: 'pnpm', bin: 'pnpm', args: ['--version'] },
  { id: 'yarn', bin: 'yarn', args: ['--version'] },
  { id: 'bun', bin: 'bun', args: ['--version'] },
  { id: 'corepack', bin: 'corepack', args: ['--version'] },
  { id: 'php', bin: 'php', args: ['--version'], version: /PHP (\d+\.\d+\.\d+)/ },
  { id: 'php-modules', bin: 'php', args: ['-m'] },
  { id: 'php-ini', bin: 'php', args: ['--ini'] },
  { id: 'composer', bin: 'composer', args: ['--version', '--no-ansi', '--no-plugins', '--no-scripts', '--no-interaction'], version: /Composer (?:version )?(\d+\.\d+\.\d+)/ },
  { id: 'docker', bin: 'docker', args: ['--version'], version: /version (\d+\.\d+\.\d+)/ },
  { id: 'docker-compose', bin: 'docker', args: ['compose', 'version', '--short'] },
  { id: 'docker-daemon', bin: 'docker', args: ['info', '--format', '{{.ServerVersion}}'] },
  { id: 'git', bin: 'git', args: ['--version'] },
  { id: 'git-lfs', bin: 'git-lfs', args: ['--version'], version: /git-lfs\/(\d+\.\d+\.\d+)/ },
  { id: 'make', bin: 'make', args: ['--version'] },
  { id: 'just', bin: 'just', args: ['--version'] },
  { id: 'python', bin: 'python3', args: ['--version'] },
  { id: 'python-win', bin: 'py', args: ['-3', '--version'], platform: 'win32' },
  { id: 'uv', bin: 'uv', args: ['--version'] },
  { id: 'poetry', bin: 'poetry', args: ['--version', '--no-ansi'] },
  { id: 'pipenv', bin: 'pipenv', args: ['--version'] },
  { id: 'pdm', bin: 'pdm', args: ['--version'] },
  { id: 'go', bin: 'go', args: ['version'], version: /go(\d+\.\d+(?:\.\d+)?)/ },
  { id: 'rust', bin: 'rustc', args: ['--version'] },
  { id: 'cargo', bin: 'cargo', args: ['--version'] },
  { id: 'ruby', bin: 'ruby', args: ['--version'] },
  { id: 'bundler', bin: 'bundle', args: ['--version'] },
  { id: 'java', bin: 'java', args: ['-version'], version: /version "(?:1\.)?(\d+(?:\.\d+)*)/ },
  { id: 'maven', bin: 'mvn', args: ['--version'] },
  { id: 'gradle', bin: 'gradle', args: ['--version'] },
  { id: 'dotnet', bin: 'dotnet', args: ['--version'] },
  { id: 'deno', bin: 'deno', args: ['--version'] },
  { id: 'elixir', bin: 'elixir', args: ['--version'], version: /Elixir (\d+\.\d+\.\d+)/ },
  { id: 'powershell-policy', bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], platform: 'win32' },
];

/** Tools only looked up on PATH (never run): version managers and OS package managers, for advice. */
export const LOOKUPS = ['mise', 'fnm', 'volta', 'asdf', 'pyenv', 'rbenv', 'brew', 'winget', 'scoop', 'choco', 'apt', 'dnf', 'pacman', 'apk', 'zypper'];

/** Probe ids needed to check a requirement name. */
export const PROBES_FOR: Record<string, string[]> = {
  node: ['node'], npm: ['npm'], pnpm: ['pnpm', 'corepack'], yarn: ['yarn', 'corepack'], bun: ['bun'],
  php: ['php', 'php-ini'], composer: ['composer'], docker: ['docker', 'docker-compose', 'docker-daemon'], git: ['git'], 'git-lfs': ['git-lfs'],
  make: ['make'], just: ['just'], python: ['python', 'python-win'], uv: ['uv'], poetry: ['poetry'], pipenv: ['pipenv'], pdm: ['pdm'],
  go: ['go'], rust: ['rust', 'cargo'], ruby: ['ruby'], bundler: ['bundler'], java: ['java'], maven: ['maven'], gradle: ['gradle'],
  dotnet: ['dotnet'], deno: ['deno'], elixir: ['elixir'],
};

export interface ProbeResult {
  id: string;
  /** The command as it was run, for the report. */
  command: string;
  found: boolean;
  path?: string;
  ok: boolean;
  version?: string;
  output: string;
  ms: number;
  error?: string;
}

export interface ProbeHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Run a resolved executable. Injected in tests. */
  run(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;
  isFile(p: string): boolean;
}

export const realHost: ProbeHost = {
  platform: process.platform,
  env: process.env,
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  run: (file, args, opts) =>
    new Promise((resolve) => {
      let cmd = file;
      let argv = args;
      const extra: { windowsVerbatimArguments?: boolean } = {};
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
        // Node refuses to spawn .cmd/.bat without a shell; the arguments are constants from PROBES.
        cmd = process.env.ComSpec ?? 'cmd.exe';
        argv = ['/d', '/s', '/c', `"${[`"${file}"`, ...args].join(' ')}"`];
        extra.windowsVerbatimArguments = true;
      }
      execFile(cmd, argv, { cwd: opts.cwd, env: opts.env, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024, shell: false, ...extra }, (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          error: e ? (e.killed ? 'timed out after 5 s' : e.message.split('\n')[0]) : undefined,
        });
      });
    }),
};

/** Find an executable on PATH without running anything (PATHEXT on Windows). */
export function which(bin: string, host: ProbeHost): string | null {
  const isWin = host.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const dirs = (host.env.PATH ?? host.env.Path ?? '').split(sep).filter(Boolean);
  const exts = isWin ? (host.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()) : [''];
  const join = isWin ? path.win32.join : path.posix.join;
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, bin + ext);
      if (host.isFile(p)) {
        // The Microsoft Store "python" alias opens the Store instead of running Python.
        if (isWin && /\\WindowsApps\\python3?(\.exe)?$/i.test(p)) continue;
        return p;
      }
    }
  }
  return null;
}

/** Environment for probes: no prompts, no downloads, no colours, no telemetry banners. */
export function probeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_STRICT: '0',
    GOTOOLCHAIN: 'local',
    RUSTUP_AUTO_INSTALL: '0',
    NO_COLOR: '1',
    COMPOSER_NO_INTERACTION: '1',
    COMPOSER_DISABLE_NETWORK: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    DOTNET_NOLOGO: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    HOMEBREW_NO_AUTO_UPDATE: '1',
    POETRY_NO_INTERACTION: '1',
    PIPENV_VERBOSITY: '-1',
  };
}

export function extractVersion(def: ProbeDef, text: string): string | undefined {
  const m = (def.version ?? /(\d+\.\d+(?:\.\d+)?)/).exec(text);
  return m?.[1];
}

export async function runProbes(ids: string[], host: ProbeHost = realHost): Promise<Map<string, ProbeResult>> {
  const results = new Map<string, ProbeResult>();
  const defs = PROBES.filter((p) => ids.includes(p.id) && (!p.platform || p.platform === host.platform));
  let neutral: string | null = null;
  try {
    neutral = fs.mkdtempSync(path.join(os.tmpdir(), 'seefast-doctor-'));
  } catch {
    neutral = os.tmpdir();
  }
  const env = probeEnv(host.env);
  try {
    await Promise.all(
      defs.map(async (def) => {
        const command = [def.bin, ...def.args].join(' ');
        const file = which(def.bin, host);
        if (!file) {
          results.set(def.id, { id: def.id, command, found: false, ok: false, output: '', ms: 0 });
          return;
        }
        const t = performance.now();
        const r = await host.run(file, def.args, { cwd: neutral!, env });
        const output = (r.stdout + '\n' + r.stderr).trim();
        results.set(def.id, {
          id: def.id, command, found: true, path: file, ok: r.code === 0, version: r.code === 0 || def.id === 'java' ? extractVersion(def, output) : undefined,
          output: output.slice(0, 20_000), ms: Math.round(performance.now() - t), error: r.error,
        });
      }),
    );
  } finally {
    if (neutral && neutral !== os.tmpdir()) fs.rmSync(neutral, { recursive: true, force: true });
  }
  return results;
}

/** `php -m` output → lower-case module names. */
export function parsePhpModules(output: string): Set<string> {
  const mods = new Set<string>();
  for (const l of output.split(/\r?\n/)) {
    const t = l.trim();
    if (!t || t.startsWith('[')) continue;
    const n = t.toLowerCase();
    mods.add(n === 'zend opcache' ? 'opcache' : n);
  }
  return mods;
}

/** The OS family used to pick install advice: debian, fedora, arch, alpine, suse, linux, macos, windows. */
export function osFamily(platform: NodeJS.Platform, osRelease: string | null, families: Record<string, string[]>): { family: string; distro?: string; release?: string } {
  if (platform === 'darwin') return { family: 'macos' };
  if (platform === 'win32') return { family: 'windows' };
  if (!osRelease) return { family: 'linux' };
  const get = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?`, 'm').exec(osRelease)?.[1];
  const ids = [get('ID'), ...(get('ID_LIKE') ?? '').split(/\s+/)].filter(Boolean) as string[];
  for (const id of ids) for (const [fam, members] of Object.entries(families)) if (members.includes(id.toLowerCase())) return { family: fam, distro: get('PRETTY_NAME') ?? get('NAME'), release: get('VERSION_ID') };
  return { family: 'linux', distro: get('PRETTY_NAME'), release: get('VERSION_ID') };
}

export function readOsRelease(): string | null {
  for (const f of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      /* next */
    }
  }
  return null;
}
