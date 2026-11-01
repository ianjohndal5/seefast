# SeeFast: design

`seefast` takes a folder holding a project someone else wrote and answers two questions: **what does this machine need to run it, and which exact steps get it running?** It answers offline, without AI and without executing the project's code. Then it lets the user follow a manual guide or have the tool run the steps, with consent.

This document covers the survey of existing tools, the architecture, the plan data model, the evidence and confidence model, the user flows, the platform research for the floating launcher, the main risks, and answers to the brief's open questions. Decisions with alternatives are logged in [DECISIONS.md](DECISIONS.md); the plan format is documented field by field in [PLAN-SCHEMA.md](PLAN-SCHEMA.md).

> **Name.** SeeFast (`seefast`), chosen by the author on 2026-11-01 after a search (the working name was `cloneready`). It was free on npm (including `see-fast`, which npm's similarity check compares against), PyPI, crates.io and Homebrew that day. Considered and rejected: `readyup` (an active npm package doing pre-deployment environment checks, so `npx readyup` would run someone else's tool), `quickset` (an abandoned npm package, and a trademark used for device-setup software), `readyset` (an existing database product), `firstrun` and `runready` (npm refuses them next to `first-run` and `run-ready`). Trademarks have not been checked. The name lives in `src/brand.ts`.

## Assumptions (no review pause was possible)

1. **First ecosystems**: the brief left them unfilled, so the suggested default applies: Node.js (npm, Yarn classic and Berry, pnpm, Bun) including Next.js; PHP with Composer including Laravel; services declared in Docker Compose; generic fallbacks (Makefile, justfile, Taskfile, Procfile, Dockerfile, dev containers, CI, README) plus low-confidence detection of Python, Go, Rust, Ruby, Java and .NET.
2. **Electron is acceptable for the launcher** despite its download size (see D3). The CLI stays light.
3. **Windows and macOS are verified through unit tests with a simulated platform and a CI matrix**, not on real machines in this first pass: the development machine is Arch Linux under Wayland. Where a claim about Windows or macOS is untested, the docs say so.
4. **Network is used only to build the tool and to fetch the validation corpus**, never by the tool itself.

## 1. Survey of existing tools

| Tool | What it does | Borrow | Where it falls short for this purpose |
| --- | --- | --- | --- |
| **Railpack** (Railway, Go) and its predecessor **Nixpacks** (Rust) | Detects a language provider, reads lockfiles and version files, produces a JSON build plan, builds a container image (BuildKit / Nix). | Provider-per-ecosystem architecture; lockfile decides the package manager; version files read in a fixed order (Railpack reads `mise`-style idiomatic files); a plan as data between detection and execution. | Targets a production image, not a developer machine. Ignores CI, README, env templates and services. No confidence, no explanation of why a version was chosen, no "unknown". |
| **Cloud Native Buildpacks** (Paketo, Heroku) | `detect` then `build`; buildpacks exchange a *build plan* of `requires`/`provides`, with metadata such as `version-source: .nvmrc`. | The `version-source` idea is exactly evidence; requires/provides is a clean way to model "frontend needs backend". Detection order groups. | `bin/detect` is an executable: detection runs code. Production images only; needs Docker and `pack`. |
| **repo2docker** (Jupyter) | Reads `environment.yml`, `requirements.txt`, `runtime.txt`, `apt.txt`, `postBuild`... and builds an image. | An explicit, documented list of configuration files and their precedence. | Data-science focus; runs `postBuild`; needs Docker. |
| **Dev Containers** (`devcontainer.json`) | A maintainer-authored environment: image, features, `postCreateCommand`, `forwardPorts`. | When present it is first-class evidence: features name tools and versions, lifecycle commands are the maintainers' own setup steps, `forwardPorts` gives ports. | Exists only when maintainers wrote one; requires Docker and a supporting editor; no help for the native path. |
| **mise / asdf** | Read `.tool-versions`, `mise.toml` and idiomatic files (`.nvmrc`, `.python-version`...), install runtimes, run tasks. | The list of idiomatic version files and their meaning. When `mise` is on the machine, the doctor's advice uses it. | An installer, not an analyzer: no package managers, services, env, steps or explanations. |
| **Gitpod `.gitpod.yml`, Procfile + foreman/overmind, Laravel Sail, `composer check-platform-reqs`** | Task lists; multi-process runners; a Docker dev setup for Laravel; extension checks. | `tasks.init`/`command` as evidence; Procfile semantics for multi-process runs; `check-platform-reqs` logic replicated statically from `composer.lock`. | Each covers one slice. `check-platform-reqs` needs Composer and runs it. |

