// Generic fallbacks for ecosystems without full support yet: enough to name the runtime and its version, the
// likely install command and a run command, always at lower confidence and marked as generic.
import type { Ctx, ProjectDraft } from '../context.js';
import { ev, withRole, stepId } from '../context.js';
import { joinRel } from '../fs.js';
import { readDoc, asRecord, asString } from '../parse/structured.js';
import { pep440Range, parsePin, npmRange } from '../versions.js';
import type { Action, Confidence } from '../schema.js';

const GENERIC_NOTE = 'Generic support: this ecosystem is detected with fallbacks, not a full provider. Check the project docs.';

export function collectGeneric(ctx: Ctx): void {
  for (const p of ctx.projects) {
    if (p.ecosystems.has('python')) python(ctx, p);
    if (p.ecosystems.has('go')) go(ctx, p);
    if (p.ecosystems.has('rust')) rust(ctx, p);
    if (p.ecosystems.has('ruby')) ruby(ctx, p);
    if (p.ecosystems.has('java')) java(ctx, p);
    if (p.ecosystems.has('dotnet')) dotnet(ctx, p);
    if (p.ecosystems.has('deno')) deno(ctx, p);
    if (p.ecosystems.has('elixir')) elixir(ctx, p);
    if (!p.name) p.name = p.root === '.' ? 'root' : p.root.split('/').pop()!;
    if (p.role === 'unknown' && p.ecosystems.size) p.role = 'app';
  }
}

function step(ctx: Ctx, p: ProjectDraft, local: string, phase: 'install' | 'database' | 'build' | 'generate', title: string, action: Action, why: string, evidenceFile: string, opts: { network?: boolean; requires?: string[]; after?: string[]; order?: number; confidence?: Confidence; optional?: boolean } = {}): void {
  ctx.addStep({
    local, project: p.id, phase, order: opts.order ?? 10, title, cwd: p.root, action,
    network: opts.network ?? false, thirdPartyCode: true, requires: opts.requires ?? [], after: opts.after ?? [], optional: opts.optional ?? false,
    confidence: opts.confidence ?? 'low', why, notes: [GENERIC_NOTE],
    evidence: [withRole(ev(evidenceFile, undefined, 'manifest', `${evidenceFile.split('/').pop()} present`), 'basis')],
  });
}

function run(ctx: Ctx, p: ProjectDraft, local: string, title: string, action: Action, port: number | null, why: string, file: string, after: string[]): void {
  ctx.addRun({
    local, project: p.id, name: local, kind: 'dev', primary: !ctx.runs.some((r) => r.project === p.id && r.primary && r.kind === 'dev'), title,
    cwd: p.root, action, after,
    ports: port ? [{ port, confidence: 'low', evidence: [withRole(ev(file, undefined, 'recipe', `default port ${port}`), 'basis')] }] : [],
    readiness: port ? { type: 'port', port, timeoutSec: 180 } : { type: 'stays-up', seconds: 20 },
    confidence: 'low', why, evidence: [withRole(ev(file, undefined, 'manifest', `${file.split('/').pop()} present`), 'basis')],
  });
}

function has(ctx: Ctx, p: ProjectDraft, name: string): boolean {
  return ctx.files.isFile(joinRel(p.root, name));
}

