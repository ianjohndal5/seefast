// Why a command failed, in words. The last lines it printed are matched against the messages runtimes and tools
// print when something is missing, busy or unreachable; failing that, the exit code is looked up. Nothing here runs
// anything: it only reads what the command already printed. When no rule matches, the output speaks for itself.

export interface Diagnosis {
  /** What went wrong, in one sentence; absent when neither the output nor the exit code says. */
  reason?: string;
  /** Commands or changes that usually fix it, most direct first. */
  advice: string[];
  /** The last lines the command printed, oldest first. */
  output: string[];
}

export interface Failure {
  code: number | null;
  signal?: NodeJS.Signals | null;
  /** Everything the command printed (stdout and stderr as they arrived), or its last part. */
  output: string;
  platform: NodeJS.Platform;
}

/** How much output to keep per command for diagnosis, and how many lines to show. */
export const OUTPUT_KEPT = 64 * 1024;
const SHOWN = 15;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** Output as a terminal shows it: no colour codes, carriage-return rewrites applied, no blank lines. */
export function outputLines(text: string): string[] {
  return text.replace(ANSI, '').split(/\r?\n/).map((l) => (l.split('\r').filter(Boolean).pop() ?? '').trimEnd()).filter((l) => l.trim());
}

/** "exited with 1", "exited with 0x80008096" (Windows status codes read better in hex), "was killed by SIGKILL". */
export function exitText(code: number | null, signal: NodeJS.Signals | null | undefined, platform: NodeJS.Platform, error?: Error): string {
  if (error) return `could not start: ${error.message}`;
  if (code === null) return signal ? `was killed by ${signal}` : 'ended';
  const u = code >>> 0;
  return platform === 'win32' && u > 0xffff ? `exited with 0x${u.toString(16).toUpperCase()}` : `exited with ${code}`;
}

type Found = { reason: string; advice?: string[] };
type Rule = (text: string, platform: NodeJS.Platform) => Found | null;

const FRAMEWORKS: Record<string, string> = { 'Microsoft.NETCore.App': '.NET', 'Microsoft.AspNetCore.App': 'ASP.NET Core', 'Microsoft.WindowsDesktop.App': '.NET Desktop' };

