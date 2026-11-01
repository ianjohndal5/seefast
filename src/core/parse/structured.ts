// JSON (with comments) and YAML documents with source lines, behind one small interface so providers can ask
// "what is at engines.node, and on which line?" without caring about the format.
import * as jsonc from 'jsonc-parser';
import YAML, { isMap, isScalar, isSeq, LineCounter, type Node as YNode } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { LineIndex, findLine, escapeRe } from '../text.js';
import type { ProjectFiles } from '../fs.js';

export type Path = (string | number)[];

export interface Doc {
  file: string;
  text: string;
  value: unknown;
  /** Value at a path, or undefined. */
  get(path: Path): unknown;
  /** 1-based line of the value (or key) at a path; falls back to the nearest existing parent. */
  line(path: Path): number | undefined;
}

export function getPath(value: unknown, path: Path): unknown {
  let v: unknown = value;
  for (const k of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string | number, unknown>)[k];
  }
  return v;
}

export function parseJsonDoc(file: string, text: string): Doc | null {
  const errors: jsonc.ParseError[] = [];
  const tree = jsonc.parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || (errors.length && tree.type !== 'object' && tree.type !== 'array')) return null;
  const value = jsonc.getNodeValue(tree);
  const idx = new LineIndex(text);
  return {
    file,
    text,
    value,
    get: (p) => getPath(value, p),
    line: (p) => {
      for (let n = p.length; n >= 0; n--) {
        const node = jsonc.findNodeAtLocation(tree, p.slice(0, n));
        if (node) {
          // Point at the key for properties ("engines": {...} → the "engines" line).
          const at = node.parent?.type === 'property' ? node.parent.offset : node.offset;
          return idx.line(at);
        }
      }
      return undefined;
    },
  };
}

export function parseYamlDoc(file: string, text: string): Doc | null {
  const lc = new LineCounter();
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(text, { lineCounter: lc, uniqueKeys: false, merge: true, strict: false, prettyErrors: false });
  } catch {
    return null;
  }
  if (doc.errors.length) return null;
  const value = doc.toJS({ maxAliasCount: 1000 });
  const nodeAt = (p: Path): { node: YNode | null; keyOffset?: number } => {
    let node: unknown = doc.contents;
    let keyOffset: number | undefined;
    for (const k of p) {
      if (isMap(node)) {
        const pair = node.items.find((it) => (isScalar(it.key) ? String(it.key.value) === String(k) : false));
        if (!pair) return { node: null };
        keyOffset = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
        node = pair.value;
      } else if (isSeq(node) && typeof k === 'number') {
        node = node.items[k];
        keyOffset = undefined;
      } else return { node: null };
    }
    return { node: (node as YNode) ?? null, keyOffset };
  };
  return {
    file,
    text,
    value,
    get: (p) => getPath(value, p),
    line: (p) => {
      for (let n = p.length; n >= 0; n--) {
        const { node, keyOffset } = nodeAt(p.slice(0, n));
        const off = keyOffset ?? (node as { range?: [number, number, number] } | null)?.range?.[0];
        if (off !== undefined) return lc.linePos(off).line;
      }
      return undefined;
    },
  };
}

/** TOML has no position-preserving parser in JS; lines are found by searching for the key inside its table. */
export function parseTomlDoc(file: string, text: string): Doc | null {
  let value: unknown;
  try {
    value = parseToml(text);
  } catch {
    return null;
  }
  return {
    file,
    text,
    value,
    get: (p) => getPath(value, p),
    line: (p) => {
      const keys = p.map(String);
      for (let n = keys.length; n >= 1; n--) {
        const key = keys[n - 1];
        const table = keys.slice(0, n - 1);
        const after = table.length ? new RegExp(`^\\s*\\[+\\s*${table.map(escapeRe).join('\\s*\\.\\s*')}\\s*\\]+`) : undefined;
        const l = findLine(text, new RegExp(`^\\s*["']?${escapeRe(key)}["']?\\s*=`), after);
        if (l) return l;
        if (after) {
          const t = findLine(text, after);
          if (t) return t;
        }
      }
      return undefined;
    },
  };
}

/** Read and parse a structured file through the read layer; parse failures are recorded, not thrown. */
export function readDoc(files: ProjectFiles, rel: string, kind?: 'json' | 'yaml' | 'toml', maxBytes?: number): Doc | null {
  const text = files.readText(rel, maxBytes);
  if (text === null) return null;
  const k = kind ?? (/\.ya?ml$/i.test(rel) ? 'yaml' : /\.toml$/i.test(rel) ? 'toml' : 'json');
  const doc = k === 'yaml' ? parseYamlDoc(rel, text) : k === 'toml' ? parseTomlDoc(rel, text) : parseJsonDoc(rel, text);
  if (!doc) files.parseError(rel, `could not parse as ${k.toUpperCase()}`);
  return doc;
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

export function asStringArray(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  return Array.isArray(v) ? v.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(String) : [];
}