function python(ctx: Ctx, p: ProjectDraft): void {
  const pyproject = joinRel(p.root, 'pyproject.toml');
  const doc = ctx.files.isFile(pyproject) ? readDoc(ctx.files, pyproject, 'toml') : null;
  const pp = asRecord(doc?.value);
  const reqPy = asString(asRecord(pp.project)['requires-python']) ?? asString(asRecord(asRecord(asRecord(pp.tool).poetry).dependencies).python);
  if (reqPy && doc) {
    const range = pep440Range(reqPy);
    if (range) ctx.versionClaims.push({ tool: 'python', dir: p.root, role: 'constraint', range, display: reqPy, source: 'manifest', evidence: ev(pyproject, doc.line(asRecord(pp.project)['requires-python'] ? ['project', 'requires-python'] : ['tool', 'poetry', 'dependencies', 'python']), 'manifest', `requires-python: "${reqPy}"`) });
  }
  const runtimeTxt = joinRel(p.root, 'runtime.txt');
  if (ctx.files.isFile(runtimeTxt)) {
    const m = /python-([\d.]+)/.exec(ctx.files.readText(runtimeTxt) ?? '');
    const pin = m ? parsePin(m[1]) : null;
    if (pin?.range) ctx.versionClaims.push({ tool: 'python', dir: p.root, role: 'preference', range: pin.range, display: pin.display, source: 'version-file', evidence: ev(runtimeTxt, 1, 'version-file', `runtime.txt: python-${m![1]}`) });
  }
  let pm: 'uv' | 'poetry' | 'pipenv' | 'pdm' | 'pip';
  // Docs or CI that install with plain pip beat an incidental lockfile (a uv.lock nobody's instructions use).
  const said = ctx.mentions.filter((m) => (m.source === 'readme' || m.source === 'ci') && m.sig.kind === 'install' && ['pip', 'uv', 'poetry', 'pipenv', 'pdm'].includes(m.sig.tool ?? '') && (m.project === p.id || !m.project));
  const saidTools = new Set(said.map((m) => m.sig.tool));
  if (saidTools.size === 1 && saidTools.has('pip') && !has(ctx, p, 'poetry.lock') && !has(ctx, p, 'Pipfile')) {
    pm = 'pip';
    if (has(ctx, p, 'uv.lock')) {
      ctx.conflict({
        id: `pm:python@${p.id}`, subject: `pm:python@${p.id}`, chosen: 'pip',
        alternatives: [{ value: 'pip', evidence: said.slice(0, 3).map((m) => withRole(m.evidence, 'basis')) }, { value: 'uv', evidence: [withRole(ev(joinRel(p.root, 'uv.lock'), undefined, 'lockfile', 'uv.lock present'), 'contradicts')] }],
        severity: 'info', rule: 'what the docs and CI run beats an unused lockfile',
        message: `uv.lock exists, but ${said[0].evidence.file} installs with pip ("${said[0].evidence.detail}"); using pip and a virtual environment.`,
      });
    }
  } else if (has(ctx, p, 'uv.lock')) pm = 'uv';
  else if (has(ctx, p, 'poetry.lock') || asRecord(pp.tool).poetry) pm = 'poetry';
  else if (has(ctx, p, 'Pipfile')) pm = 'pipenv';
  else if (has(ctx, p, 'pdm.lock')) pm = 'pdm';
  else pm = 'pip';
  void 0;
  p.packageManagers.push({ ecosystem: 'python', name: pm, confidence: pm === 'pip' ? 'low' : 'medium', why: pm === 'pip' ? 'No lockfile of uv, Poetry, Pipenv or PDM; using pip with a virtual environment.' : `${pm} lockfile or configuration present.`, evidence: [] });
  const py: Action = { type: 'exec', argv: ['.venv/bin/python'], windowsArgv: ['.venv\\Scripts\\python.exe'] };
  const inEnv = (args: string[]): Action => {
    if (pm === 'uv') return { type: 'exec', argv: ['uv', 'run', ...args] };
    if (pm === 'poetry' || pm === 'pipenv' || pm === 'pdm') return { type: 'exec', argv: [pm, 'run', ...args] };
    return { type: 'exec', argv: ['.venv/bin/' + args[0], ...args.slice(1)], windowsArgv: ['.venv\\Scripts\\' + args[0] + '.exe', ...args.slice(1)] };
  };
  const evFile = doc ? pyproject : has(ctx, p, 'requirements.txt') ? joinRel(p.root, 'requirements.txt') : p.markers[0]?.file ?? p.root;
  const requires = ['runtime:python', ...(pm === 'pip' ? [] : [`package-manager:${pm}`])];
  if (pm === 'pip') {
    step(ctx, p, 'venv', 'install', 'Create a virtual environment (.venv)', { type: 'exec', argv: ['python3', '-m', 'venv', '.venv'], windowsArgv: ['py', '-3', '-m', 'venv', '.venv'] }, 'Keeps the project\'s packages out of the system Python.', evFile, { order: 5, requires });
    const req = has(ctx, p, 'requirements.txt') ? ['-r', 'requirements.txt'] : ['-e', '.'];
    step(ctx, p, 'install', 'install', 'Install Python dependencies (pip)', { type: 'exec', argv: [(py as { argv: string[] }).argv[0], '-m', 'pip', 'install', ...req], windowsArgv: [(py as { windowsArgv: string[] }).windowsArgv[0], '-m', 'pip', 'install', ...req] }, `${req[1]} lists the dependencies.`, evFile, { network: true, requires, after: [stepId(p.id, 'venv')] });
  } else {
    const argv = pm === 'uv' ? ['uv', 'sync'] : pm === 'pipenv' ? ['pipenv', 'install', '--dev'] : [pm, 'install'];
    step(ctx, p, 'install', 'install', `Install Python dependencies (${pm})`, { type: 'exec', argv }, `${pm} manages this project's dependencies.`, evFile, { network: true, requires, confidence: 'medium' });
  }
  if (has(ctx, p, 'manage.py')) {
    step(ctx, p, 'migrate', 'database', 'Apply Django database migrations', inEnv(['python', 'manage.py', 'migrate']), 'manage.py marks a Django project; migrate creates the database tables.', joinRel(p.root, 'manage.py'), { after: [stepId(p.id, 'install')], order: 50 });
    run(ctx, p, 'runserver', `Start ${p.name} (Django dev server)`, inEnv(['python', 'manage.py', 'runserver']), 8000, 'Django\'s development server listens on port 8000 by default.', joinRel(p.root, 'manage.py'), [stepId(p.id, 'install')]);
  }
}

