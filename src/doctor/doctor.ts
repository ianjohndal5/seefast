// doctor: compare the plan's requirements with this machine, offline, using only the fixed probes in probes.ts,
// a port bind check on 127.0.0.1 and stat() of env files. Reads the plan; never re-analyzes the project.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { Plan, Requirement } from '../core/schema.js';
import { loadData } from '../core/kb.js';
import { satisfies } from '../core/versions.js';
import { label, requirementLine, colors } from '../render/text.js';
import type { ShellKind } from '../render/shell.js';
import { LOOKUPS, PROBES_FOR, osFamily, parsePhpModules, readOsRelease, realHost, runProbes, which, type ProbeHost, type ProbeResult } from './probes.js';

export type CheckStatus = 'ok' | 'missing' | 'wrong-version' | 'unknown' | 'warning' | 'info';

export interface Check {
  id: string;
  kind: 'requirement' | 'service' | 'port' | 'env' | 'machine';
  title: string;
  status: CheckStatus;
  required: boolean;
  found?: string;
  expected?: string;
  message: string;
  advice: string[];
}

export interface DoctorReport {
  machine: { platform: string; arch: string; family: string; distro?: string; release?: string };
  checks: Check[];
  summary: { ok: number; missingRequired: number; missingOptional: number; unknown: number; warnings: number };
  /** Every command that was run, exactly. */
  probes: { id: string; command: string; ran: boolean; ok: boolean; ms: number }[];
  knowledgeBase: string;
}

export interface DoctorDeps {
  host?: ProbeHost;
  osRelease?: string | null;
  arch?: string;
  /** Whether something listens on 127.0.0.1:port. Injected in tests. */
  portInUse?: (port: number) => Promise<boolean>;
  /** Project root on disk, to check whether env files exist (stat only). */
  root?: string;
}

interface InstallKb {
  reviewed: string;
  families: Record<string, string[]>;
  versionManagers: Record<string, { probe?: string; env?: string; advice: string }[]>;
  tools: Record<string, Record<string, string[]>>;
  services: Record<string, Record<string, string[] | string>>;
}
interface ExtKb {
  reviewed: string;
  builtin: string[];
  unavailable: Record<string, string[]>;
  packages: Record<string, Record<string, unknown>>;
}

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

/** `{full}` the recommended version as given (20.18.0), `{v}` major.minor (8.3), `{major}` (20), `{nodot}` (83). */
function fill(s: string, version?: string): string {
  const v = version?.replace(/\s*\(.*\)$/, '').replace(/\.x$/, '');
  const major = v?.split('.')[0] ?? '';
  const mm = v ? v.split('.').slice(0, 2).join('.') : '';
  return s.replace(/\{full\}/g, v || 'lts').replace(/\{v\}/g, mm || major || '').replace(/\{major\}/g, major).replace(/\{nodot\}/g, mm.replace('.', ''));
}

/** Install advice for a tool on this OS family, preferring version managers the machine already has. */
export function toolAdvice(tool: string, family: string, version: string | undefined, present: Set<string>, env: NodeJS.ProcessEnv): string[] {
  const kb = loadData<InstallKb>('kb/install.json');
  const out: string[] = [];
  for (const vm of kb.versionManagers[tool] ?? []) {
    if ((vm.probe && present.has(vm.probe)) || (vm.env && env[vm.env])) {
      out.push(fill(vm.advice, version));
      break;
    }
  }
  const t = kb.tools[tool];
  if (t) {
    const lines = t[family] ?? (family !== 'macos' && family !== 'windows' ? t.linux : undefined) ?? t.any ?? [];
    for (const l of lines) out.push(fill(l, version));
    if (!lines.length && t.any) for (const l of t.any) out.push(fill(l, version));
  }
  return out;
}

