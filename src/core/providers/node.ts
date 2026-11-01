// Node.js ecosystem: package.json, lockfiles, workspaces, engines / packageManager / volta / devEngines, and the
// scripts that become run targets. Scripts are read as text and classified; they are never run.
import semver from 'semver';
import type { Ctx, ProjectDraft } from '../context.js';
import { ev, withRole, stepId } from '../context.js';
import { readDoc, asRecord, asString, asStringArray, parseJsonDoc } from '../parse/structured.js';
import { joinRel } from '../fs.js';
import { globToRegExp } from '../scan.js';
import { MAX_LOCKFILE_BYTES } from '../fs.js';
import { LineIndex, splitShell } from '../text.js';
import { nodeInstallArgv, nodeRunArgv, type NodePM } from '../commands.js';
import { npmRange, parsePin } from '../versions.js';
import { matchServer, isOrchestrator, isGenericServer } from '../kb.js';
import type { Evidence, RunPort } from '../schema.js';
import { redactCommand } from '../parse/envfile.js';

export const LOCKFILES: readonly { name: string; pm: NodePM }[] = [
  { name: 'package-lock.json', pm: 'npm' },
  { name: 'npm-shrinkwrap.json', pm: 'npm' },
  { name: 'pnpm-lock.yaml', pm: 'pnpm' },
  { name: 'yarn.lock', pm: 'yarn' },
  { name: 'bun.lock', pm: 'bun' },
  { name: 'bun.lockb', pm: 'bun' },
];