function go(ctx: Ctx, p: ProjectDraft): void {
  const file = joinRel(p.root, 'go.mod');
  const text = ctx.files.readText(file) ?? '';
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const g = /^go\s+([\d.]+)/.exec(l);
    if (g) {
      const range = npmRange(`>=${g[1].split('.').length === 2 ? g[1] + '.0' : g[1]}`);
      if (range) ctx.versionClaims.push({ tool: 'go', dir: p.root, role: 'constraint', range, display: `>= ${g[1]}`, source: 'manifest', evidence: ev(file, i + 1, 'manifest', l.trim()) });
    }
    const t = /^toolchain\s+go([\d.]+)/.exec(l);
    const pin = t ? parsePin(t[1]) : null;
    if (pin?.range) ctx.versionClaims.push({ tool: 'go', dir: p.root, role: 'preference', range: pin.range, display: pin.display, source: 'manifest-explicit', evidence: ev(file, i + 1, 'manifest-explicit', l.trim()) });
  });
  step(ctx, p, 'install', 'install', 'Download Go modules', { type: 'exec', argv: ['go', 'mod', 'download'] }, 'go.mod declares the module dependencies.', file, { network: true, requires: ['runtime:go'], confidence: 'medium' });
  const mains = ctx.entries.files.filter((f) => f.startsWith(p.root === '.' ? '' : p.root + '/') && /(^|\/)main\.go$/.test(f)).map((f) => f.slice(p.root === '.' ? 0 : p.root.length + 1));
  const rootMain = mains.includes('main.go');
  const cmd = mains.filter((m) => /^cmd\/[^/]+\/main\.go$/.test(m)).sort();
  if (rootMain) run(ctx, p, 'run', `Run ${p.name}`, { type: 'exec', argv: ['go', 'run', '.'] }, null, 'main.go at the module root.', joinRel(p.root, 'main.go'), [stepId(p.id, 'install')]);
  else if (cmd.length) run(ctx, p, 'run', `Run ${cmd[0].split('/')[1]}`, { type: 'exec', argv: ['go', 'run', `./${cmd[0].replace(/\/main\.go$/, '')}`] }, null, `${cmd[0]} is a main package${cmd.length > 1 ? ` (one of ${cmd.length})` : ''}.`, joinRel(p.root, cmd[0]), [stepId(p.id, 'install')]);
}

function rust(ctx: Ctx, p: ProjectDraft): void {
  const file = joinRel(p.root, 'Cargo.toml');
  const doc = readDoc(ctx.files, file, 'toml');
  const rv = asString(asRecord(asRecord(doc?.value).package)['rust-version']);
  if (rv && doc) {
    const range = npmRange(`>=${rv}`);
    if (range) ctx.versionClaims.push({ tool: 'rust', dir: p.root, role: 'constraint', range, display: `>= ${rv}`, source: 'manifest', evidence: ev(file, doc.line(['package', 'rust-version']), 'manifest', `rust-version = "${rv}"`) });
  }
  step(ctx, p, 'install', 'install', 'Fetch and build Rust dependencies', { type: 'exec', argv: ['cargo', 'build'] }, 'Cargo.toml declares the crate and its dependencies.', file, { network: true, requires: ['runtime:rust'], confidence: 'medium' });
  if (ctx.files.isFile(joinRel(p.root, 'src/main.rs'))) run(ctx, p, 'run', `Run ${p.name}`, { type: 'exec', argv: ['cargo', 'run'] }, null, 'src/main.rs is a binary crate.', joinRel(p.root, 'src/main.rs'), [stepId(p.id, 'install')]);
}

