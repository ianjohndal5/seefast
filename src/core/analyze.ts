// The analysis pipeline: scan → detect → collect → resolve → plan. Read-only: it imports no process, network or
// worker module (test/safety.test.ts checks both the imports and the behaviour).
import path from 'node:path';
import { ProjectFiles } from './fs.js';
import { Ctx } from './context.js';
import { scan, detectProjects, DEFAULT_SCAN, type ScanOptions } from './scan.js';
import { collectNode, planNode, applyPnpmPrefix } from './providers/node.js';
import { collectPhp } from './providers/php.js';
import { collectVersionFiles } from './providers/versionfiles.js';
import { collectEnvTemplates, collectCodeEnvReads, collectEnvServices } from './providers/env.js';
import { collectCi } from './providers/ci.js';
import { collectContainers } from './providers/containers.js';
import { collectTaskRunners, collectReadmes, collectGit, genericTaskFallback } from './providers/repo.js';
import { collectGeneric } from './providers/generic.js';
import { applyRecipes } from './recipes.js';
import { resolvePackageManagers } from './resolve.js';
import { assemble, buildRequirements, linkMentions, linkProjects, planEnv, planServices } from './plan.js';
import { knowledgeBaseDate } from './kb.js';
import type { EnvFile, Plan, PlanMeta, Service } from './schema.js';
import { TOOL_NAME } from '../brand.js';
import { TOOL_VERSION } from '../version.js';

export interface AnalyzeOptions {
  scan?: Partial<ScanOptions>;
  /** Override the clock (tests). */
  now?: () => Date;
}

export function analyze(root: string, opts: AnalyzeOptions = {}): Plan {
  const now = opts.now ?? (() => new Date());
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  let last = t0;
  const lap = (name: string) => {
    const t = performance.now();
    timings[name] = Math.round((t - last) * 10) / 10;
    last = t;
  };
  const files = new ProjectFiles(root);
  if (!files.isDir('.')) throw new Error(`Not a folder: ${root}`);
  const ctx = new Ctx(files);

  scan(ctx, { ...DEFAULT_SCAN, ...opts.scan });
  detectProjects(ctx);
  lap('scan');

  collectEnvTemplates(ctx);
  collectNode(ctx);
  collectPhp(ctx);
  collectVersionFiles(ctx);
  collectCi(ctx);
  collectContainers(ctx);
  collectTaskRunners(ctx);
  collectReadmes(ctx);
  collectGit(ctx);
  // After CI and README mentions: the generic providers use them (pip vs uv).
  collectGeneric(ctx);
  collectCodeEnvReads(ctx);
  collectEnvServices(ctx);
  lap('collect');

  for (const p of ctx.projects) if (p.root === '.' && (!p.name || p.name === 'root')) p.name = path.basename(files.root);
  resolvePackageManagers(ctx);
  planNode(ctx);
  applyRecipes(ctx);
  genericTaskFallback(ctx);
  applyPnpmPrefix(ctx);
  lap('recipes');

  const services: Service[] = [];
  planServices(ctx, services);
  const env: EnvFile[] = [];
  planEnv(ctx, env);
  linkMentions(ctx);
  linkProjects(ctx, services);
  const { requirements, idFor } = buildRequirements(ctx);
  if (!ctx.projects.length) {
    ctx.unknown({
      id: 'no-project', subject: 'projects',
      message: 'No project manifest was found (no package.json, composer.json, pyproject.toml, go.mod, Cargo.toml, Gemfile, pom.xml, Makefile, Dockerfile...).',
      suggestion: 'Check that this is the right folder, or read the README for setup instructions.',
    });
  }
  lap('resolve');

  const meta: PlanMeta = {
    generatedAt: now().toISOString(),
    durationMs: 0,
    timings,
    rootName: path.basename(path.resolve(root)),
    knowledgeBase: knowledgeBaseDate(),
    stats: {
      entriesSeen: ctx.entriesSeen,
      filesRead: 0,
      secretFilesNotRead: [...files.secretFilesSeen].sort(),
      skipped: files.skipped,
      parseErrors: [...files.parseErrors].sort((a, b) => (a.file < b.file ? -1 : 1)),
      readmeCommandsIgnored: ctx.readmeIgnored,
      codeFilesScanned: ctx.codeFilesScanned,
      truncated: ctx.truncated,
    },
    inputs: [],
  };
  const plan = assemble(ctx, { env, services, requirements, idFor }, meta, { name: TOOL_NAME, version: TOOL_VERSION });
  lap('plan');
  plan.meta.stats.filesRead = files.filesRead;
  plan.meta.stats.skipped = Object.fromEntries(Object.entries(files.skipped).sort(([a], [b]) => (a < b ? -1 : 1)));
  plan.meta.inputs = files.inputs();
  plan.meta.durationMs = Math.round(performance.now() - t0);
  return plan;
}