/** The .NET host could not find the shared framework (runtime) the app targets. */
const dotnetFramework: Rule = (text, platform) => {
  if (!/You must install or update \.NET to run this application|framework '[^']+', version '[^']+' (?:\([^)]*\) )?was not found/i.test(text)) return null;
  const m = /Framework: '([^']+)', version '([^']+)'/.exec(text) ?? /framework '([^']+)', version '([^']+)'/i.exec(text);
  const fw = m?.[1] ?? 'Microsoft.NETCore.App';
  const wanted = m?.[2];
  const block = /following frameworks were found:\s*\n((?:[ \t-]+\S.*(?:\n|$))*)/i.exec(text)?.[1] ?? '';
  const found = [...block.matchAll(/(\d+\.\d+\.\d+\S*) at \[/g)].map((x) => x[1]);
  const major = wanted?.split('.')[0];
  const name = `${FRAMEWORKS[fw] ?? fw}${wanted ? ' ' + wanted.split('.').slice(0, 2).join('.') : ''}`;
  const advice: string[] = [];
  if (major) {
    advice.push(platform === 'win32' ? `winget install Microsoft.DotNet.SDK.${major}` : `Install the .NET ${major} SDK or runtime: https://dotnet.microsoft.com/download/dotnet/${major}.0`);
    const newer = Math.max(...found.map((v) => Number(v.split('.')[0])));
    if (newer > Number(major)) advice.push(`Or run it on .NET ${newer}: add <RollForward>Major</RollForward> to the project file, or set DOTNET_ROLL_FORWARD=Major (usually works; newer versions can change behaviour)`);
  }
  return {
    reason: `The app needs the ${name} runtime (${fw}${wanted ? ' ' + wanted : ''}), but ${found.length ? `this machine only has ${found.join(', ')}. .NET does not run an app on a newer major version unless the project allows it` : 'it is not installed'}.`,
    advice,
  };
};

const dotnetSdk: Rule = (text, platform) => {
  if (!/A compatible \.NET SDK was not found|No \.NET SDKs were found|compatible installed \.NET SDK for global\.json/i.test(text)) return null;
  const v = /Requested SDK version: (\S+)/.exec(text)?.[1];
  return {
    reason: v ? `global.json asks for .NET SDK ${v}, which is not installed.` : 'No installed .NET SDK fits this project.',
    advice: [
      v && platform === 'win32' ? `winget install Microsoft.DotNet.SDK.${v.split('.')[0]}` : 'Install the .NET SDK: https://dotnet.microsoft.com/download',
      ...(v ? ['Or let a newer SDK build it: set "rollForward": "latestMajor" in global.json'] : []),
    ],
  };
};

/** `dotnet run` / `dotnet build` stopping at a compile or restore error: name the first one. */
const dotnetBuild: Rule = (text) => {
  if (!/The build failed\. Fix the build errors|Build FAILED\./.test(text)) return null;
  const m = /(?:([^\\/\s]+\(\d+,\d+\)): )?error ([A-Z]+\d+): (.*?)(?: \[[^\]]*\])?$/m.exec(text);
  return { reason: m ? `It does not build: ${m[1] ? m[1] + ' ' : ''}${m[2]}: ${m[3]}` : 'It does not build; the errors are in the output.' };
};

const portBusy: Rule = (text, platform) => {
  // Vite's "Port 5173 is in use, trying another one..." is not a failure.
  if (!/EADDRINUSE|address already in use|Only one usage of each socket address|port \d+ is (?:already )?(?:in use|taken|allocated)(?!, trying)|That port is already in use/i.test(text)) return null;
  const port = /EADDRINUSE[^\n]*?:(\d{2,5})\b/.exec(text)?.[1]
    ?? /Failed to (?:bind to address|listen on) [^\s]*?:(\d{2,5})\b/i.exec(text)?.[1]
    ?? /\bport (\d{2,5}) is (?:already )?(?:in use|taken|allocated)(?!, trying)/i.exec(text)?.[1];
  if (!port) return { reason: 'A port the app wants is already in use by another program.' };
  return {
    reason: `Port ${port} is already in use: another program (perhaps an earlier copy of this app) is listening on it.`,
    advice: platform === 'win32'
      ? [`netstat -ano | findstr :${port}`, 'then close that program, or end it by the PID in the last column: taskkill /PID <pid> /F']
      : [`lsof -i :${port}`, 'then stop that program, or change the port this app uses'],
  };
};

const notFound: Rule = (text) => {
  const bin = /'([^']+)' is not recognized as an internal or external command/.exec(text)?.[1]
    ?? /The term '([^']+)' is not recognized as (?:the )?name of a cmdlet/.exec(text)?.[1]
    ?? /^(?:\/bin\/)?(?:ba|da|z)?sh: (?:line )?(?:\d+: )?([^\s:]+): (?:command )?not found/m.exec(text)?.[1]
    ?? /^zsh: command not found: (\S+)/m.exec(text)?.[1];
  return bin ? { reason: `${bin} was not found: it is not installed or not on PATH, or (if it comes from the project's packages) the dependencies are not installed.` } : null;
};

const phpVendor: Rule = (text) =>
  /vendor[\\/]autoload\.php/.test(text) && /Failed opening required|failed to open stream|No such file or directory/i.test(text)
    ? { reason: 'The Composer dependencies are not installed: vendor/autoload.php is missing.', advice: ['composer install'] }
    : null;

const laravelKey: Rule = (text) =>
  /No application encryption key has been specified/.test(text) ? { reason: 'APP_KEY is empty in .env.', advice: ['php artisan key:generate'] } : null;

const jsModule: Rule = (text) => {
  const name = /Cannot find (?:module|package) '([^']+)'/.exec(text)?.[1];
  if (!name) return null;
  if (/node_modules/.test(name) || !/^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(name)) {
    const pkg = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(name)?.[1].replace(/\\/g, '/') ?? (name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]);
    return { reason: `The JavaScript package ${pkg} is not installed: the dependencies are missing or out of date. Run the install step again.` };
  }
  return { reason: `A file the app loads is missing: ${name}. It may be built by a step that has not run yet.` };
};

const pyModule: Rule = (text) => {
  const name = /ModuleNotFoundError: No module named '([^']+)'/.exec(text)?.[1];
  return name ? { reason: `The Python package ${name.split('.')[0]} is not installed for the Python that ran this, or the project's virtual environment is not active.` } : null;
};

