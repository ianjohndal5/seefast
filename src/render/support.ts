// `seefast support`: what the analyzer can read, from the same catalog the launcher's "What I can read" screen uses.
import type { SupportCatalog } from '../core/support.js';
import { colors, label } from './text.js';

export function renderSupport(cat: SupportCatalog, opts: { color: boolean }): string {
  const c = colors(opts.color);
  const out: string[] = [];
  const full = cat.ecosystems.filter((e) => e.depth === 'full');
  const generic = cat.ecosystems.filter((e) => e.depth === 'generic');
  out.push(c.bold('In depth') + c.dim('  (versions, package manager, workspaces, env files, setup steps, run targets, conflicts)'));
  for (const e of full) {
    out.push(`  ${c.bold(e.name.padEnd(36))}${e.tools.join(', ')}`);
    if (e.frameworks.length) out.push(`  ${' '.repeat(36)}${c.cyan('recipes: ' + e.frameworks.map((f) => f.name).join(', '))}`);
    out.push(c.dim(`  ${' '.repeat(36)}found by ${e.markers.join(', ')}`));
  }
  out.push('', c.bold('Basic support') + c.dim('  (install and run commands from fallbacks; lower confidence)'));
  for (const e of generic) {
    out.push(`  ${c.bold(e.name.padEnd(36))}${e.tools.join(', ')}`);
    if (e.frameworks.length) out.push(`  ${' '.repeat(36)}${c.cyan('recipes: ' + e.frameworks.map((f) => f.name).join(', '))}`);
    out.push(c.dim(`  ${' '.repeat(36)}found by ${e.markers.join(', ')}`));
  }
  const byCat = new Map<string, string[]>();
  for (const s of cat.services) byCat.set(s.category, [...(byCat.get(s.category) ?? []), label(s.name)]);
  out.push('', c.bold(`Services (${cat.services.length})`));
  for (const [k, v] of byCat) out.push(`  ${k.padEnd(10)}${v.join(', ')}`);
  out.push('', c.bold('Also reads'));
  for (const s of cat.sources) out.push(`  ${s.title}: ${c.dim(s.files.join(', '))}`);
  out.push('', c.dim('Framework recipes live in recipes/*.json, service knowledge in kb/*.json.'));
  return out.join('\n') + '\n';
}
