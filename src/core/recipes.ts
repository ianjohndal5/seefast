// Recipe interpreter. Recipes (recipes/*.json) are declarative framework knowledge: detection conditions,
// version requirements, env conventions, first-run steps and run targets. They cannot run code; the few
// computations that need logic are the named functions at the bottom of this file (docs/DECISIONS.md D9).
import type { Ctx, ProjectDraft, StepDraft } from './context.js';
import { ev, withRole, stepId } from './context.js';
import { joinRel } from './fs.js';
import { listData, loadData, serviceForDriver, serviceDef } from './kb.js';
import { majorOf } from './versions.js';
import { nodeExecArgv, nodeRunArgv } from './commands.js';
import { safeValue, redactCommand } from './parse/envfile.js';
import { asRecord, asString, readDoc } from './parse/structured.js';
import type { Action, Confidence, Ecosystem, Evidence, Phase } from './schema.js';

export type Cond =
  | { all: Cond[] } | { any: Cond[] } | { not: Cond }
  | { composer: string } | { dep: string } | { file: string } | { dir: string }
  | { envKey: string } | { envKeyActive: string } | { envValue: string[] } | { envValueNot: string[] }
  | { script: string } | { composerScript: string } | { composerScriptContains: [string, string] }
  | { envFileExists: boolean } | { fn: string };

type Note = string | { when: Cond; text: string };

interface StepSpec {
  id: string;
  phase: Phase;
  order?: number;
  title: string;
  exec?: string[];
  touch?: string;
  after?: string[];
  requires?: string[];
  when?: Cond;
  optional?: boolean;
  optionalWhen?: Cond;
  confidence?: Confidence;
  lowerConfidenceWhen?: Cond;
  network?: boolean;
  thirdPartyCode?: boolean;
  why: string;
  notes?: Note[];
}

interface RunSpec {
  id: string;
  name: string;
  kind: 'dev' | 'production' | 'test' | 'worker';
  primary?: boolean;
  title: string;
  exec: string[];
  port?: number;
  after?: string[];
  when?: Cond;
  demote?: string[];
  confidence?: Confidence;
  why: string;
  notes?: Note[];
}

export interface Recipe {
  id: string;
  name: string;
  ecosystem: Ecosystem;
  reviewed: string;
  sources?: string[];
  detect: Cond;
  version?: { composer?: string; dep?: string };
  requires?: { tool: string; byMajor: Record<string, string> }[];
  env?: {
    file?: string;
    /** Env files the framework's tooling actually loads; used when recipes disagree on the file name. */
    reads?: string[];
    fileConfidence?: Confidence;
    generated?: Record<string, string>;
    optional?: string[];
    required?: string[];
    fillWhen?: Record<string, Cond>;
    notes?: Record<string, string>;
  };
  functions?: string[];
  steps?: StepSpec[];
  run?: RunSpec[];
}

/** What recipes say about a project's env file; merged across recipes. */
export interface EnvSpec {
  /** Env files each recipe's tooling loads. */
  reads: { recipe: string; files: string[] }[];
  generated: Record<string, string>;
  optional: string[];
  required: string[];
  fillWhen: Record<string, boolean>;
  notes: Record<string, string>;
}

let recipesCache: Recipe[] | null = null;
export function loadRecipes(): Recipe[] {
  if (!recipesCache) recipesCache = listData('recipes').map((f) => loadData<Recipe>(f));
  return recipesCache;
}

interface Env {
  ctx: Ctx;
  p: ProjectDraft;
  recipe: Recipe;
  /** Evidence for the positive leaves of the last evaluation. */
  found: Evidence[];
}

function template(p: ProjectDraft) {
  return p.envTemplates[0];
}

