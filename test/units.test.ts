import { describe, expect, it } from 'vitest';
import { composerRange, intersectRanges, parsePin, pep440Range, rangeText, majorOf, pickHighest } from '../src/core/versions.js';
import { parseEnvTemplate, safeValue, looksSecret, redactCommand } from '../src/core/parse/envfile.js';
import { isSecretFile, normalizeText, decodeBytes } from '../src/core/fs.js';
import { classifyLine, nodeInstallArgv } from '../src/core/commands.js';
import { splitShell } from '../src/core/text.js';
import { parseMakefile, parseMarkdownBlocks, parseDockerfile, parseJustfile } from '../src/core/parse/textformats.js';
import { composeHostPort } from '../src/core/providers/containers.js';
import { matchServer, serviceForImage } from '../src/core/kb.js';
import { quotePosix, quotePowerShell, renderAction } from '../src/render/shell.js';
import { globToRegExp } from '../src/core/scan.js';
import { parseYamlDoc, parseJsonDoc } from '../src/core/parse/structured.js';

describe('versions', () => {
  it.each([
    ['^8.2', '>=8.2.0 <9.0.0-0'],
    ['~8.2', '>=8.2.0 <9.0.0-0'], // Composer: ~8.2 means >=8.2 <9 (npm would say <8.3)
    ['~8.2.1', '>=8.2.1 <8.3.0-0'],
    ['>=8.1 <8.4', '>=8.1.0 <8.4.0'],
    ['^8.1|^8.2', '>=8.1.0 <9.0.0-0||>=8.2.0 <9.0.0-0'],
    ['8.2.*', '>=8.2.0 <8.3.0-0'],
    ['>=7.4,<8.0', '>=7.4.0 <8.0.0'],
    ['^8.2@stable', '>=8.2.0 <9.0.0-0'],
    ['^0', '<1.0.0-0'], // not <0.0.1: found on monicahq/monica (tomasvotruba/bladestan "^0")
    ['^0.3', '>=0.3.0 <0.4.0-0'],
  ])('composer %s', (c, r) => expect(composerRange(c)).toBe(r));
  it.each([
    ['>=3.10', '>=3.10.0'],
    ['>=3.9,<3.13', '>=3.9.0 <3.13.0'],
    ['~=3.11', '>=3.11.0 <4.0.0-0'],
    ['^3.10', '>=3.10.0 <4.0.0-0'],
    ['==3.12.*', '>=3.12.0 <3.13.0-0'],
  ])('pep440 %s', (c, r) => expect(pep440Range(c)).toBe(r));
  it('reads pins and LTS codenames', () => {
    expect(parsePin('v20.11.1')).toMatchObject({ range: '20.11.1', pinned: true });
    expect(parsePin('20')).toMatchObject({ range: '>=20.0.0 <21.0.0-0' });
    expect(parsePin('lts/iron')).toMatchObject({ range: '>=20.0.0 <21.0.0-0', display: '20 (lts/iron)' });
    expect(parsePin('lts/*')).toMatchObject({ range: null });
    expect(parsePin('8.3-fpm-alpine')).toMatchObject({ display: '8.3' });
  });
  it('intersects ranges and says when they cannot all hold', () => {
    expect(intersectRanges(['>=18', '>=20.9.0'])).toBe('>=20.9.0');
    expect(intersectRanges(['^18.18.0 || ^19.8.0 || >=20.0.0', '>=20'])).toBe('>=20.0.0');
    expect(intersectRanges(['<18', '>=20'])).toBeNull();
    expect(intersectRanges([])).toBe('*');
  });
  it('writes ranges for people', () => {
    expect(rangeText('>=20.0.0 <21.0.0-0')).toBe('20.x');
    expect(rangeText('>=8.2.0 <9.0.0-0')).toBe('^8.2');
    expect(rangeText('>=20.9.0')).toBe('>= 20.9');
    expect(majorOf('^11.31', 'composer')).toBe(11);
    expect(pickHighest(['18.x', '20.x', '22.x'], '>=18')).toBe('22.x');
  });
});