export function collectNode(ctx: Ctx): void {
  const { files } = ctx;
  for (const p of ctx.projects) {
    if (!p.ecosystems.has('node')) continue;
    const file = joinRel(p.root, 'package.json');
    const doc = readDoc(files, file, 'json');
    if (!doc) {
      p.ecosystems.delete('node');
      ctx.unknown({ id: `unparsable:${file}`, subject: `project:${p.id}`, message: `${file} could not be parsed as JSON, so the Node.js project there is not analyzed.` });
      continue;
    }
    const pkg = asRecord(doc.value);
    if (!p.name) p.name = asString(pkg.name) ?? p.root.split('/').pop() ?? 'root';
    if (p.root === '.' && !p.name) p.name = 'root';
    const deps = new Map<string, { range: string; dev: boolean }>();
    for (const [k, dev] of [['dependencies', false], ['devDependencies', true], ['optionalDependencies', false]] as const) {
      for (const [name, range] of Object.entries(asRecord(pkg[k]))) if (typeof range === 'string' && !deps.has(name)) deps.set(name, { range, dev });
    }
    const scripts: Record<string, string> = {};
    for (const [k, v] of Object.entries(asRecord(pkg.scripts))) if (typeof v === 'string') scripts[k] = v;

    let workspaceGlobs = Array.isArray(pkg.workspaces) ? asStringArray(pkg.workspaces) : asStringArray(asRecord(pkg.workspaces).packages);
    const pnpmWs = joinRel(p.root, 'pnpm-workspace.yaml');
    if (files.isFile(pnpmWs)) {
      const ws = readDoc(files, pnpmWs, 'yaml');
      if (ws) workspaceGlobs = [...workspaceGlobs, ...asStringArray(asRecord(ws.value).packages)];
    }

    const lockfiles: NonNullable<ProjectDraft['node']>['lockfiles'] = [];
    let yarnBerry = files.isFile(joinRel(p.root, '.yarnrc.yml'));
    for (const lf of LOCKFILES) {
      const rel = joinRel(p.root, lf.name);
      if (!files.isFile(rel)) continue;
      let berry: boolean | undefined;
      if (lf.pm === 'yarn') {
        const head = files.readText(rel, MAX_LOCKFILE_BYTES)?.slice(0, 2000) ?? '';
        berry = /__metadata:/.test(head) || !/yarn lockfile v1/.test(head);
        yarnBerry = yarnBerry || berry;
      }
      lockfiles.push({ pm: lf.pm, file: rel, yarnBerry: berry });
      if (lf.pm === 'pnpm') {
        // The lockfile format names the pnpm major that wrote it; newer majors refuse old formats.
        const head = files.readText(rel, MAX_LOCKFILE_BYTES)?.slice(0, 200) ?? '';
        const v = /lockfileVersion:\s*'?([\d.]+)/.exec(head)?.[1];
        const major = v ? PNPM_LOCKFILE_MAJOR[v] : undefined;
        if (major) ctx.versionClaims.push({ tool: 'pnpm', dir: p.root, role: 'constraint', range: `>=${major}.0.0 <${major + 1}.0.0-0`, display: `${major}.x`, source: 'lockfile', evidence: ev(rel, 1, 'lockfile', `lockfileVersion ${v} is written and read by pnpm ${major}`) });
      }
      ctx.choiceClaims.push({ subject: `pm:node@${p.id}`, value: lf.pm, source: 'lockfile', evidence: ev(rel, undefined, 'lockfile', `${lf.name} present`) });
    }
    p.node = { manifest: doc, scripts, deps, workspaceGlobs, lockfiles, yarnBerry };

    // packageManager (Corepack) and devEngines.packageManager state the answer explicitly.
    const pmField = asString(pkg.packageManager);
    if (pmField) {
      const m = /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(pmField);
      if (m) {
        ctx.choiceClaims.push({ subject: `pm:node@${p.id}`, value: m[1], source: 'manifest-explicit', evidence: ev(file, doc.line(['packageManager']), 'manifest-explicit', `packageManager: "${m[1]}@${m[2]}"`) });
        if (m[1] === 'yarn' && semver.coerce(m[2])?.major && semver.coerce(m[2])!.major >= 2) p.node.yarnBerry = true;
        const r = parsePin(m[2]);
        if (r?.range) ctx.versionClaims.push({ tool: m[1], dir: p.root, role: 'preference', range: r.range, display: m[2], source: 'manifest-explicit', evidence: ev(file, doc.line(['packageManager']), 'manifest-explicit', `packageManager: "${m[1]}@${m[2]}"`) });
      }
    }
    const devEngines = asRecord(pkg.devEngines);
    for (const [key, tool] of [['packageManager', null], ['runtime', 'node']] as const) {
      const entries = Array.isArray(devEngines[key]) ? (devEngines[key] as unknown[]) : devEngines[key] ? [devEngines[key]] : [];
      entries.forEach((e, i) => {
        const r = asRecord(e);
        const name = asString(r.name);
        const version = asString(r.version);
        const path = Array.isArray(devEngines[key]) ? ['devEngines', key, i] : ['devEngines', key];
        if (!name) return;
        if (key === 'packageManager' && /^(npm|pnpm|yarn|bun)$/.test(name)) {
          ctx.choiceClaims.push({ subject: `pm:node@${p.id}`, value: name, source: 'manifest-explicit', evidence: ev(file, doc.line(path), 'manifest-explicit', `devEngines.packageManager: ${name}${version ? '@' + version : ''}`) });
        }
        const t = tool ?? name;
        const range = version ? npmRange(version) : null;
        if (range && (key === 'packageManager' || name === 'node')) {
          ctx.versionClaims.push({ tool: t, dir: p.root, role: 'constraint', range, display: version!, source: 'manifest-explicit', evidence: ev(file, doc.line(path), 'manifest-explicit', `devEngines.${key}: ${name} ${version}`) });
        }
      });
    }
    const engines = asRecord(pkg.engines);
    for (const [tool, raw] of Object.entries(engines)) {
      if (typeof raw !== 'string' || !['node', 'npm', 'pnpm', 'yarn', 'bun'].includes(tool)) continue;
      const range = npmRange(raw);
      if (range) ctx.versionClaims.push({ tool, dir: p.root, role: 'constraint', range, display: raw, source: 'manifest', evidence: ev(file, doc.line(['engines', tool]), 'manifest', `engines.${tool}: "${raw}"`) });
      else files.parseError(file, `engines.${tool} is not a valid range: ${raw}`);
    }
    const volta = asRecord(pkg.volta);
    for (const [tool, raw] of Object.entries(volta)) {
      if (typeof raw !== 'string' || !['node', 'npm', 'pnpm', 'yarn'].includes(tool)) continue;
      const pin = parsePin(raw);
      if (pin?.range) ctx.versionClaims.push({ tool, dir: p.root, role: 'preference', range: pin.range, display: pin.display, source: 'version-file', evidence: ev(file, doc.line(['volta', tool]), 'version-file', `volta.${tool}: "${raw}"`) });
    }
    lockfileEngines(ctx, p);
  }
  linkWorkspaces(ctx);
  for (const p of ctx.projects) if (p.node) p.role = nodeRole(ctx, p);
}