function evalCond(c: Cond, e: Env): boolean {
  const { ctx, p } = e;
  const add = (x: Evidence) => e.found.push(x);
  if ('all' in c) return c.all.every((x) => evalCond(x, e));
  if ('any' in c) return c.any.some((x) => evalCond(x, e));
  if ('not' in c) {
    const saved = e.found.length;
    const r = !evalCond(c.not, e);
    e.found.length = saved;
    return r;
  }
  if ('composer' in c) {
    const r = p.php?.require[c.composer] ?? p.php?.requireDev[c.composer];
    if (r && p.php) add(withRole(ev(p.php.manifest.file, p.php.manifest.line([p.php.require[c.composer] ? 'require' : 'require-dev', c.composer]), 'manifest', `"${c.composer}": "${r}"`), 'basis'));
    return Boolean(r);
  }
  if ('dep' in c) {
    const d = p.node?.deps.get(c.dep);
    if (d && p.node) add(withRole(ev(p.node.manifest.file, p.node.manifest.line([d.dev ? 'devDependencies' : 'dependencies', c.dep]), 'manifest', `"${c.dep}": "${d.range}"`), 'basis'));
    return Boolean(d);
  }
  if ('file' in c) {
    const f = joinRel(p.root, c.file);
    const r = ctx.files.isFile(f);
    if (r) add(withRole(ev(f, undefined, 'manifest', `${c.file} exists`), 'basis'));
    return r;
  }
  if ('dir' in c) {
    const f = joinRel(p.root, c.dir);
    const r = ctx.files.isDir(f);
    if (r) add(withRole(ev(f, undefined, 'manifest', `${c.dir}/ exists`), 'basis'));
    return r;
  }
  if ('envKey' in c || 'envKeyActive' in c) {
    const name = 'envKey' in c ? c.envKey : c.envKeyActive;
    const t = template(p);
    const v = t?.vars.find((x) => x.name === name && ('envKey' in c || !x.commented));
    if (v && t) add(withRole(ev(t.file, v.line, 'env-template', `${v.commented ? '# ' : ''}${name}=`), 'basis'));
    return Boolean(v);
  }
  if ('envValue' in c || 'envValueNot' in c) {
    const [name, ...vals] = 'envValue' in c ? c.envValue : c.envValueNot;
    const t = template(p);
    const v = t?.vars.find((x) => x.name === name && !x.commented);
    const sv = v ? safeValue(name, v.raw) : undefined;
    if (!v || sv === undefined) return false;
    const hit = vals.map((x) => x.toLowerCase()).includes(sv.toLowerCase());
    const r = 'envValue' in c ? hit : !hit;
    if (r && t) add(withRole(ev(t.file, v.line, 'env-template', `${name}=${sv}`), 'basis'));
    return r;
  }
  if ('script' in c) {
    const s = p.node?.scripts[c.script];
    if (s && p.node) add(withRole(ev(p.node.manifest.file, p.node.manifest.line(['scripts', c.script]), 'manifest', `scripts.${c.script}: "${redactCommand(s)}"`), 'basis'));
    return Boolean(s);
  }
  if ('composerScript' in c || 'composerScriptContains' in c) {
    const [name, needle] = 'composerScript' in c ? [c.composerScript, ''] : c.composerScriptContains;
    const s = p.php?.scripts[name];
    const r = Boolean(s?.length) && (!needle || s!.some((x) => x.includes(needle)));
    if (r && p.php) add(withRole(ev(p.php.manifest.file, p.php.manifest.line(['scripts', name]), 'manifest', `scripts.${name}`), 'basis'));
    return r;
  }
  if ('envFileExists' in c) {
    const target = joinRel(p.root, e.recipe.env?.file ?? '.env');
    return ctx.files.exists(target) === c.envFileExists;
  }
  if ('fn' in c) {
    const fn = PREDICATES[c.fn];
    if (!fn) throw new Error(`recipe ${e.recipe.id}: unknown predicate ${c.fn}`);
    return fn(ctx, p, add);
  }
  throw new Error(`recipe ${e.recipe.id}: unknown condition ${JSON.stringify(c)}`);
}

function check(c: Cond | undefined, e: Env): { ok: boolean; evidence: Evidence[] } {
  if (!c) return { ok: true, evidence: [] };
  e.found = [];
  const ok = evalCond(c, e);
  return { ok, evidence: e.found };
}