/** Install advice for a PHP extension. */
export function extAdvice(ext: string, family: string, phpVersion: string | undefined, phpIni: string | undefined): string[] {
  const kb = loadData<ExtKb>('kb/php-extensions.json');
  const v = phpVersion ? phpVersion.split('.').slice(0, 2).join('.') : '8.3';
  const nodot = v.replace('.', '');
  const pk = kb.packages[family] as Record<string, unknown> | undefined;
  if (kb.unavailable[family]?.includes(ext)) {
    return [
      `${ext} does not exist for PHP on Windows; use WSL or Docker for this project,`,
      `or, if only a development tool needs it, install without that check: composer install --ignore-platform-req=ext-${ext}`,
    ];
  }
  if (!pk) return [`Install or enable the ${ext} extension for PHP ${v}.`];
  // The official Docker PHP images build PHP from source: distribution packages do not apply there.
  if (family !== 'windows' && phpIni?.startsWith('/usr/local/etc/php')) {
    const pecl = ['redis', 'imagick', 'xdebug', 'apcu', 'memcached', 'mongodb', 'igbinary', 'msgpack', 'pcov', 'amqp', 'yaml', 'swoole', 'protobuf', 'opentelemetry', 'grpc'];
    return pecl.includes(ext)
      ? [`pecl install ${ext} && docker-php-ext-enable ${ext}  (official Docker PHP image; ${ext} may need system libraries first)`]
      : [`docker-php-ext-install ${ext}  (official Docker PHP image; some extensions need -dev system libraries first)`];
  }
  const pkg = (pk.pkg as Record<string, string> | undefined)?.[ext];
  const sub = (s: string) => s.replace(/\{v\}/g, v).replace(/\{nodot\}/g, nodot).replace(/\{ext\}/g, ext);
  switch (family) {
    case 'debian': {
      if ((pk.common as string[]).includes(ext)) return [`${ext} is part of php${v}-common: sudo apt install php${v}-common`];
      return pkg ? [`sudo apt install ${sub(pk.pattern as string).replace('{pkg}', pkg)}`, sub(pk.note as string).replace('{pkg}', pkg)] : [`No Debian package for ${ext} is known to this tool; try: pecl install ${ext}`];
    }
    case 'fedora':
      if ((pk.common as string[]).includes(ext)) return [`${ext} is part of php-common: sudo dnf install php-common`];
      return pkg ? [`sudo dnf install php-${pkg}`, sub(pk.check as string)] : [`No Fedora package for ${ext} is known to this tool; try: pecl install ${ext}`];
    case 'arch':
      if ((pk.inPhpPackage as string[]).includes(ext)) return [`Enable it: uncomment "extension=${ext}" in ${phpIni ?? '/etc/php/php.ini'}`];
      return pkg ? [`sudo pacman -S php-${pkg}`, `then enable "extension=${ext}" in ${phpIni ?? '/etc/php/php.ini'} (or the file the package adds in /etc/php/conf.d)`] : [`Enable or install ${ext} (see the Arch wiki page for PHP)`];
    case 'alpine':
      return [`sudo apk add php${nodot}-${pkg ?? ext}`];
    case 'macos':
      return (pk.pecl as string[]).includes(ext) ? [`pecl install ${ext}`, `then add "extension=${ext}" to ${phpIni ?? 'the php.ini from `php --ini`'}`] : [`Homebrew's php includes ${ext}; check that \`php\` is Homebrew's (brew install php@${v})`];
    case 'windows':
      if ((pk.bundled as string[]).includes(ext)) return [`Enable it in ${phpIni ?? 'php.ini (path from `php --ini`)'}: uncomment or add "extension=${ext}"`];
      if ((pk.builtinOnWindows as string[]).includes(ext)) return [`${ext} is built into the official Windows builds; your PHP may be a custom build.`];
      return [sub(pk.download as string)];
    default:
      return [`Install or enable the ${ext} extension for PHP ${v} with your distribution's packages.`];
  }
}

function serviceAdvice(name: string, family: string): string[] {
  const kb = loadData<InstallKb>('kb/install.json');
  const s = kb.services[name];
  if (!s) return [`Install ${label(name)}, or run it in Docker.`];
  const lines = (s[family] ?? s.any ?? []) as string[];
  return [...lines, ...(s.docker ? [`or with Docker: ${s.docker as string}`] : [])];
}

