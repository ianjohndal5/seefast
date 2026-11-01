// Version files: the maintainers' pinned runtime versions (preferences, not constraints).
import type { Ctx } from '../context.js';
import { ev } from '../context.js';
import { dirOf } from '../fs.js';
import { parsePin } from '../versions.js';
import { readDoc, asRecord, asString } from '../parse/structured.js';

/** Single-value version files: file name → tool. */
export const SIMPLE: Readonly<Record<string, string>> = {
  '.nvmrc': 'node',
  '.node-version': 'node',
  '.php-version': 'php',
  '.python-version': 'python',
  '.ruby-version': 'ruby',
  '.go-version': 'go',
  '.java-version': 'java',
  '.bun-version': 'bun',
  '.terraform-version': 'terraform',
};

/** asdf / mise tool names → our tool names. */
const ASDF_TOOLS: Record<string, string> = {
  nodejs: 'node', node: 'node', php: 'php', python: 'python', ruby: 'ruby', golang: 'go', go: 'go', java: 'java', rust: 'rust',
  pnpm: 'pnpm', yarn: 'yarn', bun: 'bun', deno: 'deno', elixir: 'elixir', erlang: 'erlang', dotnet: 'dotnet', 'dotnet-core': 'dotnet',
};

export function collectVersionFiles(ctx: Ctx): void {
  const { files } = ctx;
  for (const f of ctx.entries.files) {
    const base = f.split('/').pop()!;
    const dir = dirOf(f);
    if (SIMPLE[base]) {
      const text = files.readText(f);
      if (text === null) continue;
      const lines = text.split('\n');
      const idx = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
      if (idx < 0) continue;
      const raw = lines[idx].trim();
      const pin = parsePin(raw);
      const tool = SIMPLE[base];
      if (!pin) {
        files.parseError(f, `not a version: ${raw.slice(0, 40)}`);
        continue;
      }
      if (!pin.range) {
        ctx.unknown({
          id: `version-alias:${f}`, subject: `runtime:${tool}`,
          message: `${f} asks for "${raw}", which names no fixed version.`,
          suggestion: tool === 'node' ? 'Use the current Node.js LTS release.' : undefined,
          evidence: [{ ...ev(f, idx + 1, 'version-file', raw), role: 'basis' }],
        });
        continue;
      }
      ctx.versionClaims.push({ tool, dir, role: 'preference', range: pin.range, display: pin.display, source: 'version-file', evidence: ev(f, idx + 1, 'version-file', `${base}: ${raw}`) });
    } else if (base === '.tool-versions') {
      const text = files.readText(f);
      if (text === null) continue;
      text.split('\n').forEach((l, i) => {
        const m = /^\s*([\w-]+)\s+(\S+)/.exec(l);
        if (!m || l.trim().startsWith('#')) return;
        const tool = ASDF_TOOLS[m[1]];
        const pin = tool ? parsePin(m[2]) : null;
        if (tool && pin?.range) ctx.versionClaims.push({ tool, dir, role: 'preference', range: pin.range, display: pin.display, source: 'version-file', evidence: ev(f, i + 1, 'version-file', `.tool-versions: ${m[1]} ${m[2]}`) });
      });
    } else if (base === 'mise.toml' || base === '.mise.toml' || base === 'mise.local.toml' || base === '.rtx.toml') {
      if (base === 'mise.local.toml') continue; // personal overrides, usually untracked
      const doc = readDoc(files, f, 'toml');
      if (!doc) continue;
      for (const [k, v] of Object.entries(asRecord(asRecord(doc.value).tools))) {
        const tool = ASDF_TOOLS[k.replace(/^(core|asdf|aqua|npm|ubi):/, '')];
        const raw = asString(v) ?? (Array.isArray(v) ? asString(v[0]) : asString(asRecord(v).version));
        const pin = tool && raw ? parsePin(raw) : null;
        if (tool && pin?.range) ctx.versionClaims.push({ tool, dir, role: 'preference', range: pin.range, display: pin.display, source: 'version-file', evidence: ev(f, doc.line(['tools', k]), 'version-file', `${base}: ${k} = "${raw}"`) });
      }
    } else if (base === 'rust-toolchain' || base === 'rust-toolchain.toml') {
      const text = files.readText(f);
      if (text === null) continue;
      const m = base.endsWith('.toml') ? /channel\s*=\s*["']([^"']+)/.exec(text) : /^\s*(\S+)/.exec(text);
      const pin = m ? parsePin(m[1]) : null;
      if (pin?.range) ctx.versionClaims.push({ tool: 'rust', dir, role: 'preference', range: pin.range, display: pin.display, source: 'version-file', evidence: ev(f, 1, 'version-file', `${base}: ${m![1]}`) });
    } else if (base === 'global.json') {
      const doc = readDoc(files, f, 'json');
      const v = asString(asRecord(asRecord(doc?.value).sdk).version);
      const pin = v ? parsePin(v) : null;
      if (doc && pin?.range) ctx.versionClaims.push({ tool: 'dotnet', dir, role: 'preference', range: pin.range, display: pin.display, source: 'version-file', evidence: ev(f, doc.line(['sdk', 'version']), 'version-file', `global.json sdk.version: ${v}`) });
    } else if (base === '.sdkmanrc') {
      const text = files.readText(f);
      if (text === null) continue;
      text.split('\n').forEach((l, i) => {
        const m = /^\s*java\s*=\s*([\d.]+)/.exec(l);
        const pin = m ? parsePin(m[1]) : null;
        if (pin?.range) ctx.versionClaims.push({ tool: 'java', dir, role: 'preference', range: pin.range, display: pin.display, source: 'version-file', evidence: ev(f, i + 1, 'version-file', `.sdkmanrc: java=${m![1]}`) });
      });
    }
  }
}