function lower(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}

/** Expand `{run:build}` and `{exec:prisma}` with the project's package manager. */
function expandArgv(argv: string[], p: ProjectDraft): string[] {
  const pm = p.node?.pm ?? 'npm';
  return argv.flatMap((a) => {
    const run = /^\{run:(.+)\}$/.exec(a);
    if (run) return nodeRunArgv(pm, run[1]);
    const exec = /^\{exec:(.+)\}$/.exec(a);
    if (exec) return nodeExecArgv(pm, exec[1], []);
    return [a.replace('{pm}', pm)];
  });
}

/** Local step references → plan step ids (`install` is the Node install, which a workspace root may own). */
function resolveRef(ref: string, p: ProjectDraft, ctx: Ctx): string {
  const opt = ref.endsWith('?');
  const local = opt ? ref.slice(0, -1) : ref;
  const owner = local === 'install' && p.workspaceRoot ? ctx.project(p.workspaceRoot)! : p;
  return stepId(owner.id, local) + (opt ? '?' : '');
}

function notesFor(notes: Note[] | undefined, e: Env): string[] {
  return (notes ?? []).flatMap((n) => (typeof n === 'string' ? [n] : check(n.when, e).ok ? [n.text] : []));
}

export function applyRecipes(ctx: Ctx): void {
  ctx.envSpecs ??= new Map();
  for (const p of ctx.projects) {
    for (const recipe of loadRecipes()) {
      if (!p.ecosystems.has(recipe.ecosystem)) continue;
      const e: Env = { ctx, p, recipe, found: [] };
      const det = check(recipe.detect, e);
      if (!det.ok) continue;
      applyRecipe(ctx, p, recipe, e, det.evidence);
    }
  }
}