function ruby(ctx: Ctx, p: ProjectDraft): void {
  const file = joinRel(p.root, 'Gemfile');
  const text = ctx.files.readText(file) ?? '';
  text.split('\n').forEach((l, i) => {
    const m = /^\s*ruby\s+['"]([^'"]+)['"]/.exec(l);
    const pin = m ? parsePin(m[1].replace(/^[~>=\s]+/, '')) : null;
    if (pin?.range) ctx.versionClaims.push({ tool: 'ruby', dir: p.root, role: 'preference', range: pin.range, display: pin.display, source: 'manifest', evidence: ev(file, i + 1, 'manifest', l.trim()) });
  });
  step(ctx, p, 'install', 'install', 'Install Ruby gems (Bundler)', { type: 'exec', argv: ['bundle', 'install'] }, 'Gemfile declares the gems.', file, { network: true, requires: ['runtime:ruby', 'package-manager:bundler'], confidence: 'medium' });
  if (ctx.files.isFile(joinRel(p.root, 'bin/rails'))) {
    const rails = (args: string[]): Action => ({ type: 'exec', argv: ['bin/rails', ...args], windowsArgv: ['ruby', 'bin/rails', ...args] });
    step(ctx, p, 'db', 'database', 'Prepare the Rails database', rails(['db:prepare']), 'bin/rails marks a Rails app; db:prepare creates and migrates the database.', joinRel(p.root, 'bin/rails'), { after: [stepId(p.id, 'install')], order: 50 });
    run(ctx, p, 'server', `Start ${p.name} (Rails server)`, rails(['server']), 3000, 'The Rails server listens on port 3000 by default.', joinRel(p.root, 'bin/rails'), [stepId(p.id, 'install')]);
  }
}

