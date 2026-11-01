// Env templates (.env.example and friends). Only templates are ever read (fs.ts refuses real env files).
// Values are classified, never copied to the plan, except through `safeValue`: connection drivers, hosts, ports and
// localhost URLs stripped of credentials, which is what service and dependency detection need.

export interface TemplateVar {
  name: string;
  line: number;
  /** `# KEY=value`: documented but disabled. */
  commented: boolean;
  /** empty: `KEY=`; placeholder: `your-key-here`, `changeme`, `<token>`; value: anything else. */
  valueKind: 'empty' | 'placeholder' | 'value';
  /** Raw value, kept in memory for classification only. Never put this in the plan; use safeValue(). */
  raw: string;
}

const SECRET_NAME = /(PASSWORD|PASSWD|PASS$|SECRET|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH_?KEY|_KEY$|^KEY$|SALT|SIGNATURE|DSN$|WEBHOOK)/i;

export function looksSecret(name: string): boolean {
  if (/^(NEXT_PUBLIC_|VITE_|PUBLIC_|NUXT_PUBLIC_|REACT_APP_)/.test(name) && !/(SECRET|PASSWORD|PRIVATE)/i.test(name)) {
    // Public client-side variables are shipped to browsers; publishable keys are not secrets.
    return /SECRET|PASSWORD|PRIVATE/i.test(name);
  }
  return SECRET_NAME.test(name);
}

const PLACEHOLDER =
  /^(your[-_ ].*|.*[-_]here|change[-_ ]?me|changeit|replace[-_ ]?me|todo|xxx+|\*+|\.\.\.|<[^>]*>|\[[^\]]*\]|\{\{.*\}\}|example|placeholder|secret|password|null|none|insert.*|put.*|enter.*|sk_test_x+|pk_test_x+)$/i;

export function parseEnvTemplate(text: string): TemplateVar[] {
  const out: TemplateVar[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i].trim();
    let commented = false;
    if (l.startsWith('#')) {
      commented = true;
      l = l.replace(/^#+\s*/, '');
    }
    l = l.replace(/^export\s+/, '');
    const m = /^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(l);
    if (!m) continue;
    const name = m[1];
    // A commented line that is prose ("# Set FOO=bar to enable") is not a variable.
    if (commented && /\s/.test(lines[i].replace(/^\s*#+\s*/, '').split('=')[0])) continue;
    let raw = m[2].trim();
    if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) raw = raw.slice(1, -1);
    else raw = raw.replace(/\s+#.*$/, '');
    if (seen.has(name)) {
      // A later active definition beats an earlier commented one.
      const prev = out.find((v) => v.name === name)!;
      if (prev.commented && !commented) Object.assign(prev, { line: i + 1, commented, raw, valueKind: classifyValue(raw) });
      continue;
    }
    seen.add(name);
    out.push({ name, line: i + 1, commented, raw, valueKind: classifyValue(raw) });
  }
  return out;
}

function classifyValue(raw: string): TemplateVar['valueKind'] {
  if (raw === '') return 'empty';
  if (PLACEHOLDER.test(raw)) return 'placeholder';
  return 'value';
}

const SAFE_WORD = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;

/**
 * The part of a template value that may appear in the plan and drive inference, or undefined. Allowed: drivers and
 * connection names (`DB_CONNECTION=mysql`), hosts, ports, environment names, and URLs reduced to scheme://host:port
 * with any credentials removed. Never for names that look like credentials.
 */
export function safeValue(name: string, raw: string): string | undefined {
  if (!raw || looksSecret(name)) return undefined;
  const n = name.toUpperCase();
  if (/(_|^)(PORT)$/.test(n)) return /^\d{1,5}$/.test(raw) ? raw : undefined;
  if (/(_|^)(HOST|HOSTNAME|SERVER)$/.test(n)) return /^[A-Za-z0-9.-]{1,100}$/.test(raw) ? raw : undefined;
  if (/(CONNECTION|DRIVER|STORE|MAILER|CLIENT|DISK|BROADCASTER|ENGINE|PROVIDER|_ENV|^APP_ENV|^NODE_ENV|SCOUT_DRIVER|_DIALECT)$/.test(n)) {
    return SAFE_WORD.test(raw) ? raw : undefined;
  }
  if (n === 'DB_DATABASE' && /\.sqlite$/.test(raw) && !raw.includes('..')) return raw;
  if (/(_URL|_URI|_ENDPOINT|_ORIGIN|_BASE)$/.test(n) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return reduceUrl(raw);
  }
  return undefined;
}

/** scheme://host[:port] without user, password, path or query; undefined when not a URL or interpolated. */
export function reduceUrl(raw: string): string | undefined {
  if (raw.includes('${')) {
    const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
    return m ? `${m[1].toLowerCase()}://` : undefined;
  }
  try {
    const u = new URL(raw);
    if (!u.protocol || !u.hostname) return undefined;
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
    return m ? `${m[1].toLowerCase()}:` : undefined;
  }
}

/**
 * Remove anything that may be a secret from a command line before it is quoted as evidence: values of inline
 * `NAME=value` assignments (unless safeValue allows them), passwords in URLs, `-p<password>` / `--password=x` /
 * `--token x` style options, `Authorization:` headers, and long random-looking tokens.
 */
export function redactCommand(line: string): string {
  let s = line;
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, '$1$2:…@');
  s = s.replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g, (m, name: string, value: string) => {
    const raw = value.replace(/^["']|["']$/g, '');
    return safeValue(name, raw) !== undefined && !/\$\{?\w/.test(raw) ? m : /^\$/.test(raw) ? m : `${name}=…`;
  });
  s = s.replace(/(\s--?(?:password|passwd|pass|token|secret|api-key|apikey|auth|key|access-key|secret-key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1…');
  s = s.replace(/(\s-p)(?!\s)("[^"]*"|'[^']*'|[^\s-]\S*)/g, '$1…');
  s = s.replace(/(authorization:\s*(?:bearer|basic|token)?\s*)[^\s"']+/gi, '$1…');
  s = s.replace(/\b(?=[A-Za-z0-9+/_-]{32,}\b)(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g, '…');
  return s;
}