**What none of them do**, and what this tool is for: combine *all* the partial descriptions a repo already has (CI, containers, manifests, version files, task runners, env templates, README), weigh them per question, explain disagreements, say "unknown" when that is the truth, and target the *developer's own machine*, with a doctor and a consent-driven runner.

## 2. Architecture

```
          ┌────────────────────────────── analysis: pure, read-only, no processes, no sockets ─────────────────────────────┐
folder ─► │ scan ─► detect ─► collect ─► resolve ─────────────► plan                                                         │
          │ bounded  projects  providers  per-question policies   setup-plan.json (schemaVersion, deterministic)            │
          │ walk     + roles   + recipes  merge / rank / conflict  digest = sha256 of canonical JSON without meta           │
          └──────────────────────────────────────────────────────────────────┬────────────────────────────────────────────┘
                                                                             │ the only input of everything below
              ┌───────────────┬───────────────┬────────────────┬─────────────┴──┬─────────────────┬────────────────┐
              ▼               ▼               ▼                ▼                ▼                 ▼                ▼
           guide          explain         SETUP.md          doctor           runner            start             diff
         (terminal)    (why + files)    (on request)    fixed probes only  consent, dry run,  run targets,     plan vs plan
                                                        + offline KB       resume, logs       readiness
              └───────────────┴───────────────┴────── CLI (seefast) and launcher app (Electron) ─────┴────────────────┘
```

* **`src/core`** is the analyzer. It may import only the read-only file layer (`src/core/fs.ts`), parsers and data. It must not import `child_process`, `net`, `http(s)`, `dgram`, `dns` or `worker_threads` (a test scans the imports, and another runs the whole analysis with those modules booby-trapped).
* **The read layer** (`ProjectFiles`) is the only way providers touch the disk. It strips byte-order marks, normalizes CRLF and lone CR to LF, caps file sizes, records every file it read with a content hash (for change detection), and **refuses** to open secret-bearing files (`.env`, `.env.local`, `.env.production`, `*.pem`, `id_rsa`, `auth.json`, `credentials*.json`...). It can `stat` them, so the plan can say ".env already exists" without reading it.
* **Providers** (`src/core/providers/*`) read one kind of source each and emit *claims*: Node manifests and lockfiles, Composer, version files, GitHub Actions, GitLab CI, Dockerfile, Compose, dev containers, task runners, env templates, README, source-code env reads, generic ecosystems.
* **Recipes** (`recipes/*.json`) are declarative framework knowledge (Laravel, Next.js, Prisma, Vite...). A small interpreter evaluates their conditions against the facts and emits claims and steps. Recipes cannot run code; computed values come from a short list of named functions in the engine (D9).
* **Resolver** (`src/core/resolve.ts`) groups claims by *subject* (`packageManager@web`, `runtime:node@web`, `service:mysql`...) and applies the per-question policy (section 4).
* **Planner** (`src/core/plan.ts`) turns resolved facts into requirements, services, env files, ordered steps and run targets, then sorts everything deterministically.
* **Interfaces** never re-analyze: `doctor`, `runner`, renderers and the launcher take a `Plan` object (in memory or a saved `setup-plan.json`).

**Language: TypeScript on Node ≥ 20** (D2), shipped as an npm package with four pure-JavaScript dependencies and no install scripts. The same code runs in the CLI, inside the Electron launcher's main process, and later in a VS Code extension. A standalone executable (Node single-executable application) is the answer for machines without Node (D2, revisit trigger).

## 3. The plan (data model)

