// A small grammar of setup commands. Commands found in READMEs, CI steps, Makefiles and dev-container hooks are
// classified into signatures, so "README runs `npm i`" can be compared with "the plan runs `pnpm install`".
// Nothing here executes anything.
import { splitShell } from './text.js';

export type NodePM = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface CommandSig {
  kind: 'install' | 'script' | 'artisan' | 'copy' | 'exec' | 'compose-up' | 'task' | 'cd' | 'submodule' | 'other';
  /** Comparable key: `install:pnpm`, `script:dev`, `artisan:key:generate`, `copy:.env.example>.env`, `exec:prisma generate`. */
  key: string;
  /** Tool that runs it: a package manager, `php`, `make`... */
  tool?: string;
  argv: string[];
}

const NODE_PMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_BUILTINS: Record<string, Set<string>> = {
  pnpm: new Set(['add', 'remove', 'rm', 'update', 'up', 'link', 'unlink', 'publish', 'outdated', 'list', 'ls', 'why', 'audit', 'store', 'config', 'env', 'setup', 'init', 'create', 'dlx', 'exec', 'patch', 'import', 'rebuild', 'prune', 'fetch', 'deploy', 'licenses', 'self-update']),
  yarn: new Set(['add', 'remove', 'upgrade', 'up', 'link', 'unlink', 'publish', 'outdated', 'list', 'info', 'why', 'audit', 'config', 'cache', 'init', 'create', 'dlx', 'exec', 'set', 'plugin', 'workspaces', 'workspace', 'global', 'bin', 'constraints', 'npm', 'pack', 'patch', 'version', 'explain', 'dedupe', 'rebuild']),
  bun: new Set(['add', 'remove', 'rm', 'update', 'link', 'unlink', 'publish', 'outdated', 'pm', 'x', 'create', 'init', 'build', 'upgrade', 'test', 'patch']),
};

function stripFlags(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('-'));
}