describe('env templates and secrets', () => {
  const vars = parseEnvTemplate('APP_KEY=\n# DB_DATABASE=laravel\nDB_CONNECTION=mysql\nexport TOKEN="your-token-here"\nNAME="My App" # comment\n# Set FOO=bar to enable things\n');
  it('classifies values without keeping them in the plan', () => {
    expect(vars.map((v) => [v.name, v.commented, v.valueKind])).toEqual([
      ['APP_KEY', false, 'empty'], ['DB_DATABASE', true, 'value'], ['DB_CONNECTION', false, 'value'], ['TOKEN', false, 'placeholder'], ['NAME', false, 'value'],
    ]);
  });
  it('only lets driver names, hosts, ports and credential-free URLs through', () => {
    expect(safeValue('DB_CONNECTION', 'mysql')).toBe('mysql');
    expect(safeValue('DB_PASSWORD', 'hunter2')).toBeUndefined();
    expect(safeValue('DATABASE_URL', 'postgres://u:p@localhost:5432/db')).toBe('postgres://localhost:5432');
    expect(safeValue('APP_NAME', 'Secret Project')).toBeUndefined();
    expect(looksSecret('NEXT_PUBLIC_STRIPE_KEY')).toBe(false);
    expect(looksSecret('STRIPE_SECRET_KEY')).toBe(true);
  });
  it('treats real env files and keys as secret, templates as readable', () => {
    for (const f of ['.env', 'api/.env.local', '.env.production', 'id_ed25519', 'auth.json', 'certs/server.key', 'prod.env']) expect(isSecretFile(f), f).toBe(true);
    for (const f of ['.env.example', '.env.sample', 'api/.env.dist', 'example.env', '.env.local.example', 'composer.json']) expect(isSecretFile(f), f).toBe(false);
  });
  it('redacts secrets from quoted commands', () => {
    expect(redactCommand('PGPASSWORD=s3cr3t psql -U app')).toBe('PGPASSWORD=… psql -U app');
    expect(redactCommand('NODE_ENV=production PORT=3000 node server.js')).toBe('NODE_ENV=production PORT=3000 node server.js');
    expect(redactCommand('mysql -uroot -psecret app')).toBe('mysql -uroot -p… app');
    expect(redactCommand('git clone https://me:tok@github.com/a/b')).toBe('git clone https://me:…@github.com/a/b');
  });
  it('normalizes BOMs, CRLF and UTF-16', () => {
    expect(normalizeText('\uFEFFa\r\nb\rc')).toBe('a\nb\nc');
    expect(decodeBytes(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe('a');
    expect(decodeBytes(Buffer.from([0x00, 0x01]))).toBeNull();
  });
});

describe('command grammar', () => {
  it('classifies install, script, copy and artisan commands from text', () => {
    expect(classifyLine('npm i && npm run dev').map((c) => c.key)).toEqual(['install:npm', 'script:dev']);
    expect(classifyLine('pnpm install --frozen-lockfile').map((c) => c.key)).toEqual(['install:pnpm']);
    expect(classifyLine('yarn').map((c) => c.key)).toEqual(['install:yarn']);
    expect(classifyLine('cp .env.example .env').map((c) => c.key)).toEqual(['copy:.env.example>.env']);
    expect(classifyLine('php artisan migrate --seed').map((c) => c.key)).toEqual(['artisan:migrate']);
    expect(classifyLine('npm install lodash').map((c) => c.key)).toEqual(['npm:install']);
    expect(classifyLine('docker compose up -d').map((c) => c.key)).toEqual(['compose-up']);
  });
  it('splits shell text without running it', () => {
    expect(splitShell(`PORT=4000 next dev -p "3 1" && echo 'a;b' # c`)).toEqual([
      { assignments: { PORT: '4000' }, argv: ['next', 'dev', '-p', '3 1'] },
      { assignments: {}, argv: ['echo', 'a;b'] },
    ]);
  });
  it('builds lockfile-respecting install commands', () => {
    expect(nodeInstallArgv('npm', { hasLockfile: true })).toEqual(['npm', 'ci']);
    expect(nodeInstallArgv('yarn', { hasLockfile: true, yarnBerry: true })).toEqual(['yarn', 'install', '--immutable']);
    expect(nodeInstallArgv('pnpm', { hasLockfile: false })).toEqual(['pnpm', 'install']);
  });
  it('recognises dev servers and their ports', () => {
    expect(matchServer(['next', 'dev', '-p', '4000'])).toMatchObject({ port: 4000, portSource: 'flag', kind: 'dev' });
    expect(matchServer(['vite', '--port', '8080'])).toMatchObject({ port: 8080, kind: 'dev' });
    expect(matchServer(['next', 'start'])).toMatchObject({ kind: 'production', needsBuild: true });
    expect(matchServer(['php', 'artisan', 'serve', '--port=8001'])).toMatchObject({ port: 8001 });
    expect(matchServer(['cross-env', 'NODE_ENV=development', 'nuxt', 'dev'])).toMatchObject({ port: 3000 });
    expect(matchServer(['node', 'server.js'])).toBeNull();
  });
  it('recognises service images', () => {
    expect(serviceForImage('mysql/mysql-server:8.0')).toMatchObject({ def: { name: 'mysql' }, version: '8.0' });
    expect(serviceForImage('docker.io/library/postgres:16-alpine')).toMatchObject({ def: { name: 'postgres' }, version: '16' });
    expect(serviceForImage('valkey/valkey')).toMatchObject({ def: { name: 'redis' } });
    expect(serviceForImage('my-app:latest')).toBeNull();
  });
  it('reads Compose port mappings', () => {
    expect(composeHostPort('${FORWARD_DB_PORT:-3306}:3306')).toBe(3306);
    expect(composeHostPort('127.0.0.1:5433:5432')).toBe(5433);
    expect(composeHostPort('5432')).toBeNull();
    expect(composeHostPort({ published: 8080, target: 80 })).toBe(8080);
  });
});

describe('parsers', () => {
  it('Makefile and justfile', () => {
    expect(parseMakefile('.PHONY: a\nVAR := 1\nsetup install: deps\n\t@npm ci\n\t-echo hi\n%.o: %.c\n\tcc\n')).toEqual([
      { name: 'setup', line: 3, commands: ['npm ci', 'echo hi'] }, { name: 'install', line: 3, commands: ['npm ci', 'echo hi'] },
    ]);
    expect(parseJustfile('set dotenv-load\ndev port="3000":\n    npm run dev -- --port {{port}}\n')).toEqual([{ name: 'dev', line: 2, commands: ['npm run dev -- --port {{port}}'] }]);
  });
  it('Markdown code blocks with their headings', () => {
    const b = parseMarkdownBlocks('# App\n## Setup\n```bash\nnpm ci\n```\nDeploy\n------\n~~~\nfly deploy\n~~~\n');
    expect(b.map((x) => [x.lang, x.heading, x.line, x.lines])).toEqual([['bash', 'Setup', 4, ['npm ci']], ['', 'Deploy', 9, ['fly deploy']]]);
  });
  it('Dockerfile continuation lines', () => {
    expect(parseDockerfile('FROM php:8.3-fpm AS base\nRUN docker-php-ext-install \\\n    pdo_mysql \\\n    zip\nEXPOSE 9000\n')).toEqual([
      { op: 'FROM', args: 'php:8.3-fpm AS base', line: 1 }, { op: 'RUN', args: 'docker-php-ext-install      pdo_mysql      zip', line: 2 }, { op: 'EXPOSE', args: '9000', line: 5 },
    ]);
  });
  it('JSON and YAML keep lines', () => {
    const j = parseJsonDoc('p.json', '{\n  // c\n  "engines": {\n    "node": ">=20",\n  }\n}')!;
    expect([j.get(['engines', 'node']), j.line(['engines', 'node'])]).toEqual(['>=20', 4]);
    const y = parseYamlDoc('c.yml', 'jobs:\n  t:\n    steps:\n      - uses: a\n      - run: npm ci\n')!;
    expect(y.line(['jobs', 't', 'steps', 1, 'run'])).toBe(5);
  });
  it('workspace globs', () => {
    expect(globToRegExp('apps/*').test('apps/web')).toBe(true);
    expect(globToRegExp('apps/*').test('apps/web/x')).toBe(false);
    expect(globToRegExp('packages/**').test('packages/a/b')).toBe(true);
  });
});

describe('shell rendering', () => {
  it('quotes for POSIX and PowerShell', () => {
    expect(quotePosix("it's")).toBe(`'it'\\''s'`);
    expect(quotePowerShell("it's")).toBe(`'it''s'`);
    expect(quotePosix('a b')).toBe(`'a b'`);
    expect(quotePowerShell('C:\\x\\y.exe')).toBe('C:\\x\\y.exe');
  });
  it('renders file actions per shell, never overwriting', () => {
    const copy = { type: 'copy', from: '.env.example', to: '.env' } as const;
    expect(renderAction(copy, 'posix')).toBe('[ -e .env ] || cp .env.example .env');
    expect(renderAction(copy, 'powershell')).toBe('if (-not (Test-Path .env)) { Copy-Item .env.example .env }');
    const venv = { type: 'exec', argv: ['.venv/bin/python', '-m', 'pip'], windowsArgv: ['.venv\\Scripts\\python.exe', '-m', 'pip'] } as const;
    expect(renderAction(venv, 'posix')).toBe('.venv/bin/python -m pip');
    expect(renderAction(venv, 'powershell')).toBe('& .\\.venv\\Scripts\\python.exe -m pip');
  });
});

import { loadData } from '../src/core/kb.js';
import { PROBES_FOR } from '../src/doctor/probes.js';
import { loadRecipes } from '../src/core/recipes.js';

describe('knowledge base coverage', () => {
  it('every tool the doctor can check has install advice', () => {
    const kb = loadData<{ tools: Record<string, unknown> }>('kb/install.json');
    for (const tool of Object.keys(PROBES_FOR)) expect(kb.tools[tool], `kb/install.json tools.${tool}`).toBeDefined();
  });
  it('every service the plan can name has a known image and port', () => {
    const kb = loadData<{ services: { name: string; port: number; images: string[] }[] }>('kb/services.json');
    for (const s of kb.services) expect(s.port > 0 && s.images.length > 0, s.name).toBe(true);
  });
  it('every PHP extension a recipe implies has a Debian package or is built in', () => {
    const kb = loadData<{ packages: { debian: { pkg: Record<string, string>; common: string[] } } }>('kb/php-extensions.json');
    for (const ext of ['pdo_mysql', 'pdo_pgsql', 'pdo_sqlite', 'redis', 'memcached', 'mbstring', 'xml', 'dom', 'curl', 'zip', 'gd', 'intl', 'bcmath', 'fileinfo', 'openssl', 'tokenizer', 'ctype']) {
      expect(kb.packages.debian.pkg[ext] ?? kb.packages.debian.common.includes(ext) ?? null, ext).toBeTruthy();
    }
  });
  it('recipes are valid data with review dates', () => {
    for (const r of loadRecipes()) {
      expect(r.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const s of r.steps ?? []) expect(Boolean(s.exec) !== Boolean(s.touch), `${r.id}.${s.id} has exactly one action`).toBe(true);
    }
  });
});
