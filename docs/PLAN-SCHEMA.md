# The setup plan (`setup-plan.json`), schema version 1

The plan is the single output of the analysis and the only input of every interface: the terminal guide,
`explain`, `SETUP.md`, the doctor, automated setup, `start` and the launcher. TypeScript types are in
[`src/core/schema.ts`](../src/core/schema.ts) and exported as `seefast/schema`.

```bash
seefast plan . > setup-plan.json        # or: seefast plan . -o setup-plan.json
seefast guide --plan setup-plan.json    # every command can read a saved plan instead of analyzing
```

## Conventions

* **Paths** are relative to the analyzed folder, with `/` separators, on every OS. `.` is the folder itself. No absolute path appears anywhere in a plan.
* **Determinism.** Two analyses of the same files give byte-identical plans except `meta.generatedAt`, `meta.durationMs` and `meta.timings`. Arrays are sorted (projects in dependency order, steps in execution order, everything else by id).
* **Confidence** is `high`, `medium` or `low` (shown as *sure*, *likely*, *guess*). See [DESIGN.md §4](DESIGN.md#4-evidence-and-confidence) for how it is computed. "Unknown" is never a confidence: it is a `status`, an `unknowns[]` entry, or a variable whose `fill` is `unknown`.
* **Evidence** backs every item. Nothing is stated without at least one evidence entry, except variables a framework requires (`fill: "user"` with an empty list and a `note`).
* **Secrets** never appear. Env values are never copied. A template value is used only for driver names, hosts, ports and URLs reduced to `scheme://host:port`. Commands quoted as evidence are redacted (inline `NAME=value` assignments, `-p<password>`, `user:password@` in URLs, tokens).
* **Versioning.** `schemaVersion` changes only when a reader written for the previous version would misread a plan. New fields and new enum values do not change it. `checkPlan(plan)` says whether a version can read a plan.

## Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | number | Format version, currently `1`. |
| `tool` | `{ name, version }` | The tool that wrote the plan. |
| `digest` | string | `sha256:` of the canonical JSON (sorted keys) of the plan without `meta` and `digest`. Approval with `setup --approve <digest>` is bound to it; `diff` uses it. |
| `summary` | object | See below. |
| `projects` | `Project[]` | Projects found, in dependency order. |
| `requirements` | `Requirement[]` | What the machine needs: runtimes, package managers, PHP extensions, tools. |
| `services` | `Service[]` | Backing services (databases, caches, mail catchers...). |
| `env` | `EnvFile[]` | Env files to create and the variables in them. |
| `steps` | `Step[]` | Setup steps in execution order. |
| `run` | `RunTarget[]` | How to start, serve and test the projects. |
| `tasks` | `Task[]` | The repo's own task-runner targets and scripts (Makefile, justfile, Taskfile, composer scripts, Procfile, dev container and Gitpod hooks), listed, never run. |
| `conflicts` | `Conflict[]` | Disagreements between sources, and how they were resolved. |
| `unknowns` | `Unknown[]` | What could not be determined. |
| `meta` | `PlanMeta` | Timing, statistics, inputs. |

### `summary`

| Field | Meaning |
| --- | --- |
| `support` | `full` (every project in a supported ecosystem), `partial` (some generic), `generic` (only fallbacks), `none` (nothing found). |
| `projects`, `steps`, `conflicts`, `unknowns` | Counts. |
| `lowestStepConfidence` | The lowest confidence among required steps, or `null` when there are none: a one-glance measure of how much to trust the plan. |

## `Evidence`

| Field | Meaning |
| --- | --- |
| `file` | File the evidence comes from. |
| `line` | 1-based line, when the source has one. |
| `source` | Kind of source: `manifest-explicit` (a field whose only purpose is the answer, e.g. `packageManager`), `lockfile`, `manifest`, `version-file`, `devcontainer`, `ci`, `container` (Dockerfile), `compose`, `task-runner`, `env-template`, `readme` (also CONTRIBUTING and docs), `code` (env reads found in source), `recipe` (framework knowledge applied to a project file), `default`. |
| `detail` | What the file says, briefly. Never a secret. |
| `role` | `basis` (the answer rests on it), `supports` (agrees), `contradicts` (disagrees; see `conflicts`). |

## `Project`

| Field | Meaning |
| --- | --- |
| `id` | `root` for the analyzed folder, otherwise its path (`apps/web`). Used in step and run ids. |
| `root` | `.` or a relative path. |
| `name` | From the manifest (`name`), else the folder name. |
| `ecosystems` | `node`, `php`, `python`, `go`, `rust`, `ruby`, `java`, `dotnet`, `deno`, `elixir`, `generic`; the framework's ecosystem first. |
| `support` | `full` or `generic` (lower-confidence fallbacks). |
| `role` | `app`, `library`, `workspace-root`, `tooling`, `unknown`. |
| `frameworks` | `{ id, name, version?, confidence, evidence }`; `version` is the declared range (`^11.31`). |
| `packageManagers` | `{ ecosystem, name, version?, confidence, why, evidence }`. `version` only when declared exactly (`packageManager: pnpm@9.15.0`). |
| `workspaceRoot` | Project id of the workspace root that installs this project, if any. |
| `dependsOn` | `{ project, kind, why, confidence, evidence }`; `kind` is `build` (must be built first: it imports a build output that is not committed), `workspace` (installed together) or `runtime` (must be running, e.g. an API its env points at). |
| `evidence` | The manifest files that mark the project. |

## `Requirement`

| Field | Meaning |
| --- | --- |
| `id` | `runtime:node`, `package-manager:pnpm`, `php-extension:pdo_mysql`, `tool:docker`; `@<project>` is appended only when projects need incompatible versions. |
| `kind` | `runtime`, `package-manager`, `extension`, `tool`. |
| `name` | `node`, `pnpm`, `pdo_mysql`, `docker`... |
| `range` | SemVer range that must hold (`>=20.9.0`). Absent: any version (or not declared; see `status`). |
| `rangeText` | The range for people: `20.x`, `^8.2`, `>= 20.9`. |
| `recommended` | The version to install when there is a choice: a version file's pin, or the newest version CI tests within the range. |
| `projects` | Project ids that need it. |
| `optional` | Only optional steps need it (Docker for starting Compose services; extensions only CI or a production image installs). |
| `status` | `ok`; `conflict` (constraints cannot all hold); `unknown` (needed, but no version is declared: see `unknowns`). |
| `confidence` | How sure the statement is. For `status: unknown` it only covers that the tool is needed. |
| `why` | One or two sentences naming the sources. |
| `evidence` | Constraints and pins, each with its role. |

## `Service`

| Field | Meaning |
| --- | --- |
| `id`, `name` | `service:mysql`, `mysql`. MariaDB and MySQL share `service:mysql`; Valkey and Redis Stack are `redis`. |
| `category` | `database`, `cache`, `queue`, `mail`, `search`, `storage`, `other`. |
| `version` | From an image tag, when known. |
| `ports` | Ports the app connects to (published Compose port, env template `*_PORT`, or the default). |
| `provider` | `{ type: "compose", file, service, image }` when the repo provides it, else `null` (a manual step asks for it). |
| `projects` | Projects that use it. |
| `env` | Names of the variables that configure the connection. |
| `optional` | Only some features use it (mail catcher, search), or only CI uses it, or the env template points elsewhere (Compose defines MySQL but the template uses SQLite). |
| `confidence`, `why`, `evidence` | As above. |

## `EnvFile` and `EnvVar`

| Field | Meaning |
| --- | --- |
| `project` | Project id. |
| `file` | The file the app reads (`api/.env`, `web/.env.local`). |
| `template` | The template it is created from, or `null` when the repo has none. |
| `exists` | The file already exists (checked with `stat`, never read). |
| `createdBy` | The step that creates it. |
| `vars` | See below. |
| `confidence`, `why`, `evidence` | As above. |

`EnvVar`: `name`; `fill` is `user` (a person must provide a value), `default` (the template's value works locally), `generated` (a step creates it, see `generatedBy`), `optional` (commented out, or only for an integration), or `unknown` (read by the code but missing from the template). `secret` is true when the name looks like a credential. `note` explains special cases, such as "`DB_HOST=mysql` is a Compose service name; use 127.0.0.1 when the app runs on your machine" or "`NEXT_PUBLIC_*` is inlined at build time". Also `confidence` and `evidence`.

## `Step`

| Field | Meaning |
| --- | --- |
| `id` | `<project>.<name>`: `api.composer-install`, `web.env`, `root.services`. Stable across runs. |
| `project` | Project id. |
| `phase` | `prepare` (git submodules, LFS), `install`, `configure` (env files, keys), `services`, `generate` (code generation), `database` (migrations, seeds), `build`. |
| `title` | What it does, for people. |
| `cwd` | Working directory, relative to the analyzed folder. |
| `action` | See below. |
| `network` | Downloads packages or images. |
| `thirdPartyCode` | Runs code from dependencies or the project (install scripts, artisan, npm scripts). |
| `outsideProject` | Changes the machine outside the folder (Compose containers and volumes). Automated mode asks separately for these. |
| `optional` | Not needed to start (seeding demo data, the production build, `storage:link`). |
| `after` | Step ids that must run first. The `steps` array is already in an order that respects them. |
| `requires` | Requirement and service ids the step needs (the doctor checks them). |
| `confidence`, `why`, `notes`, `evidence` | `notes` holds side effects ("Composer also runs post-autoload-dump"), alternatives ("if the lockfile is out of date...") and cautions. |

### `Action`

| `type` | Fields | Shown as (POSIX / PowerShell) | Executed as |
| --- | --- | --- | --- |
| `exec` | `argv`, optional `windowsArgv` | quoted for the shell | the program at `argv[0]` from PATH (or relative to `cwd`), no shell; `.cmd`/`.bat` through `cmd.exe /d /s /c` with strict argument checks |
| `copy` | `from`, `to` | `[ -e to ] \|\| cp from to` / `if (-not (Test-Path to)) { Copy-Item from to }` | a file copy that never overwrites |
| `touch` | `path` | `[ -e p ] \|\| touch p` / `New-Item` | creates an empty file if missing |
| `env-names` | `path`, `names`, `required` | `[ -e p ] \|\| printf '%s\n' … > p` / `Set-Content -Encoding ascii` | creates the env file if missing (never overwrites): a comment line, then `NAME=` for each name in `required` and `# NAME=` for the others. Names only: every name must match `[A-Za-z_][A-Za-z0-9_.]*` or the step is refused, so no value can be written. Used when a project has no env template and the names come from reading the code. |
| `manual` | `text` | the text | the runner shows it and asks you to confirm |

## `RunTarget`

| Field | Meaning |
| --- | --- |
| `id`, `project`, `name` | `web.dev`, the script, recipe or task name. |
| `kind` | `dev`, `worker` (queue workers), `production`, `test`. |
| `primary` | Started by `seefast start` without arguments. At most one per project and kind, except that a project can have several processes (Laravel's server and Vite). The docs' own start command wins over the generic `dev` script. |
| `title`, `cwd`, `action` | As for steps. |
| `ports` | `{ port, confidence, evidence }`: from a flag in the script, the server's default, `PORT` in the env template, `process.env.PORT \|\| 4000` in code, or a dev container's `forwardPorts`. |
| `needs` | Run target ids and service ids that must be up first. |
| `after` | Step ids that must have run (the build before `next start`). |
| `readiness` | How `start` decides it is running: `{ type: "port", port, timeoutSec }`, `{ type: "stays-up", seconds }` or `{ type: "exits", timeoutSec }` (tests). |
| `confidence`, `why`, `evidence` | As above. |

## `Task`

`{ runner, name, project, file, line, commands, purpose }`. `runner` is `make`, `just`, `task`, `composer`, `procfile`, `devcontainer` or `gitpod`. `commands` are the task's lines as written, redacted. `purpose` is `setup`, `run`, `test`, `build` or `other`, guessed from the name. Tasks are listed for people; only the generic fallback turns a `setup` task into a (low-confidence) step when nothing else says how to install the project.

## `Conflict`

| Field | Meaning |
| --- | --- |
| `id`, `subject` | `pm:node@web`, `runtime:node@root`, `envTarget@root`, `service:mysql`, `env:api:DB_HOST`, `port:3000`. |
| `chosen` | The value used, or `null` when nothing could be chosen. |
| `alternatives` | `{ value, evidence }` for each side. |
| `severity` | `warning`: a strong source disagrees, or a tie was broken; check before relying on it. `info`: a weaker source is stale (the README that says `npm install` next to `pnpm-lock.yaml`). |
| `message` | The plain-language sentence, e.g. `README.md says "npm install", but pnpm-lock.yaml exists; using pnpm.` |
| `rule` | The resolution rule that decided it, e.g. `stronger source wins`, `constraints beat preferences`, `a tested version beats a locked dependency's engines`. |

## `Unknown`

`{ id, subject, message, suggestion?, evidence }`. Examples: no version declared for a runtime; no env template, so variables were found in code; a setup command the docs mention that the plan does not include; no project found at all.

## `meta`

| Field | Meaning |
| --- | --- |
| `generatedAt`, `durationMs`, `timings` | Vary between runs. `timings` has `scan`, `collect`, `recipes`, `resolve`, `plan` in ms. |
| `rootName` | Name of the analyzed folder. |
| `knowledgeBase` | Date of the bundled knowledge base and recipes the plan was made with. |
| `stats.entriesSeen`, `stats.filesRead` | How much was looked at and read. |
| `stats.secretFilesNotRead` | Files that exist but were not opened because they may hold secrets (names only). |
| `stats.skipped` | Counts by reason: ignored directories, example or fixture directories, files too large, binary files, the scan limit, CI workflows not about build or test. |
| `stats.parseErrors` | `{ file, message }` for files that could not be parsed; analysis continued. |
| `stats.readmeCommandsIgnored` | README commands that matched no known command grammar. |
| `stats.codeFilesScanned` | Source files read for env variable reads. |
| `stats.truncated` | The scan stopped at its entry limit (40,000). |
| `inputs` | `{ file, sha256 }` of every file read, hashed after BOM removal and LF normalization. The launcher compares these to say "the repo changed since the last analysis". |