export async function runDoctor(plan: Plan, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const host = deps.host ?? realHost;
  const kb = loadData<InstallKb>('kb/install.json');
  const fam = osFamily(host.platform, deps.osRelease !== undefined ? deps.osRelease : host.platform === 'linux' ? readOsRelease() : null, kb.families);
  const checkPort = deps.portInUse ?? portInUse;
  const present = new Set(LOOKUPS.filter((b) => which(b, host)));

  const needed = new Set<string>();
  for (const r of plan.requirements) {
    if (r.kind === 'extension') needed.add('php-modules').add('php').add('php-ini');
    else for (const id of PROBES_FOR[r.name] ?? []) needed.add(id);
  }
  if (plan.services.some((s) => s.provider && !s.optional)) for (const id of PROBES_FOR.docker) needed.add(id);
  if (host.platform === 'win32' && plan.requirements.some((r) => r.name === 'node')) needed.add('powershell-policy');
  const probes = await runProbes([...needed], host);

  const checks: Check[] = [];
  const probe = (id: string): ProbeResult | undefined => probes.get(id);
  const phpVersion = probe('php')?.version;
  const iniOut = probe('php-ini')?.output ?? '';
  const loaded = /Loaded Configuration File:\s*(.+)/.exec(iniOut)?.[1]?.trim().replace(/^"|"$/g, '');
  const iniDir = /Configuration File \(php\.ini\) Path:\s*(.+)/.exec(iniOut)?.[1]?.trim().replace(/^"|"$/g, '');
  // No php.ini loaded (the official Docker image): name the folder where one would go.
  const phpIni = loaded && loaded !== '(none)' ? loaded : iniDir ? `${iniDir}/php.ini` : undefined;

  for (const r of plan.requirements) {
    checks.push(r.kind === 'extension' ? checkExtension(r, probe('php'), probe('php-modules'), fam.family, phpVersion, phpIni) : checkTool(r, probes, fam.family, present, host));
  }
  // Windows: npm.ps1 blocked by the default execution policy.
  const policy = probe('powershell-policy');
  if (policy?.ok && /Restricted|AllSigned/i.test(policy.output)) {
    checks.push({
      id: 'machine:powershell-policy', kind: 'machine', title: 'PowerShell script execution', status: 'warning', required: false, found: policy.output.trim(),
      message: 'PowerShell blocks scripts, so typing npm, npx or pnpm in PowerShell may fail with "running scripts is disabled on this system" (they are .ps1 shims).',
      advice: ['Set-ExecutionPolicy -Scope CurrentUser RemoteSigned', 'or call npm.cmd / npx.cmd, or use Command Prompt'],
    });
  }
  // Services
  const daemon = probe('docker-daemon');
  for (const s of plan.services) {
    const port = s.ports[0];
    const busy = port ? await checkPort(port) : false;
    if (s.provider) {
      const dockerOk = probe('docker')?.ok && probe('docker-compose')?.ok;
      const daemonOk = daemon?.ok;
      checks.push({
        id: s.id, kind: 'service', title: `${label(s.name)} (Compose service "${s.provider.service}")`, required: !s.optional,
        status: busy ? 'ok' : !dockerOk ? (s.optional ? 'info' : 'missing') : !daemonOk ? 'warning' : 'info',
        found: busy ? `something listens on port ${port}` : undefined,
        message: busy
          ? `Port ${port} is in use: either ${label(s.name)} is already running (fine), or another program holds the port and Compose cannot publish it.`
          : !dockerOk
            ? `Docker with Compose is needed to start it as the plan does${s.optional ? ' (optional)' : ''}, or install ${label(s.name)} directly.`
            : !daemonOk
              ? 'Docker is installed but the daemon is not reachable; start Docker before the services step.'
              : `Not running yet; the setup step starts it.`,
        advice: !dockerOk ? [...toolAdvice('docker', fam.family, undefined, present, host.env), ...serviceAdvice(s.name, fam.family).slice(0, 2)] : !daemonOk && !busy ? [fam.family === 'macos' || fam.family === 'windows' ? 'Start Docker Desktop.' : 'sudo systemctl start docker'] : [],
      });
    } else {
      checks.push({
        id: s.id, kind: 'service', title: label(s.name), required: !s.optional,
        status: busy ? 'ok' : s.optional ? 'info' : 'missing',
        found: busy ? `something listens on port ${port}` : undefined,
        message: busy ? `Something listens on port ${port}, probably ${label(s.name)}.` : `Nothing listens on port ${port ?? '?'}; the app needs a ${label(s.name)} server${s.optional ? ' for some features' : ''}.`,
        advice: busy ? [] : serviceAdvice(s.name, fam.family),
      });
    }
  }
  // Ports the dev servers want
  const seen = new Set<number>();
  for (const r of plan.run.filter((x) => x.primary && x.kind === 'dev')) {
    for (const p of r.ports) {
      if (seen.has(p.port) || plan.services.some((s) => s.ports.includes(p.port))) continue;
      seen.add(p.port);
      if (await checkPort(p.port)) {
        checks.push({
          id: `port:${p.port}`, kind: 'port', title: `Port ${p.port} (${r.id})`, status: 'warning', required: false,
          message: `Port ${p.port} is already in use; ${r.id} will fail to start or pick another port. Stop the other program, or change the port.`, advice: [],
        });
      }
    }
  }
  // Env files (stat only)
  if (deps.root) {
    for (const e of plan.env) {
      const exists = fs.existsSync(path.join(deps.root, ...e.file.split('/')));
      const toFill = e.vars.filter((v) => v.fill === 'user').map((v) => v.name);
      checks.push({
        id: `env:${e.file}`, kind: 'env', title: e.file, required: false, status: exists ? 'ok' : 'info',
        message: exists
          ? `Exists (not read).${toFill.length ? ` Make sure it sets ${toFill.join(', ')}.` : ''}`
          : `Does not exist yet; ${e.createdBy ? `step ${e.createdBy} creates it` : 'create it'}${toFill.length ? `, then fill in ${toFill.join(', ')}` : ''}.`,
        advice: [],
      });
    }
  }
  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    missingRequired: checks.filter((c) => c.required && (c.status === 'missing' || c.status === 'wrong-version')).length,
    missingOptional: checks.filter((c) => !c.required && (c.status === 'missing' || c.status === 'wrong-version')).length,
    unknown: checks.filter((c) => c.status === 'unknown').length,
    warnings: checks.filter((c) => c.status === 'warning').length,
  };
  return {
    machine: { platform: host.platform, arch: deps.arch ?? process.arch, ...fam },
    checks,
    summary,
    probes: [...probes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => ({ id: p.id, command: p.command, ran: p.found, ok: p.ok, ms: p.ms })),
    knowledgeBase: kb.reviewed,
  };
}

