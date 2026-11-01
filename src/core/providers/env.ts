// Env templates and env variables read by the code. Real env files are never opened (fs.ts enforces it); only
// their existence is noted. Code is read as text with regular expressions: nothing is imported or evaluated.
import type { Ctx } from '../context.js';
import { ev } from '../context.js';
import { isEnvTemplateName, isSecretFile, joinRel } from '../fs.js';
import { parseEnvTemplate, safeValue } from '../parse/envfile.js';
import { serviceDef, serviceForScheme } from '../kb.js';

/** `DATABASE_URL=postgres://…`, `REDIS_URL=redis://…`: the scheme names the service (any framework). */
export function collectEnvServices(ctx: Ctx): void {
  for (const p of ctx.projects) {
    const t = p.envTemplates[0];
    if (!t) continue;
    for (const v of t.vars) {
      if (v.commented || v.valueKind !== 'value') continue;
      const sv = safeValue(v.name, v.raw);
      const m = sv ? /^([a-z][a-z0-9+.-]*):\/\/([^:/]*)(?::(\d+))?/i.exec(sv) : null;
      if (!m) continue;
      const name = serviceForScheme(m[1]);
      const def = name ? serviceDef(name) : undefined;
      if (!name || !def) continue;
      ctx.serviceClaims.push({
        name, category: def.category, project: p.id, source: 'env-template', scope: 'dev',
        ports: [m[3] ? +m[3] : def.port], env: [v.name],
        evidence: ev(t.file, v.line, 'env-template', `${v.name}=${m[1]}://${m[2] || '…'}${m[3] ? ':' + m[3] : ''}`),
      });
    }
  }
}

export const TEMPLATE_ORDER: readonly string[] = ['.env.example', '.env.local.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', '.env.development.example', 'example.env'];

export function collectEnvTemplates(ctx: Ctx): void {
  for (const p of ctx.projects) {
    const names = ctx.files.list(p.root).filter((e) => e.isFile).map((e) => e.name);
    const templates = names.filter((n) => isEnvTemplateName(n));
    templates.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
    for (const t of templates) {
      const file = joinRel(p.root, t);
      const text = ctx.files.readText(file);
      if (text === null) continue;
      p.envTemplates.push({ file, vars: parseEnvTemplate(text) });
    }
    p.envFilesPresent = names.filter((n) => n.startsWith('.env') && isSecretFile(n)).map((n) => joinRel(p.root, n));
  }
}

function rank(name: string): number {
  const i = TEMPLATE_ORDER.indexOf(name.toLowerCase());
  return i < 0 ? TEMPLATE_ORDER.length : i;
}

/** Variables provided by the platform or tooling, not by the developer. */
const IGNORED = /^(NODE_ENV|CI|HOME|PATH|PWD|TZ|LANG|USER|SHELL|TMPDIR|TEMP|TMP|HOSTNAME|DEBUG|INIT_CWD|npm_.*|NEXT_RUNTIME|NEXT_PHASE|__NEXT.*|NEXT_TELEMETRY_DISABLED|VERCEL.*|NETLIFY.*|GITHUB_.*|RUNNER_.*|JEST_.*|VITEST.*|BUILD_ID|ANALYZE|BUNDLE_ANALYZE|PLAYWRIGHT.*|CYPRESS.*|DEV|PROD|MODE|SSR|BASE_URL|APP_RUNNING_IN_CONSOLE|LARAVEL_.*|PHP_.*|COMPOSER.*|XDG_.*|TERM|COLORTERM|FORCE_COLOR|NO_COLOR|PORT_?)$/;

const JS_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte|astro)$/;
const MAX_CODE_FILES = 4000;
const MAX_CODE_BYTES = 512 * 1024;

export function collectCodeEnvReads(ctx: Ctx): void {
  let scanned = 0;
  for (const f of ctx.entries.files) {
    if (scanned >= MAX_CODE_FILES) {
      ctx.files.count('code files over the env-scan limit');
      continue;
    }
    const isJs = JS_EXT.test(f) && !/\.(d\.ts|min\.js|config\.(js|ts|mjs|cjs)\.map)$/.test(f) && !/(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)\//.test(f);
    const isPhpConfig = /(^|\/)config\/[^/]+\.php$/.test(f);
    const isPy = /\.py$/.test(f) && !/(^|\/)(tests?|migrations)\//.test(f);
    if (!isJs && !isPhpConfig && !isPy) continue;
    const p = ctx.projectAt(f);
    if (!p) continue;
    if (isJs && !p.ecosystems.has('node') && !p.ecosystems.has('deno')) continue;
    if (isPhpConfig && !p.ecosystems.has('php')) continue;
    if (isPy && !p.ecosystems.has('python')) continue;
    const text = ctx.files.readText(f, MAX_CODE_BYTES);
    if (text === null) continue;
    scanned++;
    const re = isJs
      ? /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]|import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g
      : isPhpConfig
        ? /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g
        : /os\.environ\[['"]([A-Z_][A-Z0-9_]*)['"]\]|os\.(?:environ\.get|getenv)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g;
    let map = ctx.codeEnvReads.get(p.id);
    if (!map) ctx.codeEnvReads.set(p.id, (map = new Map()));
    const lines = text.split('\n');
    if (isJs && !ctx.codePortDefaults.has(p.id)) {
      const i = lines.findIndex((l) => /process\.env\.PORT\s*(\|\||\?\?)\s*['"]?\d{2,5}/.test(l));
      if (i >= 0) {
        const port = +/(\d{2,5})/.exec(lines[i].slice(lines[i].indexOf('process.env.PORT')))![1];
        ctx.codePortDefaults.set(p.id, { port, evidence: ev(f, i + 1, 'code', lines[i].trim().slice(0, 120)) });
      }
    }
    lines.forEach((line, i) => {
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const name = m[1] ?? m[2] ?? m[3];
        if (!name || IGNORED.test(name)) continue;
        const list = map!.get(name) ?? [];
        if (list.length < 3) list.push(ev(f, i + 1, 'code', m[0]));
        map!.set(name, list);
      }
    });
  }
  ctx.codeFilesScanned = scanned;
}
