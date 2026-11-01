// Version strings from every ecosystem, translated to SemVer ranges so they can be intersected and compared.
// Composer's `~8.2` means >=8.2 <9 (npm's means <8.3), so each dialect has its own translator.
import semver from 'semver';

const NODE_LTS: Record<string, number> = {
  argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24,
};

/** Pad `8` / `8.2` to `8.0.0` / `8.2.0`. */
function pad(v: string): string | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(v.trim());
  if (!m) return null;
  return `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}`;
}

/** `20` → range of 20.x; `20.11` → 20.11.x; `20.11.1` → exactly that. */
function partialToRange(v: string): string | null {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(v.trim());
  if (!m) return null;
  const [maj, min, pat] = [m[1], m[2], m[3]];
  if (min === undefined || min === 'x' || min === '*') return `>=${maj}.0.0 <${+maj + 1}.0.0-0`;
  if (pat === undefined || pat === 'x' || pat === '*') return `>=${maj}.${min}.0 <${maj}.${+min + 1}.0-0`;
  return `${maj}.${min}.${pat}`;
}

export interface VersionSpec {
  /** SemVer range; null when the spec names something with no fixed version (`lts/*`, `latest`, `system`). */
  range: string | null;
  /** How to show it: `20`, `20.11.1`, `>= 8.2`. */
  display: string;
  /** A pin (one version or one release line), as opposed to an open range. */
  pinned: boolean;
}

/** Version files and tool pins: `.nvmrc`, `.tool-versions`, `node-version:` in CI, Docker tags. */
export function parsePin(raw: string): VersionSpec | null {
  let v = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!v) return null;
  const lts = /^lts\/(\w+)$/i.exec(v);
  if (lts) {
    const n = NODE_LTS[lts[1].toLowerCase()];
    if (n) return { range: partialToRange(String(n)), display: `${n} (lts/${lts[1].toLowerCase()})`, pinned: true };
    return { range: null, display: v, pinned: false };
  }
  if (/^(node|stable|latest|lts|current|system|\*|lts-latest|lts\/\*)$/i.test(v)) return { range: null, display: v, pinned: false };
  v = v.replace(/^v/, '');
  const r = partialToRange(v);
  if (r) return { range: r, display: v, pinned: true };
  // `20.11.1-alpine`, `8.3-fpm`: keep the leading numeric part.
  const lead = /^(\d+(?:\.\d+){0,2})[-_.a-z]/i.exec(v);
  if (lead) {
    const rr = partialToRange(lead[1]);
    if (rr) return { range: rr, display: lead[1], pinned: true };
  }
  const asRange = npmRange(v);
  return asRange ? { range: asRange, display: v, pinned: false } : null;
}

/** An npm-style range (`engines`), validated. */
export function npmRange(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    const r = semver.validRange(v, { loose: true });
    return r === null ? null : r === '' ? '*' : r;
  } catch {
    return null;
  }
}

/** Composer version constraint → SemVer range. */
export function composerRange(raw: string): string | null {
  const alts = raw.split(/\s*\|\|?\s*/).filter(Boolean);
  const outAlts: string[] = [];
  for (const alt of alts) {
    const parts = alt
      .replace(/\s*-\s*/g, '~HYPHEN~')
      .split(/\s*,\s*|\s+/)
      .filter(Boolean);
    const out: string[] = [];
    for (let p of parts) {
      p = p.replace(/@\w+$/, '').replace(/^v/, '');
      if (p.includes('~HYPHEN~')) {
        const [a, b] = p.split('~HYPHEN~');
        const lo = pad(a);
        const hi = partialToRange(b);
        if (!lo || !hi) return null;
        out.push(`>=${lo}`, hi.startsWith('>=') ? hi.split(' ')[1] : `<=${hi}`);
        continue;
      }
      if (p === '*' || p === '') {
        out.push('*');
        continue;
      }
      const op = /^(>=|<=|>|<|!=|==|=|\^|~)?\s*(.+)$/.exec(p);
      if (!op) return null;
      const [, o = '', ver] = op;
      if (o === '~') {
        const segs = ver.split('.');
        const lo = pad(ver);
        if (!lo) return null;
        if (segs.length <= 2) out.push(`>=${lo}`, `<${+segs[0] + 1}.0.0-0`);
        else out.push(`>=${lo}`, `<${segs[0]}.${+segs[1] + 1}.0-0`);
      } else if (o === '^') {
        // Caret on the version as written: `^0` is >=0 <1 in Composer and npm alike, while `^0.0.0` would be <0.0.1.
        if (!pad(ver)) return null;
        const r = semver.validRange(`^${ver.replace(/^v/, '').replace(/[-+].*$/, '')}`);
        if (!r) return null;
        out.push(r);
      } else if (o === '!=') {
        // SemVer ranges cannot express "not"; dropping it only widens the range.
        continue;
      } else if (o === '' || o === '=' || o === '==') {
        const r = partialToRange(ver.replace(/\.\*$/, '.x'));
        if (!r) return null;
        out.push(r);
      } else {
        const v = pad(ver.replace(/\.\*$/, ''));
        if (!v) return null;
        out.push(`${o}${v}`);
      }
    }
    if (out.length) outAlts.push(out.join(' '));
  }
  const joined = outAlts.join(' || ');
  return npmRange(joined);
}

