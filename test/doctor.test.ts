// The doctor on simulated machines: which commands it runs, what it concludes, and the advice per OS.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { runDoctor, extAdvice, toolAdvice } from '../src/doctor/doctor.js';
import { which, osFamily, PROBES, type ProbeHost } from '../src/doctor/probes.js';
import { resolveCommand } from '../src/runner/exec.js';
import { analyzeFixture } from './helpers.js';

type Answers = Record<string, { out: string; code?: number }>;

/** A fake machine: files that exist, and the output of each probe command line. */
function host(platform: NodeJS.Platform, files: string[], answers: Answers, env: NodeJS.ProcessEnv = {}): ProbeHost & { ran: string[] } {
  const ran: string[] = [];
  return {
    platform,
    env: { PATH: platform === 'win32' ? 'C:\\tools;C:\\php' : '/usr/bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env },
    isFile: (p) => files.includes(p),
    ran,
    run: async (file, args) => {
      const key = [(platform === 'win32' ? path.win32 : path.posix).basename(file).replace(/\.(exe|cmd|bat)$/i, ''), ...args].join(' ');
      ran.push(key);
      const a = answers[key];
      return a ? { code: a.code ?? 0, stdout: a.out, stderr: '' } : { code: 1, stdout: '', stderr: 'not configured', error: 'failed' };
    },
  };
}

const plan = analyzeFixture('laravel-next-monorepo');
const noPorts = { portInUse: async () => false };

describe('doctor on Linux (Ubuntu)', () => {
  const files = ['/usr/bin/node', '/usr/bin/php', '/usr/bin/composer', '/usr/bin/npm'];
  const h = host('linux', files, {
    'node --version': { out: 'v18.19.1' },
    'npm --version': { out: '9.2.0' },
    'php --version': { out: 'PHP 8.3.6 (cli) (built: Apr 15 2024)' },
    'php -m': { out: '[PHP Modules]\nctype\ndom\nfileinfo\nfilter\nlibxml\nmbstring\nopenssl\nsession\ntokenizer\nxml\nxmlwriter\n\n[Zend Modules]\nZend OPcache\n' },
    'php --ini': { out: 'Loaded Configuration File:         /etc/php/8.3/cli/php.ini' },
    'composer --version --no-ansi --no-plugins --no-scripts --no-interaction': { out: 'Composer version 2.7.1 2024-02-09' },
  });
  const osRelease = 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n';
  it('reports the gaps with apt advice for the installed PHP version', async () => {
    const r = await runDoctor(plan, { host: h, osRelease, ...noPorts });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(r.machine).toMatchObject({ family: 'debian', distro: 'Ubuntu 24.04.1 LTS' });
    expect(by['runtime:node']).toMatchObject({ status: 'wrong-version', found: '18.19.1' });
    expect(by['runtime:php']).toMatchObject({ status: 'ok', found: '8.3.6' });
    expect(by['php-extension:pdo_mysql']).toMatchObject({ status: 'missing', advice: ['sudo apt install php8.3-mysql', expect.any(String)] });
    expect(by['php-extension:redis'].advice[0]).toBe('sudo apt install php8.3-redis');
    expect(by['package-manager:pnpm']).toMatchObject({ status: 'missing' });
    expect(by['package-manager:pnpm'].advice[0]).toMatch(/corepack enable pnpm/);
    expect(by['service:mysql']).toMatchObject({ status: 'missing' }); // no Docker on this machine
    expect(r.summary.missingRequired).toBeGreaterThanOrEqual(5);
  });
  it('runs only commands from the fixed list, and nothing for tools that are not installed', async () => {
    h.ran.length = 0;
    await runDoctor(plan, { host: h, osRelease, ...noPorts });
    const allowed = new Set(PROBES.map((p) => [p.bin, ...p.args].join(' ')));
    for (const cmd of h.ran) expect(allowed.has(cmd), cmd).toBe(true);
    expect(h.ran.some((c) => c.startsWith('pnpm') || c.startsWith('docker'))).toBe(false);
  });
  it('prefers a version manager that is already installed', () => {
    expect(toolAdvice('node', 'debian', '20.18.0', new Set(['fnm']), {})[0]).toBe('fnm install 20.18.0 && fnm use 20.18.0');
    expect(toolAdvice('node', 'debian', '20 (lts/iron)', new Set(), { NVM_DIR: '/home/u/.nvm' })[0]).toBe('nvm install 20 && nvm use 20');
  });
});

describe('doctor on Windows', () => {
  const files = ['C:\\tools\\node.exe', 'C:\\tools\\npm.cmd', 'C:\\php\\php.exe', 'C:\\tools\\composer.bat', 'C:\\tools\\powershell.exe'];
  const h = host('win32', files, {
    'node --version': { out: 'v20.18.0' },
    'npm --version': { out: '10.8.2' },
    'php --version': { out: 'PHP 8.3.12 (cli) (ZTS Visual C++ 2019 x64)' },
    'php -m': { out: '[PHP Modules]\nctype\ndom\nfilter\nlibxml\nopenssl\nsession\ntokenizer\nxml\nxmlwriter\n' },
    'php --ini': { out: 'Loaded Configuration File:         C:\\php\\php.ini' },
    'composer --version --no-ansi --no-plugins --no-scripts --no-interaction': { out: 'Composer version 2.8.1' },
    'powershell -NoProfile -NonInteractive -Command Get-ExecutionPolicy': { out: 'Restricted' },
  });
  it('finds .exe and .cmd tools through PATHEXT without running anything', () => {
    expect(which('npm', h)).toBe('C:\\tools\\npm.cmd');
    expect(which('php', h)).toBe('C:\\php\\php.exe');
    expect(which('pnpm', h)).toBeNull();
  });
  it('skips the Microsoft Store python alias', () => {
    const w = host('win32', ['C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'], {}, { PATH: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps' });
    expect(which('python', w)).toBeNull();
  });
  it('gives php.ini advice for bundled extensions and warns about the execution policy', async () => {
    const r = await runDoctor(plan, { host: h, osRelease: null, ...noPorts });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(r.machine.family).toBe('windows');
    expect(by['runtime:node']).toMatchObject({ status: 'ok' });
    expect(by['php-extension:mbstring'].advice).toEqual(['Enable it in C:\\php\\php.ini: uncomment or add "extension=mbstring"']);
    expect(by['php-extension:redis'].advice[0]).toMatch(/pecl\.php\.net/);
    expect(by['machine:powershell-policy']).toMatchObject({ status: 'warning' });
    expect(by['package-manager:pnpm'].status).toBe('missing');
  });
  it('explains extensions that do not exist on Windows', () => {
    expect(extAdvice('pcntl', 'windows', '8.3.12', undefined).join(' ')).toMatch(/--ignore-platform-req=ext-pcntl/);
  });
  it('runs .cmd shims through cmd.exe and refuses arguments cmd would reinterpret', () => {
    const r = resolveCommand(['npm', 'run', 'dev'], 'C:\\proj', 'C:\\proj', { ...h, env: { ...h.env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
    expect(r).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', '"C:\\tools\\npm.cmd run dev"'], windowsVerbatimArguments: true });
    expect(() => resolveCommand(['npm', 'run', 'a&calc'], 'C:\\proj', 'C:\\proj', h)).toThrow(/cmd\.exe/);
  });
});

describe('doctor in the official Docker PHP image', () => {
  it('gives docker-php-ext-install / pecl advice instead of distribution packages', () => {
    expect(extAdvice('ldap', 'debian', '8.4.27', '/usr/local/etc/php/php.ini')[0]).toMatch(/^docker-php-ext-install ldap/);
    expect(extAdvice('imagick', 'debian', '8.4.27', '/usr/local/etc/php/php.ini')[0]).toMatch(/^pecl install imagick && docker-php-ext-enable imagick/);
  });
});

describe('doctor on macOS', () => {
  it('gives Homebrew and PECL advice', () => {
    expect(toolAdvice('php', 'macos', '8.3', new Set(), {})[0]).toBe('brew install php@8.3  (or brew install php for the current release; brew link php@8.3 --force to make it the default)');
    expect(extAdvice('redis', 'macos', '8.3.1', '/opt/homebrew/etc/php/8.3/php.ini')[0]).toBe('pecl install redis');
    expect(extAdvice('intl', 'macos', '8.3.1', undefined)[0]).toMatch(/Homebrew's php includes intl/);
  });
});

describe('OS families', () => {
  const fams = { debian: ['debian', 'ubuntu'], fedora: ['fedora', 'rhel'], arch: ['arch'] };
  it('reads /etc/os-release ID and ID_LIKE', () => {
    expect(osFamily('linux', 'ID=pop\nID_LIKE="ubuntu debian"\n', fams).family).toBe('debian');
    expect(osFamily('linux', 'ID="rocky"\nID_LIKE="rhel centos fedora"\n', fams).family).toBe('fedora');
    expect(osFamily('linux', 'ID=nixos\n', fams).family).toBe('linux');
    expect(osFamily('darwin', null, fams).family).toBe('macos');
  });
});
