// The bundled knowledge base (kb/*.json) and recipes (recipes/*.json), loaded from the package itself.
// These are the tool's own files, read once; the analyzed project is only ever read through ProjectFiles.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ServiceCategory } from './schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Package root: src/core or dist/core → two levels up. */
export const PACKAGE_ROOT = path.resolve(here, '..', '..');

const cache = new Map<string, unknown>();
export function loadData<T>(rel: string): T {
  if (!cache.has(rel)) cache.set(rel, JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8')));
  return cache.get(rel) as T;
}

export function listData(dir: string): string[] {
  return fs
    .readdirSync(path.join(PACKAGE_ROOT, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => `${dir}/${f}`);
}

interface ServerDef {
  bin: string;
  sub: string[];
  kind: 'dev' | 'production';
  port: number | null;
  portFlags?: string[];
  portEnv?: string;
  needsBuild?: boolean;
  requiresFlag?: string;
  note?: string;
}

interface DevServers {
  reviewed: string;
  servers: ServerDef[];
  orchestrators: string[];
  genericServers: string[];
}

export interface ServerMatch {
  bin: string;
  kind: 'dev' | 'production';
  /** Port from a flag in the command, else the tool's default; null when the code decides. */
  port: number | null;
  portSource: 'flag' | 'default' | 'none';
  needsBuild: boolean;
  note?: string;
}

/** Recognise a dev/production server command (`next dev -p 4000`, `php artisan serve`, `vite`). */
export function matchServer(argv: string[]): ServerMatch | null {
  const kb = loadData<DevServers>('kb/dev-servers.json');
  let a = argv;
  // Unwrap `php artisan`, `python manage.py`, `npx next`, `bunx vite`, `cross-env X=1 next dev`.
  while (a.length && ['npx', 'bunx', 'pnpx', 'cross-env', 'dotenv', 'env-cmd', 'php', 'python', 'python3', 'bundle', 'exec'].includes(a[0].replace(/\.(cmd|exe)$/, ''))) {
    a = a.slice(1);
    if (a[0] === 'exec') a = a.slice(1);
    while (a.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]) || a[0].startsWith('-') || a[0] === '--')) {
      if (/^-e$|^-f$/.test(a[0])) a = a.slice(1);
      a = a.slice(1);
    }
  }
  if (!a.length) return null;
  const bin = a[0].replace(/^\.\//, '').replace(/^bin\//, '').replace(/^node_modules\/\.bin\//, '');
  // The subcommand is the first word-like positional (`vite --port 8080` has none; 8080 is a flag's value).
  const positional = a.slice(1).filter((x) => !x.startsWith('-'));
  const sub = positional.find((x) => /^[a-z][\w:-]*$/i.test(x) && !/^\d/.test(x)) ?? (positional.length && /^\.?$/.test(positional[0]) ? positional[0] : '');
  for (const s of kb.servers) {
    if (s.bin !== bin) continue;
    if (!s.sub.includes('*') && !s.sub.includes(sub)) continue;
    if (s.requiresFlag && !a.includes(s.requiresFlag)) continue;
    let port = s.port;
    let portSource: ServerMatch['portSource'] = port === null ? 'none' : 'default';
    for (let i = 1; i < a.length; i++) {
      const eq = /^(-{1,2}[A-Za-z]+)=(\d+)$/.exec(a[i]);
      if (eq && s.portFlags?.includes(eq[1])) {
        port = +eq[2];
        portSource = 'flag';
      } else if (s.portFlags?.includes(a[i]) && /^\d+$/.test(a[i + 1] ?? '')) {
        port = +a[i + 1];
        portSource = 'flag';
      }
    }
    // `manage.py runserver 0.0.0.0:8080`, `php -S localhost:8000`
    const hostPort = positional.slice(1).find((x) => /^([\w.]+:)?\d{2,5}$/.test(x));
    if (bin === 'manage.py' && hostPort) {
      port = +hostPort.split(':').pop()!;
      portSource = 'flag';
    }
    return { bin, kind: s.kind, port, portSource, needsBuild: Boolean(s.needsBuild), note: s.note };
  }
  return null;
}

export function isOrchestrator(bin: string): boolean {
  return loadData<DevServers>('kb/dev-servers.json').orchestrators.includes(bin);
}

export function isGenericServer(bin: string): boolean {
  return loadData<DevServers>('kb/dev-servers.json').genericServers.includes(bin);
}

interface ServiceDef {
  name: string;
  category: ServiceCategory;
  port: number;
  images: string[];
}
interface ServicesKb {
  reviewed: string;
  services: ServiceDef[];
  envDrivers: Record<string, Record<string, string | null>>;
  urlSchemes: Record<string, string>;
}

export function serviceDef(name: string): ServiceDef | undefined {
  return loadData<ServicesKb>('kb/services.json').services.find((s) => s.name === name);
}

/** `mysql:8.0` → { def, version: '8.0' }; `docker.io/library/postgres:16-alpine` → postgres 16. */
export function serviceForImage(image: string): { def: ServiceDef; version?: string } | null {
  const kb = loadData<ServicesKb>('kb/services.json');
  let name = image.trim().replace(/@sha256:.*$/, '');
  let tag: string | undefined;
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
  }
  name = name.replace(/^(docker\.io\/)?(library\/)?/, '');
  for (const def of kb.services) {
    if (def.images.includes(name)) {
      const v = tag && /^\d/.test(tag) ? /^\d+(\.\d+){0,2}/.exec(tag)?.[0] : undefined;
      return { def, version: v };
    }
  }
  return null;
}

/** `DB_CONNECTION=pgsql` → postgres; null for sqlite / sync (no service); undefined when the key is not a driver. */
export function serviceForDriver(key: string, value: string): string | null | undefined {
  const map = loadData<ServicesKb>('kb/services.json').envDrivers[key];
  if (!map || typeof map !== 'object') return undefined;
  const v = value.toLowerCase();
  return v in map ? map[v] : undefined;
}

export function serviceForScheme(scheme: string): string | undefined {
  return loadData<ServicesKb>('kb/services.json').urlSchemes[scheme.toLowerCase()];
}

/** Date of the knowledge base: the most recent `reviewed` date across kb and recipe files. */
export function knowledgeBaseDate(): string {
  const dates: string[] = [];
  for (const f of [...listData('kb'), ...listData('recipes')]) {
    const r = (loadData<{ reviewed?: string }>(f) ?? {}).reviewed;
    if (r) dates.push(r);
  }
  return dates.sort().pop() ?? 'unknown';
}
