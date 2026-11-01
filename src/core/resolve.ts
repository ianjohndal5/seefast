// Resolution: weigh claims per question and decide, with a confidence and an explanation (docs/DESIGN.md §4).
//
// Rules, applied per subject:
//  1. base level: the winning claim's level from the question's policy table;
//  2. corroboration: a claim of a different source kind that agrees raises it one level (max high);
//  3. contradiction: a disagreeing claim of equal or higher rank lowers it one level and is a "warning" conflict;
//     a weaker disagreeing claim is an "info" conflict (a stale README) and changes nothing;
//  4. ties between equally ranked claims are conflicts with the tie-break named, or unknown;
//  5. nothing found: an explicit default at low confidence, or an unknown.
import type { ChoiceClaim, Ctx, VersionClaim } from './context.js';
import { withRole } from './context.js';
import type { Confidence, Evidence, PackageManagerChoice, SourceKind } from './schema.js';
import type { NodePM } from './commands.js';
import { intersectRanges, pinFits, pickHighest, rangeText } from './versions.js';
import { cmp } from './text.js';

type Policy = Partial<Record<SourceKind, [rank: number, level: Confidence]>>;

export const PM_POLICY: Policy = {
  'manifest-explicit': [9, 'high'],
  lockfile: [8, 'high'],
  ci: [6, 'medium'],
  devcontainer: [5, 'medium'],
  container: [4, 'medium'],
  'task-runner': [4, 'medium'],
  readme: [2, 'low'],
  default: [0, 'low'],
};

export const ENV_TARGET_POLICY: Policy = {
  devcontainer: [6, 'medium'],
  ci: [5, 'medium'],
  'task-runner': [5, 'medium'],
  readme: [4, 'medium'],
  recipe: [3, 'medium'],
  default: [0, 'low'],
};

const PREF_POLICY: Policy = {
  'version-file': [9, 'high'],
  'manifest-explicit': [9, 'high'],
  devcontainer: [7, 'medium'],
  ci: [6, 'medium'],
  container: [5, 'medium'],
  manifest: [5, 'medium'],
  readme: [2, 'low'],
};

const CONSTRAINT_LEVEL: Partial<Record<SourceKind, Confidence>> = {
  'manifest-explicit': 'high',
  manifest: 'high',
  lockfile: 'medium',
  recipe: 'medium',
};

export function raise(c: Confidence): Confidence {
  return c === 'low' ? 'medium' : 'high';
}
export function lower(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}
function maxConf(a: Confidence, b: Confidence): Confidence {
  const o = { low: 0, medium: 1, high: 2 };
  return o[a] >= o[b] ? a : b;
}

function base(file: string): string {
  return file.split('/').pop()!;
}

/** "README says `npm install`", "pnpm-lock.yaml exists", "CI runs `yarn install`". */
export function describeClaim(c: { source: SourceKind; evidence: Omit<Evidence, 'role'>; value?: string }): string {
  const e = c.evidence;
  switch (c.source) {
    case 'readme':
      return `${base(e.file)} says "${e.detail}"`;
    case 'lockfile':
      return /present$/.test(e.detail) ? `${base(e.file)} exists` : `${base(e.file)}: ${e.detail}`;
    case 'ci':
      return `CI (${base(e.file)}) ${/^(uses|actions|shivam|setup)/.test(e.detail) ? e.detail : `runs "${e.detail}"`}`;
    case 'task-runner':
      return `${base(e.file)} runs "${e.detail}"`;
    case 'devcontainer':
      return `the dev container (${base(e.file)}) ${/^dev container|^forward/.test(e.detail) ? e.detail.replace(/^dev container /, 'uses ') : `runs "${e.detail}"`}`;
    case 'container':
      return `${base(e.file)} ${/^FROM /.test(e.detail) ? `uses ${e.detail.slice(5)}` : `runs "${e.detail}"`}`;
    case 'recipe':
      return e.detail;
    default:
      return `${base(e.file)} ${e.detail.includes(':') ? `sets ${e.detail}` : `says ${e.detail}`}`;
  }
}