The full field-by-field reference is [PLAN-SCHEMA.md](PLAN-SCHEMA.md). The shape:

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "seefast", "version": "0.1.0" },
  "digest": "sha256:…",                    // over everything except meta: identifies the plan for consent and diff
  "meta": { "generatedAt": "…", "durationMs": 41, "timings": {…}, "stats": {…}, "inputs": [{ "file": "api/composer.json", "sha256": "…" }] },
  "projects": [{ "id": "api", "root": "api", "ecosystems": ["php", "node"], "frameworks": [{ "id": "laravel", "version": "^11.0", … }],
                 "packageManagers": [{ "ecosystem": "node", "name": "npm", "confidence": "high", "evidence": […] }],
                 "dependsOn": [{ "project": "web", "kind": "runtime", "why": "…", "confidence": "medium", "evidence": […] }] }],
  "requirements": [{ "id": "runtime:php", "kind": "runtime", "name": "php", "range": ">=8.2", "recommended": "8.3",
                     "projects": ["api"], "confidence": "high", "status": "ok", "why": "…", "evidence": […] }],
  "services": [{ "id": "service:mysql", "name": "mysql", "category": "database", "version": "8.0", "provider": { "compose": { "file": "docker-compose.yml", "service": "mysql" } },
                 "ports": [3306], "projects": ["api"], "confidence": "high", "evidence": […] }],
  "env": [{ "project": "api", "file": "api/.env", "template": "api/.env.example", "exists": false,
            "vars": [{ "name": "DB_PASSWORD", "fill": "user", "secret": true, "evidence": […] },
                     { "name": "APP_KEY", "fill": "generated", "by": "api.key" }] }],
  "steps": [{ "id": "api.install", "project": "api", "phase": "install", "title": "Install PHP dependencies",
              "cwd": "api", "action": { "type": "exec", "argv": ["composer", "install"] },
              "network": true, "thirdPartyCode": true, "outsideProject": false,
              "after": [], "requires": ["runtime:php", "tool:composer"], "confidence": "high", "why": "…", "evidence": […] }],
  "run": [{ "id": "web.dev", "project": "web", "kind": "dev", "cwd": "web", "action": { "type": "exec", "argv": ["pnpm", "run", "dev"] },
            "ports": [{ "port": 3000, "confidence": "medium", "evidence": […] }], "needs": ["api.dev"],
            "readiness": { "type": "port", "port": 3000, "timeoutSec": 120 } }],
  "conflicts": [{ "id": "…", "subject": "packageManager@web", "chosen": "pnpm", "message": "README says npm install, but pnpm-lock.yaml exists; using pnpm.", … }],
  "unknowns": [{ "id": "…", "subject": "…", "message": "…", "suggestion": "…" }]
}
```

Choices worth calling out:

* **Commands are argv arrays plus typed actions, not shell strings.** `exec` (argv), `copy` (if missing), `touch` (create empty file if missing), `manual` (something only a person can do). The guide renders each action for POSIX shells and for PowerShell; the runner executes argv without a shell (D7). A copy is never `cp`: the runner does it with the file system API, refusing to overwrite.
* **Every item carries `confidence`, `evidence[]` (file, line, source kind, role) and `why`.** Evidence roles are `basis`, `supports` and `contradicts`, so the explain view can show the disagreement too.
* **No absolute paths and no machine facts in the plan.** All paths are relative to the analyzed folder with `/` separators. Only `meta.generatedAt`, `meta.durationMs` and `meta.timings` vary between runs; the determinism test compares everything else byte for byte.
* **`digest`** is the SHA-256 of the canonical JSON without `meta`. Consent can be bound to it (`--approve sha256:…`), and `diff` uses it to say "nothing changed" in one comparison.
* **`meta.inputs`** lists every file the analysis read with the hash of its normalized content, which is how the launcher tells that a repo changed since the last plan.

## 4. Evidence and confidence

### Claims, subjects and per-question policies

Providers emit **claims**: `{ subject, value, source, evidence }`. A *subject* is a question: "which package manager for `web`?", "which Node version?", "does `api` need MySQL?". A *source* is a kind: `manifest-explicit` (e.g. `packageManager` field), `lockfile`, `manifest`, `version-file`, `ci`, `container`, `devcontainer`, `task-runner`, `env-template`, `readme`, `code`, `recipe` (framework knowledge), `default`.

The brief's single ranking (CI first, README last) is right on average and wrong per question. CI is the best evidence that `pnpm install --frozen-lockfile` works, but weak evidence for which *database* a developer should run (CI often uses SQLite or a service container a developer never starts) and for which Node version to *use* (a matrix tests several). So **each subject type has its own policy**: an ordered list of source kinds and the base confidence each gives.

| Question | Order (strongest first) |
| --- | --- |
| Package manager | `packageManager` field → lockfile → CI → dev container / Dockerfile → task runner → README → default (npm) |
| Runtime version | constraints: `engines`, `require.php`, `go` directive, framework minimum (recipe) • preferences: version file (`.nvmrc`, `.tool-versions`, `mise.toml`, `.php-version`...) → dev container → CI → Dockerfile → README |
| PHP extensions | `composer.json` `ext-*` → `composer.lock` package requirements → Dockerfile `docker-php-ext-install` → CI `setup-php` extensions → recipe (driver from env template) |
| Services | env template (`DB_CONNECTION=mysql`) → Compose service → dev container → CI service container → recipe default |
| Setup steps | recipe (framework convention) → dev container lifecycle commands → CI run steps → task-runner targets → README |
| Run targets and ports | manifest scripts → Procfile → Compose `ports` → recipe default port → README |

### Version claims are constraints or preferences

`engines.node: ">=20"` is a **constraint** (anything outside may fail). `.nvmrc: 20.11.1` is a **preference** (what the maintainers use). Resolution:

1. The requirement's `range` is the intersection of all constraints (SemVer intersection; Composer constraints are translated, `~8.2` meaning `>=8.2 <9` in Composer and not `<8.3` as in npm).
2. `recommended` is the strongest preference that satisfies the range. CI matrices count as a set of tested versions.
3. A preference outside the range becomes a **conflict** with a sentence: ".nvmrc pins Node 18, but package.json engines requires >=20; using >=20 (installs may fail on 18). Consider updating .nvmrc."
4. Constraints with an empty intersection make the requirement `status: "conflict"` with no satisfying version: nothing is guessed.

### Confidence: three discrete levels, combined by rules

Levels are `high`, `medium` and `low`; `unknown` is a status, not a level (D5). The rules, applied per subject:

1. **Base**: the winning claim's level from the policy table.
2. **Corroboration**: if a claim from a *different source kind* agrees, raise one level (never above `high`). Two README mentions do not corroborate each other; README plus CI do.
3. **Contradiction**: a disagreeing claim of *equal or higher* rank lowers the result one level and creates a conflict that needs attention. A disagreeing claim of *lower* rank creates an informational conflict and leaves the level alone (the README that says `npm install` next to a `pnpm-lock.yaml`).
4. **Ties** between equally ranked, disagreeing claims make the subject `unknown` with both candidates listed, unless a recipe tie-breaker applies.
5. **Nothing found**: an `unknowns[]` entry, with what was looked for and where.

Why discrete: users act on "sure / probably / guess", tests can assert exact values, and every level is explainable by naming the rule that produced it. Scores (0.73) imply a precision the inputs don't have and make fixtures brittle.

### Never presenting a guess as fact

* Defaults are claims too (`source: "default"`, `confidence: "low"`), e.g. "no lockfile: assuming npm".
* Text sources (README, scripts) are parsed, never "understood": a README command only counts if it matches a known command grammar (install, copy env, artisan, migrate...).
* Anything dropped is counted: files skipped (size, depth, binary, ignored directory), unparsable files, README commands not understood. These are in `meta.stats` and summarized by the CLI.

## 5. User flows

### Manual

`seefast` (or `seefast guide`) prints: projects found, requirements with status icons, conflicts and unknowns in plain language, then numbered steps grouped by phase, each with its working directory and the command for the current shell (`--shell posix|powershell` to switch). `seefast explain [step]` shows why each step exists and the files that support it. `seefast setup-md --write` writes `SETUP.md` (only when asked).

### Doctor

`seefast doctor` compares the plan's requirements with the machine. It runs only the fixed commands listed in [DOCTOR.md](DOCTOR.md) (`node --version`, `php -m`...), by absolute path after a PATH lookup done without spawning, with no shell, from a neutral empty directory (so Composer cannot load the project's plugins and Corepack cannot switch versions or download), with a 5-second timeout. It also checks whether expected ports are free by binding to them on 127.0.0.1 (nothing is sent anywhere). Results: `ok`, `missing`, `wrong-version`, `unknown`, `not-checked`, each with OS-specific advice from the bundled knowledge base, preferring a version manager the user already has (mise, fnm, nvm, Volta, asdf). Exit code 0 when everything required is present, 3 when something is missing.

### Automated

`seefast setup` shows the whole plan first, prints the warning that installing dependencies runs third-party code, marks network steps, then asks per step (`y` run, `s` skip, `a` approve the rest, `q` quit). Non-interactive use needs `--yes` (approve the plan that is printed) or `--approve sha256:…` (approve exactly the plan whose digest you reviewed; refuses if the plan changed). Steps that change anything outside the project (starting Compose containers) need `--allow-outside` in addition. It never runs `sudo`/`doas`/`runas`, stops on the first failure, writes a log per step and a resume state under `.seefast/` (which contains its own `.gitignore`), and `--resume` continues from the failed step if the plan digest still matches. `--dry-run` executes nothing. `seefast start [target]` starts run targets with their dependencies (services → backend → frontend), prefixes output per process, and reports readiness.

## 6. The floating launcher

Electron app (`app/`), reading the same plan from the same library (D3). Window strategy (D11):

* **Collapsed**: a 64×64 transparent, frameless, always-on-top window holding a circular `<button>`.
* **Expanding**: compute the panel rectangle from the bubble's position on its display's *work area*: the panel grows toward the side with more room, horizontally and vertically, and is clamped inside the work area (shrunk and scrolled if the display is too small). The window is first resized to the panel rectangle (still transparent, so nothing visible changes); the main process returns the bubble's exact rectangle inside it, and CSS animates position, size and corner radius from there to the panel. Collapsing reverses it, returns the bubble to where it was, and shrinks the window afterwards. Between panels of different sizes the window takes the union of both rectangles during the morph. This gives the same smooth morph on all three OSes, which window-level resize animation (macOS only) cannot.
* **Drag vs click**: pointer events in the renderer with pointer capture; a press that moves less than 5 DIPs is a click, anything else is a drag that moves the window through IPC (the main process follows the OS cursor). CSS `-webkit-app-region: drag` is *not* used, because it swallows the click.
* **Position memory**: saved as display id + position relative to that display's work area. On start and on `display-added/removed/metrics-changed`, the bubble is put back on its display, or the nearest one, and clamped into the work area. Electron works in DIPs, so per-monitor scaling is handled; after a cross-monitor move the size is re-asserted (Windows can rescale a window crossing monitors).
* **Reduce motion**: `prefers-reduced-motion` replaces the morph with an instant switch.
* **Accessibility**: the bubble is a real button (Enter/Space opens, arrow keys move it by 10 px, Shift+arrows by 50 px); panels are landmark regions with headings; runner status is an `aria-live` region; focus moves into a panel when it opens and back to the bubble when it closes; Escape collapses. Global shortcut (default `CommandOrControl+Alt+K`, configurable) toggles the bubble; a tray/menu-bar icon offers show/hide, recent projects and quit.
* **No network**: strict CSP (`default-src 'self'`), all navigation and new windows denied, every request outside the app's own files cancelled by a session filter; the fonts (Nunito and Chakra Petch, both SIL OFL 1.1, licenses in `app/assets/fonts/`) are bundled and every icon is inline SVG.
* **Look and feel**: friendly, cartoonish sci-fi, built from the robot's own materials: armor-plate cards with ink outlines and cel shading, dark "housing" strips for the header and the dock with a cyan light slot, lit cyan keys for primary actions, and HUD details (a faint grid, corner brackets in the answer's color, hexagon step numbers like the lens aperture, segmented light bars). Light mode is armor white, dark mode deep space; Chakra Petch for headings and buttons, Nunito for reading. It all centres around an armored sphere robot with one big camera eye: it *sees* what a project needs. Its eye carries the state at a glance (blue and blinking its lens shutter when idle; scanning with a turning light ring while busy; a mint squint when everything is there; an amber glow under a lowered lid when something is missing) and is always paired with words, never the only signal. Each view leads with one sentence that answers the question ("Almost ready: 1 thing to check", "1 thing to fix"), then shows only what matters (a quick start, projects, what to install, warnings); evidence, notes and passing checks sit one click away in collapsed sections. The two ways to set up (guide me / do it for me) stay docked at the bottom of the overview; in automated mode Start and Preview stay docked while every command it will run is listed above them. Animations (pop-in, blink, bob) are off under reduced motion.

### Platform research (summary; details in [PLATFORMS.md](PLATFORMS.md))

| | Transparent + frameless | Always on top | Positioning | Global shortcut | Tray |
| --- | --- | --- | --- | --- | --- |
| Windows 10/11 | yes | yes (`showInactive` to avoid stealing focus) | yes; re-assert size after crossing monitors with different scaling | yes | yes |
| macOS | yes | yes; `type: 'panel'` + `setVisibleOnAllWorkspaces(…, { visibleOnFullScreen: true })` to stay above full-screen Spaces | yes | yes (needs no accessibility permission for registered accelerators) | menu bar |
| Linux X11 | yes with a compositing WM, else black corners | yes (`_NET_WM_STATE_ABOVE`) | yes | yes | needs a StatusNotifier host (GNOME: AppIndicator extension) |
| Linux Wayland (native) | yes | **no** | **no** (compositor places windows) | no reliable API | as above |

**Wayland fallback**: when `WAYLAND_DISPLAY` is set and XWayland is available (`DISPLAY` set), the app starts on the X11 backend, where GNOME and KDE honour position and always-on-top. Without XWayland, or when the user picks it, the app runs in **window mode**: a normal small decorated window with the same panels. `seefast-app --toggle` (single-instance) can be bound to a desktop shortcut where global shortcuts don't work.

## 7. Answers to the open questions

**Implementation language.** TypeScript on Node ≥ 20. The analyzer is mostly config parsing, where JavaScript's JSON/YAML/TOML libraries are mature and keep source positions (`yaml`, `jsonc-parser`), and it must run in three hosts: a CLI, the Electron launcher and a VS Code extension (Node). A Go or Rust binary would avoid the Node prerequisite but would put a process boundary between the analyzer and both UIs, and SeamMap already learned how costly per-platform native binaries are. For people without Node, the desktop app bundles its runtime, and a Node single-executable build of the CLI is the planned answer (D2). **Desktop framework: Electron** (D3): the only option where transparent, frameless, always-on-top windows, tray, global shortcuts and display events behave the same on all three OSes and the analyzer runs in-process. Tauri is the revisit candidate (10× smaller), blocked today by the analyzer being TypeScript (a sidecar binary) and by WebKitGTK transparency on Linux.

**Confidence model.** Discrete levels with explicit combination rules (section 4, D5).

**Consent model.** Per step by default; approve-the-rest at any prompt; non-interactive `--yes` or digest-bound `--approve`; separate `--allow-outside` for steps that touch anything outside the project; dry run always available (D6).

**OS-specific guidance offline.** A curated JSON knowledge base shipped in the package (`kb/`), keyed by tool and OS family (Debian/Ubuntu, Fedora/RHEL, Arch, Alpine, macOS/Homebrew, Windows/winget+Scoop), each entry with a `reviewed` date and source. It is kept current by releases: a test fails when a recipe can emit a requirement the KB doesn't cover, and the doctor prints the KB date so stale advice is visible. Version managers already on the machine are preferred over OS packages (D8).

**Writing into the repo.** Analysis writes nothing. `SETUP.md` only with `setup-md --write`; `.env` only by the consented runner's copy step (never overwriting). The runner's own state goes in `.seefast/` with a self-ignoring `.gitignore` (D10).

**Services.** Use the repo's own Compose file when it declares the service (a step `docker compose up -d mysql redis`, marked outside-project and network). Otherwise explain what is needed (version, port, env vars to set) with OS-specific install advice. Generating a Compose file for missing services is a helper behind an explicit command, planned after v1 (D12).

**Running a monorepo.** `seefast start` builds the process graph from `run[].needs`: services first, then backends, then frontends; each process waits for its dependencies' readiness before starting; output is prefixed with the target id; one Ctrl+C stops all in reverse order. The launcher shows the same as one row per process.

**Proof of "running".** Readiness levels: `listening` (a TCP connection to the expected port on 127.0.0.1 succeeds), `responding` (an HTTP request gets any response), `stays-up` (no port known: the process is still alive after 20 s). The validation harness counts `listening` or better as success, and reports which level each repo reached.

**Recipe format.** Both: declarative JSON for detection, requirements, env vars, steps and run targets; a fixed set of named engine functions for computed values (D9).

**Name.** SeeFast: "see what a project needs, and get it running". Registry checks and rejected names are in the note at the top of this document.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Stale or contradictory sources produce a confident wrong plan | Per-question policies, conflicts in plain language, `explain`, and the validation corpus measured against CI ground truth. |
| Third-party code runs during install (npm lifecycle scripts, Composer scripts) | Allowed only in automated mode, with a warning before the first such step and per-step consent; never during analysis or doctor. |
| Probes trigger project code (Composer plugins) or downloads (Corepack) | Doctor runs probes from an empty temporary directory with `COREPACK_ENABLE_NETWORK=0`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, by absolute path, no shell. |
| Windows `.cmd` shims cannot be spawned without a shell (Node ≥ 20 security fix) | The runner resolves `PATHEXT`, and runs `.cmd`/`.bat` through `cmd.exe /d /s /c` with argv quoted for cmd; argv comes only from the plan. PowerShell guides note the `npm.ps1` execution-policy trap. |
| Floating windows behave differently per OS and desktop | Window mode fallback, XWayland on Wayland, documented matrix, geometry logic in pure tested functions. |
| Big monorepos are slow | Bounded walk (depth, file count, size caps, ignored directories), lockfiles parsed only when needed, timings in `meta`; benchmarks published. |
| Knowledge base goes stale | `reviewed` dates, coverage test, KB date in doctor output. |