/** The tightest `engines.node` lower bound among locked packages (npm and pnpm lockfiles). */
function lockfileEngines(ctx: Ctx, p: ProjectDraft): void {
  const lf = p.node!.lockfiles.find((l) => l.pm === 'npm' || l.pm === 'pnpm');
  if (!lf) return;
  const text = ctx.files.readText(lf.file, MAX_LOCKFILE_BYTES);
  if (!text) return;
  let best: { min: semver.SemVer; pkg: string; range: string; offset: number } | null = null;
  // Only the project's own direct dependencies: transitive and optional packages (platform-specific binaries)
  // often declare engines that npm and pnpm merely warn about.
  const direct = p.node!.deps;
  const consider = (pkg: string, range: string, offset: number) => {
    const name = pkg.replace(/@[^@]*$/, '');
    if (!direct.has(name)) return;
    let min: semver.SemVer | null = null;
    try {
      min = semver.minVersion(range);
    } catch {
      return;
    }
    if (min && (!best || semver.gt(min, best.min))) best = { min, pkg, range, offset };
  };
  if (lf.pm === 'npm') {
    let lock: { packages?: Record<string, { engines?: unknown; version?: string; dev?: boolean; optional?: boolean; devOptional?: boolean }> };
    try {
      lock = JSON.parse(text);
    } catch {
      ctx.files.parseError(lf.file, 'could not parse as JSON');
      return;
    }
    for (const [key, info] of Object.entries(lock.packages ?? {})) {
      if (!key || info.optional || info.devOptional || key.lastIndexOf('node_modules/') !== 0) continue;
      const eng = info.engines;
      const node = Array.isArray(eng) ? undefined : asString(asRecord(eng).node);
      if (node) consider(`${key.replace(/^.*node_modules\//, '')}@${info.version ?? '?'}`, node, -1);
    }
    const b = best as { pkg: string } | null;
    if (b) {
      const name = b.pkg.replace(/@[^@]*$/, '');
      (best as unknown as { offset: number }).offset = text.indexOf(`"node_modules/${name}"`);
    }
  } else {
    const re = /^ {2}['"]?\/?((?:@[^/@\s]+\/)?[^@\s'"]+)[@/]([^:('"\s]+)[^:]*['"]?:\s*$|engines:\s*\{\s*node:\s*['"]?([^'"}]+?)['"]?\s*[,}]/gm;
    let cur = '';
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[1]) cur = `${m[1]}@${m[2]}`;
      else if (m[3] && cur) consider(cur, m[3], m.index);
    }
  }
  const b = best as { min: semver.SemVer; pkg: string; range: string; offset: number } | null;
  if (!b || b.min.major < 4) return;
  const line = b.offset >= 0 ? new LineIndex(text).line(b.offset) : undefined;
  ctx.versionClaims.push({
    tool: 'node', dir: p.root, role: 'constraint', soft: true, range: `>=${b.min.version}`, display: `>= ${b.min.version}`, source: 'lockfile',
    evidence: ev(lf.file, line, 'lockfile', `locked dependency ${b.pkg} declares engines.node "${b.range}"`),
  });
}

