// What SeeFast can read, for people: the CLI's `support` command and the launcher's "What I can read" screen.
// Built from the same tables and files the analyzer uses (ecosystem markers, lockfiles, version files, task runners,
// env templates, recipes/*.json, kb/services.json), so adding a recipe or a service shows up here with no UI change.
import { FULL_ECOSYSTEMS, MARKERS, GENERIC_ROOT_MARKERS } from './scan.js';
import { LOCKFILES } from './providers/node.js';
import { SIMPLE as VERSION_FILES } from './providers/versionfiles.js';
import { MAKEFILES, JUSTFILES, TASKFILES } from './providers/repo.js';
import { TEMPLATE_ORDER } from './providers/env.js';
import { listData, loadData } from './kb.js';
import type { Ecosystem, ServiceCategory } from './schema.js';

export type SupportDepth = 'full' | 'generic';

export interface SupportCatalog {
  ecosystems: {
    id: Ecosystem;
    name: string;
    /** full: a provider reads versions, package manager, workspaces, env and steps; generic: fallbacks, lower confidence. */
    depth: SupportDepth;
    /** Files that mark a project of this ecosystem. */
    markers: string[];
    /** Package managers and build tools it knows for this ecosystem. */
    tools: string[];
    /** Framework recipes (recipes/*.json) for this ecosystem. */
    frameworks: { id: string; name: string; reviewed: string }[];
  }[];
  services: { name: string; category: ServiceCategory; port: number | null }[];
  /** Where it looks for evidence besides manifests. */
  sources: { id: string; title: string; files: string[] }[];
}

type Named = Exclude<Ecosystem, 'generic'>;

const NAMES: Record<Named, string> = {
  node: 'JavaScript / TypeScript (Node.js)', php: 'PHP', python: 'Python', go: 'Go', rust: 'Rust', ruby: 'Ruby',
  java: 'Java', dotnet: '.NET', deno: 'Deno', elixir: 'Elixir',
};

const PM_NAMES: Record<string, string> = { npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun' };

/** Tools the providers recognize per ecosystem (Node's come straight from the lockfile table). */
const TOOLS: Record<Named, string[]> = {
  node: [...new Set(LOCKFILES.map((l) => PM_NAMES[l.pm] ?? l.pm))],
  php: ['Composer', 'PHP extensions'],
  python: ['uv', 'Poetry', 'Pipenv', 'PDM', 'pip + venv'],
  go: ['Go modules'],
  rust: ['Cargo'],
  ruby: ['Bundler', 'Rails'],
  java: ['Maven', 'Gradle'],
  dotnet: ['dotnet CLI'],
  deno: ['deno tasks'],
  elixir: ['Mix', 'Phoenix'],
};

interface RecipeHead { id: string; name: string; ecosystem: Ecosystem; reviewed?: string }
interface ServicesFile { services: { name: string; category: ServiceCategory; port?: number }[] }

/** Unique file names, ignoring case (Makefile and makefile are listed once). */
function caseless(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

export function supportCatalog(): SupportCatalog {
  const recipes = listData('recipes').map((f) => loadData<RecipeHead>(f));
  const order = Object.keys(NAMES) as Named[];
  const ecosystems = order.map((id) => ({
    id,
    name: NAMES[id],
    depth: (FULL_ECOSYSTEMS.has(id) ? 'full' : 'generic') as SupportDepth,
    markers: MARKERS.filter((m) => m.eco === id).flatMap((m) => [...(m.names ?? []), ...(m.patternText ?? [])]),
    tools: TOOLS[id],
    frameworks: recipes.filter((r) => r.ecosystem === id).map((r) => ({ id: r.id, name: r.name, reviewed: r.reviewed ?? '' })),
  }));
  // In depth first, then the rest; each group keeps the order above.
  ecosystems.sort((a, b) => (a.depth === b.depth ? 0 : a.depth === 'full' ? -1 : 1));
  const services = loadData<ServicesFile>('kb/services.json').services.map((s) => ({ name: s.name, category: s.category, port: s.port ?? null }));
  const sources = [
    { id: 'version-files', title: 'Version files', files: [...Object.keys(VERSION_FILES), '.tool-versions', 'mise.toml', 'global.json', 'rust-toolchain(.toml)'] },
    { id: 'ci', title: 'CI workflows', files: ['.github/workflows/*.yml', '.gitlab-ci.yml'] },
    { id: 'containers', title: 'Containers and dev environments', files: ['Dockerfile', 'compose.yml / docker-compose.yml', '.devcontainer/devcontainer.json', '.gitpod.yml'] },
    { id: 'task-runners', title: 'Task runners', files: [...caseless([...MAKEFILES, ...JUSTFILES, ...TASKFILES]), 'Procfile'] },
    { id: 'env', title: 'Env templates (names only, never values)', files: [...TEMPLATE_ORDER] },
    { id: 'docs', title: 'Docs (commands in code blocks)', files: ['README', 'CONTRIBUTING', 'DEVELOPMENT', 'INSTALL', 'SETUP'] },
    { id: 'fallback', title: 'When nothing else matches', files: caseless(GENERIC_ROOT_MARKERS) },
  ];
  return { ecosystems, services, sources };
}
