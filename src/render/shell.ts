// Rendering plan actions as commands for a person to type: POSIX shells (bash, zsh, sh) and PowerShell.
// The runner never uses these strings; it executes argv directly (docs/DECISIONS.md D7).
import type { Action } from '../core/schema.js';
import { envNamesLines } from '../core/envnames.js';

export type ShellKind = 'posix' | 'powershell';

export function defaultShell(platform: NodeJS.Platform = process.platform): ShellKind {
  return platform === 'win32' ? 'powershell' : 'posix';
}

const POSIX_SAFE = /^[A-Za-z0-9_\-.,:/@=+%^]+$/;
const PS_SAFE = /^[A-Za-z0-9_\-.,:/\\=+%^]+$/;

export function quotePosix(arg: string): string {
  if (arg !== '' && POSIX_SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function quotePowerShell(arg: string): string {
  // A leading `-` or `@` is fine for native commands; quote anything with spaces or PowerShell metacharacters.
  if (arg !== '' && PS_SAFE.test(arg) && !/^[@-]-?$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "''")}'`;
}

export function toWindowsPath(p: string): string {
  return p.replace(/\//g, '\\');
}

export function argvFor(action: Extract<Action, { type: 'exec' }>, shell: ShellKind): string[] {
  return shell === 'powershell' && action.windowsArgv ? action.windowsArgv : action.argv;
}

/** One command line for the action, to run inside the step's working directory. */
export function renderAction(action: Action, shell: ShellKind): string {
  const q = shell === 'powershell' ? quotePowerShell : quotePosix;
  switch (action.type) {
    case 'exec': {
      const argv = argvFor(action, shell);
      // PowerShell needs the call operator for a path to an executable (.\x.exe, .venv\Scripts\python.exe).
      const first = shell === 'powershell' && /[\\/]/.test(argv[0]) ? `& ${q(toWindowsPath(argv[0]).replace(/^(?!\.\\|[A-Za-z]:)/, '.\\'))}` : q(argv[0]);
      return [first, ...argv.slice(1).map(q)].join(' ');
    }
    case 'copy':
      return shell === 'powershell'
        ? `if (-not (Test-Path ${q(toWindowsPath(action.to))})) { Copy-Item ${q(toWindowsPath(action.from))} ${q(toWindowsPath(action.to))} }`
        : `[ -e ${q(action.to)} ] || cp ${q(action.from)} ${q(action.to)}`;
    case 'touch':
      return shell === 'powershell'
        ? `if (-not (Test-Path ${q(toWindowsPath(action.path))})) { New-Item -ItemType File ${q(toWindowsPath(action.path))} | Out-Null }`
        : `[ -e ${q(action.path)} ] || touch ${q(action.path)}`;
    case 'env-names': {
      const lines = envNamesLines(action);
      return shell === 'powershell'
        ? `if (-not (Test-Path ${q(toWindowsPath(action.path))})) { Set-Content -Encoding ascii -Path ${q(toWindowsPath(action.path))} -Value @(${lines.map(quoteAlways(shell)).join(', ')}) }`
        : `[ -e ${q(action.path)} ] || printf '%s\\n' ${lines.map(quoteAlways(shell)).join(' ')} > ${q(action.path)}`;
    }
    case 'manual':
      return `# ${action.text}`;
  }
}

/** Always single-quoted (lines of text, not words). */
function quoteAlways(shell: ShellKind): (s: string) => string {
  return shell === 'powershell' ? (s) => `'${s.replace(/'/g, "''")}'` : (s) => `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `cd` into a working directory relative to the project folder. */
export function renderCd(cwd: string, shell: ShellKind): string {
  const q = shell === 'powershell' ? quotePowerShell : quotePosix;
  return `cd ${q(shell === 'powershell' ? toWindowsPath(cwd) : cwd)}`;
}

/** The command plus a `cd`, runnable from the analyzed folder's root. */
export function renderFromRoot(action: Action, cwd: string, shell: ShellKind): string {
  const cmd = renderAction(action, shell);
  if (cwd === '.' || action.type === 'manual') return cmd;
  return shell === 'powershell' ? `Push-Location ${quotePowerShell(toWindowsPath(cwd))}; ${cmd}; Pop-Location` : `(${renderCd(cwd, shell)} && ${cmd})`;
}
