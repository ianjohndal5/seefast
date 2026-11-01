// The analysis context: what providers and recipes collect before resolution turns it into a plan.
// Providers add *claims* (what one source says) and *drafts* (steps and run targets with their own evidence);
// the resolver weighs claims per question; the planner orders and sorts.
import type { CommandSig, NodePM } from './commands.js';
import type { Doc } from './parse/structured.js';
import type { ProjectFiles } from './fs.js';
import type {
  Action, Confidence, Conflict, Ecosystem, Evidence, Framework, PackageManagerChoice, Phase, Project, ProjectDependency, Readiness,
  RunPort, ServiceCategory, SourceKind, Task, Unknown,
} from './schema.js';
import type { TemplateVar } from './parse/envfile.js';

export interface NodeInfo {
  manifest: Doc;
  scripts: Record<string, string>;
  /** name → { range, dev } */
  deps: Map<string, { range: string; dev: boolean }>;
  workspaceGlobs: string[];
  lockfiles: { pm: NodePM; file: string; yarnBerry?: boolean }[];
  /** Resolved package manager (after the first resolution pass). */
  pm?: NodePM;
  pmChoice?: PackageManagerChoice;
  yarnBerry: boolean;
}

export interface PhpInfo {
  manifest: Doc;
  require: Record<string, string>;
  requireDev: Record<string, string>;
  scripts: Record<string, string[]>;
  lock: Doc | null;
}

export interface ProjectDraft {
  id: string;
  root: string;
  name: string;
  ecosystems: Set<Ecosystem>;
  support: 'full' | 'generic';
  role: Project['role'];
  markers: Evidence[];
  node?: NodeInfo;
  php?: PhpInfo;
  frameworks: Framework[];
  packageManagers: PackageManagerChoice[];
  workspaceRoot?: string;
  workspaceMembers: string[];
  dependsOn: ProjectDependency[];
  /** Env templates found in the project root (relative to the analyzed folder). */
  envTemplates: { file: string; vars: TemplateVar[] }[];
  /** Env files that exist (never read), relative paths. */
  envFilesPresent: string[];
}

export interface VersionClaim {
  tool: string;
  /** Directory the claim applies to, and everything below it ('.' for the whole folder). */
  dir: string;
  role: 'constraint' | 'preference';
  /** SemVer range (a pin is a narrow range). */
  range: string;
  display: string;
  source: SourceKind;
  evidence: Omit<Evidence, 'role'>;
  /** Part of a CI matrix: one of several tested versions, never a conflict on its own. */
  matrix?: boolean;
  /**
   * A soft constraint (a locked dependency's `engines`): package managers only warn about it, so a version the
   * maintainers test or pin wins over it, with a note.
   */
  soft?: boolean;
}

export interface ChoiceClaim {
  /** `pm:node@web`, `envTarget@api` */
  subject: string;
  value: string;
  source: SourceKind;
  evidence: Omit<Evidence, 'role'>;
}

export interface CommandMention {
  /** Project the command applies to (by working directory), if any. */
  project?: string;
  sig: CommandSig;
  source: SourceKind;
  evidence: Omit<Evidence, 'role'>;
  /** Where the source says it runs: CI is a test environment, a Dockerfile a production image. */
  scope: 'dev' | 'ci' | 'prod';
  /** Headings above the command in a document (README "Installation" > "Database"). */
  headings?: string[];
}

export interface ServiceClaim {
  name: string;
  category: ServiceCategory;
  version?: string;
  project?: string;
  ports?: number[];
  provider?: { type: 'compose'; file: string; service: string; image?: string };
  env?: string[];
  source: SourceKind;
  evidence: Omit<Evidence, 'role'>;
  scope: 'dev' | 'ci' | 'prod';
  /** Only some features need it (mail catcher, search engine). */
  optional?: boolean;
}

export interface ExtClaim {
  ext: string;
  project: string;
  source: SourceKind;
  evidence: Omit<Evidence, 'role'>;
}

export interface ToolClaim {
  tool: string;
  project?: string;
  optional: boolean;
  why: string;
  source: SourceKind;
  evidence: Omit<Evidence, 'role'>;
}

export interface StepDraft {
  /** Local id within the project (`install`, `env`, `key`); the plan id is `<project>.<local>`. */
  local: string;
  project: string;
  phase: Phase;
  title: string;
  cwd: string;
  action: Action;
  network: boolean;
  thirdPartyCode: boolean;
  outsideProject: boolean;
  optional: boolean;
  /** Plan step ids, or `<project>.<local>?` for "only if it exists". */
  after: string[];
  requires: string[];
  confidence: Confidence;
  why: string;
  notes: string[];
  evidence: Evidence[];
  /** Signature used to match mentions from README / CI / task runners. */
  sig?: string;
  /** Order within the project and phase (lower first). */
  order: number;
}

export interface RunDraft {
  local: string;
  project: string;
  name: string;
  kind: 'dev' | 'production' | 'test' | 'worker';
  primary: boolean;
  title: string;
  cwd: string;
  action: Action;
  ports: RunPort[];
  needs: string[];
  after: string[];
  readiness?: Readiness;
  confidence: Confidence;
  why: string;
  evidence: Evidence[];
  sig?: string;
}

