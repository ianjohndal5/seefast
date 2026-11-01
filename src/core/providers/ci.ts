// CI workflows read statically: GitHub Actions (setup actions, matrices, service containers, run steps) and
// GitLab CI (images, services, scripts). CI is a test environment: its commands corroborate setup steps, its
// versions are tested versions, and its services are what the *tests* use.
import type { Ctx } from '../context.js';
import { ev } from '../context.js';
import { joinRel } from '../fs.js';
import { readDoc, asRecord, asString, asStringArray, type Doc } from '../parse/structured.js';
import { classifyLine } from '../commands.js';
import { parsePin } from '../versions.js';
import { redactCommand } from '../parse/envfile.js';
import { serviceForImage } from '../kb.js';

/** Workflow names that are not about building or testing the project. */
const IRRELEVANT = /(release|publish|deploy|stale|label|greet|codeql|dependabot|lock|triage|welcome|sponsor|docs-deploy|pages|cla|backport|changelog|issue|pr-title|semantic)/i;

const SETUP_ACTIONS: Record<string, { tool: string; key: string; fileKey?: string }> = {
  'actions/setup-node': { tool: 'node', key: 'node-version', fileKey: 'node-version-file' },
  'shivammathur/setup-php': { tool: 'php', key: 'php-version', fileKey: 'php-version-file' },
  'actions/setup-python': { tool: 'python', key: 'python-version', fileKey: 'python-version-file' },
  'actions/setup-go': { tool: 'go', key: 'go-version', fileKey: 'go-version-file' },
  'ruby/setup-ruby': { tool: 'ruby', key: 'ruby-version' },
  'actions/setup-java': { tool: 'java', key: 'java-version', fileKey: 'java-version-file' },
  'actions/setup-dotnet': { tool: 'dotnet', key: 'dotnet-version' },
  'oven-sh/setup-bun': { tool: 'bun', key: 'bun-version', fileKey: 'bun-version-file' },
  'pnpm/action-setup': { tool: 'pnpm', key: 'version' },
  'denoland/setup-deno': { tool: 'deno', key: 'deno-version' },
};

export function collectCi(ctx: Ctx): void {
  for (const f of ctx.entries.files) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) githubWorkflow(ctx, f);
    else if (f === '.gitlab-ci.yml') gitlab(ctx, f);
  }
}

/** Expand `${{ matrix.x }}` against the job matrix: one value per matrix entry. */
function expand(value: string, matrix: Record<string, string[]>): { values: string[]; fromMatrix: boolean } {
  const m = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(value.trim());
  if (m) return { values: matrix[m[1]] ?? [], fromMatrix: true };
  if (value.includes('${{')) return { values: [], fromMatrix: false };
  return { values: [value], fromMatrix: false };
}

