// What changed in the setup between two plans: the answer to "I pulled; do I need to do anything?".
import type { Plan } from '../core/schema.js';
import { renderAction } from './shell.js';
import { requirementLine } from './text.js';

export interface PlanDiff {
  same: boolean;
  lines: string[];
}

export function diffPlans(before: Plan, after: Plan): PlanDiff {
  if (before.digest === after.digest) return { same: true, lines: ['The setup has not changed.'] };
  const lines: string[] = [];
  const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const section = <T extends { id: string }>(name: string, a: T[], b: T[], show: (x: T) => string) => {
    const A = byId(a);
    const B = byId(b);
    for (const [id, x] of B) {
      if (!A.has(id)) lines.push(`+ ${name} ${show(x)}`);
      else if (show(A.get(id)!) !== show(x)) lines.push(`~ ${name} ${show(A.get(id)!)}  →  ${show(x)}`);
    }
    for (const [id, x] of A) if (!B.has(id)) lines.push(`- ${name} ${show(x)}`);
  };
  section('requirement', before.requirements, after.requirements, (r) => `${requirementLine(r)}${r.optional ? ' (optional)' : ''}`);
  section('service', before.services, after.services, (s) => `${s.name}${s.version ? ' ' + s.version : ''}${s.optional ? ' (optional)' : ''}`);
  section('step', before.steps, after.steps, (s) => `${s.id}: ${renderAction(s.action, 'posix')}${s.optional ? ' (optional)' : ''}`);
  section('run', before.run, after.run, (r) => `${r.id}: ${renderAction(r.action, 'posix')}${r.ports.length ? ` :${r.ports.map((p) => p.port).join(',')}` : ''}`);
  const envVars = (p: Plan) => new Map(p.env.flatMap((e) => e.vars.filter((v) => v.fill === 'user').map((v) => [`${e.file}:${v.name}`, v.name] as const)));
  const ea = envVars(before);
  const eb = envVars(after);
  for (const [k] of eb) if (!ea.has(k)) lines.push(`+ env variable to fill: ${k}`);
  for (const [k] of ea) if (!eb.has(k)) lines.push(`- env variable no longer needed: ${k}`);
  if (!lines.length) lines.push('Only explanations or evidence changed; the steps and requirements are the same.');
  return { same: false, lines };
}