function linkWorkspaces(ctx: Ctx): void {
  const roots = ctx.projects.filter((p) => p.node?.workspaceGlobs.length);
  for (const r of roots) {
    const include = r.node!.workspaceGlobs.filter((g) => !g.startsWith('!')).map(globToRegExp);
    const exclude = r.node!.workspaceGlobs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));
    for (const m of ctx.projects) {
      if (m === r || !m.node || m.workspaceRoot) continue;
      const rel = r.root === '.' ? m.root : m.root.startsWith(r.root + '/') ? m.root.slice(r.root.length + 1) : null;
      if (rel === null) continue;
      if (include.some((re) => re.test(rel)) && !exclude.some((re) => re.test(rel))) {
        m.workspaceRoot = r.id;
        r.workspaceMembers.push(m.id);
      }
    }
  }
  // Dependencies between members, by package name.
  const byName = new Map<string, ProjectDraft>();
  for (const p of ctx.projects) if (p.node && p.workspaceRoot) byName.set(asString(asRecord(p.node.manifest.value).name) ?? '', p);
  for (const p of ctx.projects) {
    if (!p.node || !p.workspaceRoot) continue;
    for (const [dep, info] of p.node.deps) {
      const target = byName.get(dep);
      if (!target || target === p || target.workspaceRoot !== p.workspaceRoot) continue;
      const file = p.node.manifest.file;
      const main = asString(asRecord(target.node!.manifest.value).main) ?? asString(asRecord(target.node!.manifest.value).types) ?? '';
      const builtOutput = /^(\.\/)?(dist|build|lib|out)\//.test(main);
      const needsBuild = builtOutput && Boolean(target.node!.scripts.build) && !ctx.files.exists(joinRel(target.root, main));
      p.dependsOn.push({
        project: target.id,
        kind: needsBuild ? 'build' : 'workspace',
        why: needsBuild
          ? `${p.name} depends on ${dep}, whose entry point ${main} is a build output that is not in the repo, so ${dep} must be built first.`
          : `${p.name} depends on the workspace package ${dep} (${info.range}).`,
        confidence: needsBuild ? 'medium' : 'high',
        evidence: [withRole(ev(file, p.node.manifest.line([info.dev ? 'devDependencies' : 'dependencies', dep]), 'manifest', `"${dep}": "${info.range}"`), 'basis')],
      });
    }
  }
}

function nodeRole(ctx: Ctx, p: ProjectDraft): ProjectDraft['role'] {
  const n = p.node!;
  if (n.workspaceGlobs.length) return 'workspace-root';
  const s = n.scripts;
  const runnable = ['dev', 'start', 'serve', 'develop'].some((k) => s[k]);
  if (runnable) return 'app';
  if (p.ecosystems.has('php')) return 'app';
  const pkg = asRecord(n.manifest.value);
  if (pkg.main || pkg.exports || pkg.module || pkg.types) return 'library';
  if (p.root === '.' && ctx.projects.length > 1) return 'tooling';
  return 'unknown';
}

// ---- Second pass: steps and run targets, once the package manager is resolved ----------------------------------

const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare'];

/** Projects whose pnpm commands run a specific pnpm major through npx (old lockfile formats). */
const pnpmPrefix = new Map<string, string[]>();

/** Packages package.json requires that the npm lockfile does not list (it was not updated after an edit). */
function staleNpmLock(ctx: Ctx, p: ProjectDraft): string[] {
  const lf = p.node!.lockfiles.find((l) => l.pm === 'npm');
  if (!lf) return [];
  let lock: { lockfileVersion?: number; packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };
  try {
    lock = JSON.parse(ctx.files.readText(lf.file, MAX_LOCKFILE_BYTES) ?? '{}');
  } catch {
    return [];
  }
  const root = lock.packages?.[''];
  if (!root) return [];
  const locked = new Set([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {}), ...Object.keys(root.optionalDependencies ?? {})]);
  return [...p.node!.deps.keys()].filter((d) => !locked.has(d)).sort();
}

/** Rewrite `pnpm …` commands of projects pinned to an older pnpm major (call after recipes added their steps). */
export function applyPnpmPrefix(ctx: Ctx): void {
  for (const x of [...ctx.steps, ...ctx.runs]) {
    const pre = pnpmPrefix.get(x.project);
    if (pre && x.action.type === 'exec' && x.action.argv[0] === 'pnpm') x.action = { ...x.action, argv: [...pre, ...x.action.argv.slice(1)] };
  }
  pnpmPrefix.clear();
}

/** pnpm-lock.yaml lockfileVersion → the only pnpm major that reads it; format 9.0 is read by pnpm 9 and later. */
const PNPM_LOCKFILE_MAJOR: Record<string, number> = { '5.3': 6, '5.4': 7, '6.0': 8, '6.1': 8 };

/** The project says which dependencies may run build scripts (package.json "pnpm" or pnpm-workspace.yaml). */
function pnpmApprovesBuilds(ctx: Ctx, p: ProjectDraft): boolean {
  const keys = ['onlyBuiltDependencies', 'neverBuiltDependencies', 'ignoredBuiltDependencies', 'allowBuilds', 'onlyBuiltDependenciesFile', 'dangerouslyAllowAllBuilds'];
  const fromPkg = asRecord(asRecord(p.node!.manifest.value).pnpm);
  if (keys.some((k) => k in fromPkg)) return true;
  const ws = joinRel(p.root, 'pnpm-workspace.yaml');
  const text = ctx.files.isFile(ws) ? ctx.files.readText(ws) ?? '' : '';
  return keys.some((k) => new RegExp(`^${k}\\s*:`, 'm').test(text));
}