/** PEP 440 / Poetry specifier → SemVer range (`>=3.10,<3.13`, `~=3.11`, `^3.10`, `==3.12.*`). */
export function pep440Range(raw: string): string | null {
  const parts = raw.split(/\s*,\s*/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const m = /^(~=|===|==|!=|>=|<=|>|<|\^|~)?\s*([\d.*]+)/.exec(p.trim());
    if (!m) return null;
    const [, o = '==', ver] = m;
    const segs = ver.split('.');
    if (o === '~=') {
      const lo = pad(ver);
      if (!lo || segs.length < 2) return null;
      const up = segs.length === 2 ? `<${+segs[0] + 1}.0.0-0` : `<${segs[0]}.${+segs[1] + 1}.0-0`;
      out.push(`>=${lo}`, up);
    } else if (o === '^' || o === '~') {
      const r = composerRange(`${o}${ver}`);
      if (!r) return null;
      out.push(r);
    } else if (o === '==' || o === '===') {
      const r = partialToRange(ver.replace(/\.\*$/, '.x'));
      if (!r) return null;
      out.push(r);
    } else if (o === '!=') continue;
    else {
      const v = pad(ver.replace(/\.\*$/, ''));
      if (!v) return null;
      out.push(`${o}${v}`);
    }
  }
  return out.length ? npmRange(out.join(' ')) : null;
}

/** Intersection of ranges as one simplified range; null when they cannot all hold. */
export function intersectRanges(ranges: string[]): string | null {
  const real = ranges.filter((r) => r && r !== '*');
  if (!real.length) return '*';
  let sets: semver.Comparator[][] = [[]];
  for (const r of real) {
    const rr = new semver.Range(r);
    const next: semver.Comparator[][] = [];
    for (const a of sets) for (const b of rr.set) next.push([...a, ...b]);
    sets = next;
  }
  const simplified = sets.map(simplifySet).filter((s): s is string => s !== null);
  if (!simplified.length) return null;
  return [...new Set(simplified)].join(' || ');
}

function simplifySet(set: semver.Comparator[]): string | null {
  let lo: semver.Comparator | null = null;
  let hi: semver.Comparator | null = null;
  const exact: semver.Comparator[] = [];
  for (const c of set) {
    if (c.operator === '' && c.value === '') continue; // `*`
    if (c.operator === '' || c.operator === '=') exact.push(c);
    else if (c.operator.startsWith('>')) {
      if (!lo || semver.gt(c.semver, lo.semver) || (semver.eq(c.semver, lo.semver) && c.operator === '>')) lo = c;
    } else if (c.operator.startsWith('<')) {
      if (!hi || semver.lt(c.semver, hi.semver) || (semver.eq(c.semver, hi.semver) && c.operator === '<')) hi = c;
    }
  }
  const parts = exact.length ? [exact[0].value] : [lo?.value, hi?.value].filter((x): x is string => Boolean(x));
  const range = parts.length ? parts.join(' ') : '*';
  if (exact.length) {
    for (const c of [lo, hi, ...exact.slice(1)]) if (c && !c.test(exact[0].semver)) return null;
  }
  try {
    return semver.minVersion(range) ? range : null;
  } catch {
    return null;
  }
}

export function satisfies(version: string, range: string): boolean {
  const v = semver.coerce(version, { includePrerelease: false });
  if (!v) return false;
  try {
    return semver.satisfies(v, range, { includePrerelease: false });
  } catch {
    return false;
  }
}

/** Whether a pin (itself a range like 20.x) can satisfy a constraint range. */
export function pinFits(pinRange: string, constraint: string): boolean {
  try {
    return semver.intersects(pinRange, constraint);
  } catch {
    return false;
  }
}

/** Major version a range or version starts at: `^11.0` → 11, `>=8.2` → 8, `15.0.0-canary.3` → 15. */
export function majorOf(raw: string, dialect: 'npm' | 'composer' = 'npm'): number | undefined {
  const r = dialect === 'composer' ? composerRange(raw) : npmRange(raw);
  if (!r) return undefined;
  try {
    const min = semver.minVersion(r);
    return min ? min.major : undefined;
  } catch {
    return undefined;
  }
}

/** Human form of a range: `20.x`, `>= 8.2`, `>= 18.18 < 23`. */
export function rangeText(range: string | undefined | null): string {
  if (!range || range === '*') return 'any';
  return range
    .split(' || ')
    .map((set) => {
      const cs = set.split(' ');
      const lo = cs.find((c) => c.startsWith('>='));
      const hi = cs.find((c) => c.startsWith('<'));
      const short = (v: string) => v.replace(/-0$/, '').replace(/\.0\.0$/, '').replace(/(\.\d+)\.0$/, '$1');
      if (lo && hi && cs.length === 2) {
        const l = semver.parse(lo.slice(2));
        const h = semver.parse(hi.slice(1).replace(/-0$/, ''));
        if (l && h && l.minor === 0 && l.patch === 0 && h.major === l.major + 1 && h.minor === 0 && h.patch === 0) return `${l.major}.x`;
        if (l && h && l.major > 0 && h.major === l.major + 1 && h.minor === 0 && h.patch === 0) return `^${l.major}.${l.minor}${l.patch ? '.' + l.patch : ''}`;
        if (l && h && l.major === h.major && h.minor === l.minor + 1 && h.patch === 0 && l.patch === 0) return `${l.major}.${l.minor}.x`;
      }
      return cs.map((c) => c.replace(/^(>=|<=|>|<)(.*)$/, (_, o: string, v: string) => `${o} ${short(v)}`)).join(' ');
    })
    .join(' or ');
}

/** Highest version among pins that fits a range (for CI matrices). */
export function pickHighest(pins: string[], range: string): string | undefined {
  const fitting = pins.filter((p) => {
    const r = parsePin(p);
    return r?.range ? pinFits(r.range, range) : false;
  });
  return fitting.sort((a, b) => {
    const ca = semver.coerce(a);
    const cb = semver.coerce(b);
    return ca && cb ? semver.compare(cb, ca) : 0;
  })[0];
}
