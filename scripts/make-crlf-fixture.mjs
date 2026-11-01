// Regenerates fixtures/crlf-bom from fixtures/laravel-next-monorepo: every text file gets Windows line endings
// (CRLF) and a UTF-8 byte-order mark, the way some Windows editors save files. test/portability.test.ts checks
// that both folders produce the same plan.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const from = path.join(root, 'laravel-next-monorepo');
const to = path.join(root, 'crlf-bom');
fs.rmSync(to, { recursive: true, force: true });
for (const rel of fs.readdirSync(from, { recursive: true })) {
  const src = path.join(from, rel);
  const dst = path.join(to, rel);
  if (fs.statSync(src).isDirectory()) continue;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const text = fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(dst, '﻿' + text);
}
console.log(`wrote ${to}`);