export function planNode(ctx: Ctx): void {
  for (const p of ctx.projects) {
    if (!p.node) continue;
    const pm = p.node.pm ?? 'npm';
    const installer = p.workspaceRoot ? ctx.project(p.workspaceRoot)! : p;
    const installId = stepId(installer.id, 'install');
    if (!p.workspaceRoot) {
      const hasLock = p.node.lockfiles.some((l) => l.pm === pm);
      const skipUnapprovedBuilds = pm === 'pnpm' && !pnpmApprovesBuilds(ctx, p) && !(p.node.pmChoice?.version && /^[0-9]\./.test(p.node.pmChoice.version));
      let argv = nodeInstallArgv(pm, { hasLockfile: hasLock, yarnBerry: p.node.yarnBerry, skipUnapprovedBuilds });
      // An old pnpm lockfile format without a packageManager pin: run the pnpm major that reads it.
      const oldPnpm = pm === 'pnpm' && !p.node.pmChoice?.version ? ctx.versionClaims.find((c) => c.tool === 'pnpm' && c.source === 'lockfile' && c.dir === p.root) : undefined;
      if (oldPnpm) {
        const major = oldPnpm.display.replace('.x', '');
        argv = ['npx', '--yes', `pnpm@${major}`, ...nodeInstallArgv('pnpm', { hasLockfile: true }).slice(1)];
        pnpmPrefix.set(p.id, ['npx', '--yes', `pnpm@${major}`]);
        for (const m of p.workspaceMembers) pnpmPrefix.set(m, ['npx', '--yes', `pnpm@${major}`]);
      }
      // package-lock.json that misses packages package.json requires: `npm ci` refuses it.
      const stale = pm === 'npm' && hasLock ? staleNpmLock(ctx, p) : [];
      if (stale.length) {
        argv = ['npm', 'install'];
        ctx.conflict({
          id: `lock-stale:${p.id}`, subject: `lockfile@${p.id}`, chosen: 'npm install',
          alternatives: [{ value: 'npm install', evidence: [] }, { value: 'npm ci', evidence: [withRole(ev(p.node.lockfiles.find((l) => l.pm === 'npm')!.file, undefined, 'lockfile', `${stale.slice(0, 3).join(', ')} not locked`), 'contradicts')] }],
          severity: 'warning', rule: 'a stale lockfile cannot be installed exactly',
          message: `package-lock.json is out of date with package.json (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ` and ${stale.length - 3} more` : ''} not locked), so "npm ci" would refuse it; using "npm install", which resolves current versions and updates the lockfile.`,
        });
      }
      const life = LIFECYCLE.filter((k) => p.node!.scripts[k]);
      const notes: string[] = [];
      for (const k of life) notes.push(`Installing also runs the project's "${k}" script: ${redactCommand(p.node.scripts[k])}`);
      if (hasLock) notes.push(`If this fails because the lockfile is out of date, run "${pm} install" instead (it may change the lockfile).`);
      if (!hasLock) notes.push('There is no lockfile, so dependency versions are resolved fresh and may differ from what the maintainers use.');
      if (p.workspaceMembers.length) notes.push(`Installs the whole workspace: ${p.workspaceMembers.join(', ')}.`);
      if (oldPnpm) notes.push(`${oldPnpm.evidence.file} uses an older lockfile format (${oldPnpm.evidence.detail}); newer pnpm versions refuse it, so this runs pnpm ${oldPnpm.display} through npx (it downloads that pnpm).`);
      if (skipUnapprovedBuilds && !oldPnpm) notes.push('The project does not list which dependencies may run build scripts, so pnpm skips them (--config.strict-dep-builds=false) instead of stopping, as pnpm 11 and later do. If something needs one, run "pnpm approve-builds".');
      const lock = p.node.lockfiles.find((l) => l.pm === pm);
      ctx.addStep({
        local: 'install', project: p.id, phase: 'install', order: 10,
        title: p.workspaceMembers.length ? `Install the workspace's JavaScript dependencies (${pm})` : `Install JavaScript dependencies (${pm})`,
        cwd: p.root, action: { type: 'exec', argv },
        network: true, thirdPartyCode: true,
        requires: ['runtime:node', `package-manager:${pm}`],
        confidence: p.node.pmChoice?.confidence ?? 'low',
        why: `${p.node.manifest.file} declares the dependencies; ${p.node.pmChoice?.why ?? `${pm} is the default`}. ${hasLock ? 'The command installs exactly the locked versions and does not modify the lockfile.' : ''}`.trim(),
        notes,
        evidence: [
          withRole(ev(p.node.manifest.file, undefined, 'manifest', 'package.json'), 'basis'),
          ...(lock ? [withRole(ev(lock.file, undefined, 'lockfile', `${lock.file.split('/').pop()} present`), 'basis')] : []),
        ],
        sig: `install:${pm}`,
      });
    }
    planScripts(ctx, p, pm, installId);
  }
  // A workspace root whose dev script orchestrates the members (turbo, nx...) starts them itself.
  for (const root of ctx.projects.filter((p) => p.workspaceMembers.length)) {
    const rootDev = ctx.runs.find((r) => r.project === root.id && r.primary && r.kind === 'dev');
    if (!rootDev) continue;
    for (const r of ctx.runs) {
      if (root.workspaceMembers.includes(r.project) && r.kind === 'dev' && r.primary) {
        r.primary = false;
        r.why += ` The workspace root's "${rootDev.name}" script starts it together with the other packages.`;
        // The root's orchestrated dev target serves the apps' ports.
        for (const port of r.ports) {
          if (!rootDev.ports.some((x) => x.port === port.port)) rootDev.ports.push({ port: port.port, confidence: 'low', evidence: port.evidence.map((e) => ({ ...e, role: 'supports' as const })) });
        }
      }
    }
    rootDev.ports.sort((a, b) => a.port - b.port);
    if (rootDev.ports.length && rootDev.readiness?.type !== 'port') rootDev.readiness = { type: 'port', port: rootDev.ports[0].port, timeoutSec: 180 };
  }
}

