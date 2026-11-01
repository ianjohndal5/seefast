// Line-oriented formats: Makefile, justfile, Procfile, Dockerfile and Markdown code blocks. Each parser returns
// what the file *says*, with lines; nothing is evaluated (no variable expansion beyond literal text, no includes).

export interface TaskDef {
  name: string;
  line: number;
  commands: string[];
}

/** Makefile rules with their recipe lines. Pattern rules, special targets and variable assignments are skipped. */
export function parseMakefile(text: string): TaskDef[] {
  const lines = text.split('\n');
  const out: TaskDef[] = [];
  // A rule with several targets (`setup install: deps`) gives its recipe to each of them.
  let cur: TaskDef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('\t')) {
      const cmd = l.trim().replace(/^[@+-]+/, '');
      if (cmd) for (const t of cur) t.commands.push(cmd);
      continue;
    }
    if (!l.trim() || l.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9_./-]*(?:\s+[A-Za-z0-9][A-Za-z0-9_./-]*)*)\s*::?(?!=)(.*)$/.exec(l);
    if (m && !/^\s*(export|include|-include|ifeq|ifneq|ifdef|ifndef|else|endif|define|endef)\b/.test(l)) {
      cur = [];
      for (const name of m[1].split(/\s+/)) {
        if (name.startsWith('.') || name.includes('%')) continue;
        const existing = out.find((t) => t.name === name);
        const t = existing ?? { name, line: i + 1, commands: [] };
        if (!existing) out.push(t);
        cur.push(t);
      }
      // `target: ; command`
      const inline = /;\s*(.+)$/.exec(m[2]);
      if (inline) for (const t of cur) t.commands.push(inline[1].trim());
    } else {
      cur = [];
    }
  }
  return out;
}

/** justfile recipes. */
export function parseJustfile(text: string): TaskDef[] {
  const lines = text.split('\n');
  const out: TaskDef[] = [];
  let cur: TaskDef | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s+\S/.test(l)) {
      if (cur) cur.commands.push(l.trim().replace(/^[@-]+/, ''));
      continue;
    }
    const m = /^@?([A-Za-z_][A-Za-z0-9_-]*)(\s+[^:]*)?:(?!=)/.exec(l);
    if (m && !/^(set|alias|export|import|mod)\b/.test(l)) {
      cur = { name: m[1], line: i + 1, commands: [] };
      out.push(cur);
    } else cur = null;
  }
  return out;
}

/** Procfile: `name: command`. */
export function parseProcfile(text: string): TaskDef[] {
  const out: TaskDef[] = [];
  text.split('\n').forEach((l, i) => {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(l.trim());
    if (m && !l.trim().startsWith('#')) out.push({ name: m[1], line: i + 1, commands: [m[2].trim()] });
  });
  return out;
}

export interface DockerInstruction {
  /** Upper-cased instruction (FROM, RUN, EXPOSE...). */
  op: string;
  args: string;
  line: number;
}

/** Dockerfile instructions with continuation lines joined; heredoc bodies are skipped. */
export function parseDockerfile(text: string): DockerInstruction[] {
  const lines = text.split('\n');
  const out: DockerInstruction[] = [];
  let escape = '\\';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const dir = /^#\s*escape\s*=\s*(\S)/i.exec(raw);
    if (dir && out.length === 0) escape = dir[1];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const start = i;
    let full = raw;
    while (full.trimEnd().endsWith(escape) && i + 1 < lines.length) {
      full = full.trimEnd().slice(0, -1) + ' ';
      i++;
      if (lines[i].trim().startsWith('#')) continue;
      full += lines[i];
    }
    const m = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(full);
    if (!m) continue;
    out.push({ op: m[1].toUpperCase(), args: m[2].trim(), line: start + 1 });
    const heredoc = /<<-?\s*["']?([A-Za-z_]+)["']?/.exec(m[2]);
    if (heredoc) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== heredoc[1]) i++;
      i++;
    }
  }
  return out;
}

export interface CodeBlock {
  lang: string;
  /** Text of the nearest heading above the block. */
  heading: string;
  /** Headings from the top level down to the nearest one. */
  headings: string[];
  /** 1-based line of the first content line. */
  line: number;
  lines: string[];
}

/** Fenced code blocks of a Markdown file, with the headings they sit under. */
export function parseMarkdownBlocks(text: string): CodeBlock[] {
  const lines = text.split('\n');
  const out: CodeBlock[] = [];
  const stack: { level: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: h[2].replace(/[*_`]/g, '') });
      continue;
    }
    // Setext headings (Title\n=====)
    if (i + 1 < lines.length && /^(=+|-+)\s*$/.test(lines[i + 1]) && lines[i].trim() && !/^\s*[-*]/.test(lines[i])) {
      const level = lines[i + 1].startsWith('=') ? 1 : 2;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: lines[i].trim() });
      i++;
      continue;
    }
    const f = /^(\s{0,3})(```+|~~~+)\s*([^\s`]*)/.exec(lines[i]);
    if (!f) continue;
    const fence = f[2];
    const body: string[] = [];
    const startLine = i + 2;
    i++;
    while (i < lines.length && !lines[i].trimStart().startsWith(fence)) {
      body.push(lines[i]);
      i++;
    }
    out.push({
      lang: f[3].toLowerCase().replace(/^\{|\}$/g, ''),
      heading: stack.length ? stack[stack.length - 1].text : '',
      headings: stack.map((s) => s.text),
      line: startLine,
      lines: body,
    });
  }
  return out;
}
