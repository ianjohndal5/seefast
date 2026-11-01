// Scan: a bounded breadth-first walk that records directories and files, then project detection from markers.
import { isSecretFile, joinRel } from './fs.js';
import { cmp } from './text.js';
import type { Ctx, ProjectDraft } from './context.js';
import { ev, withRole } from './context.js';
import type { Ecosystem } from './schema.js';

export const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'bower_components', 'jspm_packages', '.git', '.hg', '.svn',
  'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.vercel', '.netlify', '.cache', '.parcel-cache',
  'coverage', '.nyc_output', 'target', '.gradle', '.mvn', 'bin', 'obj', '.venv', 'venv', 'env', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache',
  'storage', 'tmp', 'temp', 'log', 'logs', 'public', '.idea', '.vs', '.vscode', '.terraform', 'Pods', 'DerivedData', '.dart_tool', '_build', 'deps',
  '.seefast', '.seammap', '.yarn', '.pnpm-store', '.angular', '.expo', 'site-packages', 'elm-stuff', '.stack-work', '.bundle',
]);
/** Directories that hold example or test projects, not parts of this one. */
export const EXAMPLE_DIRS = new Set(['examples', 'example', 'fixtures', '__fixtures__', 'testdata', 'test-fixtures', 'samples', 'sample', 'templates', 'template', 'stubs', 'e2e-fixtures']);
/** Dot-directories that hold evidence. */
const EVIDENCE_DOT_DIRS = new Set(['.github', '.devcontainer', '.circleci', '.gitlab', '.husky', '.config']);

export interface ScanOptions {
  maxDepth: number;
  maxEntries: number;
}

export const DEFAULT_SCAN: ScanOptions = { maxDepth: 5, maxEntries: 40_000 };

export function scan(ctx: Ctx, opts: ScanOptions = DEFAULT_SCAN): void {
  const { files } = ctx;
  let level = ['.'];
  for (let depth = 0; depth <= opts.maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      ctx.entries.dirs.push(dir);
      for (const e of files.list(dir)) {
        ctx.entriesSeen++;
        if (ctx.entriesSeen > opts.maxEntries) {
          ctx.truncated = true;
          files.count('scan limit reached');
          return;
        }
        const rel = joinRel(dir, e.name);
        if (e.isDir) {
          if (SKIP_DIRS.has(e.name)) {
            files.count('ignored directory');
            continue;
          }
          if (e.name.startsWith('.') && !EVIDENCE_DOT_DIRS.has(e.name)) {
            files.count('ignored directory');
            continue;
          }
          if (EXAMPLE_DIRS.has(e.name.toLowerCase()) && dir !== '.') {
            files.count('example or fixture directory');
            continue;
          }
          if (depth === opts.maxDepth) files.count('below the depth limit');
          else next.push(rel);
        } else if (e.isFile) {
          ctx.entries.files.push(rel);
          if (isSecretFile(rel)) files.noteSecret(rel);
        }
      }
    }
    level = next;
  }
}

export interface MarkerDef {
  eco: Ecosystem;
  names?: string[];
  pattern?: RegExp;
  /** How `pattern` reads to people (the support screen lists it). */
  patternText?: string[];
}

/** Ecosystems with a full provider; the others are detected with generic fallbacks. */
export const FULL_ECOSYSTEMS: ReadonlySet<Ecosystem> = new Set<Ecosystem>(['node', 'php']);

export const MARKERS: readonly MarkerDef[] = [
  { eco: 'node', names: ['package.json'] },
  { eco: 'php', names: ['composer.json'] },
  { eco: 'python', names: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'setup.cfg'] },
  { eco: 'go', names: ['go.mod'] },
  { eco: 'rust', names: ['Cargo.toml'] },
  { eco: 'ruby', names: ['Gemfile'] },
  { eco: 'java', names: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
  { eco: 'dotnet', names: ['global.json'], pattern: /\.(csproj|fsproj|vbproj|sln|slnx)$/, patternText: ['*.csproj', '*.fsproj', '*.vbproj', '*.sln', '*.slnx'] },
  { eco: 'deno', names: ['deno.json', 'deno.jsonc'] },
  { eco: 'elixir', names: ['mix.exs'] },
];
/** Manifest file names that mark a project of an ecosystem. */
export function isMarkerFor(eco: Ecosystem, file: string): boolean {
  const base = file.split('/').pop()!;
  return MARKERS.some((m) => m.eco === eco && (m.names?.includes(base) || m.pattern?.test(base)));
}

/** Files that make the analyzed folder itself a (generic) project when nothing else does. */
export const GENERIC_ROOT_MARKERS = ['Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', 'Taskfile.yml', 'Taskfile.yaml', 'Dockerfile', 'Procfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

export function detectProjects(ctx: Ctx): void {
  const byRoot = new Map<string, ProjectDraft>();
  const get = (root: string): ProjectDraft => {
    let p = byRoot.get(root);
    if (!p) {
      p = {
        id: root === '.' ? 'root' : root,
        root,
        name: root === '.' ? '' : root.split('/').pop()!,
        ecosystems: new Set(),
        support: 'generic',
        role: 'unknown',
        markers: [],
        frameworks: [],
        packageManagers: [],
        workspaceMembers: [],
        dependsOn: [],
        envTemplates: [],
        envFilesPresent: [],
      };
      byRoot.set(root, p);
    }
    return p;
  };
  for (const f of ctx.entries.files) {
    const slash = f.lastIndexOf('/');
    const dir = slash < 0 ? '.' : f.slice(0, slash);
    const base = f.slice(slash + 1);
    // Project markers inside evidence dot-directories (.github/actions/x/package.json) are not projects.
    if (dir !== '.' && dir.split('/').some((s) => s.startsWith('.'))) continue;
    for (const m of MARKERS) {
      if (m.names?.includes(base) || m.pattern?.test(base)) {
        const p = get(dir);
        p.ecosystems.add(m.eco);
        p.markers.push(withRole(ev(f, undefined, 'manifest', `${base} found`), 'basis'));
      }
    }
  }
  if (!byRoot.has('.')) {
    const generic = GENERIC_ROOT_MARKERS.filter((n) => ctx.entries.files.includes(n));
    if (generic.length && byRoot.size === 0) {
      const p = get('.');
      p.ecosystems.add('generic');
      for (const g of generic) p.markers.push(withRole(ev(g, undefined, 'task-runner', `${g} found`), 'basis'));
    }
  }
  for (const p of byRoot.values()) {
    p.support = [...p.ecosystems].some((e) => FULL_ECOSYSTEMS.has(e)) ? 'full' : 'generic';
  }
  ctx.projects = [...byRoot.values()].sort((a, b) => cmp(depthKey(a.root), depthKey(b.root)));
}

/** Sort key: the root first, then by path (stable, locale-independent through zero-padded depth). */
function depthKey(root: string): string {
  return root === '.' ? '' : root;
}

/** Translate a workspace glob (`apps/*`, `packages/**`) to a RegExp over relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, '').replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  g = re;
  return new RegExp(`^${g}$`);
}