interface ScriptInfo {
  name: string;
  command: string;
  server: ReturnType<typeof matchServer>;
  orchestrator: boolean;
  generic: boolean;
}

function analyzeScript(name: string, command: string, scripts: Record<string, string>, depth = 0): ScriptInfo {
  const cmds = splitShell(command);
  let server: ScriptInfo['server'] = null;
  let orchestrator = false;
  let generic = false;
  for (const c of cmds) {
    const a = c.argv;
    if (!a.length) continue;
    const m = matchServer(a);
    if (m) {
      server = m;
      if (c.assignments.PORT && /^\d+$/.test(c.assignments.PORT)) {
        server = { ...m, port: +c.assignments.PORT, portSource: 'flag' };
      }
      break;
    }
    // `npm run dev:web` / `pnpm dev` inside a script: follow one level.
    const runIdx = a[0] && /^(npm|pnpm|yarn|bun)$/.test(a[0]) ? (a[1] === 'run' ? 2 : 1) : -1;
    if (runIdx > 0 && a[runIdx] && scripts[a[runIdx]] && depth < 2 && a[runIdx] !== name) {
      const inner = analyzeScript(a[runIdx], scripts[a[runIdx]], scripts, depth + 1);
      if (inner.server || inner.orchestrator || inner.generic) return { ...inner, name, command };
    }
    if (isOrchestrator(a[0])) orchestrator = true;
    else if (isGenericServer(a[0])) generic = true;
  }
  return { name, command, server, orchestrator, generic };
}

function portsForScript(ctx: Ctx, p: ProjectDraft, info: ScriptInfo): RunPort[] {
  const n = p.node!;
  const file = n.manifest.file;
  if (info.server?.port) {
    const conf = info.server.portSource === 'flag' ? 'high' : 'medium';
    const detail = info.server.portSource === 'flag' ? `the script sets port ${info.server.port}` : `${info.server.bin}'s default port is ${info.server.port}`;
    return [{ port: info.server.port, confidence: conf, evidence: [withRole(ev(file, n.manifest.line(['scripts', info.name]), 'manifest', detail), 'basis')] }];
  }
  if (info.generic || info.server) {
    for (const t of p.envTemplates) {
      const v = t.vars.find((x) => x.name === 'PORT' && /^\d+$/.test(x.raw));
      if (v) return [{ port: +v.raw, confidence: 'medium', evidence: [withRole(ev(t.file, v.line, 'env-template', `PORT=${v.raw}`), 'basis')] }];
    }
    const code = ctx.codePortDefaults.get(p.id);
    if (code) return [{ port: code.port, confidence: 'medium', evidence: [withRole(code.evidence, 'basis')] }];
  }
  return [];
}