function checkTool(r: Requirement, probes: Map<string, ProbeResult>, family: string, present: Set<string>, host: ProbeHost): Check {
  const ids = PROBES_FOR[r.name] ?? [];
  const res = ids.map((id) => probes.get(id)).find((p) => p?.found && p.ok) ?? ids.map((id) => probes.get(id)).find((p) => p?.found);
  const title = requirementLine(r);
  const advice = (v?: string) => toolAdvice(r.name, family, v ?? r.recommended?.replace(/\s.*$/, ''), present, host.env);
  const base = { id: r.id, kind: 'requirement' as const, title, required: !r.optional, expected: r.rangeText ?? r.recommended };
  if (!ids.length) return { ...base, status: 'unknown', message: `This tool has no probe for ${r.name}; check it yourself.`, advice: advice() };
  if (!res) return { ...base, status: 'missing', message: `${label(r.name)} is not on PATH.${r.optional ? ' (optional)' : ''}`, advice: advice() };
  if (!res.ok) {
    const corepack = (r.name === 'pnpm' || r.name === 'yarn') && /corepack|COREPACK|download/i.test(res.output + (res.error ?? ''));
    return {
      ...base, status: 'unknown', found: res.path,
      message: corepack ? `${label(r.name)} is a Corepack shim that has not downloaded ${label(r.name)} yet (the doctor never downloads). Run it once with network access.` : `\`${res.command}\` failed: ${(res.error ?? res.output).split('\n')[0].slice(0, 160)}`,
      advice: [],
    };
  }
  if (!res.version) return { ...base, status: 'ok', found: res.path, message: `${label(r.name)} found at ${res.path}.`, advice: [] };
  if (r.range && !satisfies(res.version, r.range)) {
    return { ...base, status: 'wrong-version', found: res.version, message: `Found ${label(r.name)} ${res.version}, but the project needs ${r.rangeText}.`, advice: advice() };
  }
  const recMajor = r.recommended?.split(/[.\s]/)[0];
  const off = recMajor && /^\d+$/.test(recMajor) && res.version.split('.')[0] !== recMajor;
  return {
    ...base, status: 'ok', found: res.version,
    message: `${label(r.name)} ${res.version}${r.rangeText && r.rangeText !== 'any' ? ` satisfies ${r.rangeText}` : ''}.${off ? ` The maintainers use ${r.recommended}; differences are possible.` : ''}`,
    advice: [],
  };
}