function githubWorkflow(ctx: Ctx, file: string): void {
  const doc = readDoc(ctx.files, file, 'yaml');
  if (!doc) return;
  const wf = asRecord(doc.value);
  const name = asString(wf.name) ?? file;
  if (IRRELEVANT.test(name) || IRRELEVANT.test(file.split('/').pop()!)) {
    ctx.files.count('CI workflow not about build or test');
    return;
  }
  for (const [jobId, jobRaw] of Object.entries(asRecord(wf.jobs))) {
    const job = asRecord(jobRaw);
    if (IRRELEVANT.test(jobId) && !/test|build|ci/i.test(jobId)) continue;
    const matrix: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(asRecord(asRecord(job.strategy).matrix))) {
      if (k === 'include' || k === 'exclude') continue;
      matrix[k] = asStringArray(v);
    }
    for (const inc of Array.isArray(asRecord(asRecord(job.strategy).matrix).include) ? (asRecord(asRecord(job.strategy).matrix).include as unknown[]) : []) {
      for (const [k, v] of Object.entries(asRecord(inc))) {
        const s = asString(v);
        if (s && !(matrix[k] ?? []).includes(s)) (matrix[k] ??= []).push(s);
      }
    }
    const defaultsWd = asString(asRecord(asRecord(job.defaults).run)['working-directory']);
    // Service containers
    for (const [svcName, svcRaw] of Object.entries(asRecord(job.services))) {
      const svc = asRecord(svcRaw);
      const image = asString(svc.image) ?? (typeof svcRaw === 'string' ? svcRaw : undefined);
      if (!image) continue;
      for (const img of expand(image, matrix).values) {
        const s = serviceForImage(img);
        if (!s) continue;
        ctx.serviceClaims.push({
          name: s.def.name, category: s.def.category, version: s.version, scope: 'ci', source: 'ci',
          evidence: ev(file, doc.line(['jobs', jobId, 'services', svcName]), 'ci', `CI job "${jobId}" runs service container ${img}`),
        });
      }
    }
    if (asString(asRecord(job.container).image) ?? asString(job.container)) {
      const img = asString(asRecord(job.container).image) ?? asString(job.container)!;
      containerImageClaims(ctx, file, doc.line(['jobs', jobId, 'container']), img, '.', 'ci', `CI job "${jobId}" runs in ${img}`);
    }
    const steps = Array.isArray(job.steps) ? (job.steps as unknown[]) : [];
    steps.forEach((stepRaw, i) => {
      const step = asRecord(stepRaw);
      const uses = asString(step.uses)?.split('@')[0];
      const wd = asString(step['working-directory']) ?? defaultsWd ?? '.';
      const dir = joinRel(wd.replace(/\$\{\{.*?\}\}/g, ''));
      if (uses && SETUP_ACTIONS[uses]) {
        const def = SETUP_ACTIONS[uses];
        const w = asRecord(step.with);
        const line = doc.line(['jobs', jobId, 'steps', i, 'with', def.key]) ?? doc.line(['jobs', jobId, 'steps', i]);
        const raw = asString(w[def.key]);
        if (raw) {
          const { values, fromMatrix } = expand(raw, matrix);
          for (const v of values.flatMap((x) => x.split(/\s*\n\s*|\s*,\s*/)).filter(Boolean)) {
            const pin = parsePin(v);
            if (pin?.range) {
              ctx.versionClaims.push({
                tool: def.tool, dir, role: 'preference', range: pin.range, display: pin.display, source: 'ci', matrix: fromMatrix || values.length > 1,
                evidence: ev(file, line, 'ci', `${uses} ${def.key}: ${v}${fromMatrix ? ' (matrix)' : ''}`),
              });
            }
          }
        }
        if (uses === 'actions/setup-node') {
          const cache = asString(w.cache);
          if (cache && /^(npm|pnpm|yarn)$/.test(cache)) ctx.choiceClaims.push({ subject: `pm-dir:node@${dir}`, value: cache, source: 'ci', evidence: ev(file, doc.line(['jobs', jobId, 'steps', i, 'with', 'cache']), 'ci', `actions/setup-node cache: ${cache}`) });
        }
        if (uses === 'pnpm/action-setup') ctx.choiceClaims.push({ subject: `pm-dir:node@${dir}`, value: 'pnpm', source: 'ci', evidence: ev(file, doc.line(['jobs', jobId, 'steps', i]), 'ci', 'uses pnpm/action-setup') });
        if (uses === 'oven-sh/setup-bun') ctx.choiceClaims.push({ subject: `pm-dir:node@${dir}`, value: 'bun', source: 'ci', evidence: ev(file, doc.line(['jobs', jobId, 'steps', i]), 'ci', 'uses oven-sh/setup-bun') });
        if (uses === 'shivammathur/setup-php') {
          const exts = asString(w.extensions);
          if (exts) {
            for (const e of exts.split(/\s*,\s*/).filter((x) => x && !x.startsWith(':') && !x.includes('${{'))) {
              const ext = e.replace(/-.*$/, '').toLowerCase();
              const p = ctx.projectAt(dir === '.' ? '.' : dir) ?? ctx.projects.find((x) => x.php);
              if (p?.php) ctx.extClaims.push({ ext, project: p.id, source: 'ci', evidence: ev(file, doc.line(['jobs', jobId, 'steps', i, 'with', 'extensions']), 'ci', `setup-php extensions: ${e}`) });
            }
          }
        }
      }
      const run = asString(step.run);
      if (run) {
        const runLine = doc.line(['jobs', jobId, 'steps', i, 'run']) ?? 1;
        // `run: |` puts the first command on the next line.
        const block = /run:\s*[|>][-+]?\d*\s*$/.test(doc.text.split('\n')[runLine - 1] ?? '') ? 1 : 0;
        addMentions(ctx, run, file, runLine + block, dir, 'ci', 'ci');
      }
    });
  }
}