function applyRecipe(ctx: Ctx, p: ProjectDraft, recipe: Recipe, e: Env, detectEvidence: Evidence[]): void {
  // Framework and its version.
  let version: string | undefined;
  let versionEv: Evidence | undefined;
  if (recipe.version?.composer && p.php) {
    version = p.php.require[recipe.version.composer] ?? p.php.requireDev[recipe.version.composer];
    versionEv = detectEvidence.find((x) => x.detail.startsWith(`"${recipe.version!.composer}"`));
  } else if (recipe.version?.dep && p.node) {
    version = p.node.deps.get(recipe.version.dep)?.range;
    versionEv = detectEvidence.find((x) => x.detail.startsWith(`"${recipe.version!.dep}"`));
  }
  p.frameworks.push({ id: recipe.id, name: recipe.name, version, confidence: 'high', evidence: detectEvidence });
  const anchor = versionEv ?? detectEvidence[0];

  for (const req of recipe.requires ?? []) {
    if (!version) continue;
    const major = majorOf(version, recipe.ecosystem === 'php' ? 'composer' : 'npm');
    if (major === undefined) continue;
    const keys = Object.keys(req.byMajor).map(Number).sort((a, b) => a - b);
    let key = keys.includes(major) ? major : undefined;
    let assumed = false;
    if (key === undefined && major > keys[keys.length - 1]) {
      key = keys[keys.length - 1];
      assumed = true;
    }
    if (key === undefined) continue;
    const range = req.byMajor[String(key)];
    ctx.versionClaims.push({
      tool: req.tool, dir: p.root, role: 'constraint', range, display: range, source: 'recipe',
      evidence: ev(anchor?.file ?? p.root, anchor?.line, 'recipe', assumed
        ? `${recipe.name} ${major} is newer than this tool knows; assuming it needs ${req.tool} ${range} like ${recipe.name} ${key}`
        : `${recipe.name} ${major} requires ${req.tool} ${range.replace('>=', '>= ')} (${recipe.sources?.[0] ?? `recipe ${recipe.id}`})`),
    });
  }

  if (recipe.env) {
    const spec = ctx.envSpecs!.get(p.id) ?? { reads: [], generated: {}, optional: [], required: [], fillWhen: {}, notes: {} };
    if (recipe.env.file) {
      ctx.choiceClaims.push({ subject: `envTarget@${p.id}`, value: recipe.env.file, source: 'recipe', evidence: ev(anchor?.file ?? p.root, anchor?.line, 'recipe', `${recipe.name} reads ${recipe.env.file}`) });
      spec.reads.push({ recipe: recipe.name, files: recipe.env.reads ?? [recipe.env.file] });
    }
    for (const [k, v] of Object.entries(recipe.env.generated ?? {})) spec.generated[k] = stepId(p.id, v);
    spec.optional.push(...(recipe.env.optional ?? []));
    spec.required.push(...(recipe.env.required ?? []));
    for (const [k, c] of Object.entries(recipe.env.fillWhen ?? {})) spec.fillWhen[k] = check(c, e).ok;
    Object.assign(spec.notes, recipe.env.notes ?? {});
    ctx.envSpecs!.set(p.id, spec);
  }

  for (const fn of recipe.functions ?? []) {
    const f = FUNCTIONS[fn];
    if (!f) throw new Error(`recipe ${recipe.id}: unknown function ${fn}`);
    f(ctx, p);
  }

  for (const s of recipe.steps ?? []) {
    const cond = check(s.when, e);
    if (!cond.ok) continue;
    if (s.id === 'build' && !p.node) continue;
    const action: Action = s.touch ? { type: 'touch', path: s.touch } : { type: 'exec', argv: expandArgv(s.exec ?? [], p) };
    let confidence = s.confidence ?? 'medium';
    if (s.lowerConfidenceWhen && check(s.lowerConfidenceWhen, e).ok) confidence = lower(confidence);
    const optional = Boolean(s.optional) || (s.optionalWhen ? check(s.optionalWhen, e).ok : false);
    const evidence = [
      withRole(ev(anchor?.file ?? p.root, anchor?.line, 'recipe', `${recipe.name} recipe: ${s.title.toLowerCase()}`), 'basis'),
      ...cond.evidence,
    ];
    const fields: Partial<StepDraft> = {
      phase: s.phase, order: s.order ?? 50, title: s.title, action, optional, confidence, why: s.why,
      network: s.network ?? false, thirdPartyCode: s.thirdPartyCode ?? action.type === 'exec',
      after: (s.after ?? []).map((r) => resolveRef(r, p, ctx)), requires: s.requires ?? [],
      notes: notesFor(s.notes, e), evidence,
    };
    const existing = ctx.steps.find((x) => x.project === p.id && x.local === s.id);
    if (existing) {
      Object.assign(existing, { ...fields, action: existing.action, after: [...new Set([...existing.after, ...fields.after!])], notes: [...existing.notes, ...fields.notes!], evidence: [...existing.evidence, ...evidence] });
    } else {
      ctx.addStep({ local: s.id, project: p.id, cwd: p.root, ...(fields as Omit<StepDraft, 'local' | 'project' | 'cwd'>) });
    }
  }

  const demotions: string[] = [];
  for (const r of recipe.run ?? []) {
    const cond = check(r.when, e);
    if (!cond.ok) continue;
    const port = r.port;
    const notes = notesFor(r.notes, e);
    ctx.addRun({
      local: r.id, project: p.id, name: r.name, kind: r.kind, primary: r.primary ?? false, title: r.title, cwd: p.root,
      action: { type: 'exec', argv: expandArgv(r.exec, p) },
      ports: port ? [{ port, confidence: 'medium', evidence: [withRole(ev(anchor?.file ?? p.root, anchor?.line, 'recipe', `${r.exec.join(' ')} listens on port ${port} by default`), 'basis')] }] : [],
      after: (r.after ?? []).map((x) => resolveRef(x, p, ctx)),
      readiness: port ? { type: 'port', port, timeoutSec: 120 } : r.kind === 'test' ? { type: 'exits', timeoutSec: 1800 } : { type: 'stays-up', seconds: 20 },
      confidence: r.confidence ?? 'medium',
      why: r.why + (notes.length ? ' ' + notes.join(' ') : ''),
      evidence: [withRole(ev(anchor?.file ?? p.root, anchor?.line, 'recipe', `${recipe.name} recipe: ${r.title.toLowerCase()}`), 'basis'), ...cond.evidence],
    });
    demotions.push(...(r.demote ?? []));
  }
  for (const run of ctx.runs) if (run.project === p.id && demotions.includes(run.local)) run.primary = false;
}

