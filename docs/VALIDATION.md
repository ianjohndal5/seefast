# Validation

How well does the plan match what a developer actually has to do, and does following it get the app running?
Measured on 32 public repositories, with the failures included.

**Headline**

| | Development set (24 repos) | **Held-out set (8 repos)** |
| --- | --- | --- |
| Required setup steps the plan includes | 77 / 110 (70%) | **20 / 33 (61%)** |
| …the README alone covers | 25 / 110 (23%) | **7 / 33 (21%)** |
| Steps the plan gets wrong (another tool for the same job) | 1 | **0** |
| Package manager correct | 22 / 22 | **7 / 7** |
| …the README names it correctly | 8 right, 2 wrong, 12 silent | **2 right, 0 wrong, 5 silent** |
| Runtime minimum agrees (same or compatible) | 29 / 30 | **10 / 12** |
| Backing services found | 21 / 34 | **3 / 6** |
| Dev command identical to the ground truth | 18 / 24 | **5 / 8** |

**End-to-end** on 11 repositories that can run without a database server, in a clean container: following the
plan got the app answering on its port in **7 of 11**; following the README alone, in **2 of 11**.

**Speed:** median 52 ms per repository, 323 ms for Cal.com (7,491 files and folders, 113 workspace packages);
the slowest cold run was 1.64 s (Formbricks, first read from disk). Targets: 1 s typical, 5 s for a large monorepo.

The development set was used to find and fix problems, so its numbers are optimistic. The held-out set's ground
truth was written before any tool change and it was scored once after the changes; it is the honest estimate of
how the tool does on a repository it has never seen. It is also small (8 repos, 33 steps): ±10 points is noise.

## Method

### Corpus

24 repositories chosen to cover the supported ecosystems (popular Laravel and Next.js apps, Laravel apps with
frontends, Next.js monorepos with turbo and Prisma, repos only generic support covers) and some messy ones. After
the first scoring run, 8 more were added as a held-out set. Shallow clones at the commits below
(`validation/corpus.json`, `validation/commits.json`).