/** Command mentions from a block of shell text; one mention per classified command, with its own line. */
export function addMentions(ctx: Ctx, text: string, file: string, firstLine: number, dir: string, source: 'ci' | 'readme' | 'task-runner' | 'devcontainer' | 'container', scope: 'dev' | 'ci' | 'prod', blockLineOffset = 1): void {
  let cwd = dir;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    while (l.trimEnd().endsWith('\\') && i + 1 < lines.length) l = l.trimEnd().slice(0, -1) + ' ' + lines[++i];
    for (const sig of classifyLine(l)) {
      if (sig.kind === 'cd') {
        const target = sig.key.slice(3);
        if (target && /^[\w./-]+$/.test(target) && !target.startsWith('/') && ctx.files.isDir(joinRel(cwd, target))) cwd = joinRel(cwd, target);
        continue;
      }
      const project = ctx.projectAt(cwd)?.id;
      ctx.mentions.push({ project, sig, source, scope, evidence: ev(file, firstLine + i + (blockLineOffset - 1), source, redactCommand(l.trim()).slice(0, 160)) });
    }
  }
}

/** A container image names a runtime version: `node:20-alpine`, `php:8.3-fpm`, `python:3.12-slim`. */
export function containerImageClaims(ctx: Ctx, file: string, line: number | undefined, image: string, dir: string, source: 'ci' | 'container' | 'devcontainer', detail: string): void {
  const m = /^(?:docker\.io\/)?(?:library\/)?(node|php|python|ruby|golang|rust|openjdk|eclipse-temurin|amazoncorretto|elixir|denoland\/deno|oven\/bun|mcr\.microsoft\.com\/dotnet\/sdk|composer)(?::([^@\s]+))?/.exec(image);
  if (m) {
    const tool = ({ golang: 'go', openjdk: 'java', 'eclipse-temurin': 'java', amazoncorretto: 'java', 'denoland/deno': 'deno', 'oven/bun': 'bun', 'mcr.microsoft.com/dotnet/sdk': 'dotnet' } as Record<string, string>)[m[1]] ?? m[1];
    const pin = m[2] ? parsePin(m[2]) : null;
    if (pin?.range && tool !== 'composer') ctx.versionClaims.push({ tool, dir, role: 'preference', range: pin.range, display: pin.display, source, evidence: ev(file, line, source, detail) });
    return;
  }
  // Dev container images: mcr.microsoft.com/devcontainers/typescript-node:1-20-bookworm, .../php:1-8.2
  const dc = /devcontainers\/(javascript-node|typescript-node|php|python|go|rust|ruby|java|dotnet)(?::(?:\d+-)?(\d+(?:\.\d+)?))?/.exec(image);
  if (dc && dc[2]) {
    const tool = ({ 'javascript-node': 'node', 'typescript-node': 'node' } as Record<string, string>)[dc[1]] ?? dc[1];
    const pin = parsePin(dc[2]);
    if (pin?.range) ctx.versionClaims.push({ tool, dir, role: 'preference', range: pin.range, display: pin.display, source, evidence: ev(file, line, source, detail) });
  }
}

function gitlab(ctx: Ctx, file: string): void {
  const doc: Doc | null = readDoc(ctx.files, file, 'yaml');
  if (!doc) return;
  const root = asRecord(doc.value);
  const handleImage = (img: string | undefined, path: (string | number)[]) => {
    if (img) containerImageClaims(ctx, file, doc.line(path), img, '.', 'ci', `GitLab CI image ${img}`);
  };
  handleImage(asString(root.image) ?? asString(asRecord(root.image).name), ['image']);
  const services = (key: unknown, path: (string | number)[]) => {
    (Array.isArray(key) ? key : []).forEach((s, i) => {
      const img = asString(s) ?? asString(asRecord(s).name);
      const svc = img ? serviceForImage(img) : null;
      if (svc) ctx.serviceClaims.push({ name: svc.def.name, category: svc.def.category, version: svc.version, scope: 'ci', source: 'ci', evidence: ev(file, doc.line([...path, i]), 'ci', `GitLab CI service ${img}`) });
    });
  };
  services(root.services, ['services']);
  for (const [jobId, jobRaw] of Object.entries(root)) {
    const job = asRecord(jobRaw);
    if (jobId.startsWith('.') && !job.script) continue;
    if (!job.script && !job.before_script) continue;
    if (IRRELEVANT.test(jobId) || asString(job.stage) === 'deploy') continue;
    handleImage(asString(job.image) ?? asString(asRecord(job.image).name), [jobId, 'image']);
    services(job.services, [jobId, 'services']);
    for (const key of ['before_script', 'script']) {
      asStringArray(job[key]).forEach((cmd, i) => addMentions(ctx, cmd, file, doc.line([jobId, key, i]) ?? 1, '.', 'ci', 'ci'));
    }
  }
}