// ---- Named predicates and functions -----------------------------------------------------------------------

type Predicate = (ctx: Ctx, p: ProjectDraft, add: (e: Evidence) => void) => boolean;

function prismaSchema(ctx: Ctx, p: ProjectDraft): { file: string; text: string } | null {
  for (const rel of ['prisma/schema.prisma', 'schema.prisma']) {
    const f = joinRel(p.root, rel);
    const text = ctx.files.isFile(f) ? ctx.files.readText(f) : null;
    if (text) return { file: f, text };
  }
  const dir = joinRel(p.root, 'prisma/schema');
  for (const e of ctx.files.list(dir)) {
    if (!e.isFile || !e.name.endsWith('.prisma')) continue;
    const f = joinRel(dir, e.name);
    const text = ctx.files.readText(f);
    if (text && /datasource\s+\w+\s*\{/.test(text)) return { file: f, text };
  }
  return null;
}

function prismaProvider(ctx: Ctx, p: ProjectDraft): { provider: string; line: number; file: string; urlEnv?: string } | null {
  const s = prismaSchema(ctx, p);
  if (!s) return null;
  const lines = s.text.split('\n');
  const start = lines.findIndex((l) => /^\s*datasource\s+\w+\s*\{/.test(l));
  if (start < 0) return null;
  let provider: string | undefined;
  let line = start + 1;
  let urlEnv: string | undefined;
  for (let i = start; i < lines.length && !/^\s*\}/.test(lines[i]); i++) {
    const m = /provider\s*=\s*"([^"]+)"/.exec(lines[i]);
    if (m) {
      provider = m[1];
      line = i + 1;
    }
    const u = /url\s*=\s*env\("([A-Z_][A-Z0-9_]*)"\)/.exec(lines[i]);
    if (u) urlEnv = u[1];
  }
  return provider ? { provider, line, file: s.file, urlEnv } : null;
}

const PREDICATES: Record<string, Predicate> = {
  prismaIsSqlite: (ctx, p, add) => {
    const d = prismaProvider(ctx, p);
    if (d?.provider === 'sqlite') add(withRole(ev(d.file, d.line, 'manifest', 'provider = "sqlite"'), 'basis'));
    return d?.provider === 'sqlite';
  },
  prismaHasSeed: (ctx, p, add) => {
    const seed = asString(asRecord(asRecord(p.node?.manifest.value).prisma).seed);
    if (seed && p.node) {
      add(withRole(ev(p.node.manifest.file, p.node.manifest.line(['prisma', 'seed']), 'manifest', `prisma.seed: "${redactCommand(seed)}"`), 'basis'));
      return true;
    }
    for (const f of ['prisma.config.ts', 'prisma.config.js', 'prisma.config.mjs']) {
      const rel = joinRel(p.root, f);
      const text = ctx.files.isFile(rel) ? ctx.files.readText(rel) : null;
      if (text && /\bseed\s*:/.test(text)) {
        add(withRole(ev(rel, text.split('\n').findIndex((l) => /\bseed\s*:/.test(l)) + 1, 'manifest', 'seed configured'), 'basis'));
        return true;
      }
    }
    return false;
  },
};

type Fn = (ctx: Ctx, p: ProjectDraft) => void;

const DRIVER_EXT: Record<string, string> = { mysql: 'pdo_mysql', mariadb: 'pdo_mysql', pgsql: 'pdo_pgsql', postgres: 'pdo_pgsql', sqlite: 'pdo_sqlite', sqlsrv: 'pdo_sqlsrv' };

