# Milestone report

Status of the first release against the brief's milestones. The numbers come from [VALIDATION.md](VALIDATION.md);
the decisions from [DECISIONS.md](DECISIONS.md).

## Order of work, and why it differs from the brief

The brief suggested five milestones, with the launcher growing alongside 1–3. The work followed that, with one
change: the validation corpus was built right after milestone 1 rather than at milestone 3, because the first run
against real repositories found problems no fixture had (lockfile `engines` from optional platform binaries,
duplicated conflicts, recipe ids colliding with script names). Measuring early changed what got built next.
Milestone 4 (more ecosystems) was reduced to generic support; milestone 5 (editor extension) was not started.

## Milestone 1: plan core

**Works.** Detection of projects (nested, workspaces, Laravel + Node in one folder), evidence model, plan schema v1,
per-question resolution with three confidence levels, conflicts and unknowns, terminal guide and `explain`.
Recipes for Laravel, Next.js and Prisma as JSON. Generic support for eight more ecosystems and Makefile-only repos.

**Exit criterion: all fixtures produce their expected plan, deterministically.** Met: 15 fixtures, each with a golden
plan and trap-specific assertions; determinism (two runs, any absolute location) and portability (CRLF + BOM) tested
per fixture; 160 tests in total, including regression tests for the traps found on real repositories.

**Measured.** 52 ms median analysis time on 32 real repositories; 323 ms for the largest (Cal.com, 113 workspace
packages); 1.6 s for the slowest cold run. Brief's targets: 1 s typical, 5 s for a large monorepo. Plan accuracy on 8
held-out repositories: 61% of required steps (the README alone: 21%), package manager 7/7.

## Milestone 2: doctor and SETUP.md

**Works.** Fixed list of read-only probes (no shell, PATH lookup without spawning, run from an empty temporary
folder with downloads disabled), port checks by binding, env-file existence by `stat`, offline advice for
Debian/Ubuntu, Fedora/RHEL, Arch, Alpine, openSUSE, macOS and Windows, preferring version managers already
installed. `setup-md` writes SETUP.md only with `--write` and never over a file it did not write.

**Exit criterion: correct gaps on Windows and one Unix-like system.** Partly met. On Linux (Arch) the doctor ran for
real and found a real gap (the `redis` PHP extension a project's `CACHE_STORE=redis` needs, with the right Arch
advice). Windows, Ubuntu and macOS behaviour is covered by tests on simulated hosts (PATHEXT lookup, `.cmd` shims,
the Store `python` alias, php.ini advice, execution-policy warning, apt package names); the CI workflow runs the
doctor on real Windows and macOS runners, but has not run yet.

## Milestone 3: automated mode

**Works.** Every command shown first; per-step consent, approve-the-rest, `--yes`, or approval bound to the plan's
digest; outside-project steps need their own yes; dry run; stop on first failure; resume; logs in `.seefast/`;
never elevates; never overwrites an env file. `start` runs targets in dependency order with readiness checks.

**Exit criterion: end-to-end runs succeed in clean containers on the validation corpus at a measured rate.** Measured
on 11 repositories that can run without a database server: the plan got the app answering on its port in **7 of 11**,
the README alone in 2 of 11 ([VALIDATION.md](VALIDATION.md#end-to-end)). The three plan failures stopped at a step
that names the reason (no MySQL server; two PHP extensions the doctor reports; Composer blocking a dependency with
security advisories). The runs found seven problems static scoring could not: pnpm 11+ refusing unapproved build
scripts, pnpm refusing old lockfile formats, an env file Prisma cannot read, a production `start` chosen as the dev
command, stale lockfiles, a Composer `^0` translation bug, and a README tooling section becoming a required step.

## Launcher (alongside 1–3)

**Works.** Floating bubble with drag vs click, position memory per display, panels that open toward the side with
room and morph out of the bubble, reduce motion, keyboard and screen-reader support, tray, global shortcut, single
instance, folder drop, recent projects, "changed since last time", and panels for the analysis, manual guide,
doctor, automated setup and settings. Wayland handled through XWayland or a normal window.

**Measured.** A smoke test drives the real window: 16/16 checks on Linux under XWayland. Windows and macOS not yet
run.

## Known limitations

See [README.md#limitations](../README.md#limitations). The most important: about a third of required setup steps are
missed on repositories the tool was not tuned on, mostly because the steps live in external docs, in one-command
scripts listed as their parts, or need accounts only a person can create.

## Next

1. Run the CI matrix and the launcher on real Windows and macOS machines; fix what they find.
2. End-to-end runs with database service containers next to the clean machine, to cover the Laravel apps that need
   MySQL or PostgreSQL.
3. Recognise one-command setup scripts (`composer setup`, `npm run dx`) as an equivalent path rather than missing
   steps; offer them as "the maintainers' way".
4. Recipes for Django, Rails and Symfony, then Nuxt, Remix and SvelteKit (milestone 4), each with fixtures and
   corpus repos first.
5. Editor extension reading the same plan (milestone 5).
6. A single-executable build of the CLI for machines without Node.js (D2).
