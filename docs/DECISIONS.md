# Decision log

Each entry: the problem, the options considered, the choice, the reasons, and what would make us revisit it. Newest last.

## D1. Scope of the first release (2026-11-01)

**Problem.** The brief left the first ecosystems blank.
**Options.** (a) Node + PHP + Compose (the brief's default); (b) start with Python, which has the messiest setup story; (c) breadth first: shallow support for ten ecosystems.
**Choice.** (a), plus generic, low-confidence detection for Python, Go, Rust, Ruby, Java and .NET so that unsupported repos still get runtimes, a likely install command and the repo's own task-runner targets.
**Why.** It matches SeamMap's proven narrow-and-deep path and the author's Laravel/Next.js expertise, and Laravel + Next.js together exercise every hard part: two package managers in one folder, PHP extensions, env generation, databases, a frontend that needs a backend.
**Revisit when.** The validation corpus shows generic fallbacks are used for more than a third of repos people actually feed it.

## D2. Implementation language: TypeScript on Node ≥ 20 (2026-11-01)

**Problem.** A setup tool that needs Node is awkward for a Go or Python developer; a static binary avoids that.
**Options.**
1. TypeScript/Node: same stack as SeamMap; mature JSON/YAML/TOML parsers that keep line numbers; runs in-process in Electron and a VS Code extension; `npx` install. Requires Node for the CLI.
2. Go: single static binary, fast startup, good YAML/TOML libraries; desktop via Wails (WebView2/WebKit). The VS Code extension would need per-platform binaries, and the launcher would cross a process boundary for every call.
3. Rust: single binary; desktop via Tauri. Same boundary and per-platform build costs, slower to iterate.
**Choice.** TypeScript on Node ≥ 20, with four pure-JS runtime dependencies (`yaml`, `jsonc-parser`, `smol-toml`, `semver`) and no install scripts.
**Why.** The hard part of this tool is evidence resolution and UX, not raw speed (the target is < 1 s and config parsing is fast in any language). One codebase serves the CLI, the launcher and the editor extension without IPC. The Node prerequisite is answered three ways: the desktop app bundles its runtime; `npx` works for the many developers who have Node; and a Node single-executable application (SEA) build of the CLI is planned for the rest.
**Revisit when.** User feedback shows the Node prerequisite blocks adoption *and* SEA binaries prove too large or flaky; then port `src/core` (pure, no I/O except the read layer) to Go behind the same plan schema, using the fixtures as the conformance suite.

## D3. Desktop framework: Electron (2026-11-01)

**Problem.** The launcher needs a transparent, frameless, always-on-top, draggable window that resizes and morphs, plus tray, global shortcut, display-change events and a folder picker, on Windows, macOS and Linux.
**Options.** Electron; Tauri v2; Wails; a native toolkit per OS; Qt.
**Choice.** Electron.
**Why.** It runs the TypeScript analyzer in-process; its window APIs (`setAlwaysOnTop` levels, `type: 'panel'` on macOS, `setVisibleOnAllWorkspaces`, `screen` events in DIPs, `globalShortcut`, `Tray`) behave consistently across OSes and are well documented; transparency on Linux uses Chromium's compositor rather than WebKitGTK. Tauri is ten times smaller but would need the analyzer as a sidecar binary (see D2) and its Linux transparency depends on WebKitGTK and the compositor. A native toolkit per OS triples the UI work.
**Cost.** ~100 MB installed. Accepted for a desktop app; the CLI remains light.
**Revisit when.** The analyzer is ported to a compiled language (D2), or install size becomes a top complaint.

## D4. The source ranking is per question, not global (2026-11-01)

**Problem.** The brief ranks CI > containers > manifests/lockfiles > version files > task runners > env templates > README.
**Observation.** That ranking fails on specific questions: the lockfile, not CI, decides the package manager; CI often runs tests on SQLite or on service containers a developer never starts, so env templates are better evidence of the *local* database; a CI matrix tests several Node versions and does not say which one to use.
**Choice.** Each subject type has its own ordered policy (DESIGN.md §4). Version claims are split into constraints (ranges) and preferences (pins).
**Revisit when.** Validation shows a policy picking wrong answers that a different order would have got right.

## D5. Confidence: three discrete levels with explicit combination rules (2026-11-01)

**Options.** Numeric scores combined probabilistically; discrete levels; a bare boolean "certain".
**Choice.** `high` / `medium` / `low` from the policy table, +1 level for corroboration by a different source kind, −1 for contradiction by an equal-or-stronger source, ties become `unknown`.
**Why.** Every level is explained by naming the rule that produced it; tests assert exact values; users act on "sure / probably / guess", not on 0.73.
**Revisit when.** Users ask for finer ranking among many candidates (e.g. dozens of possible run commands), where scores would help ordering, not display.

## D6. Consent model (2026-11-01)

**Choice.** Interactive per-step consent by default, with "approve the rest" at any prompt. Non-interactive: `--yes` (approves the plan as printed in full first) or `--approve <digest>` (binds approval to the exact plan reviewed earlier; refuses if anything changed). Steps flagged `outsideProject` additionally require `--allow-outside` or a separate interactive confirmation. `--dry-run` never executes. Stop on first failure. Never elevate.
**Why.** Per-phase consent groups steps with different risks (copying `.env` vs running `composer install`); approving a whole plan is only meaningful if it's bound to what was reviewed, hence the digest.
**Revisit when.** Users find per-step prompts tedious in practice and `a` is not enough.

## D7. Commands are argv plus typed actions; no shell strings (2026-11-01)

**Problem.** The same plan must be shown and run in PowerShell and POSIX shells.
**Choice.** Steps hold `argv` arrays or typed actions (`copy`, `touch`, `manual`). Renderers quote per shell. The runner executes argv without a shell; on Windows, `.cmd`/`.bat` shims are resolved via `PATHEXT` and run through `cmd.exe /d /s /c` with cmd quoting, because Node refuses to spawn them directly since the 2024 security fix.
**Why.** Shell strings would need parsing and quoting rules per shell, and would make `&&`, globbing and variable expansion silent hazards. File copies done natively can refuse to overwrite on every OS.
**Revisit when.** A recipe genuinely needs a pipeline; then add a typed action, not a shell string.

## D8. OS guidance: curated offline knowledge base (2026-11-01)

**Choice.** `kb/*.json` keyed by tool or PHP extension and OS family, with `reviewed` dates and sources. Version managers present on the machine are preferred. Coverage test against recipes. The doctor prints the KB date.
**Revisit when.** Maintaining the KB by hand becomes the bottleneck; then generate parts of it at release time from package indexes (still shipped offline).

## D9. Recipes: declarative JSON with a fixed set of engine functions (2026-11-01)

**Options.** Code plugins; pure data; data with named computed functions.
**Choice.** JSON recipes with conditions (`dep`, `composer`, `file`, `envKey`, `envValue`, `script`, `all/any/not`), templated argv (`{pm}`, `{exec}`, `{run:script}`), and a short list of named functions implemented in the engine (`laravelDbService`, `nextMinNode`...).
**Why.** Contributors can add framework knowledge without touching the engine, recipes are safe to load (no code), and they are testable as data. The few computations that need logic stay reviewed engine code.
**Revisit when.** More than a handful of recipes need new engine functions; then consider a tiny expression language.

## D10. Writing into the analyzed project (2026-11-01)

**Choice.** Analysis and doctor write nothing. `SETUP.md` only with `--write`. `.env` only through a consented `copy` step that never overwrites. The runner keeps state and logs in `.seefast/` inside the project, with a `.gitignore` containing `*` so it never shows up in `git status`. The launcher stores plans and recent projects in its own app-data folder.
**Revisit when.** Teams want the plan committed (e.g. for review in pull requests); then add `plan --write` that writes `setup-plan.json` deliberately.

## D11. Launcher window strategy (2026-11-01)

**Problem.** Smooth morphing between a circle and panels of different sizes, without a large transparent window blocking clicks.
**Options.** (a) One large transparent window with click-through on empty areas (`setIgnoreMouseEvents(true, { forward: true })`): forwarding is unsupported on Linux, so hover cannot re-enable input there. (b) Animate the window bounds: animated `setBounds` is macOS-only and janky elsewhere. (c) Resize the window to the target rectangle while it is still transparent, morph in CSS, shrink afterwards.
**Choice.** (c). Drag implemented with pointer events, not `-webkit-app-region`.
**Revisit when.** A platform shows visible flicker during the resize; then pre-size to the largest panel only while expanded.

## D12. Services: use the repo's Compose file, otherwise explain (2026-11-01)

**Choice.** When Compose declares the service, emit `docker compose up -d <services>` (flagged network and outside-project). Otherwise list the service with version, port and env vars and give OS-specific install advice. Generating a Compose file is a later, explicit helper.
**Why.** Generating infrastructure the maintainers didn't write is a guess about versions, credentials and volumes; explaining is honest and fast.
**Revisit when.** Validation shows most repos without Compose fail only because of a missing database.

## D13. Install commands respect the lockfile (2026-11-01)

**Choice.** `npm ci` (with `package-lock.json`), `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` (classic) / `yarn install --immutable` (Berry), `bun install --frozen-lockfile`, `composer install`.
**Why.** A fresh clone should get exactly what the maintainers tested, and setup should not modify tracked files. When the lockfile is out of date the step fails loudly and the guide explains the fallback (plain `install`), rather than silently resolving new versions.
**Revisit when.** Validation shows many real repos have out-of-sync lockfiles.

## D14. pnpm installs skip unapproved dependency build scripts (2026-11-01)

**Problem.** Found by the end-to-end runs: pnpm 11 and later stop with `ERR_PNPM_IGNORED_BUILDS` when dependencies
have build scripts the project has not approved. A repo with no `packageManager` field (vercel/commerce) gets the
newest pnpm from Corepack and cannot be installed non-interactively; `pnpm approve-builds` is interactive.
**Options.** (a) Keep the plain command and explain the error; (b) `--config.strict-dep-builds=false`, which keeps
pnpm 10's behaviour: unapproved build scripts are skipped with a warning; (c) `--config.dangerously-allow-all-builds`.
**Choice.** (b), only when the project declares no build approvals (`onlyBuiltDependencies`, `allowBuilds`... in
package.json or pnpm-workspace.yaml) and does not pin pnpm 9 or older. The step's note says so and names
`pnpm approve-builds`.
**Why.** It makes the install succeed while running *less* third-party code, not more; (c) would run every script.
The flag is visible in the plan and the guide, never added silently by the runner.
**Revisit when.** pnpm changes the setting's name or default again, or a project needs a skipped build to start.

## D15. On Linux Wayland, a normal window by default (2026-11-01)

**Problem.** Found by the user on the first real launch: on GNOME/Wayland with an Intel Tiger Lake GPU, no Electron 44
window appears through XWayland (opaque or transparent), while Electron reports it visible at the right position.
The launcher used XWayland on every Wayland session, so the bubble was invisible. The smoke test passed because its
screenshots come from inside Chromium, not from the screen.
**Options.** (a) Keep XWayland and try GPU flags (tested: no backend gives GPU compositing under XWayland there);
(b) a frameless bubble on native Wayland (renders, but cannot float, be placed or remember its place); (c) a normal
window on Wayland, with the floating bubble as an opt-in that names the risk.
**Choice.** (c), plus `SEEFAST_WINDOW=window|floating` to override the setting, so an invisible bubble always has a
way back.
**Why.** An app that does not appear is worse than one that does not float; the brief's fallback for desktops that
cannot float windows is exactly a normal window. Native Wayland rendering was confirmed on screen by a person.
**Revisit when.** Electron's XWayland output works on that hardware, or the app can confirm on-screen rendering itself;
or GNOME supports a protocol for always-on-top utility windows.
