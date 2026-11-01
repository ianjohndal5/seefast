// Small text helpers shared by the parsers: offset → line, line search, and a shell-word splitter for the
// commands found in scripts, CI steps, Makefiles and READMEs (which are parsed, never run).

export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  /** 1-based line of a 0-based offset. */
  line(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

/** First 1-based line matching `re`, optionally only after the first line matching `after`. */
export function findLine(text: string, re: RegExp, after?: RegExp): number | undefined {
  const lines = text.split('\n');
  let start = 0;
  if (after) {
    const i = lines.findIndex((l) => after.test(l));
    if (i < 0) return undefined;
    start = i;
  }
  for (let i = start; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return undefined;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ShellCommand {
  /** Leading `NAME=value` assignments (values kept only for the parser; never copied to the plan). */
  assignments: Record<string, string>;
  argv: string[];
}

/**
 * Split a POSIX-ish command line into simple commands (on `&&`, `||`, `;`, `|` and newlines) and words. Quotes are
 * honoured, variables are left as written, anything this cannot follow (subshells, heredocs) just yields words.
 */
export function splitShell(line: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let words: string[] = [];
  let cur = '';
  let hasCur = false;
  let quote: '"' | "'" | null = null;
  const pushWord = () => {
    if (hasCur) words.push(cur);
    cur = '';
    hasCur = false;
  };
  const pushCmd = () => {
    pushWord();
    if (words.length) {
      const assignments: Record<string, string> = {};
      let i = 0;
      while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
        const eq = words[i].indexOf('=');
        assignments[words[i].slice(0, eq)] = words[i].slice(eq + 1);
        i++;
      }
      commands.push({ assignments, argv: words.slice(i) });
    }
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      hasCur = true;
    } else if (c === '\\' && i + 1 < line.length) {
      if (line[i + 1] === '\n') i++;
      else {
        cur += line[++i];
        hasCur = true;
      }
    } else if (c === ' ' || c === '\t') {
      pushWord();
    } else if (c === '#' && !hasCur) {
      // comment to end of line
      while (i < line.length && line[i] !== '\n') i++;
      pushCmd();
    } else if (c === '\n' || c === ';') {
      pushCmd();
    } else if (c === '&' || c === '|') {
      if (line[i + 1] === c) i++;
      pushCmd();
    } else if (c === '(' || c === ')') {
      pushCmd();
    } else {
      cur += c;
      hasCur = true;
    }
  }
  pushCmd();
  return commands;
}

/** Stable sort helper: compare strings by code unit (locale-independent). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
