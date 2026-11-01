// The manual guide in the terminal: what the project is, what the machine needs, what disagrees, and the
// numbered steps with commands for the user's shell. Rendered from the plan only.
import type { Plan, Step, RunTarget } from '../core/schema.js';
import { renderAction, type ShellKind, toWindowsPath } from './shell.js';
import { colors, confidenceTag, label, projectLabel, refs, requirementLine, serviceLine } from './text.js';

export interface GuideOptions {
  shell: ShellKind;
  color: boolean;
  /** Show evidence references next to each item. */
  verbose?: boolean;
}

export function renderGuide(plan: Plan, opts: GuideOptions): string {
  const c = colors(opts.color);
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  const cwdLabel = (cwd: string) => (cwd === '.' ? '' : `${opts.shell === 'powershell' ? toWindowsPath(cwd) + '\\' : cwd + '/'} `);
  const conf = (x: string) => (x === 'high' ? c.green(confidenceTag(x)) : x === 'medium' ? c.yellow(confidenceTag(x)) : c.red(confidenceTag(x)));

  line(`${c.bold(plan.tool.name)} ${plan.tool.version} · ${c.bold(plan.meta.rootName)} ${c.dim(`· analyzed in ${plan.meta.durationMs} ms, offline, nothing executed`)}`);
  line();
  if (!plan.projects.length) {
    line(c.yellow('No project found in this folder.'));
    for (const u of plan.unknowns) line(`  ${u.message}${u.suggestion ? ' ' + u.suggestion : ''}`);
    return out.join('\n') + '\n';
  }

  line(c.bold('Projects'));
  for (const p of plan.projects) {
    const fw = p.frameworks.map((f) => `${f.name}${f.version ? ' ' + f.version : ''}`).join(', ');
    const pms = p.packageManagers.map((m) => `${label(m.name)}`).join(' + ');
    const eco = p.ecosystems.filter((e) => e !== 'generic').map(label).join(' + ') || 'unrecognized';
    const deps = p.dependsOn.map((d) => `${d.kind === 'runtime' ? 'needs' : d.kind === 'build' ? 'builds after' : 'uses'} ${projectLabel(plan, d.project)}`).join(', ');
    const generic = p.support === 'generic' ? c.yellow(' (generic support, lower confidence)') : '';
    line(`  ${c.cyan(projectLabel(plan, p.id).padEnd(18))} ${[fw, eco].filter(Boolean).join(' · ')}${pms ? ` (${pms})` : ''}${p.workspaceRoot ? c.dim(` · workspace of ${projectLabel(plan, p.workspaceRoot)}`) : ''}${deps ? c.dim(` · ${deps}`) : ''}${generic}`);
  }
  line();

  const reqs = plan.requirements.filter((r) => !r.optional);
  const exts = reqs.filter((r) => r.kind === 'extension');
  line(c.bold('This machine needs'));
  for (const r of reqs.filter((x) => x.kind !== 'extension')) {
    const status = r.status === 'conflict' ? c.red(' (sources disagree, see below)') : r.status === 'unknown' ? c.yellow(' (version not declared)') : '';
    line(`  • ${requirementLine(r)}${status}  ${conf(r.confidence)}${opts.verbose ? c.dim('  ' + refs(r.evidence, 3)) : ''}`);
  }
  if (exts.length) line(`  • PHP extensions: ${exts.map((e) => e.name).join(', ')}`);
  for (const s of plan.services.filter((x) => !x.optional)) line(`  • ${serviceLine(s)}  ${conf(s.confidence)}`);
  const optional = [...plan.requirements.filter((r) => r.optional).map(requirementLine), ...plan.services.filter((s) => s.optional).map((s) => label(s.name))];
  if (optional.length) line(c.dim(`  Optional: ${optional.join(', ')}`));
  line(c.dim(`  Check this machine: ${plan.tool.name} doctor`));
  line();

  const warnings = plan.conflicts.filter((x) => x.severity === 'warning');
  const infos = plan.conflicts.filter((x) => x.severity === 'info');
  if (plan.conflicts.length || plan.unknowns.length) {
    line(c.bold(`Heads-up (${plan.conflicts.length + plan.unknowns.length})`));
    for (const x of warnings) line(`  ${c.red('!')} ${x.message}`);
    for (const x of infos) line(`  ${c.yellow('i')} ${x.message}`);
    for (const u of plan.unknowns) line(`  ${c.yellow('?')} ${u.message}${u.suggestion ? c.dim(' ' + u.suggestion) : ''}`);
    line();
  }

  const required = plan.steps.filter((s) => !s.optional);
  const opt = plan.steps.filter((s) => s.optional);
  line(c.bold(`Setup steps`) + c.dim(` (${opts.shell === 'powershell' ? 'PowerShell' : 'POSIX shell'}; paths are relative to this folder)`));
  let n = 0;
  const stepBlock = (s: Step) => {
    n++;
    const flags = [s.network ? 'network' : '', s.thirdPartyCode && s.action.type === 'exec' ? 'runs third-party code' : '', s.outsideProject ? 'changes things outside the project' : ''].filter(Boolean);
    line(`  ${c.bold(String(n).padStart(2) + '.')} ${s.title}  ${conf(s.confidence)}${flags.length ? c.dim('  [' + flags.join(', ') + ']') : ''}`);
    if (s.action.type === 'manual') line(`      ${c.yellow('→')} ${s.action.text}`);
    else line(`      ${c.dim(cwdLabel(s.cwd) + (opts.shell === 'powershell' ? 'PS>' : '$'))} ${c.cyan(renderAction(s.action, opts.shell))}`);
    for (const note of s.notes) line(c.dim(`      ${note}`));
    if (opts.verbose) line(c.dim(`      why: ${s.why}  (${refs(s.evidence, 4)})`));
  };
  required.forEach(stepBlock);
  if (!required.length) line(c.dim('  No setup steps found.'));
  if (opt.length) {
    line(c.dim('  Optional:'));
    opt.forEach(stepBlock);
  }
  line();

  const runs = plan.run;
  if (runs.length) {
    line(c.bold('Run'));
    const kinds: RunTarget['kind'][] = ['dev', 'worker', 'production', 'test'];
    for (const k of kinds) {
      const rs = runs.filter((r) => r.kind === k && (r.primary || k === 'production'));
      if (!rs.length) continue;
      const title = { dev: 'Develop', worker: 'Workers', production: 'Production', test: 'Tests' }[k];
      line(`  ${c.bold(title)}`);
      for (const r of rs) {
        const url = r.ports.length ? c.dim(` → http://localhost:${r.ports[0].port}`) : '';
        const needs = r.needs.length ? c.dim(` (after ${r.needs.map((x) => x.replace(/^service:/, '')).join(', ')})`) : '';
        line(`    ${c.dim(cwdLabel(r.cwd) + (opts.shell === 'powershell' ? 'PS>' : '$'))} ${c.cyan(renderAction(r.action, opts.shell))}${url}${needs}`);
      }
    }
    const others = runs.filter((r) => !r.primary && r.kind === 'dev');
    if (others.length) line(c.dim(`  Also available: ${others.map((r) => r.id).join(', ')}`));
    line(c.dim(`  Start the dev targets together: ${plan.tool.name} start`));
    line();
  }

  const tasks = plan.tasks.filter((t) => t.purpose === 'setup');
  if (tasks.length) {
    line(c.dim(`The repo also has its own setup tasks: ${tasks.map((t) => `${t.runner === 'devcontainer' || t.runner === 'gitpod' ? t.file : `${t.runner} ${t.name}`}`).join(', ')}. They are listed in the plan, not run.`));
    line();
  }
  line(c.dim(`Next: ${plan.tool.name} doctor · ${plan.tool.name} setup --dry-run · ${plan.tool.name} explain <step> · ${plan.tool.name} plan > setup-plan.json`));
  return out.join('\n') + '\n';
}