| Id | Repository | Group | Commit | Files + folders | Projects found | Analysis (ms, median of 5) | Slowest of 5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| laravel | [laravel/laravel](https://github.com/laravel/laravel) | laravel | `def7ce1481` | 76 | 1 | 13 | 59 |
| koel | [koel/koel](https://github.com/koel/koel) | laravel | `da0e70f4b4` | 3079 | 1 | 122 | 484 |
| solidtime | [solidtime-io/solidtime](https://github.com/solidtime-io/solidtime) | laravel | `d10bdb1c95` | 1468 | 3 | 130 | 349 |
| bookstack | [BookStackApp/BookStack](https://github.com/BookStackApp/BookStack) | laravel | `045c6a98ca` | 2690 | 1 | 61 | 275 |
| firefly-iii | [firefly-iii/firefly-iii](https://github.com/firefly-iii/firefly-iii) | laravel | `d65e916130` | 2205 | 2 | 47 | 161 |
| monica | [monicahq/monica](https://github.com/monicahq/monica) | laravel | `dab74273ac` | 1930 | 1 | 76 | 150 |
| pixelfed | [pixelfed/pixelfed](https://github.com/pixelfed/pixelfed) | laravel | `99462454d0` | 3470 | 1 | 119 | 437 |
| akaunting | [akaunting/akaunting](https://github.com/akaunting/akaunting) | laravel | `a7a5fc790a` | 4534 | 1 | 69 | 303 |
| invoiceninja | [invoiceninja/invoiceninja](https://github.com/invoiceninja/invoiceninja) | laravel | `15ea35ea63` | 5309 | 1 | 89 | 295 |
| pterodactyl | [pterodactyl/panel](https://github.com/pterodactyl/panel) | laravel | `90b2aa8746` | 1530 | 1 | 57 | 196 |
| saas-starter | [nextjs/saas-starter](https://github.com/nextjs/saas-starter) | nextjs | `6e33e58b1e` | 80 | 1 | 5 | 36 |
| dub | [dubinc/dub](https://github.com/dubinc/dub) | nextjs-monorepo | `6b463b4bdd` | 2220 | 10 | 105 | 681 |
| umami | [umami-software/umami](https://github.com/umami-software/umami) | nextjs | `559e3c607c` | 1420 | 3 | 61 | 346 |
| precedent | [steven-tey/precedent](https://github.com/steven-tey/precedent) | nextjs | `3be40205d7` | 61 | 1 | 4 | 12 |
| breeze-next | [laravel/breeze-next](https://github.com/laravel/breeze-next) | nextjs | `7a2db7e9fc` | 75 | 1 | 11 | 21 |
| taxonomy | [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy) | nextjs | `298a8857c7` | 232 | 1 | 9 | 29 |
| chatbot-ui | [mckaywrigley/chatbot-ui](https://github.com/mckaywrigley/chatbot-ui) | nextjs | `81328b61d2` | 381 | 2 | 24 | 137 |
| formbricks | [formbricks/formbricks](https://github.com/formbricks/formbricks) | nextjs-monorepo | `fa289168d4` | 4648 | 25 | 307 | 1640 |
| documenso | [documenso/documenso](https://github.com/documenso/documenso) | nextjs-monorepo | `503cd1aa1c` | 2879 | 17 | 141 | 285 |
| calcom | [calcom/cal.com](https://github.com/calcom/cal.com) | nextjs-monorepo | `f972feefa1` | 7491 | 113 | 323 | 545 |
| commerce | [vercel/commerce](https://github.com/vercel/commerce) | nextjs | `f7521d57d2` | 101 | 1 | 4 | 8 |
| djangoproject | [django/djangoproject.com](https://github.com/django/djangoproject.com) | generic | `af69186487` | 669 | 1 | 18 | 41 |
| pocketbase | [pocketbase/pocketbase](https://github.com/pocketbase/pocketbase) | generic | `7f2773ec23` | 787 | 2 | 16 | 56 |
| zoxide | [ajeetdsouza/zoxide](https://github.com/ajeetdsouza/zoxide) | generic | `f0b31631d2` | 87 | 1 | 9 | 25 |
| laravelio | [laravelio/laravel.io](https://github.com/laravelio/laravel.io) | laravel, held out | `55be0d8022` | 638 | 1 | 34 | 47 |
| lychee | [LycheeOrg/Lychee](https://github.com/LycheeOrg/Lychee) | laravel, held out | `4e5d5c8bfd` | 5821 | 1 | 141 | 146 |
| filament-demo | [filamentphp/demo](https://github.com/filamentphp/demo) | laravel, held out | `124bdfd9d4` | 468 | 1 | 37 | 58 |
| linkstack | [linkstackorg/linkstack](https://github.com/linkstackorg/linkstack) | laravel, held out | `35d8205f01` | 1176 | 1 | 59 | 61 |
| ai-chatbot | [vercel/ai-chatbot](https://github.com/vercel/ai-chatbot) | nextjs, held out | `c2f8235e1f` | 226 | 1 | 11 | 25 |
| next-auth-example | [nextauthjs/next-auth-example](https://github.com/nextauthjs/next-auth-example) | nextjs, held out | `39ff2b7a37` | 64 | 1 | 4 | 4 |
| openstatus | [openstatusHQ/openstatus](https://github.com/openstatusHQ/openstatus) | nextjs-monorepo, held out | `08484bca64` | 3623 | 50 | 203 | 345 |
| fastapi-template | [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) | generic, held out | `f4bcfaba7c` | 285 | 4 | 26 | 42 |

Timings: Arch Linux, x86-64 laptop, Node.js 26, idle machine, `analyze()` in-process, five runs each.

### Ground truth

For each repository, a reviewer wrote `validation/ground-truth/<id>.json` (format: [validation/GROUND-TRUTH.md](../validation/GROUND-TRUTH.md)):
the required setup steps in a fixed vocabulary (`install:pnpm`, `env-copy`, `artisan:key:generate`, `prisma:migrate`,
`compose-up`, `script:dx`...), optional steps, runtime minimums, services, the dev command and port, the README's
literal setup commands, and notes on ambiguity. Reviewers read only the repository's own files (README,
CONTRIBUTING, docs/, CI workflows, Docker files, manifests, env templates), ran nothing, and never saw this tool, its
source or its output.

The reviewers were AI agents (five instances, each handling 4–8 repos), instructed as above. Disclosed limitations:

* One reviewer, after finishing its own files, printed summaries of other reviewers' ground-truth files while checking
  JSON validity. It had not seen this tool's output, so independence from the tool holds; independence between
  reviewers does not for that batch (pixelfed, akaunting, invoiceninja, pterodactyl, djangoproject, pocketbase, zoxide).
* There is one reviewer per repository and no agreement check between reviewers.
* Several repositories keep their setup docs on external websites the reviewers could not read; their ground truth is
  reconstructed from CI, Docker files and conventions, and says so in its notes.
* Judgment calls differ: e.g. one reviewer treated a seed command listed in the README as required, another as
  optional. These are recorded in each file's `notes`.

### Scoring

`validation/score.mjs` maps every non-optional plan step, and every command in the README's setup section, onto the
same vocabulary, then compares sets per repository:

* **correct**: a ground-truth step the plan also has;
* **wrong**: the plan does the same job with a different tool (installs with npm where the repo uses pnpm);
* **missing**: a ground-truth step the plan lacks;
* **extra**: a plan step the ground truth does not list as required (reported, not counted as wrong: often the
  individual parts of a one-command script, or a step the ground truth considered optional).

Mapping rules the scorer applies (all visible in the script): `composer run x` = `composer x`; `pnpm x` = `pnpm run
x`; a pinned pnpm through `npx pnpm@8 install` and `composer update` are installs; the plan's "start a MySQL server …
create the database it names" step satisfies `manual:create-database`. These were added after the first run, when
they were found to undercount; the first run is reported both ways below.

## Results over time

| Run | Code | Development set: steps | Held-out: steps | Notes |
| --- | --- | --- | --- | --- |
| First run | before `98ded8d` | 67 / 110 (61%) | – | before any change to steps informed by the corpus (lockfile engines were already soft) |
| First run, scorer fixed | same | 70 / 110 (64%) | – | the mapping rules above |
| After general fixes | `98ded8d` | 77 / 110 (70%) | – | docs beyond the README, the docs' start command, env-URL services, Laravel DB default, Mix builds, Passport keys, db scripts |
| Held-out, first and only scoring | `6c702cf` | – | **20 / 33 (61%)** | ground truth written before the fixes |
| Final, after end-to-end fixes | `efde077` | 77 / 110 (70%) | 20 / 33 (61%) | stale lockfiles, old pnpm, env files Prisma cannot read |

The held-out number did not move with the end-to-end fixes (they mostly change *how* a step runs, not *whether* it is
in the plan). Dev command matches on the held-out set went from 4/8 to 5/8 with the fix that stops a production
`start` script from being chosen as the dev command.

### Development set, final

| Repo | Group | Required (GT) | Correct | Wrong | Missing | Extra | README covers | PM | Runtimes | Services found/missed/extra | Dev cmd | Port |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| laravel | laravel | 5 | 5 | 0 | 0 | other:sqlite-file | 0/5 | correct | php: same | 0/0/0 | correct | correct |
| koel | laravel | 5 | 4 | 0 | script:koel:init | artisan:key:generate, artisan:migrate, build-assets | 0/5 | correct | php: same, node: same | 1/0/0 | correct | correct |
| solidtime | laravel | 8 | 7 | 0 | manual:traefik-reverse-proxy | workspace-build | 0/8 | correct | php: same, node: same | 1/3/0 | different | n/a |
| bookstack | laravel | 4 | 2 | 0 | other:chgrp-docker-storage, compose-up | install:composer, install:npm, artisan:key:generate, artisan:migrate | 0/4 | correct | php: same, node: compatible | 0/2/0 | different | different |
| firefly-iii | laravel | 5 | 4 | 0 | build-assets | artisan:passport:keys, manual:mysql, workspace-build | 0/5 | correct | php: same, node: compatible | 1/0/0 | correct | correct |
| monica | laravel | 7 | 5 | 0 | other:create-sqlite-file, artisan:monica:setup | compose-up, other:sqlite-file, artisan:migrate | 0/7 | correct | php: same, node: same | 0/0/1 | correct | correct |
| pixelfed | laravel | 9 | 4 | 0 | other:chown-storage-www-data, artisan:instance:actor, artisan:import:cities, artisan:passport:client, artisan:user:create | install:composer, install:npm, artisan:key:generate, artisan:migrate, build-assets | 0/9 | correct | php: same, node: same | 2/0/0 | different | different |
| akaunting | laravel | 5 | 5 | 0 | 0 | env-copy, artisan:key:generate, artisan:migrate | 3/5 | correct | php: same, node: same | 1/0/0 | correct | correct |
| invoiceninja | laravel | 4 | 3 | 0 | manual:web-setup-wizard | install:npm, artisan:key:generate, artisan:migrate, build-assets | 2/4 | correct | php: same | 1/0/0 | correct | correct |
| pterodactyl | laravel | 9 | 7 | 0 | manual:create-database, artisan:p:user:make | compose-up | 0/9 | correct | php: same, node: same | 2/0/0 | correct | correct |
| saas-starter | nextjs | 5 | 3 | 0 | manual:stripe-cli-login, script:db:seed | env-copy, manual:postgres | 4/5 | correct | – | 1/0/0 | correct | correct |
| dub | nextjs-monorepo | 7 | 6 | 0 | manual:tinybird-setup | prisma:generate | 0/7 | correct | node: same | 2/2/0 | correct | different |
| umami | nextjs | 4 | 4 | 0 | 0 | compose-up | 1/4 | correct | node: differs, pnpm: same | 1/0/0 | correct | correct |
| precedent | nextjs | 2 | 2 | 0 | 0 | 0 | 1/2 | correct | – | 0/0/0 | correct | correct |
| breeze-next | nextjs | 3 | 2 | 0 | manual:laravel-backend | manual:external-8000 | 1/3 | correct | – | 0/0/0 | correct | correct |
| taxonomy | nextjs | 2 | 2 | 0 | 0 | manual:mysql, prisma:generate | 2/2 | correct | node: same | 1/0/0 | different | correct |
| chatbot-ui | nextjs | 5 | 2 | 0 | manual:install-docker-and-supabase-cli, other:supabase-start, manual:edit-setup-migration | 0 | 2/5 | correct | node: same | 0/1/0 | correct | correct |
| formbricks | nextjs-monorepo | 2 | 1 | 0 | script:go | env-copy, compose-up, manual:external-8080, db:migrate, workspace-build | 2/2 | correct | node: same | 3/4/0 | correct | correct |
| documenso | nextjs-monorepo | 2 | 1 | 0 | script:dx | install:npm, compose-up, prisma:generate, prisma:migrate | 2/2 | correct | node: same | 1/1/0 | correct | correct |
| calcom | nextjs-monorepo | 4 | 3 | 0 | script:dx | manual:external-5555, workspace-build, prisma:generate, compose-up, manual:external-80, prisma:migrate | 2/4 | correct | node: same | 2/0/1 | correct | correct |
| commerce | nextjs | 2 | 2 | 0 | 0 | 0 | 1/2 | correct | – | 0/0/0 | correct | correct |
| djangoproject | generic | 9 | 1 | install:pip | other:create-virtualenv, env-manual, manual:create-databases, other:load-trac-schema, other:createsuperuser, other:loaddata-dev_sites, build-assets | compose-up | 1/9 | n/a | python: same | 1/0/0 | different | correct |
| pocketbase | generic | 1 | 1 | 0 | 0 | 0 | 1/1 | correct | go: same, node: compatible | 0/0/0 | different | different |
| zoxide | generic | 1 | 1 | 0 | 0 | 0 | 0/1 | n/a | rust: same | 0/0/0 | correct | n/a |

(`validation/results-dev-final.json` has every row with the plan's and the ground truth's step lists.)

### Held-out set

| Repo | Group | Required (GT) | Correct | Wrong | Missing | Extra | README covers | PM | Runtimes | Services found/missed/extra | Dev cmd | Port |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| laravelio | laravel | 3 | 1 | 0 | manual:create-database, script:setup | install:npm, env-copy, artisan:key:generate, artisan:migrate, build-assets | 1/3 | correct | php: same, node: same | 0/1/0 | correct | correct |
| lychee | laravel | 6 | 5 | 0 | manual:create-database | submodules, other:sqlite-file, build-assets | 0/6 | correct | php: same, node: compatible | 0/1/0 | different | n/a |
| filament-demo | laravel | 4 | 3 | 0 | script:setup | env-copy, artisan:key:generate, other:sqlite-file, artisan:migrate | 1/4 | correct | php: same, node: same | 0/0/0 | correct | correct |
| linkstack | laravel | 5 | 2 | 0 | artisan:key:generate, artisan:db:seed, manual:web-server | install:npm, env-copy, manual:mysql, build-assets | 0/5 | n/a | php: differs | 0/0/1 | correct | correct |
| ai-chatbot | nextjs | 5 | 3 | 0 | manual:provision-postgres, manual:ai-gateway-api-key | 0 | 2/5 | correct | node: same | 0/1/0 | correct | correct |
| next-auth-example | nextjs | 2 | 2 | 0 | 0 | 0 | 2/2 | correct | node: same | 0/0/0 | correct | correct |
| openstatus | nextjs-monorepo | 4 | 2 | 0 | other:start-libsql-server, script:dx | install:go, workspace-build, compose-up, db:migrate | 1/4 | correct | node: same | 1/0/1 | different | different |
| fastapi-template | generic | 4 | 2 | 0 | db:migrate, install:bun | 0 | 0/4 | correct | python: same, bun: unknown | 2/0/0 | different | different |

## Why steps are missed

All 45 missing steps (32 development, 13 held-out), grouped:

| Reason | Count | Examples | Fixable here? |
| --- | --- | --- | --- |
| Accounts, keys, infrastructure or a database only a person can arrange | 15 | Stripe CLI login, Tinybird, Supabase CLI, an AI gateway key, a Traefik proxy, a separate Laravel backend, creating the database when Compose or SQLite is the default | Mostly not; the plan's manual steps cover some under other names |
| Generic ecosystems | 9 | djangoproject (virtualenv, two databases, Trac schema, `createsuperuser`, `loaddata`), fastapi-template (bun, migrations) | With Python recipes (milestone 4) |
| Repo-specific commands documented outside the repo or only in prose | 7 | `koel:init`, `monica:setup`, Pixelfed's `instance:actor`, `import:cities`, `user:create`, Pterodactyl's `p:user:make` | Partly: commands in setup code blocks are already picked up |
| A one-command setup script the plan lists as its parts | 6 | `composer setup` (laravelio, filament-demo), `npm run dx` (documenso, calcom, openstatus), `pnpm go` (formbricks) | Yes: offer the script as "the maintainers' way" (planned) |
| Conventions the plan treats as optional, or not yet in recipes | 4 | seeds the ground truth calls required (saas-starter, linkstack); `key:generate` in linkstack, which commits its own `.env` (never read, so generating a key that would replace one is optional); Monica's SQLite file path | Judgment calls |
| Docker is the only documented path; the plan proposes the native one | 3 | BookStack (`compose up`, `chgrp` on storage), Pixelfed (`chown` on storage) | Offered as an alternative run target, not as steps |
| Other | 1 | firefly-iii's asset build: its frontend lives in `resources/assets/v2` without a root `package.json` | Yes |

The one **wrong** step: djangoproject's docs and CI install with pip while the repo has a `uv.lock`; the plan's pip
detection only fires when docs and CI agree on pip alone, and its CI also mentions uv.

## End-to-end

**Machine.** `validation/e2e/Dockerfile`: Debian 12, PHP 8.4 (official image) with common extensions (pdo_mysql,
pdo_pgsql, zip, gd, intl, bcmath, pcntl, exif, gmp, redis), Composer 2, Node.js 22 with Corepack, Go 1.25, git. No
database servers, no Docker inside. Repos that need MySQL or PostgreSQL to start were therefore not in this set,
except Taxonomy, included because its README trap (a pnpm lockfile older pnpm versions write) is worth testing.

**Plan path.** A fresh copy of the clone, then `seefast setup --yes` (no `--allow-outside`, so no containers) and
`seefast start --yes --until-ready`: success when every primary dev target answers on its port (or stays up 30 s
when it has none).
**README path.** A fresh copy, then the README's literal setup commands in order (as recorded by the ground truth,
without `git clone`), then its dev command, judged by the same port check.

| Repo | Plan path | Time | README alone | Why the README path failed |
| --- | --- | --- | --- | --- |
| laravel | **responding** (HTTP) | 0.8 min | failed | the README has no install commands; the dev command needs `vendor/` |
| monica | **responding** | 1.1 min | failed | same: no install commands in the README |
| filament-demo | **responding** | 0.5 min | listening | – |
| precedent | **listening** | 0.4 min | failed | `npm i` hits ERESOLVE: the repo uses pnpm |
| breeze-next | **listening** | 0.6 min | failed | starts with `laravel new next-backend` (another project, the Laravel installer) |
| next-auth-example | **listening** | 0.3 min | listening | – |
| commerce | **listening** | 0.5 min | failed | `npm i -g vercel` needs root |
| taxonomy | stopped at migrate: no MySQL (the plan's manual step says to start one) | 1.3 min | failed | `pnpm install` with current pnpm refuses the lockfile format 6.0 |
| pocketbase | *not counted*: started the admin UI's Vite server, not the Go app | 0.6 min | failed | `go build` then `./base`: the README's commands must run in `examples/base` |
| lychee | stopped at `composer install`: needs `ext-imagick` and `ext-ldap` | 0.1 min | failed | the README's path downloads a Compose file and needs Docker |
| linkstack | stopped at `composer update`: Composer blocks its Laravel 9 because of security advisories | 0.2 min | failed | no install commands; `vendor/` missing |

**Plan: 7 of 11. README alone: 2 of 11.** Where the plan stopped, it stopped at a step that names the reason:
the doctor, run in the same container, reports Lychee's two missing extensions with the right advice
(`pecl install imagick && docker-php-ext-enable imagick`, `docker-php-ext-install ldap`) and exits with code 3.

### What the end-to-end runs changed

Every one of these was invisible to the static scoring and found only by running the plan:

1. **A README section about optional tooling became a required step.** The Laravel skeleton's "Agentic Development"
   section (`php artisan boost:install`, from a package that is not installed) stopped automated setup. Commands from
   docs are now taken only from setup sections, and artisan commands the app's code does not define become optional.
2. **pnpm 11+ stops on unapproved dependency build scripts** (vercel/commerce, no `packageManager` field, so Corepack
   picks the newest pnpm). Installs now add `--config.strict-dep-builds=false` when the project approves no builds
   (pnpm 10's behaviour: skip and warn; less third-party code runs). Decision D14.
3. **pnpm refuses old lockfile formats** (taxonomy, lockfile 6.0). The format now becomes a pnpm major requirement,
   and every pnpm command of the project runs that major through `npx --yes pnpm@8`.
4. **Prisma's CLI only reads `.env`**, while Taxonomy's README creates `.env.local`: migrations could never see
   `DATABASE_URL`. A file some framework's tooling cannot read is now replaced, with a warning.
5. **A production `start` script was chosen as the dev command** (next-auth-example's README mentions `pnpm run start`;
   its `dev` script is a bare `next`, which the knowledge base did not know means `next dev`). Production servers are
   never promoted now.
6. **Stale lockfiles** (linkstack): `composer.lock` locks a version `composer.json` no longer allows. Detected
   statically now (missing, excluded version, or a runtime package locked only as dev) with `composer update`.
   Checking the detector on Monica found a translation bug: Composer's `^0` was read as `<0.0.1` instead of `<1`.
7. **The doctor's advice for PHP built from source** (the official Docker image) named apt packages; it now detects
   the image from `php --ini` and advises `docker-php-ext-install` / `pecl`.
8. The harness's own mistake: the container set `CI=` (empty), and `laravel-vite-plugin` refuses to start its dev
   server when `CI` is defined. Removed; reported here because it cost one run.

Logs of every run: `validation/work/e2e/` (not committed; regenerate with `node validation/e2e/run.mjs <ids>`).

## Reproducing

```bash
npm ci && npm run build
cd validation && mkdir -p repos
# clone each repo of corpus.json at the commit in commits.json (shallow clones work), into repos/<id>
node run-corpus.mjs                       # plans into validation/work/plans, timings into work/timings.json
node score.mjs --set=dev                  # or --set=heldout, --set=all
docker build -t seefast-e2e:1 e2e && node e2e/run.mjs laravel precedent ...
```

## What this validation does not show

* **Windows and macOS.** Everything here ran on Linux. The CI workflow runs the unit tests and the doctor on Windows
  and macOS runners; the end-to-end harness is Linux-only.
* **Apps that need a database to start.** The e2e machine has no database server; a run with service containers next
  to it is the next step.
* **Inter-rater reliability.** One reviewer per repository.
* **Long-term drift.** Repositories change; the commits are pinned so the numbers can be reproduced, not so they stay
  representative.