function java(ctx: Ctx, p: ProjectDraft): void {
  const maven = has(ctx, p, 'pom.xml');
  const file = joinRel(p.root, maven ? 'pom.xml' : ctx.files.isFile(joinRel(p.root, 'build.gradle.kts')) ? 'build.gradle.kts' : 'build.gradle');
  const text = ctx.files.readText(file) ?? '';
  const lines = text.split('\n');
  const vi = lines.findIndex((l) => /<(java\.version|maven\.compiler\.release|maven\.compiler\.source)>\s*\d+|JavaLanguageVersion\.of\(\s*\d+|sourceCompatibility\s*=\s*['"]?(JavaVersion\.VERSION_)?\d+/.test(l));
  if (vi >= 0) {
    const v = /(\d+)(?!.*\d)/.exec(lines[vi].replace(/1\.8/, '8'))?.[1];
    const pin = v ? parsePin(v) : null;
    if (pin?.range) ctx.versionClaims.push({ tool: 'java', dir: p.root, role: 'preference', range: pin.range, display: pin.display, source: 'manifest', evidence: ev(file, vi + 1, 'manifest', lines[vi].trim()) });
  }
  const wrapper = maven ? has(ctx, p, 'mvnw') : has(ctx, p, 'gradlew');
  const tool = maven ? (wrapper ? './mvnw' : 'mvn') : wrapper ? './gradlew' : 'gradle';
  const winTool = maven ? (wrapper ? 'mvnw.cmd' : 'mvn') : wrapper ? 'gradlew.bat' : 'gradle';
  const args = maven ? ['-DskipTests', 'package'] : ['build', '-x', 'test'];
  const requires = ['runtime:java', ...(wrapper ? [] : [`package-manager:${maven ? 'maven' : 'gradle'}`])];
  step(ctx, p, 'install', 'install', `Build with ${maven ? 'Maven' : 'Gradle'}${wrapper ? ' (wrapper)' : ''}`, { type: 'exec', argv: [tool, ...args], windowsArgv: [winTool, ...args] }, `${file.split('/').pop()} defines the build.`, file, { network: true, requires });
  if (/spring-boot/.test(text)) {
    const goal = maven ? ['spring-boot:run'] : ['bootRun'];
    run(ctx, p, 'run', `Start ${p.name} (Spring Boot)`, { type: 'exec', argv: [tool, ...goal], windowsArgv: [winTool, ...goal] }, 8080, 'Spring Boot listens on port 8080 by default.', file, [stepId(p.id, 'install')]);
  }
}

function dotnet(ctx: Ctx, p: ProjectDraft): void {
  const projFiles = ctx.entries.files.filter((f) => (p.root === '.' ? !f.includes('/') : f.startsWith(p.root + '/') && !f.slice(p.root.length + 1).includes('/')) && /\.(csproj|fsproj|sln|slnx)$/.test(f));
  const file = projFiles[0] ?? joinRel(p.root, 'global.json');
  for (const pf of projFiles.filter((f) => /proj$/.test(f))) {
    const text = ctx.files.readText(pf) ?? '';
    const m = /<TargetFrameworks?>\s*net(\d+)\.(\d+)/.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      ctx.versionClaims.push({ tool: 'dotnet', dir: p.root, role: 'constraint', range: `>=${m[1]}.${m[2]}.0`, display: `>= ${m[1]}.${m[2]}`, source: 'manifest', evidence: ev(pf, line, 'manifest', `TargetFramework net${m[1]}.${m[2]}`) });
    }
  }
  step(ctx, p, 'install', 'install', 'Restore .NET packages', { type: 'exec', argv: ['dotnet', 'restore'] }, `${file.split('/').pop()} defines the project.`, file, { network: true, requires: ['runtime:dotnet'], confidence: 'medium' });
  const web = projFiles.find((f) => /proj$/.test(f) && /Microsoft\.NET\.Sdk\.Web/.test(ctx.files.readText(f) ?? ''));
  if (!web) return;
  run(ctx, p, 'run', `Start ${web.split('/').pop()}`, { type: 'exec', argv: ['dotnet', 'run', '--project', web.split('/').pop()!] }, null, `${web} uses the web SDK; its port is in Properties/launchSettings.json.`, web, [stepId(p.id, 'install')]);
  // Running it needs the ASP.NET Core runtime of the major version it targets. A newer SDK builds it, but the app
  // does not start on a newer runtime major unless the project opts in with RollForward.
  const text = ctx.files.readText(web) ?? '';
  const m = /<TargetFrameworks?>\s*net(\d+)\.(\d+)/.exec(text);
  if (!m) return;
  const anyMajor = /<RollForward>\s*(?:Major|LatestMajor)\s*<\/RollForward>/i.test(text);
  const range = anyMajor ? `>=${m[1]}.${m[2]}.0` : `>=${m[1]}.${m[2]}.0 <${Number(m[1]) + 1}.0.0-0`;
  const evidence = ev(web, text.slice(0, m.index).split('\n').length, 'manifest', `TargetFramework net${m[1]}.${m[2]}${anyMajor ? ', RollForward Major' : ''}`);
  const why = `${web} targets net${m[1]}.${m[2]}, so it runs on the ASP.NET Core ${m[1]} runtime${anyMajor ? ' or newer (RollForward allows newer majors)' : '; a newer major version does not run it'}.`;
  ctx.toolClaims.push({ tool: 'aspnetcore-runtime', project: p.id, optional: false, why, source: 'manifest', evidence });
  ctx.versionClaims.push({ tool: 'aspnetcore-runtime', dir: p.root, role: 'constraint', range, display: anyMajor ? `>= ${m[1]}.${m[2]}` : `${m[1]}.x`, source: 'manifest', evidence });
}

function deno(ctx: Ctx, p: ProjectDraft): void {
  const file = joinRel(p.root, has(ctx, p, 'deno.json') ? 'deno.json' : 'deno.jsonc');
  const doc = readDoc(ctx.files, file, 'json');
  const tasks = asRecord(asRecord(doc?.value).tasks);
  if (tasks.dev) run(ctx, p, 'dev', `Start ${p.name} (deno task dev)`, { type: 'exec', argv: ['deno', 'task', 'dev'] }, null, `${file} defines a dev task: ${asString(tasks.dev)}`, file, []);
  ctx.toolClaims.push({ tool: 'deno', project: p.id, optional: false, why: `${file} marks a Deno project.`, source: 'manifest', evidence: ev(file, undefined, 'manifest', 'deno.json present') });
}

function elixir(ctx: Ctx, p: ProjectDraft): void {
  const file = joinRel(p.root, 'mix.exs');
  const text = ctx.files.readText(file) ?? '';
  step(ctx, p, 'install', 'install', 'Fetch Elixir dependencies', { type: 'exec', argv: ['mix', 'deps.get'] }, 'mix.exs declares the dependencies.', file, { network: true, requires: ['runtime:elixir'] });
  if (/:phoenix\b/.test(text)) run(ctx, p, 'server', `Start ${p.name} (Phoenix)`, { type: 'exec', argv: ['mix', 'phx.server'] }, 4000, 'Phoenix listens on port 4000 by default.', file, [stepId(p.id, 'install')]);
}
