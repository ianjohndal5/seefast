# What the doctor runs

`seefast doctor` compares the plan's requirements with this machine. It runs only the commands below, and only
for tools the plan needs. Nothing the project defines is ever run, and nothing is installed or downloaded.

## How a command is run

1. **Lookup without running.** The program is found by scanning `PATH` (and `PATHEXT` on Windows). A tool that is not
   on `PATH` costs nothing and is reported missing. The Microsoft Store `python.exe` alias is skipped.
2. **By absolute path, no shell.** `execFile` with the resolved path and fixed arguments. On Windows, `.cmd`/`.bat`
   shims are run through `cmd.exe /d /s /c` (Node refuses to spawn them directly); the arguments are constants.
3. **From an empty temporary folder**, never the project. This matters: in a project folder Composer would load the
   project's plugins (project code), Corepack would switch to the `packageManager` version (a download), and Go and
   rustup would download the toolchain a project pins.
4. **With downloads and prompts disabled where the tool allows it:** `COREPACK_ENABLE_NETWORK=0`,
   `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, `COREPACK_ENABLE_AUTO_PIN=0`, `GOTOOLCHAIN=local`, `RUSTUP_AUTO_INSTALL=0`,
   `COMPOSER_DISABLE_NETWORK=1`, `COMPOSER_NO_INTERACTION=1`, `NPM_CONFIG_UPDATE_NOTIFIER=false`, `DOTNET_NOLOGO=1`,
   `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `HOMEBREW_NO_AUTO_UPDATE=1`, `POETRY_NO_INTERACTION=1`, `NO_COLOR=1`.
5. **5-second timeout** per command. A timeout is reported as "could not be checked", not as missing.

The report lists every command it actually ran (`--json`: `probes[]`).

## The list

| Probe | Command | Used for |
| --- | --- | --- |
| node | `node --version` | Node.js |
| npm | `npm --version` | npm |
| pnpm | `pnpm --version` | pnpm |
| yarn | `yarn --version` | Yarn |
| bun | `bun --version` | Bun |
| corepack | `corepack --version` | whether pnpm/Yarn can come from Corepack |
| php | `php --version` | PHP |
| php-modules | `php -m` | PHP extensions |
| php-ini | `php --ini` | which php.ini to edit (advice) |
| composer | `composer --version --no-ansi --no-plugins --no-scripts --no-interaction` | Composer |
| docker | `docker --version` | Docker |
| docker-compose | `docker compose version --short` | Compose v2 |
| docker-daemon | `docker info --format {{.ServerVersion}}` | whether the daemon is reachable (a local socket) |
| git | `git --version` | submodules |
| git-lfs | `git-lfs --version` | LFS files |
| make | `make --version` | Makefile tasks |
| just | `just --version` | justfile tasks |
| python | `python3 --version` | Python |
| python-win | `py -3 --version` (Windows only) | Python on Windows |
| uv / poetry / pipenv / pdm | `uv --version`, `poetry --version --no-ansi`, `pipenv --version`, `pdm --version` | Python package managers |
| go | `go version` | Go |
| rust / cargo | `rustc --version`, `cargo --version` | Rust |
| ruby / bundler | `ruby --version`, `bundle --version` | Ruby |
| java | `java -version` | Java |
| maven / gradle | `mvn --version`, `gradle --version` | Java builds |
| dotnet | `dotnet --version` | .NET SDK |
| dotnet-runtimes | `dotnet --list-runtimes` | installed .NET and ASP.NET Core runtimes (an ASP.NET Core app runs only on its target major version) |
| deno | `deno --version` | Deno |
| elixir | `elixir --version` | Elixir |
| powershell-policy | `powershell -NoProfile -NonInteractive -Command Get-ExecutionPolicy` (Windows only, when Node.js is needed) | warns when `npm.ps1` would be blocked |

Looked up on `PATH` but **never run**, to tailor advice: `mise`, `fnm`, `volta`, `asdf`, `pyenv`, `rbenv`, `brew`,
`winget`, `scoop`, `choco`, `apt`, `dnf`, `pacman`, `apk`, `zypper`. `nvm` is a shell function: its presence is read from
the `NVM_DIR` environment variable.

## Other checks

* **Ports.** For services and dev servers, the doctor binds to `127.0.0.1:<port>` and closes immediately. A failed bind
  means something already listens there (the database is running, or the dev server's port is taken). Nothing is
  sent, nothing is connected to.
* **Env files.** `stat` only: whether `api/.env` exists. Never read.
* **OS family.** `process.platform`, and on Linux `/etc/os-release` (`ID`, `ID_LIKE`), to pick advice for Debian/Ubuntu,
  Fedora/RHEL, Arch, Alpine, openSUSE, macOS or Windows.

## Advice

Advice comes from the bundled knowledge base (`kb/install.json`, `kb/php-extensions.json`), reviewed on the date the
report prints. A version manager already on the machine is suggested first (`fnm install 20.18.0`). PHP extension
advice uses the installed PHP version (`sudo apt install php8.3-mysql`) and the php.ini path from `php --ini`.

## Exit codes

`0` when every required item was found in a suitable version, `3` when something required is missing or the wrong
version, `1` on errors.
