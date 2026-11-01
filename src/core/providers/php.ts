// PHP with Composer: composer.json (PHP version, extensions, scripts) and composer.lock (the extensions and PHP
// versions every locked package needs, which is what `composer check-platform-reqs` would check, done statically).
import semver from 'semver';
import type { Ctx } from '../context.js';
import { ev, withRole, stepId } from '../context.js';
import { joinRel, MAX_LOCKFILE_BYTES } from '../fs.js';
import { readDoc, asRecord, asString, asStringArray, parseJsonDoc } from '../parse/structured.js';
import { composerRange, satisfies } from '../versions.js';
import { redactCommand } from '../parse/envfile.js';

/** Extensions compiled into every PHP build; never worth reporting. */
const ALWAYS_PRESENT = new Set(['core', 'standard', 'spl', 'pcre', 'date', 'reflection', 'hash', 'random', 'json']);

export function collectPhp(ctx: Ctx): void {
  const { files } = ctx;
  for (const p of ctx.projects) {
    if (!p.ecosystems.has('php')) continue;
    const file = joinRel(p.root, 'composer.json');
    const doc = readDoc(files, file, 'json');
    if (!doc) {
      p.ecosystems.delete('php');
      ctx.unknown({ id: `unparsable:${file}`, subject: `project:${p.id}`, message: `${file} could not be parsed as JSON, so the PHP project there is not analyzed.` });
      continue;
    }
    const c = asRecord(doc.value);
    if (!p.name || p.name === p.root.split('/').pop()) p.name = asString(c.name)?.split('/').pop() ?? p.name ?? 'root';
    const require = Object.fromEntries(Object.entries(asRecord(c.require)).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    const requireDev = Object.fromEntries(Object.entries(asRecord(c['require-dev'])).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    const scripts: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(asRecord(c.scripts))) scripts[k] = asStringArray(v).map(redactCommand);
    const lockRel = joinRel(p.root, 'composer.lock');
    let lock = null;
    if (files.isFile(lockRel)) {
      const text = files.readText(lockRel, MAX_LOCKFILE_BYTES);
      lock = text ? parseJsonDoc(lockRel, text) : null;
      if (text && !lock) files.parseError(lockRel, 'could not parse as JSON');
    }
    p.php = { manifest: doc, require, requireDev, scripts, lock };
    if (p.role === 'unknown') p.role = files.isFile(joinRel(p.root, 'artisan')) || files.isFile(joinRel(p.root, 'public/index.php')) || files.isFile(joinRel(p.root, 'index.php')) ? 'app' : asString(c.type) === 'library' ? 'library' : 'app';

    for (const [section, deps] of [['require', require], ['require-dev', requireDev]] as const) {
      for (const [name, constraint] of Object.entries(deps)) {
        if (name === 'php' || name === 'php-64bit') {
          const range = composerRange(constraint);
          if (range) ctx.versionClaims.push({ tool: 'php', dir: p.root, role: 'constraint', range, display: constraint, source: 'manifest', evidence: ev(file, doc.line([section, name]), 'manifest', `${section}.php: "${constraint}"`) });
          else files.parseError(file, `${section}.php is not a constraint this tool understands: ${constraint}`);
        } else if (name.startsWith('ext-')) {
          const ext = name.slice(4).toLowerCase();
          if (!ALWAYS_PRESENT.has(ext)) ctx.extClaims.push({ ext, project: p.id, source: 'manifest', evidence: ev(file, doc.line([section, name]), 'manifest', `${section}.${name}: "${constraint}"`) });
        }
      }
    }
    const platformPhp = asString(asRecord(asRecord(c.config).platform).php);
    if (platformPhp) {
      const range = composerRange(platformPhp);
      if (range) ctx.versionClaims.push({ tool: 'php', dir: p.root, role: 'preference', range, display: platformPhp, source: 'manifest-explicit', evidence: ev(file, doc.line(['config', 'platform', 'php']), 'manifest-explicit', `config.platform.php: "${platformPhp}" (dependencies are resolved for this PHP version)`) });
    }

    if (lock) lockfileRequirements(ctx, p.id, lock);

    // Composer itself.
    const pluginApi = asString(asRecord(lock?.value)['plugin-api-version']);
    ctx.toolClaims.push({
      tool: 'composer', project: p.id, optional: false, why: `${file} declares the PHP dependencies.`, source: 'manifest',
      evidence: ev(file, undefined, 'manifest', pluginApi ? `composer.lock written by Composer with plugin API ${pluginApi}` : 'composer.json'),
    });
    if (pluginApi && semver.coerce(pluginApi)?.major === 2) {
      ctx.versionClaims.push({ tool: 'composer', dir: p.root, role: 'constraint', range: '>=2.0.0', display: '2', source: 'lockfile', evidence: ev(lockRel, lock!.line(['plugin-api-version']), 'lockfile', `plugin-api-version: "${pluginApi}" (Composer 2)`) });
    }

    // composer.lock that misses packages composer.json requires: `composer install` refuses it.
    // Stale when a required package is not locked, is locked at a version its constraint excludes, or is a
    // runtime requirement locked only as a dev package (the cases where `composer install` refuses the lock).
    const lockedIn = (k: string) => new Map((Array.isArray(asRecord(lock?.value)[k]) ? (asRecord(lock?.value)[k] as unknown[]) : []).map((x) => [asString(asRecord(x).name) ?? '', asString(asRecord(x).version) ?? ''] as const));
    const prod = lockedIn('packages');
    const dev = lockedIn('packages-dev');
    const staleOne = (name: string, constraint: string, isDev: boolean): boolean => {
      if (!name.includes('/')) return false;
      const version = prod.get(name) ?? (isDev ? dev.get(name) : undefined);
      if (version === undefined) return true;
      if (/^dev-|\.x-dev$/.test(version) || /dev|@|\*/.test(constraint)) return false;
      const range = composerRange(constraint);
      return Boolean(range) && !satisfies(version, range!);
    };
    const stale = lock
      ? [...Object.entries(require).filter(([n, c]) => staleOne(n, c, false)), ...Object.entries(requireDev).filter(([n, c]) => staleOne(n, c, true))].map(([n]) => n).sort()
      : [];
    if (stale.length) {
      ctx.conflict({
        id: `lock-stale:${p.id}`, subject: `lockfile@${p.id}`, chosen: 'composer update',
        alternatives: [{ value: 'composer update', evidence: [] }, { value: 'composer install', evidence: [withRole(ev(lockRel, undefined, 'lockfile', `${stale.slice(0, 3).join(', ')} not locked`), 'contradicts')] }],
        severity: 'warning', rule: 'a stale lockfile cannot be installed exactly',
        message: `composer.lock is out of date with composer.json (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ` and ${stale.length - 3} more` : ''} not locked as composer.json requires), so "composer install" would refuse it; using "composer update", which resolves current versions and rewrites composer.lock.`,
      });
    }
    // composer install
    const onInstall = ['pre-install-cmd', 'post-install-cmd', 'post-autoload-dump'].filter((k) => scripts[k]?.length);
    const notes = onInstall.map((k) => `Composer also runs the project's "${k}" script: ${scripts[k].join(' && ')}`);
    if (!lock) notes.push('There is no composer.lock, so dependency versions are resolved fresh and may differ from what the maintainers use.');
    ctx.addStep({
      local: 'composer-install', project: p.id, phase: 'install', order: 10,
      title: 'Install PHP dependencies (Composer)',
      cwd: p.root, action: { type: 'exec', argv: ['composer', stale.length ? 'update' : 'install'] },
      network: true, thirdPartyCode: true,
      requires: ['runtime:php', 'package-manager:composer'],
      confidence: stale.length ? 'medium' : 'high',
      why: `${file} declares the PHP dependencies${lock ? ' and composer.lock pins them' : ''}; composer install installs exactly the locked versions.`,
      notes,
      evidence: [withRole(ev(file, undefined, 'manifest', 'composer.json'), 'basis'), ...(lock ? [withRole(ev(lockRel, undefined, 'lockfile', 'composer.lock present'), 'basis')] : [])],
      sig: 'install:composer',
    });
    for (const [name, cmds] of Object.entries(scripts)) {
      if (/^(pre|post)-/.test(name)) continue;
      ctx.tasks.push({ runner: 'composer', name, project: p.id, file, line: doc.line(['scripts', name]) ?? 1, commands: cmds, purpose: taskPurpose(name) });
    }
    void stepId;
  }
}

/** Extensions and PHP versions required by locked packages. */
function lockfileRequirements(ctx: Ctx, project: string, lock: NonNullable<ReturnType<typeof parseJsonDoc>>): void {
  const l = asRecord(lock.value);
  let tightest: { min: semver.SemVer; pkg: string; constraint: string; idx: number; section: string } | null = null;
  const extSeen = new Set<string>();
  for (const section of ['packages', 'packages-dev']) {
    const pkgs = Array.isArray(l[section]) ? (l[section] as unknown[]) : [];
    pkgs.forEach((raw, idx) => {
      const pkg = asRecord(raw);
      const name = asString(pkg.name) ?? '?';
      for (const [dep, constraint] of Object.entries(asRecord(pkg.require))) {
        if (typeof constraint !== 'string') continue;
        if (dep === 'php') {
          const r = composerRange(constraint);
          let min: semver.SemVer | null = null;
          try {
            min = r ? semver.minVersion(r) : null;
          } catch {
            min = null;
          }
          if (min && (!tightest || semver.gt(min, tightest.min))) tightest = { min, pkg: `${name} ${asString(pkg.version) ?? ''}`.trim(), constraint, idx, section };
        } else if (dep.startsWith('ext-')) {
          const ext = dep.slice(4).toLowerCase();
          if (ALWAYS_PRESENT.has(ext) || extSeen.has(ext)) continue;
          extSeen.add(ext);
          ctx.extClaims.push({ ext, project, source: 'lockfile', evidence: ev(lock.file, lock.line([section, idx, 'require', dep]), 'lockfile', `${name} requires ${dep}`) });
        }
      }
    });
  }
  const t = tightest as { min: semver.SemVer; pkg: string; constraint: string; idx: number; section: string } | null;
  if (t) {
    ctx.versionClaims.push({
      tool: 'php', dir: ctx.project(project)!.root, role: 'constraint', range: `>=${t.min.version}`, display: `>= ${t.min.major}.${t.min.minor}`, source: 'lockfile',
      evidence: ev(lock.file, lock.line([t.section, t.idx, 'require', 'php']), 'lockfile', `locked package ${t.pkg} requires php "${t.constraint}"`),
    });
  }
  for (const [k, v] of Object.entries(asRecord(l.platform))) {
    if (k.startsWith('ext-') && typeof v === 'string') {
      const ext = k.slice(4).toLowerCase();
      if (!ALWAYS_PRESENT.has(ext) && !extSeen.has(ext)) ctx.extClaims.push({ ext, project, source: 'lockfile', evidence: ev(lock.file, lock.line(['platform', k]), 'lockfile', `platform requirement ${k}`) });
    }
  }
}

export function taskPurpose(name: string): 'setup' | 'run' | 'test' | 'build' | 'other' {
  const n = name.toLowerCase();
  if (/^(setup|install|bootstrap|init|deps|dependencies|prepare|first-run|dev-setup|setup-dev|configure)$/.test(n) || /^setup[:_-]/.test(n)) return 'setup';
  if (/^(dev|run|start|serve|up|server|watch|develop)$/.test(n) || /^(dev|start|serve)[:_-]/.test(n)) return 'run';
  if (/^(test|tests|check|ci|spec|phpunit|pest)/.test(n)) return 'test';
  if (/^(build|compile|dist|bundle|assets)/.test(n)) return 'build';
  return 'other';
}