const FUNCTIONS: Record<string, Fn> = {
  /** Services and PHP extensions implied by a Laravel env template. */
  laravelServices(ctx, p) {
    const t = p.envTemplates[0];
    if (!t) return;
    const get = (name: string) => {
      const v = t.vars.find((x) => x.name === name && !x.commented);
      return v ? { v, value: safeValue(name, v.raw) } : null;
    };
    let db = get('DB_CONNECTION');
    if (!db) {
      // No DB_CONNECTION in the template: the app uses the default in config/database.php (Laravel <= 10: mysql).
      const cfg = joinRel(p.root, 'config/database.php');
      const text = ctx.files.isFile(cfg) ? ctx.files.readText(cfg) : null;
      const lines = text?.split('\n') ?? [];
      const i = lines.findIndex((l) => /'default'\s*=>\s*env\(\s*['"]DB_CONNECTION['"]\s*,\s*['"](\w+)['"]/.test(l));
      const usesDb = t.vars.some((v) => /^DB_(HOST|DATABASE|USERNAME)$/.test(v.name) && !v.commented);
      if (i >= 0 && usesDb) {
        const value = /,\s*['"](\w+)['"]/.exec(lines[i])![1];
        db = { v: { name: 'DB_CONNECTION', line: i + 1, commented: false, valueKind: 'value', raw: value }, value };
        const ext = DRIVER_EXT[value.toLowerCase()];
        const svc = serviceForDriver('DB_CONNECTION', value);
        if (ext) ctx.extClaims.push({ ext, project: p.id, source: 'manifest', evidence: ev(cfg, i + 1, 'manifest', `default connection ${value} (${ext})`) });
        if (svc) ctx.serviceClaims.push({ name: svc, category: 'database', project: p.id, source: 'manifest', scope: 'dev', ports: [serviceDef(svc)?.port ?? 0].filter(Boolean), env: ['DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD'], evidence: ev(cfg, i + 1, 'manifest', `config/database.php defaults to the ${value} connection`) });
        db = null;
      }
    }
    // DB_CONNECTION=sqlite with an explicit relative DB_DATABASE path: that file must exist too.
    const dbFile = get('DB_DATABASE');
    if (db?.value === 'sqlite' && dbFile?.value && /\.sqlite$/.test(dbFile.value) && !dbFile.value.startsWith('/') && !ctx.files.exists(joinRel(p.root, dbFile.value))) {
      ctx.addStep({
        local: 'sqlite', project: p.id, phase: 'database', order: 45, title: 'Create the SQLite database file', cwd: p.root,
        action: { type: 'touch', path: dbFile.value }, network: false, thirdPartyCode: false, confidence: 'high',
        why: `DB_CONNECTION=sqlite with DB_DATABASE=${dbFile.value}; the file is not committed.`,
        evidence: [withRole(ev(t.file, dbFile.v.line, 'env-template', `DB_DATABASE=${dbFile.value}`), 'basis')],
      });
    }
    if (db?.value) {
      const ext = DRIVER_EXT[db.value.toLowerCase()];
      if (ext) ctx.extClaims.push({ ext, project: p.id, source: 'env-template', evidence: ev(t.file, db.v.line, 'env-template', `DB_CONNECTION=${db.value} uses the ${ext} driver`) });
      const svc = serviceForDriver('DB_CONNECTION', db.value);
      if (svc) {
        const port = get('DB_PORT');
        ctx.serviceClaims.push({
          name: svc, category: 'database', project: p.id, source: 'env-template', scope: 'dev',
          ports: port?.value ? [+port.value] : [serviceDef(svc)?.port ?? 0].filter(Boolean),
          env: ['DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD'],
          evidence: ev(t.file, db.v.line, 'env-template', `DB_CONNECTION=${db.value}`),
        });
      }
    }
    const redisUsers = ['CACHE_STORE', 'CACHE_DRIVER', 'QUEUE_CONNECTION', 'SESSION_DRIVER', 'BROADCAST_CONNECTION', 'BROADCAST_DRIVER'].map(get).filter((x) => x?.value?.toLowerCase() === 'redis');
    if (redisUsers.length) {
      const first = redisUsers[0]!;
      ctx.serviceClaims.push({
        name: 'redis', category: 'cache', project: p.id, source: 'env-template', scope: 'dev', ports: [6379], env: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD'],
        evidence: ev(t.file, first.v.line, 'env-template', `${first.v.name}=redis`),
      });
      const client = get('REDIS_CLIENT');
      if ((client?.value ?? 'phpredis').toLowerCase() === 'phpredis') {
        ctx.extClaims.push({ ext: 'redis', project: p.id, source: 'env-template', evidence: ev(t.file, client?.v.line ?? first.v.line, 'env-template', client ? `REDIS_CLIENT=${client.value}` : `${first.v.name}=redis with Laravel's default client phpredis`) });
      }
    }
    for (const name of ['CACHE_STORE', 'CACHE_DRIVER', 'SESSION_DRIVER']) {
      const v = get(name);
      if (v?.value?.toLowerCase() === 'memcached') {
        ctx.serviceClaims.push({ name: 'memcached', category: 'cache', project: p.id, source: 'env-template', scope: 'dev', ports: [11211], evidence: ev(t.file, v.v.line, 'env-template', `${name}=memcached`) });
        ctx.extClaims.push({ ext: 'memcached', project: p.id, source: 'env-template', evidence: ev(t.file, v.v.line, 'env-template', `${name}=memcached`) });
        break;
      }
    }
    const mailer = get('MAIL_MAILER') ?? get('MAIL_DRIVER');
    const mailHost = get('MAIL_HOST');
    if (mailer?.value === 'smtp' && mailHost?.value && /^(mailpit|mailhog)$/.test(mailHost.value)) {
      ctx.serviceClaims.push({ name: mailHost.value, category: 'mail', project: p.id, source: 'env-template', scope: 'dev', optional: true, ports: [1025], env: ['MAIL_HOST', 'MAIL_PORT'], evidence: ev(t.file, mailHost.v.line, 'env-template', `MAIL_HOST=${mailHost.value}`) });
    }
    const scout = get('SCOUT_DRIVER');
    if (scout?.value && /^(meilisearch|typesense)$/.test(scout.value)) {
      ctx.serviceClaims.push({ name: scout.value, category: 'search', project: p.id, source: 'env-template', scope: 'dev', optional: true, evidence: ev(t.file, scout.v.line, 'env-template', `SCOUT_DRIVER=${scout.value}`) });
    }
  },
  /** The database a Prisma schema's datasource needs, and the env variable holding its URL. */
  prismaService(ctx, p) {
    const d = prismaProvider(ctx, p);
    if (!d) return;
    const name = ({ postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', sqlserver: 'sqlserver', mongodb: 'mongodb', cockroachdb: 'cockroachdb' } as Record<string, string>)[d.provider];
    if (name) {
      ctx.serviceClaims.push({
        name, category: 'database', project: p.id, source: 'manifest', scope: 'dev', env: d.urlEnv ? [d.urlEnv] : [],
        ports: [serviceDef(name)?.port ?? 0].filter(Boolean), evidence: ev(d.file, d.line, 'manifest', `datasource provider = "${d.provider}"`),
      });
    }
    if (d.urlEnv) {
      const spec = ctx.envSpecs!.get(p.id) ?? { reads: [], generated: {}, optional: [], required: [], fillWhen: {}, notes: {} };
      if (!spec.required.includes(d.urlEnv)) spec.required.push(d.urlEnv);
      spec.notes[d.urlEnv] = `Connection string for the ${d.provider} database (prisma schema: ${d.file}).`;
      ctx.envSpecs!.set(p.id, spec);
    }
  },
};

export { readDoc };
