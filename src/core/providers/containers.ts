// Container and dev-environment files: Dockerfile (a production image: weak evidence for local setup, good for
// versions and PHP extensions), Compose (services a developer can start), dev containers and Gitpod (the
// maintainers' own dev setup), Procfile.
import type { Ctx } from '../context.js';
import { ev, withRole } from '../context.js';
import { dirOf, joinRel } from '../fs.js';
import { readDoc, asRecord, asString, asStringArray } from '../parse/structured.js';
import { parseDockerfile, parseProcfile } from '../parse/textformats.js';
import { serviceForImage } from '../kb.js';
import { addMentions, containerImageClaims } from './ci.js';
import { taskPurpose } from './php.js';
import { redactCommand } from '../parse/envfile.js';

export function collectContainers(ctx: Ctx): void {
  for (const f of ctx.entries.files) {
    const base = f.split('/').pop()!;
    if (/^(Dockerfile|Containerfile)(\..+)?$|\.Dockerfile$/i.test(base)) dockerfile(ctx, f);
    else if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base) && !/\.(prod|production|ci|test)\./.test(base)) compose(ctx, f);
    else if (base === 'devcontainer.json' || base === '.devcontainer.json') devcontainer(ctx, f);
    else if (base === '.gitpod.yml') gitpod(ctx, f);
    else if (/^Procfile(\.dev)?$/.test(base)) procfile(ctx, f);
  }
}

function dockerfile(ctx: Ctx, file: string): void {
  const text = ctx.files.readText(file);
  if (text === null) return;
  const dir = dirOf(file).replace(/(^|\/)(docker|\.docker|build|deploy|infra|\.devcontainer)(\/.*)?$/, '') || '.';
  const project = ctx.projectAt(dir === '' ? '.' : dir);
  const dev = /\.dev(elop(ment)?)?$|dev\.Dockerfile$/i.test(file) || file.startsWith('.devcontainer/');
  for (const ins of parseDockerfile(text)) {
    if (ins.op === 'FROM') {
      const image = ins.args.split(/\s+/).find((w) => !w.startsWith('--')) ?? '';
      if (!image.includes('$')) containerImageClaims(ctx, file, ins.line, image, project?.root ?? '.', dev ? 'devcontainer' : 'container', `FROM ${image}`);
    } else if (ins.op === 'RUN') {
      for (const m of ins.args.matchAll(/(?:docker-php-ext-install|docker-php-ext-enable|install-php-extensions)\s+((?:[\w@.-]+\s*)+)/g)) {
        for (const e of m[1].split(/\s+/).filter((x) => x && !x.startsWith('-') && !x.startsWith('$'))) {
          const ext = e.replace(/@.*$/, '').toLowerCase();
          const php = project?.php ? project : ctx.projects.find((p) => p.php);
          if (php) ctx.extClaims.push({ ext, project: php.id, source: 'container', evidence: ev(file, ins.line, 'container', `${file.split('/').pop()} installs PHP extension ${ext}`) });
        }
      }
      for (const m of ins.args.matchAll(/pecl\s+install\s+(?:-[\w-]+\s+)*([\w-]+)/g)) {
        const php = project?.php ? project : ctx.projects.find((p) => p.php);
        if (php) ctx.extClaims.push({ ext: m[1].toLowerCase().replace(/-\d.*$/, ''), project: php.id, source: 'container', evidence: ev(file, ins.line, 'container', `pecl install ${m[1]}`) });
      }
      addMentions(ctx, ins.args, file, ins.line, project?.root ?? '.', 'container', dev ? 'dev' : 'prod');
    }
  }
}

/** `"${FORWARD_DB_PORT:-3306}:3306"` → 3306; `127.0.0.1:5432:5432` → 5432; `5432` → null (random host port). */
export function composeHostPort(spec: unknown): number | null {
  if (typeof spec === 'number') return null;
  const r = asRecord(spec);
  if (r.published !== undefined) return Number(String(r.published).replace(/\$\{[^:}]+:-?(\d+)\}/, '$1')) || null;
  const s = asString(spec);
  if (!s) return null;
  const resolved = s.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, '$1').replace(/\/(tcp|udp)$/, '');
  if (resolved.includes('$')) return null;
  const parts = resolved.split(':');
  if (parts.length < 2) return null;
  const host = parts[parts.length - 2];
  return /^\d+$/.test(host) ? +host : null;
}

