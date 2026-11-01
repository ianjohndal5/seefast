// The sandboxed preload must be CommonJS: compile output is ESM, so the preload is kept as a plain .cjs file.
import fs from 'node:fs';
fs.copyFileSync(new URL('../src/preload.cjs', import.meta.url), new URL('../out/preload.cjs', import.meta.url));