const nodeTooOld: Rule = (text) => {
  const m = /You are using Node\.js (\d+(?:\.\d+)*)\.?\s*(.*)/.exec(text);
  if (m) return { reason: `Node.js ${m[1]} is too old for this project. ${m[2]}`.trim(), advice: ['Install the Node.js version the doctor recommends'] };
  const y = /The engine "node" is incompatible with this module\. Expected version "([^"]+)"\. Got "([^"]+)"/.exec(text);
  return y ? { reason: `A package needs Node.js ${y[1]}, but this is ${y[2]}.`, advice: ['Install the Node.js version the doctor recommends'] } : null;
};

const outOfMemory: Rule = (text) =>
  /JavaScript heap out of memory/.test(text) ? { reason: 'Node.js ran out of memory.', advice: ['Give it more: set NODE_OPTIONS=--max-old-space-size=4096, then try again'] } : null;

const SERVICE_PORTS: Record<string, string> = { 3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 27017: 'MongoDB', 1433: 'SQL Server', 5672: 'RabbitMQ', 11211: 'Memcached', 9200: 'Elasticsearch' };

const unreachable: Rule = (text) => {
  if (/A network-related or instance-specific error occurred while establishing a connection to SQL Server/.test(text)) {
    return { reason: 'The app could not connect to SQL Server: it is not running here, or the connection string points somewhere else.', advice: ['Start SQL Server (or LocalDB), or change the connection string (appsettings.json or user secrets)'] };
  }
  const port = /ECONNREFUSED [^\s]*?:(\d{2,5})\b/.exec(text)?.[1]
    ?? /port (\d{2,5}) failed: Connection refused/.exec(text)?.[1]
    ?? /accepting TCP\/IP connections on port (\d{2,5})/.exec(text)?.[1];
  if (port) return { reason: `The app could not connect to ${SERVICE_PORTS[port] ?? 'a service'} on port ${port}: nothing is listening there. Start it, then try again.` };
  return /SQLSTATE\[HY000\] \[2002\]/.test(text) ? { reason: 'The app could not connect to its database server: it is not running, or DB_HOST / DB_PORT in .env point somewhere else.' } : null;
};

const RULES: Rule[] = [dotnetFramework, dotnetSdk, dotnetBuild, notFound, portBusy, phpVendor, laravelKey, jsModule, pyModule, nodeTooOld, outOfMemory, unreachable];

/** Exit codes that mean one thing whatever printed them. Windows codes are NTSTATUS values or .NET host errors. */
const WINDOWS_CODES: Record<number, string> = {
  0x80008083: 'The .NET host could not find the .NET runtime files: .NET is missing or damaged.',
  0x80008096: 'A .NET runtime version the app needs is not installed. The doctor shows which runtimes this machine has.',
  0x8000809b: 'The .NET SDK version that global.json asks for is not installed.',
  0xc0000135: 'A DLL the program needs was not found (often a missing Visual C++ Redistributable).',
  0xc0000005: 'The program crashed (access violation).',
  0xc00000fd: 'The program crashed (stack overflow).',
  0xc0000409: 'The program stopped itself after detecting an internal error.',
  0xc000013a: 'The program was interrupted (Ctrl+C, or its console was closed).',
  9009: 'A command it calls was not found.',
};
const POSIX_CODES: Record<number, string> = {
  126: 'A command it calls is not executable.',
  127: 'A command it calls was not found.',
  137: 'It was killed (SIGKILL), often because the machine ran out of memory.',
  139: 'It crashed (segmentation fault).',
};
const SIGNALS: Partial<Record<NodeJS.Signals, string>> = { SIGKILL: POSIX_CODES[137], SIGSEGV: POSIX_CODES[139] };

export function diagnose(f: Failure): Diagnosis {
  const lines = outputLines(f.output);
  const text = lines.slice(-200).join('\n');
  const output = lines.slice(-SHOWN);
  for (const rule of RULES) {
    const d = rule(text, f.platform);
    if (d) return { reason: d.reason, advice: d.advice ?? [], output };
  }
  const reason = f.code === null
    ? (f.signal ? SIGNALS[f.signal] : undefined)
    : f.platform === 'win32' ? WINDOWS_CODES[f.code >>> 0] : POSIX_CODES[f.code];
  return { reason, advice: [], output };
}
