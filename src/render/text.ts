// Shared wording for renderers: tool labels, requirement lines, evidence references, colours.
import type { Evidence, Plan, Requirement, Service } from '../core/schema.js';

const LABELS: Record<string, string> = {
  node: 'Node.js', php: 'PHP', python: 'Python', go: 'Go', rust: 'Rust', ruby: 'Ruby', java: 'Java', dotnet: '.NET SDK', deno: 'Deno', elixir: 'Elixir',
  npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun', composer: 'Composer', bundler: 'Bundler', uv: 'uv', poetry: 'Poetry', pipenv: 'Pipenv', pdm: 'PDM',
  maven: 'Maven', gradle: 'Gradle', docker: 'Docker', git: 'Git', 'git-lfs': 'Git LFS', make: 'make', just: 'just',
  mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', redis: 'Redis', memcached: 'Memcached', mongodb: 'MongoDB', sqlserver: 'SQL Server',
  rabbitmq: 'RabbitMQ', mailpit: 'Mailpit', mailhog: 'MailHog', meilisearch: 'Meilisearch', elasticsearch: 'Elasticsearch', opensearch: 'OpenSearch',
  typesense: 'Typesense', minio: 'MinIO', localstack: 'LocalStack', kafka: 'Kafka', nats: 'NATS', clickhouse: 'ClickHouse', soketi: 'Soketi', selenium: 'Selenium',
  inbucket: 'Inbucket', maildev: 'MailDev', smtp4dev: 'smtp4dev', gotenberg: 'Gotenberg', spicedb: 'SpiceDB', keycloak: 'Keycloak', cube: 'Cube',
};

export function label(name: string): string {
  return LABELS[name] ?? name;
}

export function requirementLine(r: Requirement): string {
  if (r.kind === 'extension') return `PHP extension ${r.name}`;
  const v = r.rangeText && r.rangeText !== 'any' ? ` ${r.rangeText}` : '';
  const rec = r.recommended && r.recommended !== r.rangeText ? ` (recommended ${r.recommended})` : '';
  return `${label(r.name)}${v}${rec}`;
}

export function serviceLine(s: Service): string {
  const where = s.provider ? `Compose service "${s.provider.service}" in ${s.provider.file}` : 'not provided by the repo';
  return `${label(s.name)}${s.version ? ' ' + s.version : ''} (${s.category}, port ${s.ports.join(', ') || '?'}; ${where})`;
}

export function ref(e: Evidence): string {
  return e.line ? `${e.file}:${e.line}` : e.file;
}

export function refs(list: Evidence[], max = 3, role?: Evidence['role']): string {
  const xs = list.filter((e) => !role || e.role === role);
  const shown = xs.slice(0, max).map(ref);
  return shown.join(', ') + (xs.length > max ? ` +${xs.length - max}` : '');
}

export function projectLabel(plan: Plan, id: string): string {
  const p = plan.projects.find((x) => x.id === id);
  if (!p) return id;
  return p.root === '.' ? `${p.name} (root)` : p.root;
}

export interface Colors {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  cyan(s: string): string;
}

export function colors(enabled: boolean): Colors {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39), cyan: wrap(36, 39) };
}

export function confidenceTag(c: string): string {
  return c === 'high' ? 'sure' : c === 'medium' ? 'likely' : 'guess';
}
