// Programmatic API: the analysis, the plan types, and the interfaces that read a plan.
export { analyze, type AnalyzeOptions } from './core/analyze.js';
export * from './core/schema.js';
export { planDigest, canonicalJson } from './core/plan.js';
export { renderGuide } from './render/guide.js';
export { supportCatalog, type SupportCatalog } from './core/support.js';
export { renderSupport } from './render/support.js';
export { label as displayName } from './render/text.js';
export { renderExplain } from './render/explain.js';
export { renderSetupMd } from './render/setupmd.js';
export { renderAction, renderFromRoot, defaultShell, type ShellKind } from './render/shell.js';
export { quickStart, type QuickStart, type QuickStartLine, type QuickStartOptions } from './render/quickstart.js';
export { diffPlans } from './render/diff.js';
export { runDoctor, type DoctorReport, type Check } from './doctor/doctor.js';
export { PROBES } from './doctor/probes.js';
export { runSetup, selectSteps, readState, type RunnerOptions, type RunnerEvent, type RunResult, type ConsentRequest, type Decision } from './runner/runner.js';
export { startTargets, selectTargets, type StartOptions, type StartEvent, type StartResult } from './runner/start.js';
export { TOOL_NAME, TOOL_TITLE, STATE_DIR, PLAN_FILE } from './brand.js';
export { TOOL_VERSION } from './version.js';
