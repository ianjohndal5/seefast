// The explain view: why each step, requirement and run target exists, and which files support or contradict it.
import type { Evidence, Plan } from '../core/schema.js';
import { renderAction, type ShellKind } from './shell.js';
import { colors, ref, requirementLine } from './text.js';

function evidenceLines(list: Evidence[], c: ReturnType<typeof colors>): string[] {
  const order = { basis: 0, supports: 1, contradicts: 2 };
  return [...list]
    .sort((a, b) => order[a.role] - order[b.role])
    .map((e) => {
      const tag = e.role === 'basis' ? c.green('basis      ') : e.role === 'supports' ? c.blue('supports   ') : c.red('contradicts');
      return `      ${tag} ${ref(e).padEnd(36)} ${c.dim(`[${e.source}]`)} ${e.detail}`;
    });
}

/** Explain everything, or the items whose id contains `filter`. */
export function renderExplain(plan: Plan, opts: { shell: ShellKind; color: boolean; filter?: string }): string {
  const c = colors(opts.color);
  const out: string[] = [];
  const match = (id: string) => !opts.filter || id === opts.filter || id.includes(opts.filter);
  for (const r of plan.requirements.filter((x) => match(x.id))) {
    out.push(`${c.bold(r.id)}  ${requirementLine(r)}  ${c.dim(`confidence ${r.confidence}, ${r.status}${r.optional ? ', optional' : ''}`)}`);
    out.push(`    ${r.why}`);
    out.push(...evidenceLines(r.evidence, c), '');
  }
  for (const s of plan.services.filter((x) => match(x.id))) {
    out.push(`${c.bold(s.id)}  ${c.dim(`confidence ${s.confidence}${s.optional ? ', optional' : ''}`)}`);
    out.push(`    ${s.why}`);
    out.push(...evidenceLines(s.evidence, c), '');
  }
  for (const s of plan.steps.filter((x) => match(x.id))) {
    out.push(`${c.bold(s.id)}  ${s.title}  ${c.dim(`[${s.phase}] confidence ${s.confidence}${s.optional ? ', optional' : ''}`)}`);
    out.push(`    ${c.cyan(renderAction(s.action, opts.shell))}  ${c.dim(`in ${s.cwd}`)}`);
    out.push(`    ${s.why}`);
    if (s.after.length) out.push(c.dim(`    after: ${s.after.join(', ')}`));
    if (s.requires.length) out.push(c.dim(`    needs: ${s.requires.join(', ')}`));
    for (const n of s.notes) out.push(c.dim(`    note: ${n}`));
    out.push(...evidenceLines(s.evidence, c), '');
  }
  for (const r of plan.run.filter((x) => match(x.id))) {
    out.push(`${c.bold(r.id)}  ${r.title}  ${c.dim(`[${r.kind}${r.primary ? ', primary' : ''}] confidence ${r.confidence}`)}`);
    out.push(`    ${c.cyan(renderAction(r.action, opts.shell))}  ${c.dim(`in ${r.cwd}`)}`);
    out.push(`    ${r.why}`);
    for (const p of r.ports) out.push(c.dim(`    port ${p.port} (${p.confidence}): ${p.evidence.map(ref).join(', ')}`));
    out.push(...evidenceLines(r.evidence, c), '');
  }
  for (const x of plan.conflicts.filter((y) => match(y.id) || match(y.subject))) {
    out.push(`${c.bold(x.subject)}  ${x.severity === 'warning' ? c.red('conflict') : c.yellow('note')}  ${c.dim(`rule: ${x.rule}`)}`);
    out.push(`    ${x.message}`);
    for (const a of x.alternatives) {
      out.push(`    ${a.value === x.chosen ? c.green('✓') : c.red('✗')} ${a.value}`);
      out.push(...evidenceLines(a.evidence, c));
    }
    out.push('');
  }
  if (!out.length) return `Nothing in the plan matches "${opts.filter}". Step ids: ${plan.steps.map((s) => s.id).join(', ')}\n`;
  return out.join('\n') + '\n';
}
