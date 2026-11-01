// The setup plan: the single output of the analysis and the only input of every interface (guide, doctor,
// runner, SETUP.md, launcher). Documented field by field in docs/PLAN-SCHEMA.md. No Node imports here, so the
// launcher's renderer and an editor extension can share it.

/**
 * Version of the plan format. It increases only when a reader written for the previous version would misread a
 * plan: a field removed or renamed, or a field's type or meaning changed. Additions never change it.
 */
export const SCHEMA_VERSION = 1;

export type Confidence = 'high' | 'medium' | 'low';

/** Kind of source a piece of evidence comes from. The resolver ranks these per question (docs/DESIGN.md §4). */
export type SourceKind =
  | 'manifest-explicit' // a field whose only purpose is to state the answer (packageManager, devEngines)
  | 'lockfile'
  | 'manifest'
  | 'version-file'
  | 'devcontainer'
  | 'ci'
  | 'container' // Dockerfile
  | 'compose'
  | 'task-runner'
  | 'env-template'
  | 'readme'
  | 'code' // a static read of source code (env variable reads)
  | 'recipe' // framework knowledge shipped with the tool, applied to a project file
  | 'default'; // an ecosystem default, used when nothing says otherwise

export interface Evidence {
  /** Path relative to the analyzed folder, `/`-separated. */
  file: string;
  /** 1-based line, when the source has one. */
  line?: number;
  source: SourceKind;
  /** What the file says, briefly: `engines.node: ">=20"`, `FROM node:20-alpine`. Never a secret value. */
  detail: string;
  /** How this evidence relates to the item: the basis of the answer, agreeing with it, or disagreeing. */
  role: 'basis' | 'supports' | 'contradicts';
}

export type Ecosystem = 'node' | 'php' | 'python' | 'go' | 'rust' | 'ruby' | 'java' | 'dotnet' | 'deno' | 'elixir' | 'generic';