function compose(ctx: Ctx, file: string): void {
  const doc = readDoc(ctx.files, file, 'yaml');
  if (!doc) return;
  const dir = dirOf(file);
  for (const [name, raw] of Object.entries(asRecord(asRecord(doc.value).services))) {
    const svc = asRecord(raw);
    const image = asString(svc.image);
    const ports = (Array.isArray(svc.ports) ? svc.ports : []).map(composeHostPort).filter((x): x is number => x !== null);
    if (svc.build !== undefined) {
      ctx.composeApps.push({ file, service: name, line: doc.line(['services', name]) });
      continue;
    }
    if (!image) continue;
    const known = serviceForImage(image.replace(/\$\{[^}]*:-([^}]*)\}/g, '$1'));
    if (!known) {
      ctx.composeOther.push({ file, service: name, image, ports, line: doc.line(['services', name]) });
      continue;
    }
    const profiles = asStringArray(svc.profiles);
    ctx.serviceClaims.push({
      name: known.def.name,
      category: known.def.category,
      version: known.version,
      ports,
      provider: { type: 'compose', file, service: name, image },
      scope: profiles.length ? 'ci' : 'dev',
      source: 'compose',
      evidence: ev(file, doc.line(['services', name]), 'compose', `service "${name}": image ${image}${ports.length ? `, port ${ports.join(', ')}` : ''}${profiles.length ? ` (profiles: ${profiles.join(', ')})` : ''}`),
      project: ctx.projectAt(dir)?.id,
    });
  }
}

function lifecycleCommands(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return [v.map(String).join(' ')];
  return Object.values(asRecord(v)).flatMap(lifecycleCommands);
}

function devcontainer(ctx: Ctx, file: string): void {
  const doc = readDoc(ctx.files, file, 'json');
  if (!doc) return;
  const d = asRecord(doc.value);
  const root = file.startsWith('.devcontainer/') || file === '.devcontainer.json' ? '.' : dirOf(dirOf(file));
  const image = asString(d.image);
  if (image) containerImageClaims(ctx, file, doc.line(['image']), image, root, 'devcontainer', `dev container image ${image}`);
  for (const [feature, opts] of Object.entries(asRecord(d.features))) {
    const m = /features\/([\w-]+)(?::\d+)?$/.exec(feature.split('@')[0]);
    if (!m) continue;
    const tool = ({ node: 'node', php: 'php', python: 'python', go: 'go', rust: 'rust', ruby: 'ruby', java: 'java', dotnet: 'dotnet' } as Record<string, string>)[m[1]];
    const version = asString(asRecord(opts).version);
    if (tool && version && version !== 'latest' && version !== 'lts') {
      containerImageClaims(ctx, file, doc.line(['features', feature]), `${tool === 'go' ? 'golang' : tool}:${version}`, root, 'devcontainer', `dev container feature ${m[1]} version ${version}`);
    }
  }
  for (const key of ['onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand']) {
    const cmds = lifecycleCommands(d[key]);
    if (!cmds.length) continue;
    const line = doc.line([key]) ?? 1;
    ctx.tasks.push({ runner: 'devcontainer', name: key, project: ctx.projectAt(root)?.id ?? 'root', file, line, commands: cmds.map(redactCommand), purpose: key === 'postStartCommand' ? 'run' : 'setup' });
    for (const c of cmds) addMentions(ctx, c, file, line, root, 'devcontainer', 'dev');
  }
  for (const port of Array.isArray(d.forwardPorts) ? d.forwardPorts : []) {
    if (typeof port === 'number') ctx.portHints.push({ port, evidence: withRole(ev(file, doc.line(['forwardPorts']), 'devcontainer', `forwardPorts includes ${port}`), 'supports') });
  }
}

function gitpod(ctx: Ctx, file: string): void {
  const doc = readDoc(ctx.files, file, 'yaml');
  if (!doc) return;
  const g = asRecord(doc.value);
  (Array.isArray(g.tasks) ? g.tasks : []).forEach((t: unknown, i: number) => {
    const task = asRecord(t);
    for (const key of ['before', 'init', 'command']) {
      const cmd = asString(task[key]);
      if (!cmd) continue;
      const line = doc.line(['tasks', i, key]) ?? 1;
      ctx.tasks.push({ runner: 'gitpod', name: `${asString(task.name) ?? `task ${i + 1}`} (${key})`, project: 'root', file, line, commands: cmd.split('\n').filter(Boolean).map(redactCommand), purpose: key === 'command' ? 'run' : 'setup' });
      addMentions(ctx, cmd, file, line + (/[|>]\s*$/.test(doc.text.split('\n')[line - 1] ?? '') ? 1 : 0), '.', 'devcontainer', 'dev');
    }
  });
  for (const p of Array.isArray(g.ports) ? g.ports : []) {
    const port = Number(asRecord(p).port);
    if (port) ctx.portHints.push({ port, evidence: withRole(ev(file, doc.line(['ports']), 'devcontainer', `Gitpod exposes port ${port}`), 'supports') });
  }
}

function procfile(ctx: Ctx, file: string): void {
  const text = ctx.files.readText(file);
  if (text === null) return;
  const dir = dirOf(file);
  const project = ctx.projectAt(dir)?.id ?? 'root';
  for (const t of parseProcfile(text)) {
    ctx.tasks.push({ runner: 'procfile', name: t.name, project, file, line: t.line, commands: t.commands.map(redactCommand), purpose: t.name === 'release' ? 'setup' : 'run' });
  }
  void joinRel;
}

export { taskPurpose };
