// The support catalog (CLI `support`, the launcher's "What I can read") must say exactly what the analyzer reads:
// it is built from the analyzer's own tables and data files, and these tests keep it that way.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { supportCatalog } from '../src/core/support.js';
import { FULL_ECOSYSTEMS, MARKERS } from '../src/core/scan.js';
import { LOCKFILES } from '../src/core/providers/node.js';
import { PACKAGE_ROOT } from '../src/core/kb.js';
import { main } from '../src/cli.js';

const cat = supportCatalog();
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8'));

describe('support catalog', () => {
  it('lists every ecosystem that has project markers, once, in-depth ones first', () => {
    const withMarkers = [...new Set(MARKERS.map((m) => m.eco))].sort();
    expect(cat.ecosystems.map((e) => e.id).sort()).toEqual(withMarkers);
    const depths = cat.ecosystems.map((e) => e.depth);
    expect(depths.indexOf('generic')).toBeGreaterThan(depths.lastIndexOf('full'));
  });

  it('uses the same in-depth set as project detection', () => {
    for (const e of cat.ecosystems) expect(e.depth).toBe(FULL_ECOSYSTEMS.has(e.id) ? 'full' : 'generic');
  });

  it('shows every ecosystem marker, including pattern ones', () => {
    const dotnet = cat.ecosystems.find((e) => e.id === 'dotnet')!;
    expect(dotnet.markers).toContain('*.csproj');
    for (const e of cat.ecosystems) expect(e.markers.length).toBeGreaterThan(0);
  });

  it('lists every recipe file under its ecosystem', () => {
    const files = fs.readdirSync(path.join(PACKAGE_ROOT, 'recipes')).filter((f) => f.endsWith('.json'));
    const listed = cat.ecosystems.flatMap((e) => e.frameworks.map((f) => ({ id: f.id, eco: e.id })));
    expect(listed.map((x) => x.id).sort()).toEqual(files.map((f) => readJson(`recipes/${f}`).id).sort());
    for (const f of files) {
      const r = readJson(`recipes/${f}`);
      expect(listed.find((x) => x.id === r.id)?.eco).toBe(r.ecosystem);
    }
  });

  it('lists every service in the knowledge base', () => {
    expect(cat.services.map((s) => s.name)).toEqual(readJson('kb/services.json').services.map((s: { name: string }) => s.name));
  });

  it("takes Node's package managers from the lockfile table", () => {
    const node = cat.ecosystems.find((e) => e.id === 'node')!;
    expect(node.tools.map((t) => t.toLowerCase()).sort()).toEqual([...new Set(LOCKFILES.map((l) => l.pm))].sort());
  });

  it('is available from the CLI without analyzing a folder, as text and JSON', async () => {
    const out: string[] = [];
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void out.push(s), isTTY: false };
    expect(await main(['support'], io)).toBe(0);
    expect(out.join('')).toMatch(/In depth[\s\S]*Laravel[\s\S]*Basic support[\s\S]*Python/);
    out.length = 0;
    expect(await main(['support', '--json'], io)).toBe(0);
    expect(JSON.parse(out.join('')).ecosystems.length).toBe(cat.ecosystems.length);
  });
});