export interface ChoiceResult {
  value: string | null;
  confidence: Confidence;
  why: string;
  evidence: Evidence[];
}

/** Resolve a categorical question (package manager, env file name) from claims under a policy. */
export function resolveChoice(ctx: Ctx, subject: string, claims: ChoiceClaim[], policy: Policy, label: string, fallback?: { value: string; why: string }): ChoiceResult {
  const ranked = claims
    .filter((c) => policy[c.source])
    .map((c) => ({ c, rank: policy[c.source]![0], level: policy[c.source]![1] }))
    .sort((a, b) => b.rank - a.rank || cmp(a.c.evidence.file, b.c.evidence.file) || (a.c.evidence.line ?? 0) - (b.c.evidence.line ?? 0));
  if (!ranked.length) {
    if (!fallback) return { value: null, confidence: 'low', why: `Nothing in the repo says which ${label} to use.`, evidence: [] };
    return { value: fallback.value, confidence: 'low', why: fallback.why, evidence: [] };
  }
  // Best claim per value.
  const best = new Map<string, (typeof ranked)[number]>();
  for (const r of ranked) if (!best.has(r.c.value)) best.set(r.c.value, r);
  const order = [...best.values()].sort((a, b) => b.rank - a.rank || supportCount(ranked, b.c.value) - supportCount(ranked, a.c.value) || cmp(a.c.value, b.c.value));
  const win = order[0];
  const tied = order.filter((o) => o !== win && o.rank === win.rank);
  let confidence = win.level;
  const agreeingKinds = new Set(ranked.filter((r) => r.c.value === win.c.value && r.c.source !== win.c.source && r.c.source !== 'default').map((r) => r.c.source));
  if (agreeingKinds.size) confidence = raise(confidence);
  if (tied.length) {
    const broken = tied.every((t) => supportCount(ranked, win.c.value) > supportCount(ranked, t.c.value));
    confidence = broken ? lower(confidence) : lower(lower(confidence));
  }

  for (const lose of order.slice(1)) {
    const isTie = lose.rank === win.rank;
    const decider = ranked.find((r) => r.c.value === win.c.value && r.c.source !== win.c.source);
    const bothLockfiles = isTie && win.c.source === 'lockfile' && lose.c.source === 'lockfile';
    const opening = bothLockfiles ? `Both ${base(lose.c.evidence.file)} and ${base(win.c.evidence.file)} exist` : `${capital(describeClaim(lose.c))}, but ${describeClaim(win.c)}`;
    const message = !isTie
      ? `${opening}; using ${win.c.value}.`
      : supportCount(ranked, win.c.value) > supportCount(ranked, lose.c.value) && decider
        ? `${opening}; ${describeClaim(decider.c)}, so using ${win.c.value}.${bothLockfiles ? ` ${base(lose.c.evidence.file)} is probably stale.` : ''}`
        : `${opening}; nothing else decides, so using ${win.c.value} is a guess. Remove the stale one or ask the maintainers.`;
    ctx.conflict({
      id: `${subject}:${lose.c.value}`,
      subject,
      chosen: win.c.value,
      alternatives: [
        { value: win.c.value, evidence: ranked.filter((r) => r.c.value === win.c.value).slice(0, 4).map((r) => withRole(r.c.evidence, 'basis')) },
        { value: lose.c.value, evidence: ranked.filter((r) => r.c.value === lose.c.value).slice(0, 4).map((r) => withRole(r.c.evidence, 'contradicts')) },
      ],
      severity: isTie ? 'warning' : 'info',
      message,
      rule: isTie ? 'tie between equally strong sources' : 'stronger source wins',
    });
  }
  const evidence: Evidence[] = [];
  for (const r of ranked) {
    const role = r.c.value === win.c.value ? (r === win ? 'basis' : 'supports') : 'contradicts';
    if (evidence.filter((e) => e.role === role).length < 4) evidence.push(withRole(r.c.evidence, role));
  }
  const why = `${capital(describeClaim(win.c))}${agreeingKinds.size ? ` (${[...agreeingKinds].map((k) => k.replace('-', ' ')).join(', ')} agree${agreeingKinds.size === 1 ? 's' : ''})` : ''}`;
  return { value: win.c.value, confidence, why, evidence };
}