/** Classify one simple command (argv). Leading `sudo` is ignored for classification only. */
export function classifyArgv(argvIn: string[]): CommandSig | null {
  let argv = argvIn.filter((a) => a !== '');
  while (argv.length && ['sudo', 'time', 'exec', 'command', 'env'].includes(argv[0])) argv = argv.slice(1);
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv = argv.slice(1);
  if (!argv.length) return null;
  const [cmd0, ...rest] = argv;
  const cmd = cmd0.replace(/\.(cmd|exe|bat)$/i, '').replace(/^\.\//, '');
  const pos = stripFlags(rest);

  if (cmd === 'cd' || cmd === 'pushd' || cmd === 'Set-Location') return { kind: 'cd', key: `cd:${pos[0] ?? ''}`, argv };

  if (NODE_PMS.has(cmd)) {
    const sub = pos[0];
    if (cmd === 'npm') {
      if (sub === 'ci' || ((sub === 'install' || sub === 'i' || sub === 'isntall' || sub === 'add') && pos.length === 1)) return { kind: 'install', key: 'install:npm', tool: 'npm', argv };
      if ((sub === 'run' || sub === 'run-script') && pos[1]) return { kind: 'script', key: `script:${pos[1]}`, tool: 'npm', argv };
      if (['start', 'test', 't', 'stop', 'restart'].includes(sub ?? '')) return { kind: 'script', key: `script:${sub === 't' ? 'test' : sub}`, tool: 'npm', argv };
      if (sub === 'exec' && pos[1]) return { kind: 'exec', key: `exec:${pos.slice(1).join(' ')}`, tool: 'npm', argv };
      return { kind: 'other', key: `npm:${sub ?? ''}`, tool: 'npm', argv };
    }
    if (!sub || ((sub === 'install' || sub === 'i') && pos.length === 1)) {
      // `yarn` alone installs; `pnpm` / `bun` alone print help.
      if (sub || cmd === 'yarn') return { kind: 'install', key: `install:${cmd}`, tool: cmd, argv };
      return null;
    }
    if (sub === 'run' && pos[1]) return { kind: 'script', key: `script:${pos[1]}`, tool: cmd, argv };
    if ((sub === 'exec' || sub === 'dlx' || sub === 'x') && pos[1]) return { kind: 'exec', key: `exec:${pos.slice(1).join(' ')}`, tool: cmd, argv };
    if (sub === 'test' && cmd !== 'bun') return { kind: 'script', key: 'script:test', tool: cmd, argv };
    if (!PM_BUILTINS[cmd]?.has(sub)) return { kind: 'script', key: `script:${sub}`, tool: cmd, argv };
    return { kind: 'other', key: `${cmd}:${sub}`, tool: cmd, argv };
  }
  if (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx') {
    const p = pos.filter((a) => !/^(--yes|-y)$/.test(a));
    if (p[0]) return { kind: 'exec', key: `exec:${p.join(' ')}`, tool: cmd === 'npx' ? 'npm' : cmd === 'bunx' ? 'bun' : 'pnpm', argv };
  }
  if (cmd === 'corepack') return { kind: 'other', key: `corepack:${pos.join(' ')}`, tool: 'corepack', argv };
  if (cmd === 'composer' || cmd === 'composer.phar' || (cmd === 'php' && /composer(\.phar)?$/.test(pos[0] ?? ''))) {
    const p = cmd === 'php' ? pos.slice(1) : pos;
    if (!p[0] || p[0] === 'install' || p[0] === 'i') return { kind: 'install', key: 'install:composer', tool: 'composer', argv };
    if ((p[0] === 'run' || p[0] === 'run-script') && p[1]) return { kind: 'script', key: `composer-script:${p[1]}`, tool: 'composer', argv };
    return { kind: 'other', key: `composer:${p[0]}`, tool: 'composer', argv };
  }
  if (cmd === 'php' && (pos[0] === 'artisan' || pos[0] === './artisan')) {
    return { kind: 'artisan', key: `artisan:${pos[1] ?? 'list'}`, tool: 'php', argv };
  }
  if (cmd === 'artisan') return { kind: 'artisan', key: `artisan:${pos[0] ?? 'list'}`, tool: 'php', argv };
  if (['cp', 'copy', 'Copy-Item', 'copy-item', 'xcopy'].includes(cmd) && pos.length >= 2) {
    const [from, to] = pos.slice(-2);
    return { kind: 'copy', key: `copy:${norm(from)}>${norm(to)}`, argv };
  }
  if ((cmd === 'docker' && pos[0] === 'compose' && pos.includes('up')) || (cmd === 'docker-compose' && pos.includes('up'))) {
    return { kind: 'compose-up', key: 'compose-up', tool: 'docker', argv };
  }
  if (cmd === 'sail' || /vendor\/bin\/sail$/.test(cmd)) return { kind: 'other', key: `sail:${pos[0] ?? ''}`, tool: 'sail', argv };
  if (cmd === 'make' || cmd === 'just' || cmd === 'task') return { kind: 'task', key: `${cmd}:${pos[0] ?? 'default'}`, tool: cmd, argv };
  if (cmd === 'git' && pos[0] === 'submodule') return { kind: 'submodule', key: 'submodule', tool: 'git', argv };
  if (['prisma', 'drizzle-kit', 'next', 'vite', 'nuxt', 'astro'].includes(cmd)) return { kind: 'exec', key: `exec:${[cmd, ...pos].join(' ')}`, argv };
  if (cmd === 'pip' || cmd === 'pip3' || (/^python[0-9.]*$/.test(cmd) && pos[0] === '-m' && pos[1] === 'pip')) {
    return { kind: 'install', key: 'install:pip', tool: 'pip', argv };
  }
  if ((cmd === 'poetry' || cmd === 'pipenv' || cmd === 'pdm') && pos[0] === 'install') return { kind: 'install', key: `install:${cmd}`, tool: cmd, argv };
  if (cmd === 'uv' && pos[0] === 'sync') return { kind: 'install', key: 'install:uv', tool: 'uv', argv };
  if (cmd === 'bundle' && (!pos[0] || pos[0] === 'install')) return { kind: 'install', key: 'install:bundler', tool: 'bundler', argv };
  if (cmd === 'go' && pos[0] === 'mod' && pos[1] === 'download') return { kind: 'install', key: 'install:go', tool: 'go', argv };
  return { kind: 'other', key: `other:${cmd}`, tool: cmd, argv };
}

function norm(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/');
}

/** Classify every simple command in a shell line or script body. */
export function classifyLine(line: string): CommandSig[] {
  // PowerShell's `Copy-Item -Path a -Destination b` and cmd's `copy a b` are handled by the word splitter well enough.
  return splitShell(line)
    .map((c) => classifyArgv(c.argv))
    .filter((c): c is CommandSig => c !== null);
}

// ---- Commands the plan emits --------------------------------------------------------------------------------

export function nodeInstallArgv(pm: NodePM, opts: { hasLockfile: boolean; yarnBerry?: boolean; skipUnapprovedBuilds?: boolean }): string[] {
  switch (pm) {
    case 'npm':
      return opts.hasLockfile ? ['npm', 'ci'] : ['npm', 'install'];
    case 'pnpm': {
      const base = opts.hasLockfile ? ['pnpm', 'install', '--frozen-lockfile'] : ['pnpm', 'install'];
      // pnpm 11+ stops when dependencies have build scripts nobody approved; this skips them instead (pnpm 10's default).
      return opts.skipUnapprovedBuilds ? [...base, '--config.strict-dep-builds=false'] : base;
    }
    case 'yarn':
      if (!opts.hasLockfile) return ['yarn', 'install'];
      return opts.yarnBerry ? ['yarn', 'install', '--immutable'] : ['yarn', 'install', '--frozen-lockfile'];
    case 'bun':
      return opts.hasLockfile ? ['bun', 'install', '--frozen-lockfile'] : ['bun', 'install'];
  }
}

export function nodeRunArgv(pm: NodePM, script: string): string[] {
  return pm === 'yarn' ? ['yarn', 'run', script] : [pm, 'run', script];
}

export function nodeExecArgv(pm: NodePM, bin: string, args: string[]): string[] {
  switch (pm) {
    // After the install step the binary is local, so npx / bunx run it without downloading.
    case 'npm':
      return ['npx', bin, ...args];
    case 'pnpm':
      return ['pnpm', 'exec', bin, ...args];
    case 'yarn':
      return ['yarn', bin, ...args];
    case 'bun':
      return ['bunx', bin, ...args];
  }
}