function checkExtension(r: Requirement, php: ProbeResult | undefined, mods: ProbeResult | undefined, family: string, phpVersion: string | undefined, phpIni: string | undefined): Check {
  const base = { id: r.id, kind: 'requirement' as const, title: `PHP extension ${r.name}`, required: !r.optional };
  if (!php?.found) return { ...base, status: 'unknown', message: 'PHP is not installed, so its extensions cannot be checked.', advice: [] };
  if (!mods?.ok) return { ...base, status: 'unknown', message: `\`php -m\` failed: ${(mods?.error ?? '').slice(0, 120)}`, advice: [] };
  const set = parsePhpModules(mods.output);
  const name = r.name.toLowerCase();
  const has = set.has(name) || (name === 'pdo_sqlite' && set.has('pdo_sqlite')) || (name === 'mysqlnd' && set.has('mysqlnd'));
  if (has) return { ...base, status: 'ok', found: 'loaded', message: `${r.name} is loaded.`, advice: [] };
  return { ...base, status: 'missing', message: `${r.name} is not loaded in PHP ${phpVersion ?? ''}.${r.optional ? ' (optional)' : ''}`.trim(), advice: extAdvice(name, family, phpVersion, phpIni) };
}

export function renderDoctor(report: DoctorReport, plan: Plan, opts: { color: boolean; shell: ShellKind }): string {
  const c = colors(opts.color);
  const o: string[] = [];
  const icon = (s: CheckStatus, required: boolean) =>
    s === 'ok' ? c.green('✓') : s === 'missing' || s === 'wrong-version' ? (required ? c.red('✗') : c.yellow('–')) : s === 'warning' ? c.yellow('!') : s === 'unknown' ? c.yellow('?') : c.dim('·');
  const m = report.machine;
  o.push(`${c.bold('doctor')} · ${m.distro ?? m.family} (${m.platform}/${m.arch}) · checks for ${c.bold(plan.meta.rootName)}`);
  o.push('');
  const groups: [string, Check['kind'][]][] = [['Requirements', ['requirement']], ['Services', ['service']], ['Machine', ['machine', 'port']], ['Env files', ['env']]];
  for (const [title, kinds] of groups) {
    const cs = report.checks.filter((x) => kinds.includes(x.kind));
    if (!cs.length) continue;
    o.push(c.bold(title));
    for (const ch of cs) {
      const opt = !ch.required && (ch.kind === 'requirement' || ch.kind === 'service') ? c.dim(' (optional)') : '';
      o.push(`  ${icon(ch.status, ch.required)} ${ch.title}${opt}  ${c.dim(ch.message)}`);
      for (const a of ch.advice) o.push(`      ${c.cyan(a)}`);
    }
    o.push('');
  }
  const s = report.summary;
  o.push(s.missingRequired ? c.red(`${s.missingRequired} required item${s.missingRequired === 1 ? ' is' : 's are'} missing or the wrong version.`) : c.green('Everything required was found.') + (s.unknown ? c.yellow(` ${s.unknown} could not be checked.`) : ''));
  o.push(c.dim(`Commands run (fixed list, see docs/DOCTOR.md): ${report.probes.filter((p) => p.ran).map((p) => p.command).join(' · ') || 'none'}`));
  o.push(c.dim(`Advice from the bundled knowledge base, reviewed ${report.knowledgeBase}. Nothing was installed or downloaded.`));
  return o.join('\n') + '\n';
}