function supportCount(ranked: { c: ChoiceClaim }[], value: string): number {
  return new Set(ranked.filter((r) => r.c.value === value).map((r) => r.c.source)).size;
}

function capital(s: string): string {
  // A sentence that starts with a file name keeps it as written (package.json, .nvmrc).
  if (!s || /^[^\s]*[./]/.test(s.split(' ')[0])) return s;
  return s[0].toUpperCase() + s.slice(1);
}

const NODE_PMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Decide each Node project's package manager. Workspace members use their root's. */
export function resolvePackageManagers(ctx: Ctx): void {
  for (const p of ctx.projects) {
    if (!p.node || p.workspaceRoot) continue;
    const subject = `pm:node@${p.id}`;
    const claims: ChoiceClaim[] = ctx.choiceClaims.filter((c) => c.subject === subject);
    const memberIds = new Set([p.id, ...p.workspaceMembers]);
    for (const c of ctx.choiceClaims) {
      if (!c.subject.startsWith('pm-dir:node@')) continue;
      const at = ctx.projectAt(c.subject.slice('pm-dir:node@'.length));
      if (at && memberIds.has(at.id)) claims.push({ ...c, subject });
    }
    for (const m of ctx.mentions) {
      if (!m.project || !memberIds.has(m.project) || !m.sig.tool || !NODE_PMS.has(m.sig.tool)) continue;
      if (m.sig.kind !== 'install' && m.sig.kind !== 'script' && m.sig.kind !== 'exec') continue;
      if (m.scope === 'prod' && m.source === 'container' && m.sig.kind !== 'install') continue;
      claims.push({ subject, value: m.sig.tool, source: m.source, evidence: m.evidence });
    }
    const res = resolveChoice(ctx, subject, claims, PM_POLICY, 'package manager', {
      value: 'npm',
      why: 'No lockfile, packageManager field, CI step or README command names a package manager, so npm (bundled with Node.js) is assumed.',
    });
    const pm = (res.value ?? 'npm') as NodePM;
    if (!res.evidence.length) {
      ctx.unknown({
        id: `pm-default:${p.id}`, subject,
        message: `${p.node.manifest.file} has no lockfile and nothing names a package manager; assuming npm.`,
        suggestion: 'If the project uses pnpm, Yarn or Bun, its lockfile is missing from the repository; ask the maintainers.',
      });
    }
    const pkgPmField = ctx.choiceClaims.find((c) => c.subject === subject && c.source === 'manifest-explicit');
    const version = pkgPmField && /@([^+\s"]+)/.exec(pkgPmField.evidence.detail)?.[1];
    const choice: PackageManagerChoice = { ecosystem: 'node', name: pm, version: version || undefined, confidence: res.confidence, why: res.why, evidence: res.evidence };
    for (const id of memberIds) {
      const q = ctx.project(id);
      if (!q?.node) continue;
      q.node.pm = pm;
      q.node.pmChoice = choice;
      q.packageManagers.push(choice);
    }
  }
  for (const p of ctx.projects) {
    if (p.php) {
      p.packageManagers.push({
        ecosystem: 'php', name: 'composer', confidence: 'high', why: `${p.php.manifest.file} is a Composer manifest.`,
        evidence: [withRole({ file: p.php.manifest.file, source: 'manifest', detail: 'composer.json' }, 'basis')],
      });
    }
  }
}

export interface VersionResult {
  range?: string;
  recommended?: string;
  confidence: Confidence;
  status: 'ok' | 'conflict' | 'unknown';
  why: string;
  evidence: Evidence[];
}

function isAncestorOrSelf(dir: string, root: string): boolean {
  return dir === '.' || dir === root || root.startsWith(dir + '/');
}

/** Version claims that apply to a project root: claims on its directory or any directory above it. */
export function claimsFor(ctx: Ctx, tool: string, root: string): VersionClaim[] {
  return ctx.versionClaims.filter((c) => c.tool === tool && isAncestorOrSelf(c.dir, root));
}

/** Resolve a tool's version requirement for one project. */
export function resolveVersion(ctx: Ctx, tool: string, label: string, projectRoot: string, subject: string): VersionResult {
  const claims = claimsFor(ctx, tool, projectRoot);
  const constraints = claims.filter((c) => c.role === 'constraint').sort(byEvidence);
  const prefs = claims
    .filter((c) => c.role === 'preference')
    .map((c) => ({ c, rank: (PREF_POLICY[c.source]?.[0] ?? 1) - (c.matrix ? 2 : 0), level: PREF_POLICY[c.source]?.[1] ?? 'low', depth: c.dir === '.' ? 0 : c.dir.split('/').length }))
    .sort((a, b) => b.rank - a.rank || b.depth - a.depth || byEvidence(a.c, b.c));
  if (!constraints.length && !prefs.length) {
    return { confidence: 'low', status: 'unknown', why: `No ${label} version is declared anywhere (no version file, manifest constraint, CI setup or container image).`, evidence: [] };
  }
  const evidence: Evidence[] = [];
  const hard = constraints.filter((c) => !c.soft);
  const soft = constraints.filter((c) => c.soft);
  let range = intersectRanges(hard.map((c) => c.range));
  let status: VersionResult['status'] = 'ok';
  if (range === null) {
    status = 'conflict';
    ctx.conflict({
      id: `${subject}:constraints`, subject, chosen: null,
      alternatives: hard.map((c) => ({ value: c.display, evidence: [withRole(c.evidence, 'contradicts')] })),
      severity: 'warning',
      message: `No ${label} version satisfies every requirement: ${hard.map((c) => `${describeVersion(c)} (${rangeText(c.range)})`).join('; ')}.`,
      rule: 'constraints with an empty intersection',
    });
  }
  let confidence: Confidence = 'low';
  const kinds = new Set<SourceKind>();
  for (const c of hard) {
    confidence = maxConf(confidence, CONSTRAINT_LEVEL[c.source] ?? 'low');
    kinds.add(c.source);
    evidence.push(withRole(c.evidence, 'basis'));
  }
  const fitting = range ? prefs.filter((p) => pinFits(p.c.range, range!)) : [];
  const outside = range ? prefs.filter((p) => !pinFits(p.c.range, range!)) : prefs;
  let recommended: string | undefined;
  const chosen = fitting[0];
  // Soft constraints (locked dependencies' engines) tighten the range unless the maintainers test or pin a
  // version below them, which shows the dependency works there anyway.
  if (range !== null && soft.length) {
    const withSoft = intersectRanges([range, ...soft.map((c) => c.range)]);
    const strongPref = chosen && chosen.rank >= 5 ? chosen : undefined;
    if (withSoft && (!strongPref || pinFits(strongPref.c.range, withSoft))) {
      range = withSoft;
      for (const c of soft) {
        kinds.add(c.source);
        evidence.push(withRole(c.evidence, 'basis'));
        if (!hard.length) confidence = maxConf(confidence, 'medium');
      }
    } else if (strongPref) {
      const s0 = soft.find((c) => !pinFits(strongPref.c.range, c.range)) ?? soft[0];
      evidence.push(withRole(s0.evidence, 'contradicts'));
      ctx.conflict({
        id: `${subject}:soft:${s0.evidence.file}`, subject, chosen: strongPref.c.display,
        alternatives: [{ value: strongPref.c.display, evidence: [withRole(strongPref.c.evidence, 'basis')] }, { value: rangeText(s0.range), evidence: [withRole(s0.evidence, 'contradicts')] }],
        severity: 'info',
        message: `${capital(describeVersion(s0))}, but ${describeVersion(strongPref.c)}, so it works there; recommending ${label} ${strongPref.c.display}. If installing warns about engines, use ${label} ${rangeText(s0.range)}.`,
        rule: 'a tested version beats a locked dependency\'s engines',
      });
    }
  }
  if (chosen) {
    if (chosen.c.matrix) {
      const matrixPins = fitting.filter((f) => f.c.matrix && f.c.evidence.file === chosen.c.evidence.file).map((f) => f.c.display);
      recommended = pickHighest(matrixPins, range!) ?? chosen.c.display;
    } else recommended = chosen.c.display;
    confidence = maxConf(confidence, chosen.level);
    kinds.add(chosen.c.source);
    evidence.push(withRole(chosen.c.evidence, 'basis'));
    for (const f of fitting.slice(1)) {
      const agrees = pinFits(f.c.range, chosen.c.range);
      if (agrees) {
        kinds.add(f.c.source);
        if (evidence.filter((e) => e.role === 'supports').length < 4) evidence.push(withRole(f.c.evidence, 'supports'));
      } else if (!f.c.matrix && f.rank >= 5) {
        ctx.conflict({
          id: `${subject}:pref:${f.c.display}`, subject, chosen: recommended,
          alternatives: [{ value: recommended, evidence: [withRole(chosen.c.evidence, 'basis')] }, { value: f.c.display, evidence: [withRole(f.c.evidence, 'contradicts')] }],
          severity: f.rank >= chosen.rank ? 'warning' : 'info',
          message: `${capital(describeVersion(f.c))}, but ${describeVersion(chosen.c)}; recommending ${label} ${recommended}. Both satisfy the requirements.`,
          rule: f.rank >= chosen.rank ? 'tie between equally strong sources' : 'stronger source wins',
        });
        if (evidence.filter((e) => e.role === 'contradicts').length < 4) evidence.push(withRole(f.c.evidence, 'contradicts'));
      }
    }
  }
  // Preferences outside the hard range: one conflict per pinned version and kind of source, naming every file.
  const groups = new Map<string, typeof outside>();
  for (const o of outside) groups.set(`${o.c.source}|${o.c.display}`, [...(groups.get(`${o.c.source}|${o.c.display}`) ?? []), o]);
  for (const group of groups.values()) {
    const o = group[0];
    const strong = o.rank >= 7;
    if (strong) confidence = lower(confidence);
    if (evidence.filter((e) => e.role === 'contradicts').length < 4) evidence.push(withRole(o.c.evidence, 'contradicts'));
    if (!range) continue;
    // Name the constraint that actually rules the version out.
    const excluding = hard.filter((c) => !pinFits(o.c.range, c.range));
    const basis = excluding.find((c) => CONSTRAINT_LEVEL[c.source] === 'high') ?? excluding[0];
    const files = uniqStr(group.map((g) => base(g.c.evidence.file)));
    const who = files.length > 1 ? describeVersion(o.c).replace(`(${files[0]})`, `(${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''})`) : describeVersion(o.c);
    ctx.conflict({
      id: `${subject}:outside:${o.c.source}:${o.c.display}`, subject, chosen: rangeText(range),
      alternatives: [
        { value: rangeText(range), evidence: (excluding.length ? excluding : hard).slice(0, 3).map((c) => withRole(c.evidence, 'basis')) },
        { value: o.c.display, evidence: group.slice(0, 4).map((g) => withRole(g.c.evidence, 'contradicts')) },
      ],
      severity: strong ? 'warning' : 'info',
      message: `${capital(who)}, but ${basis ? describeVersion(basis) : `the requirements say ${rangeText(range)}`}; using ${label} ${rangeText(range)}.${strong ? ` Installs may fail on ${label} ${o.c.display.replace(/\s*\(.*\)$/, '')}; consider updating ${base(o.c.evidence.file)}.` : ''}`,
      rule: 'constraints beat preferences',
    });
  }
  // Corroboration: two different kinds of source agree.
  const real = [...kinds].filter((k) => k !== 'default');
  if (real.length >= 2 && status === 'ok') confidence = raise(confidence);
  const whyParts: string[] = [];
  const strongest = hard.find((c) => CONSTRAINT_LEVEL[c.source] === 'high') ?? hard[0] ?? soft[0];
  if (strongest) whyParts.push(`${capital(describeVersion(strongest))}`);
  const tighter = constraints.find((c) => c !== strongest && range && c.range !== strongest?.range && rangeText(range) === rangeText(intersectRanges([c.range])) && (!c.soft || pinFits(c.range, range)));
  if (tighter) whyParts.push(`${describeVersion(tighter)}`);
  if (chosen?.c.matrix) {
    const tested = fitting.filter((f) => f.c.matrix && f.c.evidence.file === chosen.c.evidence.file).map((f) => f.c.display);
    whyParts.push(`CI (${base(chosen.c.evidence.file)}) tests ${label} ${uniqStr(tested).join(', ')}; recommending the newest`);
  } else if (chosen) whyParts.push(`${describeVersion(chosen.c)}`);
  if (range && range !== '*' && constraints.length > 1) whyParts.push(`together: ${rangeText(range)}`);
  return {
    range: range && range !== '*' ? range : undefined,
    recommended,
    confidence: status === 'conflict' ? 'low' : confidence,
    status,
    why: whyParts.join('; ') + '.',
    evidence,
  };
}

const TOOL_LABEL: Record<string, string> = { node: 'Node.js', php: 'PHP', python: 'Python', go: 'Go', rust: 'Rust', ruby: 'Ruby', java: 'Java', dotnet: '.NET', bun: 'Bun', deno: 'Deno', pnpm: 'pnpm', yarn: 'Yarn', npm: 'npm', composer: 'Composer' };

/** "`.nvmrc` pins Node.js 18 (lts/hydrogen)", "package.json engines.node requires \">=20.9.0\"", "CI (ci.yml) uses PHP 8.3". */
export function describeVersion(c: VersionClaim): string {
  const label = TOOL_LABEL[c.tool] ?? c.tool;
  const f = base(c.evidence.file);
  switch (c.source) {
    case 'version-file':
      return `${f} pins ${label} ${c.display}`;
    case 'manifest-explicit':
      return `${f} pins ${label} ${c.display}${/platform/.test(c.evidence.detail) ? ' (config.platform)' : ''}`;
    case 'manifest': {
      const key = /^([\w.-]+):/.exec(c.evidence.detail)?.[1];
      return key ? `${f} ${key} requires "${c.display}"` : `${f} requires ${label} ${c.display}`;
    }
    case 'lockfile':
      return `${f}: ${c.evidence.detail}`;
    case 'ci':
      return `CI (${f}) uses ${label} ${c.display}`;
    case 'container':
      return `${f} uses ${c.evidence.detail.replace(/^FROM /, '')}`;
    case 'devcontainer':
      return `the dev container uses ${label} ${c.display}`;
    default:
      return c.evidence.detail;
  }
}

function uniqStr(xs: string[]): string[] {
  return [...new Set(xs)];
}

function byEvidence(a: VersionClaim, b: VersionClaim): number {
  return cmp(a.evidence.file, b.evidence.file) || (a.evidence.line ?? 0) - (b.evidence.line ?? 0);
}
