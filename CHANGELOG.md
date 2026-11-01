# Changelog

All notable changes. The plan format has its own version (`schemaVersion`, see [docs/PLAN-SCHEMA.md](docs/PLAN-SCHEMA.md)).

## 0.1.0 (2026-11-01)

First release.

### Analysis
- Read-only pipeline: scan, detect projects (including nested projects and workspaces), collect evidence, resolve per
  question, plan. No process, network or worker module is imported by the analyzer.
- Sources: package.json, lockfiles (npm, pnpm, Yarn classic and Berry, Bun), `packageManager` / `devEngines` / `volta`
  / `engines`, composer.json and composer.lock (PHP version and the `ext-*` every locked package needs), version files
  (`.nvmrc`, `.node-version`, `.tool-versions`, `mise.toml`, `.php-version`, `.python-version`, `.ruby-version`,
  `global.json`, `rust-toolchain`...), GitHub Actions (setup actions, matrices, service containers, run steps) and
  GitLab CI, Dockerfiles, Compose files, dev containers, Gitpod, Procfiles, Makefile / justfile / Taskfile, READMEs,
  CONTRIBUTING and development guides, env templates, env reads in code, git submodules and LFS.
- Recipes as declarative JSON: Laravel, Next.js, Prisma.
- Generic support for Python, Go, Rust, Ruby, Java, .NET, Deno and Elixir, and for Makefile-only repos.
- Evidence (file and line) and a confidence level on every item; conflicts explained in plain language; unknowns
  reported; secrets never read or written; deterministic and portable output; a plan digest.

### Interfaces
- CLI: `guide`, `plan`, `explain`, `doctor`, `setup`, `start`, `setup-md`, `diff`, `support`; POSIX and PowerShell
  commands.
- Doctor: a fixed list of read-only probes, port checks by binding, offline OS-specific advice.
- Automated setup: per-step consent or digest-bound approval, dry run, separate consent outside the project, stop on
  first failure, resume, logs; `start` with dependency order and readiness checks.
- Desktop launcher (Electron): floating bubble, morphing panels, manual guide, doctor, consent-driven runner.
- Launcher look: an armored sphere robot with one camera eye whose glow and lids show its mood, in a sci-fi
  theme (armor plates, dark housing strips, cyan light, HUD details) in light and dark; Nunito and Chakra Petch bundled (OFL);
  one-sentence answers first, details collapsed; steps you can tick off in the guide; setup actions docked at the
  bottom; every command listed before automated setup starts.
- Automated setup in the launcher shows that it is working: the running step is lit with a spinner, a moving bar, a
  clock and the latest output line; the dock shows "Step x of n", the elapsed time and one segment per step. Stop
  turns into "Stopping…" at once, and a step ended by Stop is shown as stopped, not failed.
- "What I can read" screen and `seefast support`: languages (in depth or basic), framework recipes, services and the
  files it reads, built from the analyzer's own tables and `recipes/` / `kb/` files.

### Validation
- 32-repository corpus with independent ground truth, end-to-end runs in a clean container; see
  [docs/VALIDATION.md](docs/VALIDATION.md).