export interface Framework {
  id: string;
  name: string;
  /** The version range as declared in the manifest, e.g. `^11.0`. */
  version?: string;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface PackageManagerChoice {
  ecosystem: Ecosystem;
  name: string;
  /** Exact version when declared (packageManager field), else absent. */
  version?: string;
  confidence: Confidence;
  why: string;
  evidence: Evidence[];
}

export interface ProjectDependency {
  project: string;
  /** build: must be built first; workspace: installed together; runtime: must be running (e.g. an API). */
  kind: 'build' | 'workspace' | 'runtime';
  why: string;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface Project {
  /** `root` for the analyzed folder itself, otherwise its relative path. */
  id: string;
  /** `.` or a relative path. */
  root: string;
  name: string;
  ecosystems: Ecosystem[];
  /** full: a supported ecosystem with recipes; generic: detected with lower-confidence fallbacks. */
  support: 'full' | 'generic';
  role: 'app' | 'library' | 'workspace-root' | 'tooling' | 'unknown';
  frameworks: Framework[];
  packageManagers: PackageManagerChoice[];
  /** Project id of the workspace root this project is installed through, if any. */
  workspaceRoot?: string;
  dependsOn: ProjectDependency[];
  evidence: Evidence[];
}

export type RequirementKind = 'runtime' | 'package-manager' | 'extension' | 'tool';

export interface Requirement {
  /** `runtime:node`, `package-manager:pnpm`, `php-extension:pdo_mysql`, `tool:docker`; `@project` when projects disagree. */
  id: string;
  kind: RequirementKind;
  name: string;
  /** SemVer range that must hold (`>=20.9.0`), or absent when any version works. */
  range?: string;
  /** The range as people write it (`>= 20.9`). */
  rangeText?: string;
  /** Version to install when there is a choice (from a version file, CI or the newest tested). */
  recommended?: string;
  projects: string[];
  /** Only some optional steps need it (e.g. Docker for starting Compose services). */
  optional: boolean;
  status: 'ok' | 'conflict' | 'unknown';
  confidence: Confidence;
  why: string;
  evidence: Evidence[];
}

export type ServiceCategory = 'database' | 'cache' | 'queue' | 'mail' | 'search' | 'storage' | 'other';

export interface Service {
  /** `service:mysql` */
  id: string;
  name: string;
  category: ServiceCategory;
  version?: string;
  ports: number[];
  /** Where the repo provides it, when it does. */
  provider: { type: 'compose'; file: string; service: string; image?: string } | null;
  projects: string[];
  /** Env variables that configure the connection (names only). */
  env: string[];
  optional: boolean;
  confidence: Confidence;
  why: string;
  evidence: Evidence[];
}

export interface EnvVar {
  name: string;
  /**
   * user: a person must provide a value; default: the template's value works locally; generated: a step creates it;
   * optional: commented out or not needed to start; unknown: read by the code but missing from the template.
   */
  fill: 'user' | 'default' | 'generated' | 'optional' | 'unknown';
  /** The name looks like a credential (PASSWORD, SECRET, TOKEN, KEY...). Values are never in the plan. */
  secret: boolean;
  generatedBy?: string;
  note?: string;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface EnvFile {
  project: string;
  /** The file the app reads, relative to the analyzed folder. */
  file: string;
  /** The template it is created from, or null when the repo has none. */
  template: string | null;
  /** The file already exists (checked without reading it). */
  exists: boolean;
  createdBy?: string;
  vars: EnvVar[];
  confidence: Confidence;
  why: string;
  evidence: Evidence[];
}

export type Phase = 'prepare' | 'install' | 'configure' | 'services' | 'generate' | 'database' | 'build';
export const PHASES: Phase[] = ['prepare', 'install', 'configure', 'services', 'generate', 'database', 'build'];

export type Action =
  /** Run a program. `argv[0]` is looked up on PATH; no shell is involved. `windowsArgv` replaces argv on Windows. */
  | { type: 'exec'; argv: string[]; windowsArgv?: string[] }
  /** Copy a file if the destination does not exist (never overwrites). Paths relative to the step's cwd. */
  | { type: 'copy'; from: string; to: string }
  /** Create an empty file if it does not exist. */
  | { type: 'touch'; path: string }
  /**
   * Create an env file listing variable names, if it does not exist (never overwrites). Names only, never values:
   * names in `required` are written `NAME=`, the others commented out (`# NAME=`). See src/core/envnames.ts.
   */
  | { type: 'env-names'; path: string; names: string[]; required: string[] }
  /** Something only a person can do; the runner pauses and shows it. */
  | { type: 'manual'; text: string };

export interface Step {
  /** `<project>.<name>`, stable across runs. */
  id: string;
  project: string;
  phase: Phase;
  title: string;
  /** Working directory relative to the analyzed folder (`.` for the folder itself). */
  cwd: string;
  action: Action;
  /** Needs network access (downloads packages or images). */
  network: boolean;
  /** Runs code from third parties (package install scripts, Composer scripts) or from the project. */
  thirdPartyCode: boolean;
  /** Changes something outside the project folder (containers, volumes, global installs). */
  outsideProject: boolean;
  /** Useful but not needed to start the app (seeding demo data). */
  optional: boolean;
  /** Step ids that must have run first. */
  after: string[];
  /** Requirement and service ids this step needs. */
  requires: string[];
  confidence: Confidence;
  why: string;
  notes: string[];
  evidence: Evidence[];
}

export type Readiness =
  | { type: 'port'; port: number; timeoutSec: number }
  | { type: 'stays-up'; seconds: number }
  | { type: 'exits'; timeoutSec: number };

export interface RunPort {
  port: number;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface RunTarget {
  /** `<project>.<name>` */
  id: string;
  project: string;
  /** Script, recipe or task name (`dev`, `serve`, `queue`). */
  name: string;
  kind: 'dev' | 'production' | 'test' | 'worker';
  /** The target to start when the user just says "start". At most one per project and kind. */
  primary: boolean;
  title: string;
  cwd: string;
  action: Action;
  ports: RunPort[];
  /** Run target or service ids that must be up first. */
  needs: string[];
  /** Step ids that must have run first (e.g. the build before `next start`). */
  after: string[];
  readiness: Readiness;
  confidence: Confidence;
  why: string;
  evidence: Evidence[];
}

export interface Task {
  runner: 'make' | 'just' | 'task' | 'composer' | 'procfile' | 'devcontainer' | 'gitpod';
  name: string;
  project: string;
  file: string;
  line: number;
  /** The commands the task runs, as written (not executed, not interpreted). */
  commands: string[];
  purpose: 'setup' | 'run' | 'test' | 'build' | 'other';
}

export interface Conflict {
  id: string;
  subject: string;
  /** The value used, or null when the tool could not choose. */
  chosen: string | null;
  alternatives: { value: string; evidence: Evidence[] }[];
  /** warning: a strong source disagrees, check before relying on it; info: a weaker source is stale. */
  severity: 'warning' | 'info';
  message: string;
  /** The resolution rule that decided it (docs/DESIGN.md §4). */
  rule: string;
}

export interface Unknown {
  id: string;
  subject: string;
  message: string;
  suggestion?: string;
  evidence: Evidence[];
}

export interface PlanStats {
  /** Files and directories the scan looked at. */
  entriesSeen: number;
  filesRead: number;
  /** Files that exist but were deliberately not read because they may hold secrets (names only). */
  secretFilesNotRead: string[];
  skipped: Record<string, number>;
  parseErrors: { file: string; message: string }[];
  /** Commands in README code blocks that matched no known command grammar (counted, not used). */
  readmeCommandsIgnored: number;
  /** Source files scanned for environment variable reads. */
  codeFilesScanned: number;
  truncated: boolean;
}

export interface PlanMeta {
  /** Varies between runs. */
  generatedAt: string;
  /** Varies between runs. */
  durationMs: number;
  /** Varies between runs. */
  timings: Record<string, number>;
  /** Name of the analyzed folder. */
  rootName: string;
  /** Date of the bundled knowledge base the recipes and advice come from. */
  knowledgeBase: string;
  stats: PlanStats;
  /** Every file the analysis read, with the SHA-256 of its normalized content (BOM removed, LF line endings). */
  inputs: { file: string; sha256: string }[];
}

export interface Plan {
  schemaVersion: number;
  tool: { name: string; version: string };
  /** `sha256:` of the canonical JSON of the plan without `meta` and `digest`. */
  digest: string;
  summary: {
    /** full: every project is supported; partial: some are generic; generic: only fallbacks; none: nothing found. */
    support: 'full' | 'partial' | 'generic' | 'none';
    projects: number;
    steps: number;
    conflicts: number;
    unknowns: number;
    /** Lowest confidence among required (non-optional) steps. */
    lowestStepConfidence: Confidence | null;
  };
  projects: Project[];
  requirements: Requirement[];
  services: Service[];
  env: EnvFile[];
  steps: Step[];
  run: RunTarget[];
  tasks: Task[];
  conflicts: Conflict[];
  unknowns: Unknown[];
  meta: PlanMeta;
}

export interface SchemaProblem {
  kind: 'invalid' | 'missing' | 'newer' | 'older';
  message: string;
}

/** Whether this version can read a parsed plan: null when it can, otherwise why not. */
export function checkPlan(plan: unknown, toolName = 'seefast'): SchemaProblem | null {
  const p = plan as { schemaVersion?: unknown; steps?: unknown; tool?: { version?: unknown } } | null;
  if (!p || typeof p !== 'object' || !Array.isArray(p.steps)) {
    return { kind: 'invalid', message: `This file is not a setup plan written by ${toolName}.` };
  }
  const writer = typeof p.tool?.version === 'string' ? `${toolName} ${p.tool.version}` : `an unknown version of ${toolName}`;
  const v = p.schemaVersion;
  if (v === undefined) return { kind: 'missing', message: `This plan has no schemaVersion (written by ${writer}). Analyze the project again.` };
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return { kind: 'invalid', message: `This plan has an invalid schemaVersion (${JSON.stringify(v)}). Analyze the project again.` };
  }
  if (v > SCHEMA_VERSION) {
    return { kind: 'newer', message: `This plan uses format ${v} (written by ${writer}); this version reads format ${SCHEMA_VERSION}. Update ${toolName}.` };
  }
  if (v < SCHEMA_VERSION) {
    return { kind: 'older', message: `This plan uses format ${v} (written by ${writer}); this version reads format ${SCHEMA_VERSION}. Analyze the project again.` };
  }
  return null;
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
export function confidenceRank(c: Confidence): number {
  return CONFIDENCE_ORDER[c];
}
export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER[a] <= CONFIDENCE_ORDER[b] ? a : b;
}