export interface EnvDraft {
  project: string;
  file: string;
  template: string | null;
  exists: boolean;
  createdBy?: string;
  /** Variables the recipe generates: name → local step id. */
  generated: Record<string, string>;
  confidence: Confidence;
  why: string;
  evidence: Evidence[];
}

export class Ctx {
  projects: ProjectDraft[] = [];
  versionClaims: VersionClaim[] = [];
  choiceClaims: ChoiceClaim[] = [];
  mentions: CommandMention[] = [];
  serviceClaims: ServiceClaim[] = [];
  extClaims: ExtClaim[] = [];
  toolClaims: ToolClaim[] = [];
  steps: StepDraft[] = [];
  runs: RunDraft[] = [];
  tasks: Task[] = [];
  envFiles: EnvDraft[] = [];
  conflicts: Conflict[] = [];
  unknowns: Unknown[] = [];
  /** Env variables read in code, per project: name → evidence. */
  codeEnvReads = new Map<string, Map<string, Omit<Evidence, 'role'>[]>>();
  /** `process.env.PORT || 4000` in code, per project: the port a generic server falls back to. */
  codePortDefaults = new Map<string, { port: number; evidence: Omit<Evidence, 'role'> }>();
  /** Ports a dev environment forwards (dev containers, Gitpod): corroborate run-target ports. */
  portHints: { port: number; evidence: Evidence }[] = [];
  /** Compose services whose image the knowledge base does not know (kept to match env references). */
  composeOther: { file: string; service: string; image: string; ports: number[]; line?: number }[] = [];
  /** Compose services built from the repo (the app itself): the "everything in Docker" path. */
  composeApps: { file: string; service: string; line?: number }[] = [];
  /** What recipes say about each project's env file (generated, optional and required variables). */
  envSpecs?: Map<string, import('./recipes.js').EnvSpec>;
  /** Directories and files seen by the scan (relative paths), for providers that look for specific files. */
  entries: { dirs: string[]; files: string[] } = { dirs: [], files: [] };
  entriesSeen = 0;
  truncated = false;
  readmeIgnored = 0;
  codeFilesScanned = 0;

  constructor(public readonly files: ProjectFiles) {}

  project(id: string): ProjectDraft | undefined {
    return this.projects.find((p) => p.id === id);
  }

  /** The deepest project whose root contains `rel` (a file or directory path). */
  projectAt(rel: string): ProjectDraft | undefined {
    // Called for every scanned file: walk up the path's segments through an index of project roots.
    if (this.rootIndex.size !== this.projects.length || this.indexedFrom !== this.projects) {
      this.rootIndex = new Map(this.projects.map((p) => [p.root, p]));
      this.indexedFrom = this.projects;
    }
    let cur = rel;
    for (;;) {
      const p = this.rootIndex.get(cur);
      if (p) return p;
      const i = cur.lastIndexOf('/');
      if (i < 0) break;
      cur = cur.slice(0, i);
    }
    return this.rootIndex.get(cur) ?? this.rootIndex.get('.');
  }

  private rootIndex = new Map<string, ProjectDraft>();
  private indexedFrom: ProjectDraft[] | null = null;

  addStep(s: Omit<StepDraft, 'notes' | 'evidence' | 'requires' | 'after' | 'order' | 'optional' | 'outsideProject'> & Partial<StepDraft>): StepDraft {
    const existing = this.steps.find((x) => x.project === s.project && x.local === s.local);
    if (existing) return existing;
    const draft: StepDraft = {
      notes: [], evidence: [], requires: [], after: [], order: 50, optional: false, outsideProject: false, ...s,
    };
    this.steps.push(draft);
    return draft;
  }

  addRun(r: Omit<RunDraft, 'needs' | 'after' | 'ports'> & Partial<RunDraft>): RunDraft {
    const existing = this.runs.find((x) => x.project === r.project && x.local === r.local);
    if (existing) return existing;
    const draft: RunDraft = { needs: [], after: [], ports: [], ...r };
    this.runs.push(draft);
    return draft;
  }

  unknown(u: Omit<Unknown, 'evidence'> & { evidence?: Evidence[] }): void {
    if (this.unknowns.some((x) => x.id === u.id)) return;
    this.unknowns.push({ evidence: [], ...u });
  }

  conflict(c: Conflict): void {
    // The same sentence for several projects or files is one conflict.
    if (this.conflicts.some((x) => x.id === c.id || x.message === c.message)) return;
    this.conflicts.push(c);
  }
}

export function ev(file: string, line: number | undefined, source: SourceKind, detail: string): Omit<Evidence, 'role'> {
  return line === undefined ? { file, source, detail } : { file, line, source, detail };
}

export function withRole(e: Omit<Evidence, 'role'>, role: Evidence['role']): Evidence {
  return { ...e, role };
}

export function stepId(project: string, local: string): string {
  return `${project}.${local}`;
}
