# Changelog

All notable changes. The plan format has its own version (`schemaVersion`, see [docs/PLAN-SCHEMA.md](docs/PLAN-SCHEMA.md)).

## Unreleased

### Failures say why
- A start target or setup step that fails now says why in words, with what usually fixes it, instead of only an exit
  code: a missing .NET runtime or SDK, a .NET build error, a busy port, a program or package that is not installed,
  missing Composer dependencies, an empty `APP_KEY`, an old Node.js, a database it cannot reach, and known exit codes
  (Windows status codes such as `0xC0000135`, .NET host errors such as `0x80008096`, POSIX 126/127/137). Windows exit
  codes print in hex. The reasons come from the output the command already printed; nothing extra runs.
- `start`: a target that exits during its "stays up" wait is reported at once rather than after the wait; a target
  whose program is not installed fails with that reason instead of ending the run with an error; a target that stays
  up reports the address it announces ("running at http://localhost:5242"); a port timeout says when it is running at
  another address.
- Launcher: the "Running" card shows the reason, the fix with copy buttons and the last lines the target printed;
  failed setup steps show their fix; "Stop the app" stops started targets.

### .NET
- An ASP.NET Core project now also needs the ASP.NET Core runtime of the major version it targets (`net9.0` → 9.x,
  any newer with `<RollForward>Major</RollForward>`): a newer SDK builds it but does not run it. The doctor checks it
  with a new fixed probe, `dotnet --list-runtimes`.

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
- Evidence (file and line) and a confidence level on every item; conflicts explained in plain language (projects
  sharing a port get one warning naming them all, not one per pair); unknowns reported; secrets never read or
  written; deterministic and portable output; a plan digest.

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
  turns into "Stopping…" at once, and a step ended by Stop is shown as stopped, not failed. With "Include optional
  extras" off, optional steps are skipped without asking, and a step waiting for approval is always on screen.
- A project without an env template no longer gets only a "create .env by hand" step: the `env-names` action creates
  the file with the variable names the code reads, commented out, and no values (never overwriting an existing one).
  The launcher asks "Create it for me" or "I'll do it myself"; the guide and SETUP.md show the command.
- Quick start on the launcher's overview, README style: `cd` into the folder, the installs, the start command and
  where it serves. Every required step it leaves out is counted in a "N more steps first" line (env files, services,
  database...), a second start command appears only when it belongs with the first (a frontend and its API), and
  "Copy all" is offered only when the block is complete and fits one terminal. Built by `quickStart()` from the plan.
- "What I can read" screen and `seefast support`: languages (in depth or basic), framework recipes, services and the
  files it reads, built from the analyzer's own tables and `recipes/` / `kb/` files.

### Validation
- 32-repository corpus with independent ground truth, end-to-end runs in a clean container; see
  [docs/VALIDATION.md](docs/VALIDATION.md).