/** Whether a script starts something long-running (a server, a watcher, several processes) rather than finishing. */
export function scriptStartsSomething(p: ProjectDraft, name: string): boolean {
  const body = p.node?.scripts[name];
  if (!body) return false;
  const info = analyzeScript(name, body, p.node!.scripts);
  // A production server (`next start`, `vite preview`) needs a build first: never a dev target.
  if (info.server && (info.server.kind === 'production' || info.server.needsBuild)) return false;
  return Boolean(info.server || info.orchestrator || info.generic) || /\b(dev|serve|watch)\b/.test(body);
}

/**
 * Make a script the project's primary dev target because the docs start the app with it (`npm run chat`,
 * `pnpm go`), creating its run target if the generic pass did not.
 */
export function preferDocumentedScript(ctx: Ctx, p: ProjectDraft, name: string, mention: Evidence): boolean {
  const n = p.node;
  if (!n?.scripts[name]) return false;
  const pm = n.pm ?? 'npm';
  const info = analyzeScript(name, n.scripts[name], n.scripts);
  const installer = p.workspaceRoot ? ctx.project(p.workspaceRoot)! : p;
  let run = ctx.runs.find((r) => r.project === p.id && r.local === name);
  if (!run) {
    const ports = portsForScript(ctx, p, info);
    run = ctx.addRun({
      local: name, project: p.id, name, kind: 'dev', primary: false, title: `Start ${p.name} (${name}, as the docs say)`,
      cwd: p.root, action: { type: 'exec', argv: nodeRunArgv(pm, name) }, ports, after: [stepId(installer.id, 'install')],
      readiness: ports.length ? { type: 'port', port: ports[0].port, timeoutSec: 180 } : { type: 'stays-up', seconds: 30 },
      confidence: 'medium', why: `${n.manifest.file} defines "${name}": ${redactCommand(n.scripts[name])}.`,
      evidence: [withRole(ev(n.manifest.file, n.manifest.line(['scripts', name]), 'manifest', `scripts.${name}: "${redactCommand(n.scripts[name])}"`), 'basis')],
      sig: `script:${name}`,
    });
  }
  if (run.primary && run.kind === 'dev') return false;
  const others = ctx.runs.filter((r) => r.project === p.id && r.kind === 'dev' && r.primary && r !== run && (r.sig?.startsWith('script:') || info.orchestrator || /concurrently|turbo|docker/.test(n.scripts[name])));
  for (const o of others) o.primary = false;
  run.kind = 'dev';
  run.primary = true;
  run.evidence.push(mention);
  run.why += ` The docs start the app with it (${mention.file}${mention.line ? ':' + mention.line : ''}).`;
  return true;
}

const DB_MIGRATE_SCRIPT = /^(db:migrate|db:push|db:deploy|migrate|migrate:deploy|migrate:latest|db:migrate:deploy)$/;
const DB_SEED_SCRIPT = /^(db:seed|seed|db:seed:dev)$/;

