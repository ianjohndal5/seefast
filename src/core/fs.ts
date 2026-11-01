// The read-only file layer. Every provider reads the analyzed project through this class and nothing else:
//  * it never writes, never executes, and never opens files that may hold secrets (it may stat them);
//  * it strips byte-order marks and normalizes CRLF / CR to LF, so line numbers and hashes are the same on every OS;
//  * it caps file sizes and counts what it skipped;
//  * it records each file it read with a content hash, for change detection (plan.meta.inputs).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Lockfiles can be large; they are read only when a provider needs them. */
export const MAX_LOCKFILE_BYTES = 24 * 1024 * 1024;

const TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults?|tmpl|tpl|example\.local)$/i;

/**
 * Whether a file may hold secret values and must never be read. Env files are secret unless they are templates
 * (`.env.example`, `.env.sample`, `example.env`...). Matching is on the base name, case-insensitive.
 */
export function isSecretFile(relPath: string): boolean {
  const base = relPath.split('/').pop()!.toLowerCase();
  if (base === '.env' || (base.startsWith('.env.') && !TEMPLATE_SUFFIX.test(base))) return true;
  // production.env, local.env... (but example.env is a template)
  if (base.endsWith('.env')) return !/(example|sample|template)/.test(base);
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx)$/.test(base)) return true;
  return [
    'auth.json', // Composer credentials
    'credentials.json',
    'credentials.yml',
    'credentials.yaml',
    'secrets.json',
    'secrets.yml',
    'secrets.yaml',
    'master.key',
    '.git-credentials',
    '.netrc',
    '_netrc',
    '.pgpass',
    '.htpasswd',
    'service-account.json',
    'serviceaccount.json',
    '.pypirc',
  ].includes(base);
}

export function isEnvTemplateName(base: string): boolean {
  const b = base.toLowerCase();
  return (b.startsWith('.env') && TEMPLATE_SUFFIX.test(b)) || /^(example|sample|template)\.env$/.test(b);
}

export class SecretFileError extends Error {
  constructor(public readonly file: string) {
    super(`refusing to read ${file}: it may hold secrets`);
  }
}

/** Remove a byte-order mark and normalize line endings to LF. */
export function normalizeText(raw: string): string {
  let t = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (t.includes('\r')) t = t.replace(/\r\n?/g, '\n');
  return t;
}

/** Decode bytes as UTF-8, or UTF-16 when a UTF-16 byte-order mark says so (PowerShell's default output). */
export function decodeBytes(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  // A NUL byte in the first 8 KB means binary.
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return null;
  return buf.toString('utf8');
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  isFile: boolean;
}

export class ProjectFiles {
  readonly root: string;
  private readonly cache = new Map<string, string | null>();
  private readonly hashes = new Map<string, string>();
  readonly secretFilesSeen = new Set<string>();
  readonly skipped: Record<string, number> = {};
  readonly parseErrors: { file: string; message: string }[] = [];

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private abs(rel: string): string {
    const clean = rel === '.' || rel === '' ? '' : rel;
    const abs = path.resolve(this.root, ...clean.split('/'));
    // Never leave the analyzed folder (`..` segments, absolute paths from manifests).
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`path escapes the analyzed folder: ${rel}`);
    return abs;
  }

  count(reason: string, n = 1): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + n;
  }

  parseError(file: string, message: string): void {
    if (!this.parseErrors.some((e) => e.file === file)) this.parseErrors.push({ file, message: message.split('\n')[0].slice(0, 200) });
  }

  exists(rel: string): boolean {
    try {
      fs.lstatSync(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  isDir(rel: string): boolean {
    try {
      return fs.statSync(this.abs(rel)).isDirectory();
    } catch {
      return false;
    }
  }

  isFile(rel: string): boolean {
    try {
      return fs.statSync(this.abs(rel)).isFile();
    } catch {
      return false;
    }
  }

  /** Entries of a directory, sorted by name (code-unit order, the same on every OS). Symlinked directories are not followed. */
  list(rel: string): DirEntry[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.abs(rel), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() || e.isSymbolicLink() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Text of a file, normalized; null when it is missing, binary or too large (counted). Throws SecretFileError for
   * files that may hold secrets: callers must check `isSecretFile` first, and the error is a bug, never swallowed.
   */
  readText(rel: string, maxBytes = MAX_FILE_BYTES): string | null {
    if (isSecretFile(rel)) throw new SecretFileError(rel);
    if (this.cache.has(rel)) return this.cache.get(rel)!;
    let text: string | null = null;
    try {
      const abs = this.abs(rel);
      const st = fs.statSync(abs);
      if (!st.isFile()) {
        text = null;
      } else if (st.size > maxBytes) {
        this.count('file too large');
      } else {
        const decoded = decodeBytes(fs.readFileSync(abs));
        if (decoded === null) this.count('binary file');
        else text = normalizeText(decoded);
      }
    } catch {
      text = null;
    }
    this.cache.set(rel, text);
    if (text !== null) this.hashes.set(rel, createHash('sha256').update(text).digest('hex'));
    return text;
  }

  /** Note that a secret file exists, by name only. */
  noteSecret(rel: string): void {
    this.secretFilesSeen.add(rel);
  }

  /** Files read so far, sorted, with content hashes. */
  inputs(): { file: string; sha256: string }[] {
    return [...this.hashes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, sha256]) => ({ file, sha256 }));
  }

  get filesRead(): number {
    return this.hashes.size;
  }
}

/** Join relative POSIX paths, treating `.` as the root. */
export function joinRel(...parts: string[]): string {
  const segs: string[] = [];
  for (const p of parts) {
    for (const s of p.split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') segs.pop();
      else segs.push(s);
    }
  }
  return segs.length ? segs.join('/') : '.';
}

/** Path of `file` relative to directory `dir` (both relative to the root, POSIX). */
export function relTo(dir: string, file: string): string {
  if (dir === '.' || dir === '') return file;
  if (file === dir) return '.';
  if (file.startsWith(dir + '/')) return file.slice(dir.length + 1);
  const up = dir.split('/').map(() => '..');
  return [...up, file].join('/');
}

export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '.' : rel.slice(0, i);
}
