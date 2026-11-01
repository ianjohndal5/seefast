# Ground truth format

One JSON file per repository: `validation/ground-truth/<id>.json`. It records what a developer must do to get a
**local development instance** running from a fresh clone, according to the repository's own CI workflows and
maintainer documentation (README, CONTRIBUTING, docs/), plus framework conventions where the docs rely on them.

It is written by reading the repository only, never by running anything, and independently of any tool output.

```jsonc
{
  "id": "koel",
  "sources": ["README.md", ".github/workflows/backend.yml", "docs/development.md"],  // files actually used
  "projects": [
    { "root": ".", "stack": ["laravel", "vue"], "packageManagers": ["composer", "pnpm"] }
  ],
  // Minimum versions the repo states or enforces (CI matrix floor, manifest constraint, docs). Omit what is not stated.
  "runtimes": { "php": "8.2", "node": "20" },
  // Backing services a local dev setup needs per the docs (canonical names below). [] when none.
  "services": ["mysql"],
  // Required setup steps on a fresh clone, in order, using the step kinds below.
  "steps": [
    { "kind": "install:composer", "source": "docs", "evidence": "README.md:41" },
    { "kind": "env-copy", "source": "ci", "evidence": ".github/workflows/backend.yml:30" },
    { "kind": "artisan:key:generate", "source": "convention", "evidence": "Laravel needs APP_KEY; CI runs it" }
  ],
  // Steps the docs present as optional (seeding demo data, etc.).
  "optionalSteps": [{ "kind": "artisan:db:seed", "source": "docs", "evidence": "README.md:60" }],
  // How the docs say to start it for development; port when stated or the framework default is unambiguous.
  "dev": [{ "cwd": ".", "command": "php artisan serve", "port": 8000 }],
  // The literal commands the README's local-setup section tells you to run, in order (for the "README alone" baseline).
  "readmeCommands": ["composer install", "cp .env.example .env", "php artisan koel:init"],
  // Ambiguities, stale docs, contradictions between sources, things that could not be determined.
  "notes": "README says npm but the repo has pnpm-lock.yaml; CI uses pnpm."
}
```

`source` is `docs`, `ci` or `convention` (needed by framework norms although the docs do not say it).

## Step kinds

| Kind | Meaning |
| --- | --- |
| `install:npm` `install:pnpm` `install:yarn` `install:bun` | Install JavaScript dependencies with that package manager |
| `install:composer` | `composer install` |
| `install:pip` `install:poetry` `install:uv` `install:pipenv` | Python dependencies |
| `install:go` `install:cargo` | Go modules / Rust crates (fetch or build) |
| `env-copy` | Create the env file from a template (`cp .env.example .env`) |
| `env-manual` | Create or edit an env file by hand (no template, or values that must be filled to start) |
| `artisan:<command>` | A Laravel artisan command, e.g. `artisan:key:generate`, `artisan:migrate`, `artisan:storage:link`, `artisan:db:seed`, `artisan:passport:install` |
| `build-assets` | Build frontend assets the app needs to serve pages (`npm run build` in a Laravel app) |
| `prisma:generate` / `prisma:migrate` | Prisma client generation / applying the schema (`migrate deploy`, `migrate dev` or `db push`) |
| `db:migrate` | Applying the schema with another tool (Drizzle, Django `migrate`, scripts) |
| `compose-up` | Start backing services with Docker Compose |
| `workspace-build` | Build internal monorepo packages before the dev server can start |
| `submodules` | `git submodule update --init` |
| `script:<name>` | A package.json / composer / Makefile script the docs require (e.g. `script:db:setup`) |
| `manual:<what>` | Something only a person can do (create a database, obtain an API key) |
| `other:<what>` | Anything else |

## Canonical service names

`mysql` (MySQL or MariaDB), `postgres`, `redis`, `mongodb`, `memcached`, `meilisearch`, `elasticsearch`, `typesense`,
`mailpit` (or mailhog), `minio`, `rabbitmq`, `clickhouse`, `tinybird`, other names as written. SQLite is not a service.