function planScripts(ctx: Ctx, p: ProjectDraft, pm: NodePM, installId: string): void {
  const n = p.node!;
  const file = n.manifest.file;
  const scripts = n.scripts;
  const evFor = (name: string): Evidence => withRole(ev(file, n.manifest.line(['scripts', name]), 'manifest', `scripts.${name}: "${redactCommand(scripts[name])}"`), 'basis');
  const infos = new Map<string, ScriptInfo>();
  for (const name of ['dev', 'develop', 'serve', 'start', 'preview', 'test', 'build', 'watch']) {
    if (scripts[name]) infos.set(name, analyzeScript(name, scripts[name], scripts));
  }
  const portsFor = (info: ScriptInfo): RunPort[] => portsForScript(ctx, p, info);

  // Build: a step for production targets and for workspace packages others need built.
  const buildNeeded = ctx.projects.some((o) => o.dependsOn.some((d) => d.project === p.id && d.kind === 'build'));
  if (scripts.build) {
    ctx.addStep({
      local: 'build', project: p.id, phase: 'build', order: 60,
      title: buildNeeded ? `Build ${p.name} (other workspace packages import its build output)` : `Build ${p.name} for production`,
      cwd: p.root, action: { type: 'exec', argv: nodeRunArgv(pm, 'build') },
      network: false, thirdPartyCode: true, optional: !buildNeeded,
      after: [installId], requires: ['runtime:node'],
      confidence: buildNeeded ? 'medium' : 'high',
      why: buildNeeded
        ? `Other packages in the workspace import ${p.name}'s compiled output, which is not committed.`
        : 'Only needed for the production run target; the dev server builds on the fly.',
      evidence: [evFor('build')],
      sig: 'script:build',
    });
  }

  // Database scripts the project defines (`db:migrate`, `db:push`, `db:seed`), unless a recipe already covers them.
  for (const [name, body] of Object.entries(scripts)) {
    const migrate = DB_MIGRATE_SCRIPT.test(name);
    const seed = DB_SEED_SCRIPT.test(name);
    if (!migrate && !seed) continue;
    if (/prisma\s+(migrate|db\s+push|db\s+seed)/.test(body)) continue; // the Prisma recipe has these steps
    ctx.addStep({
      local: `script-${name.replace(/[^\w-]/g, '-')}`, project: p.id, phase: 'database', order: seed ? 56 : 52,
      title: seed ? `Seed the database (${name})` : `Apply the database schema (${name})`,
      cwd: p.root, action: { type: 'exec', argv: nodeRunArgv(pm, name) }, network: false, thirdPartyCode: true, optional: seed,
      after: [installId, stepId(p.id, 'env') + '?'], requires: ['runtime:node'], confidence: 'medium',
      why: `${file} defines "${name}": ${redactCommand(body)}. ${seed ? 'Seeds usually add demo data; read the script first.' : 'It needs the database from the env file to be running.'}`,
      evidence: [evFor(name)], sig: `script:${name}`,
    });
  }

  const devName = ['dev', 'develop', 'serve'].find((k) => infos.has(k));
  const start = infos.get('start');
  const startIsProd = start?.server?.kind === 'production' || (start?.server?.needsBuild ?? false);
  const primaryDev = devName ?? (start && !startIsProd ? 'start' : undefined);
  for (const [name, info] of infos) {
    if (name === 'build' || name === 'watch') continue;
    if (name === 'test') {
      if (/no test specified/.test(info.command)) continue;
      ctx.addRun({
        local: 'test', project: p.id, name, kind: 'test', primary: true, title: `Run ${p.name}'s tests`,
        cwd: p.root, action: { type: 'exec', argv: nodeRunArgv(pm, 'test') }, after: [installId],
        readiness: { type: 'exits', timeoutSec: 1800 }, confidence: 'high',
        why: `${file} defines a test script.`, evidence: [evFor(name)], sig: 'script:test',
      });
      continue;
    }
    const kind: 'dev' | 'production' = name === 'start' ? (startIsProd ? 'production' : 'dev') : name === 'preview' ? 'production' : 'dev';
    if (name === 'preview' && !info.server) continue;
    const ports = portsFor(info);
    const after = [installId];
    const needsBuild = info.server?.needsBuild || name === 'preview';
    if (needsBuild && scripts.build) after.push(stepId(p.id, 'build'));
    const primary = name === primaryDev || (kind === 'production' && name === 'start');
    const what = info.server ? `${info.server.bin} ${kind === 'dev' ? 'dev server' : 'server'}` : info.orchestrator ? 'several processes through a task runner' : 'the app';
    ctx.addRun({
      local: name, project: p.id, name, kind, primary, title: `${kind === 'dev' ? 'Start' : 'Serve'} ${p.name} (${what})`,
      cwd: p.root, action: { type: 'exec', argv: nodeRunArgv(pm, name) }, ports, after,
      readiness: ports.length ? { type: 'port', port: ports[0].port, timeoutSec: 120 } : { type: 'stays-up', seconds: info.orchestrator ? 30 : 20 },
      confidence: info.server || info.orchestrator || info.generic ? 'high' : 'medium',
      why: `${file} defines "${name}": ${redactCommand(info.command)}${needsBuild ? ' (needs a build first)' : ''}.`,
      evidence: [evFor(name)], sig: `script:${name}`,
    });
  }
}
