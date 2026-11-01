// Planning: turn resolved facts into the plan's env files, services, requirements, ordered steps and run targets.
import { isEnvName } from './envnames.js';
import { createHash } from 'node:crypto';
import type { ChoiceClaim, Ctx, ProjectDraft, ServiceClaim, StepDraft } from './context.js';
import { ev, withRole, stepId } from './context.js';
import { joinRel, dirOf } from './fs.js';
import { ENV_TARGET_POLICY, raise, resolveChoice, resolveVersion, describeClaim, type VersionResult } from './resolve.js';
import { looksSecret, safeValue } from './parse/envfile.js';
import { serviceDef, serviceForScheme } from './kb.js';
import { loadRecipes } from './recipes.js';
import { isMarkerFor } from './scan.js';
import { classifyArgv, nodeRunArgv } from './commands.js';
import { preferDocumentedScript, scriptStartsSomething } from './providers/node.js';
import { intersectRanges, parsePin, pinFits, rangeText } from './versions.js';
import { cmp, uniq } from './text.js';
import type {
  Action, Confidence, Ecosystem, EnvFile, EnvVar, Evidence, Plan, PlanMeta, Project, Requirement, RunTarget, Service, Step, Task,
} from './schema.js';
import { PHASES, SCHEMA_VERSION, confidenceRank } from './schema.js';

// ---- Env files ------------------------------------------------------------------------------------------------

function matches(patterns: string[], name: string): boolean {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));
}

export function planEnv(ctx: Ctx, out: EnvFile[]): void {
  // In a workspace, packages without their own template read the root's env file (turbo, nx and most
  // monorepo setups load it from there): their variables belong to the root's file, not to one file per package.
  for (const p of ctx.projects) {
    if (!p.workspaceRoot || p.envTemplates.length) continue;
    const reads = ctx.codeEnvReads.get(p.id);
    if (!reads?.size) continue;
    const rootReads = ctx.codeEnvReads.get(p.workspaceRoot) ?? new Map();
    for (const [name, list] of reads) if (!rootReads.has(name)) rootReads.set(name, list);
    ctx.codeEnvReads.set(p.workspaceRoot, rootReads);
    ctx.codeEnvReads.delete(p.id);
  }
  for (const p of ctx.projects) {
    const spec = ctx.envSpecs?.get(p.id);
    const reads = ctx.codeEnvReads.get(p.id) ?? new Map();
    if (!p.envTemplates.length && !reads.size && !spec?.required.length) continue;
    const subject = `envTarget@${p.id}`;
    const claims: ChoiceClaim[] = ctx.choiceClaims.filter((c) => c.subject === subject);
    const copyFrom = new Map<string, string>();
    for (const m of ctx.mentions) {
      if (m.project !== p.id || m.sig.kind !== 'copy') continue;
      const [from, to] = m.sig.key.slice(5).split('>');
      const toBase = to.split('/').pop()!;
      if (!/^\.env(\.[\w-]+)?$/.test(toBase) || /example|sample|template/.test(toBase)) continue;
      claims.push({ subject, value: toBase, source: m.source, evidence: m.evidence });
      copyFrom.set(toBase, from.split('/').pop()!);
    }
    // Recipes that disagree (Next.js: .env.local; Prisma's CLI: only .env): keep a file every recipe's tooling reads.
    const recipeValues = uniq(claims.filter((c) => c.source === 'recipe').map((c) => c.value));
    if (recipeValues.length > 1 && spec?.reads.length) {
      const common = recipeValues.filter((v) => spec.reads.every((r) => r.files.includes(v)));
      if (common.length === 1) {
        const dropped = claims.filter((c) => c.source === 'recipe' && c.value !== common[0]);
        const strict = spec.reads.filter((r) => !dropped.some(() => r.files.includes(dropped[0].value)));
        ctx.conflict({
          id: `${subject}:recipes`, subject, chosen: common[0],
          alternatives: [
            { value: common[0], evidence: claims.filter((c) => c.value === common[0]).map((c) => withRole(c.evidence, 'basis')) },
            ...dropped.map((c) => ({ value: c.value, evidence: [withRole(c.evidence, 'contradicts')] })),
          ],
          severity: 'info',
          message: `${dropped.map((c) => c.evidence.detail).join(', ')}, but ${strict.map((r) => r.recipe).join(' and ')} only read${strict.length === 1 ? 's' : ''} ${common[0]}; using ${common[0]}, which every tool here reads.`,
          rule: 'env file every framework reads',
        });
        for (const d of dropped) claims.splice(claims.indexOf(d), 1);
      }
    }
    const res = resolveChoice(ctx, subject, claims, ENV_TARGET_POLICY, 'env file', { value: '.env', why: 'Nothing names the env file; most tools read .env.' });
    let targetBase = res.value ?? '.env';
    // A file some framework's tooling cannot read (the Prisma CLI reads only .env) breaks a later step whatever the
    // docs say: use a file every tool reads, and say so.
    const unreadBy = (spec?.reads ?? []).filter((r) => !r.files.includes(targetBase));
    if (unreadBy.length) {
      const common = ['.env', '.env.local'].find((f) => (spec?.reads ?? []).every((r) => r.files.includes(f)));
      if (common) {
        const said = claims.find((c) => c.value === targetBase && c.source !== 'recipe');
        ctx.conflict({
          id: `${subject}:unreadable`, subject, chosen: common,
          alternatives: [{ value: common, evidence: [] }, { value: targetBase, evidence: said ? [withRole(said.evidence, 'contradicts')] : [] }],
          severity: 'warning',
          message: `${said ? `${said.evidence.file} creates ${targetBase}` : `${targetBase} would be the usual file`}, but ${unreadBy.map((r) => r.recipe).join(' and ')} only read${unreadBy.length === 1 ? 's' : ''} ${unreadBy[0].files.join(', ')}; using ${common}, which every tool here reads.`,
          rule: 'env file every framework reads',
        });
        targetBase = common;
        // Earlier notes about this file's name are superseded by this one.
        ctx.conflicts = ctx.conflicts.filter((c) => c.subject !== subject || c.id === `${subject}:unreadable`);
      }
    }
    const target = joinRel(p.root, targetBase);
    const wanted = copyFrom.get(targetBase);
    const tpl =
      p.envTemplates.find((t) => t.file.split('/').pop() === wanted) ??
      p.envTemplates.find((t) => targetBase === '.env.local' && /\.env\.local\./.test(t.file)) ??
      p.envTemplates[0];
    const exists = ctx.files.exists(target);
    const envStep = stepId(p.id, 'env');
    const vars: EnvVar[] = [];
    const seen = new Set<string>();
    const composeNames = new Set(ctx.serviceClaims.filter((c) => c.provider).map((c) => c.provider!.service));
    if (tpl) {
      for (const v of tpl.vars) {
        seen.add(v.name);
        const gen = spec?.generated[v.name];
        const evidence: Evidence[] = [withRole(ev(tpl.file, v.line, 'env-template', `${v.commented ? '# ' : ''}${v.name}=${v.valueKind === 'value' ? '…' : v.valueKind === 'placeholder' ? '<placeholder>' : ''}`), 'basis')];
        for (const r of (reads.get(v.name) ?? []).slice(0, 2)) evidence.push(withRole(r, 'supports'));
        let fill: EnvVar['fill'];
        let note: string | undefined;
        let confidence: Confidence = 'medium';
        if (gen && ctx.steps.some((s) => stepId(s.project, s.local) === gen)) {
          fill = 'generated';
          confidence = 'high';
        } else if (v.commented) fill = 'optional';
        else if (v.valueKind === 'value') {
          fill = 'default';
          confidence = 'high';
        } else if (spec?.fillWhen[v.name] === false) {
          fill = 'optional';
          note = 'Not needed with the configured database driver.';
        } else if (matches(spec?.optional ?? [], v.name) && !spec?.required.includes(v.name)) {
          fill = 'optional';
          note = 'Only needed for the integration it configures.';
        } else fill = 'user';
        const sv = safeValue(v.name, v.raw);
        if (/_HOST$/.test(v.name) && sv && composeNames.has(sv) && v.valueKind === 'value') {
          note = `${v.name}=${sv} is the Compose service name, which only resolves inside Docker. When the app runs on your machine, set ${v.name}=127.0.0.1.`;
          confidence = 'medium';
          ctx.conflict({
            id: `env-host:${p.id}:${v.name}`, subject: `env:${p.id}:${v.name}`, chosen: '127.0.0.1',
            alternatives: [{ value: sv, evidence: [withRole(ev(tpl.file, v.line, 'env-template', `${v.name}=${sv}`), 'contradicts')] }],
            severity: 'warning',
            message: `${tpl.file} sets ${v.name}=${sv}, the name of a Compose service. That name only resolves between containers; with the app running on your machine use ${v.name}=127.0.0.1 (the published port).`,
            rule: 'compose service names resolve only inside Docker',
          });
        }
        const patternNote = Object.entries(spec?.notes ?? {}).find(([k]) => matches([k], v.name))?.[1];
        vars.push({
          name: v.name, fill, secret: looksSecret(v.name), generatedBy: fill === 'generated' ? gen : undefined,
          note: note ?? patternNote, confidence, evidence,
        });
      }
    }
    for (const [name, list] of [...reads.entries()].sort(([a], [b]) => cmp(a, b))) {
      if (seen.has(name)) continue;
      seen.add(name);
      vars.push({
        name, fill: 'unknown', secret: looksSecret(name), confidence: 'low',
        note: tpl ? `Read by the code but missing from ${tpl.file.split('/').pop()}.` : 'Read by the code; there is no env template to say whether it needs a value.',
        evidence: list.slice(0, 3).map((e: Omit<Evidence, 'role'>) => withRole(e, 'basis')),
      });
    }
    for (const name of spec?.required ?? []) {
      if (seen.has(name)) {
        const v = vars.find((x) => x.name === name)!;
        if (v.fill === 'optional' || v.fill === 'unknown') v.fill = 'user';
        if (!v.note && spec?.notes[name]) v.note = spec.notes[name];
        continue;
      }
      vars.push({ name, fill: 'user', secret: looksSecret(name), confidence: 'medium', note: spec?.notes[name], evidence: [] });
    }
    const toFill = vars.filter((v) => v.fill === 'user').map((v) => v.name);
    const evidence: Evidence[] = [...res.evidence];
    if (tpl) evidence.unshift(withRole(ev(tpl.file, undefined, 'env-template', `${tpl.vars.length} variables`), 'basis'));
    if (tpl) {
      ctx.addStep({
        local: 'env', project: p.id, phase: 'configure', order: 20,
        title: `Create ${targetBase} from ${tpl.file.split('/').pop()}`,
        cwd: p.root, action: { type: 'copy', from: tpl.file.split('/').pop()!, to: targetBase },
        network: false, thirdPartyCode: false, confidence: res.confidence === 'low' && res.evidence.length === 0 ? 'medium' : res.confidence,
        why: `The app reads its configuration from ${targetBase}, which is not committed; ${tpl.file} is the template. ${res.why}.`,
        notes: [
          ...(exists ? [`${target} already exists: the copy is skipped and nothing is overwritten.`] : []),
          ...(toFill.length ? [`Then fill in: ${toFill.join(', ')}.`] : []),
        ],
        evidence,
        sig: `copy:${tpl.file.split('/').pop()}>${targetBase}`,
      });
    } else if (toFill.length || vars.length) {
      const names = vars.filter((v) => v.fill !== 'optional' && isEnvName(v.name)).map((v) => v.name);
      ctx.addStep({
        local: 'env', project: p.id, phase: 'configure', order: 20,
        title: `Create ${targetBase} with the variable names`,
        cwd: p.root, action: { type: 'env-names', path: targetBase, names, required: toFill.filter((n) => names.includes(n)) },
        network: false, thirdPartyCode: false, confidence: 'low',
        notes: [
          ...(exists ? [`${target} already exists: nothing is created or overwritten.`] : []),
          `Names only, no values: ${listNames(names)}. Uncomment the ones the app needs and set them${toFill.length ? `; ${toFill.join(', ')} ${toFill.length === 1 ? 'is' : 'are'} required` : ''}.`,
        ],
        // Without a template nobody says these are needed to start, unless a framework requires one.
        optional: !(spec?.required.length),
        why: `The repo has no env template, but the code reads ${vars.length} environment variable${vars.length === 1 ? '' : 's'}. Which ones need real values is unknown.`,
        evidence: vars.flatMap((v) => v.evidence).slice(0, 6),
      });
      ctx.unknown({
        id: `env-no-template:${p.id}`, subject: `env:${p.id}`,
        message: `${p.root === '.' ? 'The project' : p.root} has no env template (.env.example); the variables were found by reading the code and may be incomplete.`,
        suggestion: 'Check the README or ask the maintainers which values are needed.',
      });
    }
    out.push({
      project: p.id, file: target, template: tpl?.file ?? null, exists, createdBy: envStep, vars,
      confidence: tpl ? 'high' : 'low',
      why: tpl ? `${tpl.file} is the template for ${targetBase}. ${res.why}.` : 'No template; variables come from the code.',
      evidence,
    });
  }
}

// ---- Services ---------------------------------------------------------------------------------------------------

const COMPATIBLE: Record<string, string> = { mariadb: 'mysql' };

export function planServices(ctx: Ctx, out: Service[]): void {
  const groups = new Map<string, ServiceClaim[]>();
  for (const c of ctx.serviceClaims) {
    const key = COMPATIBLE[c.name] ?? c.name;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  // Compose services the knowledge base does not know count when an env template points at them by name.
  const refs = ctx.projects.flatMap((p) => (p.envTemplates[0]?.vars ?? []).filter((v) => !v.commented).map((v) => ({ p, v, sv: safeValue(v.name, v.raw) ?? '' })));
  for (const o of ctx.composeOther) {
    const hit = refs.find(({ sv }) => sv === o.service || new RegExp(`^[a-z][a-z0-9+.-]*://${o.service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|$)`, 'i').test(sv));
    if (!hit || groups.has(o.service)) continue;
    groups.set(o.service, [{
      name: o.service, category: 'other', project: hit.p.id, ports: o.ports, provider: { type: 'compose', file: o.file, service: o.service, image: o.image },
      source: 'compose', scope: 'dev', env: [hit.v.name], evidence: ev(o.file, o.line, 'compose', `service "${o.service}": image ${o.image}`),
    }, {
      name: o.service, category: 'other', project: hit.p.id, source: 'env-template', scope: 'dev', env: [hit.v.name],
      evidence: ev(hit.p.envTemplates[0].file, hit.v.line, 'env-template', `${hit.v.name} points at the Compose service "${o.service}"`),
    }]);
  }
  const composeSteps = new Map<string, { names: string[]; claims: ServiceClaim[] }>();
  for (const [key, claims] of [...groups.entries()].sort(([a], [b]) => cmp(a, b))) {
    const local = claims.filter((c) => c.source !== 'compose' && c.source !== 'ci');
    const compose = claims.filter((c) => c.source === 'compose' && c.scope === 'dev');
    const composeAny = claims.filter((c) => c.source === 'compose');
    const ci = claims.filter((c) => c.source === 'ci');
    const name = compose[0]?.name ?? local[0]?.name ?? claims[0].name;
    const def = serviceDef(name) ?? serviceDef(key);
    let optional: boolean;
    let confidence: Confidence;
    let why: string;
    if (local.some((c) => !c.optional)) {
      optional = false;
      confidence = compose.length || ci.length ? 'high' : 'medium';
      why = `${capital(describeClaim(local.find((c) => !c.optional)!))}.`;
    } else if (local.length) {
      optional = true;
      confidence = 'medium';
      why = `${capital(describeClaim(local[0]))}; only some features use it.`;
    } else if (compose.length) {
      const sqliteSays = ctx.projects.flatMap((p) => (p.envTemplates[0]?.vars ?? []).filter((v) => v.name === 'DB_CONNECTION' && !v.commented && safeValue(v.name, v.raw) === 'sqlite').map((v) => ({ p, v })));
      if (def?.category === 'database' && sqliteSays.length) {
        optional = true;
        confidence = 'medium';
        why = `${compose[0].evidence.file} defines it, but the env template uses SQLite.`;
        const s = sqliteSays[0];
        ctx.conflict({
          id: `service:${key}:sqlite`, subject: `service:${key}`, chosen: 'sqlite',
          alternatives: [
            { value: 'sqlite', evidence: [withRole(ev(s.p.envTemplates[0].file, s.v.line, 'env-template', 'DB_CONNECTION=sqlite'), 'basis')] },
            { value: name, evidence: [withRole(compose[0].evidence, 'contradicts')] },
          ],
          severity: 'info',
          message: `${compose[0].evidence.file} defines a ${name} service, but ${s.p.envTemplates[0].file} sets DB_CONNECTION=sqlite; using SQLite, so ${name} is optional.`,
          rule: 'env template decides the local database',
        });
      } else {
        // Required when an env template points at it (its Compose name, its port), or when there are no env
        // templates to say otherwise; optional when templates exist and none mention it (a mail catcher next to MAIL_MAILER=log).
        const svcNames = new Set(compose.map((c) => c.provider!.service));
        const ports = new Set(compose.flatMap((c) => c.ports ?? []));
        const templates = ctx.projects.flatMap((p) => p.envTemplates);
        const ref = templates.flatMap((t) => t.vars.filter((v) => !v.commented).map((v) => ({ t, v, sv: safeValue(v.name, v.raw) }))).find(({ sv }) => sv !== undefined && (svcNames.has(sv) || (/^\d+$/.test(sv) && ports.has(+sv)) || [...ports].some((pt) => sv.endsWith(`:${pt}`))));
        if (ref) {
          optional = false;
          confidence = 'medium';
          why = `${compose[0].evidence.file} defines it and ${ref.t.file} points at it (${ref.v.name}).`;
        } else if (templates.length) {
          optional = true;
          confidence = 'medium';
          why = `${compose[0].evidence.file} defines it, but no env template points at it.`;
        } else {
          optional = false;
          confidence = 'low';
          why = `${compose[0].evidence.file} defines it for local development.`;
        }
      }
    } else {
      optional = true;
      confidence = 'low';
      why = `Only CI uses it (${ci[0].evidence.file}), for tests.`;
    }
    if (composeAny.length && !compose.length && !local.length && !ci.length) {
      optional = true;
      why = `${composeAny[0].evidence.file} defines it behind a Compose profile.`;
    }
    const provider = (compose[0] ?? composeAny[0])?.provider ?? null;
    const version = compose[0]?.version ?? ci.find((c) => c.version)?.version ?? claims.find((c) => c.version)?.version;
    const ports = uniq(claims.flatMap((c) => c.ports ?? [])).filter((x) => x > 0);
    const projects = uniq(claims.map((c) => c.project).filter((x): x is string => Boolean(x))).sort(cmp);
    const evidence: Evidence[] = [];
    const ordered = [...local, ...compose, ...composeAny.filter((c) => !compose.includes(c)), ...ci];
    ordered.forEach((c, i) => evidence.length < 6 && evidence.push(withRole(c.evidence, i === 0 ? 'basis' : 'supports')));
    const id = `service:${key}`;
    out.push({
      id, name, category: def?.category ?? claims[0].category, version, ports: ports.length ? ports : def ? [def.port] : [],
      provider, projects: projects.length ? projects : ctx.projects.map((p) => p.id).slice(0, 1), env: uniq(claims.flatMap((c) => c.env ?? [])),
      optional, confidence, why, evidence,
    });
    if (provider && !optional) {
      const entry = composeSteps.get(provider.file) ?? { names: [], claims: [] };
      entry.names.push(provider.service);
      entry.claims.push(...claims);
      composeSteps.set(provider.file, entry);
    }
  }
  // The repo's Compose file builds the app itself: running everything in Docker is an alternative path.
  const appFiles = uniq(ctx.composeApps.map((a) => a.file)).sort(cmp);
  for (const file of appFiles) {
    const dir = dirOf(file);
    const project = ctx.projectAt(dir) ?? ctx.projects[0];
    if (!project) continue;
    const base = file.split('/').pop()!;
    const apps = ctx.composeApps.filter((a) => a.file === file);
    ctx.addRun({
      local: appFiles.length > 1 ? `docker-${base.replace(/\W+/g, '-')}` : 'docker', project: project.id, name: 'docker compose up', kind: 'dev', primary: false,
      title: 'Run everything in Docker (the repo\'s Compose setup)', cwd: dir,
      action: { type: 'exec', argv: ['docker', 'compose', ...(/^(docker-)?compose\.ya?ml$/.test(base) ? [] : ['-f', base]), 'up'] },
      readiness: { type: 'stays-up', seconds: 60 }, confidence: 'medium',
      why: `${file} builds the app (${apps.map((a) => `service "${a.service}"`).join(', ')}) and its services in containers. An alternative to the steps above; it creates containers and images outside the project.`,
      evidence: apps.map((a) => withRole(ev(file, a.line, 'compose', `service "${a.service}" is built from the repo`), 'basis')),
    });
  }
  let n = 0;
  for (const [file, { names }] of [...composeSteps.entries()].sort(([a], [b]) => cmp(a, b))) {
    const dir = dirOf(file);
    const base = file.split('/').pop()!;
    const project = ctx.projectAt(dir) ?? ctx.projects[0];
    if (!project) continue;
    const local = n++ ? `services-${n}` : 'services';
    const isDefault = /^(docker-)?compose\.ya?ml$/.test(base);
    const svcs = out.filter((s) => s.provider?.file === file && !s.optional);
    ctx.addStep({
      local, project: project.id, phase: 'services', order: 30,
      title: `Start ${svcs.map((s) => s.name).join(', ')} with Docker Compose`,
      cwd: dir, action: { type: 'exec', argv: ['docker', 'compose', ...(isDefault ? [] : ['-f', base]), 'up', '-d', ...uniq(names).sort(cmp)] },
      network: true, thirdPartyCode: true, outsideProject: true,
      requires: ['tool:docker'],
      after: uniq(svcs.flatMap((s) => s.projects)).map((pid) => stepId(pid, 'env') + '?'),
      confidence: 'medium',
      why: `${file} defines ${svcs.map((s) => `${s.name}${s.version ? ' ' + s.version : ''}`).join(' and ')}, which the app needs. Compose reads the env file in its folder for passwords and ports.`,
      notes: [
        `Creates containers and volumes outside the project folder, and downloads images on first run.`,
        `If you already run ${svcs.map((s) => s.name).join('/')} on this machine, skip this step and point the env file at it.`,
        'Stop them later with: docker compose stop',
      ],
      evidence: svcs.flatMap((s) => s.evidence.filter((e) => e.source === 'compose')).slice(0, 4).map((e) => ({ ...e, role: 'basis' as const })),
      sig: 'compose-up',
    });
    ctx.toolClaims.push({ tool: 'docker', project: project.id, optional: true, why: `Only to start ${svcs.map((s) => s.name).join(', ')} with Compose; a local installation works too.`, source: 'compose', evidence: ev(file, undefined, 'compose', `${base} present`) });
  }
  for (const s of out) {
    if (s.optional || s.provider) continue;
    const project = s.projects[0] ?? ctx.projects[0]?.id;
    if (!project) continue;
    const label = s.name === 'postgres' ? 'PostgreSQL' : s.name === 'mysql' ? 'MySQL (or MariaDB)' : s.name[0].toUpperCase() + s.name.slice(1);
    ctx.addStep({
      local: `service-${s.name}`, project, phase: 'services', order: 31,
      title: `Make sure a ${label} server is running`,
      cwd: ctx.project(project)?.root ?? '.',
      action: { type: 'manual', text: `Start a ${label}${s.version ? ' ' + s.version : ''} server on this machine (port ${s.ports[0] ?? '?'}) and set ${s.env.length ? s.env.join(', ') : 'the connection variables'} in the env file to match.${s.category === 'database' ? ' Create the database it names.' : ''}` },
      network: false, thirdPartyCode: false, confidence: s.confidence,
      why: `${s.why} The repo does not provide it (no Compose service), so it has to come from your machine. \`doctor\` gives install advice.`,
      evidence: s.evidence.slice(0, 3),
    });
  }
}

/** A readable list of variable names, shortened past 12. */
function listNames(names: string[]): string {
  return names.length <= 12 ? names.join(', ') : `${names.slice(0, 12).join(', ')} and ${names.length - 12} more (see the plan)`;
}

function capital(s: string): string {
  // A sentence that starts with a file name keeps it as written (package.json, .nvmrc).
  if (!s || /^[^\s]*[./]/.test(s.split(' ')[0])) return s;
  return s[0].toUpperCase() + s.slice(1);
}

// ---- Mentions: corroboration and commands the plan does not cover ----------------------------------------------

const SETUP_HEADING = /(install|setting up|set up|setup|getting started|get started|develop|local|quick ?start|running|run locally|contribut|first run|bootstrap)/i;

/** Whether the Laravel app's own code defines an artisan command (`$signature = 'koel:init'` or #[AsCommand]). */
function artisanCommandDefined(ctx: Ctx, root: string, cmd: string): boolean {
  const prefix = root === '.' ? 'app/' : `${root}/app/`;
  const re = new RegExp(`(signature\\s*=\\s*['"]|AsCommand\\(\\s*(name:\\s*)?['"]|\\$name\\s*=\\s*['"])${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['"\\s{]|$)`);
  return ctx.entries.files.some((f) => f.startsWith(prefix) && /Console|Commands/.test(f) && f.endsWith('.php') && re.test(ctx.files.readText(f) ?? ''));
}

const NOT_A_START = /^(build|test|lint|format|fmt|typecheck|type-check|check|prepare|postinstall|clean|release|deploy|e2e|storybook|docs|db:.*|migrate.*|seed.*|install|setup)(:|$)/;
const SETUP_SCRIPT = /^(setup|init|bootstrap|db:setup|db:init|dev:setup|setup:dev|setup:local|prepare:dev)$|(^|:)(setup|init|bootstrap)$/;
const UNINTERESTING_ARTISAN = /^artisan:(serve|test|tinker|queue:|schedule:|route:|make:|about|list|optimize|cache:|config:|view:|event:|pail|horizon|octane|dusk|ide-helper|telescope:prune|inspire|down|up|env|vendor:publish|package:discover|key:generate|migrate|db:seed|storage:link|reverb:start|vapor|sail)/;
const UNINTERESTING_SCRIPT = /^script:(test|lint|format|fmt|typecheck|type-check|tsc|check|e2e|storybook|coverage|cy|cypress|playwright|prettier|eslint|stylelint|dev|start|build|serve|preview|watch|analyze|clean|release|deploy|docs|commit|prepare)(:|$)/;

/** The comparable signature of an action, for steps that did not set one. */
export function sigOf(a: Action): string | undefined {
  if (a.type === 'exec') return classifyArgv(a.argv)?.key;
  if (a.type === 'copy') return `copy:${a.from}>${a.to}`;
  return undefined;
}

export function linkMentions(ctx: Ctx): void {
  const covered = new Set<string>();
  for (const s of ctx.steps) {
    s.sig ??= sigOf(s.action);
    if (!s.sig) continue;
    const ms = ctx.mentions.filter((m) => m.sig.key === s.sig && (m.project === s.project || (s.project === ctx.projects[0]?.id && !m.project)));
    let raised = false;
    for (const m of ms) {
      covered.add(m.sig.key + '@' + (m.project ?? ''));
      if (s.evidence.filter((e) => e.role === 'supports').length < 3 && !s.evidence.some((e) => e.file === m.evidence.file && e.line === m.evidence.line)) s.evidence.push(withRole(m.evidence, 'supports'));
      if (!raised && m.source !== 'readme') {
        s.confidence = raise(s.confidence);
        raised = true;
      }
    }
  }
  for (const r of ctx.runs) {
    r.sig ??= sigOf(r.action);
    if (!r.sig) continue;
    for (const m of ctx.mentions.filter((x) => x.sig.key === r.sig && x.project === r.project)) {
      covered.add(m.sig.key + '@' + (m.project ?? ''));
      if (r.evidence.filter((e) => e.role === 'supports').length < 3) r.evidence.push(withRole(m.evidence, 'supports'));
    }
  }
  // The docs' own start command beats the generic `dev` script, when the docs name exactly one per project.
  const startCandidates = new Map<string, Map<string, Evidence>>();
  for (const m of ctx.mentions) {
    if (m.source !== 'readme' || m.scope !== 'dev' || !m.project) continue;
    const p = ctx.project(m.project);
    if (!p) continue;
    let key: string | null = null;
    if (m.sig.kind === 'script' && m.sig.key.startsWith('script:')) {
      const name = m.sig.key.slice(7);
      if (p.node?.scripts[name] && !NOT_A_START.test(name) && scriptStartsSomething(p, name)) key = `script:${name}`;
    } else if (m.sig.kind === 'task') {
      const [runner, target] = m.sig.key.split(':');
      if (ctx.tasks.some((t) => t.project === p.id && t.runner === runner && t.name === target && t.purpose === 'run')) key = `task:${runner}:${target}`;
    }
    if (!key) continue;
    const map = startCandidates.get(p.id) ?? new Map();
    if (!map.has(key)) map.set(key, withRole(m.evidence, 'supports'));
    startCandidates.set(p.id, map);
  }
  for (const [pid, map] of startCandidates) {
    if (map.size !== 1) continue;
    const [key, evidence] = [...map.entries()][0];
    const p = ctx.project(pid)!;
    if (key.startsWith('script:')) {
      if (preferDocumentedScript(ctx, p, key.slice(7), evidence)) covered.add(`${key}@${pid}`);
    } else {
      const [, runner, target] = key.split(':');
      const task = ctx.tasks.find((t) => t.project === pid && t.runner === runner && t.name === target)!;
      let run = ctx.runs.find((r) => r.project === pid && r.local === `task-${target}`);
      run ??= ctx.addRun({
        local: `task-${target}`, project: pid, name: target, kind: 'dev', primary: false, title: `Run the repo's "${target}" task (${runner})`,
        cwd: p.root, action: { type: 'exec', argv: [runner, target] }, readiness: { type: 'stays-up', seconds: 30 }, confidence: 'medium',
        why: `${task.file} defines "${target}": ${task.commands.slice(0, 2).join('; ')}`,
        evidence: [withRole(ev(task.file, task.line, 'task-runner', `${target}: ${task.commands[0] ?? ''}`.trim()), 'basis')], sig: `${runner}:${target}`,
      });
      for (const r of ctx.runs) if (r.project === pid && r.kind === 'dev' && r !== run) r.primary = false;
      run.primary = true;
      run.evidence.push(evidence);
      run.why += ` The docs start the app with it (${evidence.file}:${evidence.line}).`;
      covered.add(`${runner}:${target}@${pid}`);
    }
  }

  // Setup commands the docs give that no step covers (`php artisan koel:init`, `npm run db:setup`) become steps:
  // the docs say to run them, but this tool does not know what they do, so they stay low confidence.
  for (const m of ctx.mentions) {
    if ((m.source !== 'readme' && m.source !== 'devcontainer') || m.scope !== 'dev' || !m.project) continue;
    // Only commands in setup sections ("Installation", "Getting started", "Development"), not "Deploying" or tooling extras.
    if (m.source === 'readme' && !(m.headings ?? []).some((h) => SETUP_HEADING.test(h))) continue;
    if (covered.has(m.sig.key + '@' + m.project)) continue;
    const p = ctx.project(m.project);
    if (!p) continue;
    let step: Partial<StepDraft> | null = null;
    let optional = false;
    let note: string | undefined;
    if (m.sig.kind === 'artisan' && p.php && !UNINTERESTING_ARTISAN.test(m.sig.key)) {
      const cmd = m.sig.key.slice(8);
      // A command the app's own code defines is safe to plan; one from a package may need that package first.
      if (!artisanCommandDefined(ctx, p.root, cmd)) {
        optional = true;
        note = `The app's code does not define "${cmd}"; it may come from a package that is not installed.`;
      }
      step = { local: `docs-${cmd.replace(/[^\w-]/g, '-')}`, phase: 'database', order: 58, action: { type: 'exec', argv: ['php', 'artisan', cmd] }, title: `Run php artisan ${cmd} (from the docs)`, requires: ['runtime:php'], after: [stepId(p.id, 'migrate') + '?', stepId(p.id, 'key') + '?', stepId(p.id, 'composer-install') + '?'] };
    } else if (m.sig.kind === 'script' && m.sig.key.startsWith('composer-script:') && p.php) {
      const name = m.sig.key.slice('composer-script:'.length);
      const body = p.php.scripts[name]?.join(' ') ?? '';
      if (p.php.scripts[name] && SETUP_SCRIPT.test(name) && !/\b(serve|dev|watch)\b/.test(body)) {
        step = { local: `docs-${name.replace(/[^\w-]/g, '-')}`, phase: 'database', order: 57, action: { type: 'exec', argv: ['composer', 'run', name] }, title: `Run composer ${name} (from the docs)`, requires: ['runtime:php', 'package-manager:composer'], after: [stepId(p.id, 'composer-install'), stepId(p.id, 'env') + '?'] };
      }
    } else if (m.sig.kind === 'script' && m.sig.key.startsWith('script:') && p.node) {
      const name = m.sig.key.slice(7);
      if (p.node.scripts[name] && SETUP_SCRIPT.test(name) && !scriptStartsSomething(p, name)) {
        const installer = p.workspaceRoot ?? p.id;
        step = { local: `docs-${name.replace(/[^\w-]/g, '-')}`, phase: /db|migrat|seed/.test(name) ? 'database' : 'configure', order: 55, action: { type: 'exec', argv: nodeRunArgv(p.node.pm ?? 'npm', name) }, title: `Run the "${name}" script (from the docs)`, requires: ['runtime:node'], after: [stepId(installer, 'install'), stepId(p.id, 'env') + '?'] };
      }
    }
    if (!step) continue;
    covered.add(m.sig.key + '@' + m.project);
    ctx.addStep({
      ...(step as StepDraft), project: p.id, cwd: p.root, network: false, thirdPartyCode: true, optional, confidence: 'low',
      why: `${m.evidence.file} tells you to run it (line ${m.evidence.line}); this tool does not know what it does.`,
      notes: [...(note ? [note] : []), 'Read what it does first. It may ask questions: if it waits for input, run it by hand.'],
      evidence: [withRole(m.evidence, 'basis')], sig: m.sig.key,
    });
  }

  // Commands the maintainers mention for setup that no step covers.
  const reported = new Set<string>();
  for (const m of ctx.mentions) {
    if (m.scope !== 'dev' || (m.source !== 'readme' && m.source !== 'devcontainer' && m.source !== 'task-runner')) continue;
    if (!['artisan', 'exec', 'script'].includes(m.sig.kind)) continue;
    if (UNINTERESTING_ARTISAN.test(m.sig.key) || UNINTERESTING_SCRIPT.test(m.sig.key)) continue;
    if (/^exec:(prisma (generate|migrate|db push|db seed)|next|vite|tsc|eslint|prettier|jest|vitest|playwright|cypress|turbo|husky|concurrently|create-)/.test(m.sig.key)) continue;
    if (covered.has(m.sig.key + '@' + (m.project ?? ''))) continue;
    if (ctx.runs.some((r) => r.sig === m.sig.key)) continue;
    const id = `unplanned:${m.project ?? ''}:${m.sig.key}`;
    if (reported.has(id) || reported.size >= 8) continue;
    reported.add(id);
    ctx.unknown({
      id, subject: `step:${m.project ?? 'root'}`,
      message: `${capital(describeClaim(m))} (${m.evidence.file}:${m.evidence.line}); the plan does not include it.`,
      suggestion: 'Run it after the steps above if the project needs it; this tool does not know what it does.',
      evidence: [withRole(m.evidence, 'basis')],
    });
  }
}

// ---- Projects that need each other at runtime -------------------------------------------------------------------

export function linkProjects(ctx: Ctx, services: Service[]): void {
  // A Node project inside a Laravel app (resources/assets/v2) compiles assets the app serves: its build is needed.
  for (const lp of ctx.projects.filter((p) => p.frameworks.some((f) => f.id === 'laravel'))) {
    for (const q of ctx.projects) {
      if (q === lp || !q.node || !(lp.root === '.' ? q.root !== '.' : q.root.startsWith(lp.root + '/'))) continue;
      const b = ctx.steps.find((s) => s.project === q.id && s.local === 'build');
      if (!b || !b.optional) continue;
      b.optional = false;
      b.confidence = 'medium';
      b.title = `Build ${q.root}'s frontend assets for the Laravel app`;
      b.why = `${q.root} is a frontend inside the Laravel app ${lp.root === '.' ? '' : lp.root + ' '}whose compiled output the app serves; it is not committed.`;
    }
  }
  const primaryPort = (p: ProjectDraft) => ctx.runs.find((r) => r.project === p.id && r.primary && r.kind === 'dev' && r.ports.length)?.ports[0].port;
  for (const p of ctx.projects) {
    const hits: { port: number; evidence: Omit<Evidence, 'role'>; what: string }[] = [];
    for (const t of p.envTemplates) {
      for (const v of t.vars) {
        if (v.commented) continue;
        const sv = safeValue(v.name, v.raw);
        const m = sv ? /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?$/.exec(sv) : null;
        // Only variables that name a backend: FRONTEND_URL in an API, APP_URL or NEXTAUTH_URL describe the app itself.
        const apiLike = /(API|BACKEND|SERVER|SERVICE|GRAPHQL|GQL|WS|SOCKET|ENDPOINT|GATEWAY|HOST_URL)/.test(v.name) && !/(FRONTEND|CLIENT|SITE|ORIGIN|CORS|CALLBACK|REDIRECT|NEXTAUTH|AUTH_URL|APP_URL|PUBLIC_URL)/.test(v.name);
        if (m && apiLike) hits.push({ port: m[2] ? +m[2] : 80, evidence: ev(t.file, v.line, 'env-template', `${v.name}=${sv}`), what: v.name });
      }
    }
    for (const f of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'vite.config.ts', 'vite.config.js', 'nuxt.config.ts']) {
      const rel = joinRel(p.root, f);
      if (!ctx.files.isFile(rel)) continue;
      const lines = (ctx.files.readText(rel) ?? '').split('\n');
      lines.forEach((l, i) => {
        const m = /['"`]https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(l);
        if (m) hits.push({ port: +m[1], evidence: ev(rel, i + 1, 'code', l.trim().slice(0, 120)), what: `${f} (proxy or rewrite)` });
      });
    }
    for (const h of hits) {
      const served = ctx.projects.some((q) => primaryPort(q) === h.port) || services.some((s) => s.ports.includes(h.port));
      if (!served && /env-template/.test(h.evidence.source) && !ctx.steps.some((s) => s.local === `external-${h.port}`)) {
        ctx.addStep({
          local: `external-${h.port}`, project: p.id, phase: 'services', order: 32, title: `Start the service ${h.what} points at (localhost:${h.port})`, cwd: p.root,
          action: { type: 'manual', text: `${h.what} expects something at http://localhost:${h.port}, and nothing in this repository serves that port. Start it (often a separate backend repository) or change ${h.what}.` },
          network: false, thirdPartyCode: false, confidence: 'medium',
          why: `${h.evidence.file} sets ${h.evidence.detail}; no project or service here listens on ${h.port}.`,
          evidence: [withRole(h.evidence, 'basis')],
        });
      }
      const target = ctx.projects.find((q) => q !== p && primaryPort(q) === h.port);
      if (!target || p.dependsOn.some((d) => d.project === target.id && d.kind === 'runtime')) continue;
      // Never both ways: the first link found (in project order) wins, the other is a configuration URL.
      if (target.dependsOn.some((d) => d.project === p.id)) continue;
      p.dependsOn.push({
        project: target.id, kind: 'runtime', confidence: 'medium',
        why: `${h.what} points at localhost:${h.port}, where ${target.name} serves; start ${target.name} first.`,
        evidence: [withRole(h.evidence, 'basis')],
      });
    }
  }
  for (const r of ctx.runs) {
    if (r.kind !== 'dev' && r.kind !== 'worker') continue;
    const p = ctx.project(r.project)!;
    for (const d of p.dependsOn.filter((x) => x.kind === 'runtime')) {
      const target = ctx.runs.find((x) => x.project === d.project && x.primary && x.kind === 'dev');
      if (target) r.needs.push(stepId(target.project, target.local));
    }
    for (const s of services) if (!s.optional && s.projects.includes(r.project)) r.needs.push(s.id);
    for (const port of r.ports) {
      for (const h of ctx.portHints.filter((x) => x.port === port.port)) {
        port.evidence.push(h.evidence);
        port.confidence = raise(port.confidence);
      }
    }
  }
  const primaries = ctx.runs.filter((r) => r.primary && (r.kind === 'dev' || r.kind === 'worker'));
  for (let i = 0; i < primaries.length; i++) {
    for (let j = i + 1; j < primaries.length; j++) {
      const a = primaries[i];
      const b = primaries[j];
      const shared = a.ports.find((x) => b.ports.some((y) => y.port === x.port));
      if (!shared || a.project === b.project) continue;
      ctx.conflict({
        id: `port:${shared.port}:${a.project}:${b.project}`, subject: `port:${shared.port}`, chosen: null,
        alternatives: [{ value: a.project, evidence: shared.evidence }, { value: b.project, evidence: b.ports.find((y) => y.port === shared.port)!.evidence }],
        severity: 'warning',
        message: `${ctx.project(a.project)!.name} and ${ctx.project(b.project)!.name} both start on port ${shared.port}; the second one will fail or pick another port. Start one at a time, or change one port.`,
        rule: 'two run targets on one port',
      });
    }
  }
}

// ---- Requirements -----------------------------------------------------------------------------------------------

const RUNTIME_OF: Record<string, { tool: string; label: string }> = {
  node: { tool: 'node', label: 'Node.js' }, php: { tool: 'php', label: 'PHP' }, python: { tool: 'python', label: 'Python' },
  go: { tool: 'go', label: 'Go' }, rust: { tool: 'rust', label: 'Rust' }, ruby: { tool: 'ruby', label: 'Ruby' },
  java: { tool: 'java', label: 'Java' }, dotnet: { tool: 'dotnet', label: '.NET SDK' }, deno: { tool: 'deno', label: 'Deno' }, elixir: { tool: 'elixir', label: 'Elixir' },
};

const EXT_LEVEL: Record<string, [Confidence, boolean]> = {
  manifest: ['high', true], lockfile: ['high', true], 'env-template': ['medium', true], container: ['low', false], ci: ['low', false],
};

export function buildRequirements(ctx: Ctx): { requirements: Requirement[]; idFor: (name: string, project: string) => string } {
  const reqs: Requirement[] = [];
  const perProject = new Map<string, string>(); // `${tool}@${project}` → requirement id
  const addVersioned = (kind: Requirement['kind'], tool: string, label: string, projects: ProjectDraft[], baseWhy: (p: ProjectDraft) => string, optional = false) => {
    const results = projects.map((p) => ({ p, r: resolveVersion(ctx, tool, label, p.root, `${kind}:${tool}@${p.id}`) }));
    const groups = new Map<string, typeof results>();
    // One machine usually has one version of a tool: merge projects whose ranges can all hold at once.
    const merged = mergeVersionResults(results.map((x) => x.r));
    if (merged) groups.set('merged', results.map((x, i) => ({ p: x.p, r: i === 0 ? merged : x.r })));
    else for (const x of results) {
      const key = JSON.stringify([x.r.range, x.r.recommended, x.r.status]);
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    const split = groups.size > 1;
    for (const g of groups.values()) {
      const r = g[0].r;
      const id = `${kind}:${tool}` + (split ? `@${g[0].p.id}` : '');
      const ev2: Evidence[] = [];
      for (const x of g) for (const e of x.r.evidence) if (!ev2.some((y) => y.file === e.file && y.line === e.line && y.role === e.role)) ev2.push(e);
      reqs.push({
        id, kind, name: tool, range: r.range, rangeText: r.range ? rangeText(r.range) : undefined, recommended: r.recommended,
        projects: g.map((x) => x.p.id), optional, status: r.status,
        confidence: r.status === 'unknown' ? 'high' : r.confidence,
        why: `${baseWhy(g[0].p)} ${r.why}`.trim(),
        evidence: ev2.slice(0, 10),
      });
      for (const x of g) perProject.set(`${kind}:${tool}@${x.p.id}`, id);
      if (r.status === 'unknown') {
        ctx.unknown({
          id: `version:${id}`, subject: id,
          message: `No ${label} version is declared for ${g.map((x) => x.p.name).join(', ')}.`,
          suggestion: tool === 'node' ? 'Use the current Node.js LTS release.' : `Use a current ${label} release, and check the project docs.`,
        });
      }
    }
  };
  // Runtimes
  for (const [eco, { tool, label }] of Object.entries(RUNTIME_OF)) {
    const projects = ctx.projects.filter((p) => p.ecosystems.has(eco as never));
    if (projects.length) addVersioned('runtime', tool, label, projects, (p) => `${p.markers.find((m) => isMarkerFor(eco as Ecosystem, m.file))?.file ?? p.root} needs ${label}.`);
  }
  // Package managers and tools named by steps.
  const stepNeeds = new Map<string, Set<string>>();
  for (const s of ctx.steps) for (const r of s.requires) if (/^(package-manager|tool):/.test(r)) stepNeeds.set(r, (stepNeeds.get(r) ?? new Set()).add(s.project));
  for (const t of ctx.toolClaims) {
    const id = t.tool === 'composer' ? 'package-manager:composer' : `tool:${t.tool}`;
    stepNeeds.set(id, (stepNeeds.get(id) ?? new Set()).add(t.project ?? ctx.projects[0]?.id ?? 'root'));
  }
  for (const [id, pids] of [...stepNeeds.entries()].sort(([a], [b]) => cmp(a, b))) {
    const [kind, tool] = id.split(':') as ['package-manager' | 'tool', string];
    const projects = [...pids].map((x) => ctx.project(x)).filter((x): x is ProjectDraft => Boolean(x));
    if (!projects.length) continue;
    const claims = ctx.toolClaims.filter((t) => t.tool === tool);
    const required = ctx.steps.some((s) => !s.optional && s.requires.includes(id) && !s.outsideProject) || claims.some((c) => !c.optional);
    const pmWhy = (p: ProjectDraft) => {
      if (kind === 'package-manager' && p.node?.pmChoice?.name === tool) return `${p.name} uses ${tool}: ${p.node.pmChoice.why}.${tool === 'npm' ? ' npm comes with Node.js (some Linux distributions package it separately).' : ''}`;
      return claims[0]?.why ?? `Steps for ${p.name} run ${tool}.`;
    };
    addVersioned(kind === 'package-manager' ? 'package-manager' : 'tool', tool, tool, projects, pmWhy, !required);
    const last = reqs[reqs.length - 1];
    const choice = kind === 'package-manager' ? projects.map((p) => p.node?.pmChoice).find((c) => c?.name === tool) : undefined;
    if (choice && last.status === 'unknown') last.confidence = choice.confidence;
    if (last.status === 'unknown') {
      // A package manager or tool without a declared version is normal; not an unknown worth listing.
      ctx.unknowns = ctx.unknowns.filter((u) => u.id !== `version:${last.id}`);
      last.status = 'ok';
      last.why = last.why.replace(/ No .* version is declared anywhere.*$/, '');
    }
    for (const c of claims.slice(0, 2)) if (!last.evidence.length) last.evidence.push(withRole(c.evidence, 'basis'));
  }
  // PHP extensions
  const exts = new Map<string, typeof ctx.extClaims>();
  for (const c of ctx.extClaims) exts.set(c.ext, [...(exts.get(c.ext) ?? []), c]);
  for (const [ext, claims] of [...exts.entries()].sort(([a], [b]) => cmp(a, b))) {
    const levels = claims.map((c) => EXT_LEVEL[c.source] ?? ['low', false]);
    const required = levels.some(([, req]) => req);
    let confidence: Confidence = levels.reduce<Confidence>((a, [l]) => (confidenceRank(l) > confidenceRank(a) ? l : a), 'low');
    if (new Set(claims.map((c) => c.source)).size >= 2) confidence = raise(confidence);
    if (['xdebug', 'pcov'].includes(ext) && !required) continue;
    const sorted = [...claims].sort((a, b) => confidenceRank((EXT_LEVEL[b.source] ?? ['low'])[0]) - confidenceRank((EXT_LEVEL[a.source] ?? ['low'])[0]));
    reqs.push({
      id: `php-extension:${ext}`, kind: 'extension', name: ext, projects: uniq(claims.map((c) => c.project)).sort(cmp), optional: !required,
      status: 'ok', confidence,
      why: `${capital(describeClaim(sorted[0]))}${required ? '' : ' (only CI or a container image installs it, so the app may not need it)'}.`,
      evidence: sorted.slice(0, 4).map((c, i) => withRole(c.evidence, i === 0 ? 'basis' : 'supports')),
    });
  }
  const kindOrder = { runtime: 0, 'package-manager': 1, extension: 2, tool: 3 };
  reqs.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || cmp(a.id, b.id));
  return { requirements: reqs, idFor: (name, project) => perProject.get(`${name}@${project}`) ?? name };
}

/** Merge per-project version results into one when their ranges intersect; null when they cannot all hold. */
function mergeVersionResults(rs: VersionResult[]): VersionResult | null {
  if (rs.length === 1) return rs[0];
  if (rs.some((r) => r.status === 'conflict')) return null;
  const known = rs.filter((r) => r.status === 'ok');
  if (!known.length) return rs[0];
  const range = intersectRanges(known.map((r) => r.range ?? '*'));
  if (range === null) return null;
  const recs = known.map((r) => r.recommended).filter((x): x is string => Boolean(x));
  const recommended = recs.find((x) => { const pin = parsePin(x); return pin?.range ? range === '*' || pinFits(pin.range, range) : false; });
  if (recs.length && !recommended) return null;
  const evidence: Evidence[] = [];
  for (const r of known) for (const e of r.evidence) if (!evidence.some((y) => y.file === e.file && y.line === e.line && y.role === e.role)) evidence.push(e);
  // The confidence of the project whose own range is the merged one (it decides); otherwise the weakest.
  const binding = known.find((r) => rangeText(r.range) === rangeText(range === '*' ? undefined : range) && (!recommended || r.recommended === recommended));
  const conf = binding?.confidence ?? known.reduce<Confidence>((a, r) => (confidenceRank(r.confidence) < confidenceRank(a) ? r.confidence : a), 'high');
  return {
    range: range === '*' ? undefined : range, recommended, confidence: conf, status: 'ok',
    why: uniq(known.map((r) => r.why)).join(' '), evidence,
  };
}

// ---- Assembly ---------------------------------------------------------------------------------------------------

function projectOrder(ctx: Ctx): Map<string, number> {
  const order = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (p: ProjectDraft) => {
    if (order.has(p.id) || visiting.has(p.id)) return;
    visiting.add(p.id);
    if (p.workspaceRoot) visit(ctx.project(p.workspaceRoot)!);
    for (const d of [...p.dependsOn].sort((a, b) => cmp(a.project, b.project))) {
      const q = ctx.project(d.project);
      if (q) visit(q);
    }
    order.set(p.id, order.size);
  };
  for (const p of ctx.projects) visit(p);
  return order;
}

export function assemble(ctx: Ctx, parts: { env: EnvFile[]; services: Service[]; requirements: Requirement[]; idFor: (name: string, project: string) => string }, meta: PlanMeta, tool: { name: string; version: string }): Plan {
  const pOrder = projectOrder(ctx);
  const ids = new Set(ctx.steps.map((s) => stepId(s.project, s.local)));
  const servicesByProject = new Map<string, string[]>();
  for (const s of ctx.steps) if (s.phase === 'services') for (const pid of ctx.projects.map((p) => p.id)) servicesByProject.set(pid, [...(servicesByProject.get(pid) ?? []), stepId(s.project, s.local)]);
  const dropped: string[] = [];
  const steps: Step[] = ctx.steps.map((s) => {
    const id = stepId(s.project, s.local);
    const after = new Set<string>();
    for (const a of s.after) {
      const clean = a.replace(/\?$/, '');
      if (ids.has(clean) && clean !== id) after.add(clean);
      else if (!a.endsWith('?') && clean !== id) dropped.push(`${id} → ${clean}`);
    }
    if (s.phase === 'database') for (const sv of servicesByProject.get(s.project) ?? []) after.add(sv);
    return {
      id, project: s.project, phase: s.phase, title: s.title, cwd: s.cwd, action: s.action,
      network: s.network, thirdPartyCode: s.thirdPartyCode, outsideProject: s.outsideProject, optional: s.optional,
      after: [...after].sort(cmp),
      requires: uniq(s.requires.map((r) => (r.startsWith('runtime:') ? parts.idFor(r, s.project) : r))).sort(cmp),
      confidence: s.confidence, why: s.why.replace(/\s+/g, ' ').trim(), notes: s.notes, evidence: dedupeEvidence(s.evidence),
    };
  });
  if (dropped.length) meta.stats.skipped['step dependency on a step that does not exist'] = dropped.length;
  const sorted = topoSort(steps, (s) => [s.phase === 'prepare' ? 0 : 1, pOrder.get(s.project) ?? 99, PHASES.indexOf(s.phase), orderOf(ctx, s.id), s.id]);
  const stepIds = new Set(sorted.map((s) => s.id));
  const runIds = new Set(ctx.runs.map((r) => stepId(r.project, r.local)));
  const kindOrder = { dev: 0, worker: 1, production: 2, test: 3 };
  const run: RunTarget[] = ctx.runs
    .map((r) => ({
      id: stepId(r.project, r.local), project: r.project, name: r.name, kind: r.kind, primary: r.primary, title: r.title, cwd: r.cwd, action: r.action,
      ports: r.ports.map((p) => ({ ...p, evidence: dedupeEvidence(p.evidence) })),
      needs: uniq(r.needs.filter((n) => runIds.has(n) || n.startsWith('service:'))).sort(cmp),
      after: uniq(r.after.map((a) => a.replace(/\?$/, '')).filter((a) => stepIds.has(a))).sort(cmp),
      readiness: r.readiness ?? { type: 'stays-up', seconds: 20 },
      confidence: r.confidence, why: r.why.replace(/\s+/g, ' ').trim(), evidence: dedupeEvidence(r.evidence),
    }))
    .sort((a, b) => (pOrder.get(a.project) ?? 99) - (pOrder.get(b.project) ?? 99) || kindOrder[a.kind] - kindOrder[b.kind] || Number(b.primary) - Number(a.primary) || cmp(a.id, b.id));
  const projects: Project[] = [...ctx.projects]
    .sort((a, b) => (pOrder.get(a.id) ?? 0) - (pOrder.get(b.id) ?? 0))
    .map((p) => ({
      id: p.id, root: p.root, name: p.name || p.id,
      ecosystems: [...p.ecosystems].sort((a, b) => Number(!frameworkEcos(p).includes(a)) - Number(!frameworkEcos(p).includes(b)) || cmp(a, b)) as Project['ecosystems'],
      support: p.support, role: p.role,
      frameworks: p.frameworks, packageManagers: p.packageManagers, ...(p.workspaceRoot ? { workspaceRoot: p.workspaceRoot } : {}),
      dependsOn: [...p.dependsOn].sort((a, b) => cmp(a.project, b.project) || cmp(a.kind, b.kind)), evidence: p.markers,
    }));
  const tasks: Task[] = [...ctx.tasks].sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.name, b.name));
  const conflicts = [...ctx.conflicts].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1) || cmp(a.id, b.id));
  const unknowns = [...ctx.unknowns].sort((a, b) => cmp(a.id, b.id));
  const required = sorted.filter((s) => !s.optional);
  const lowest = required.reduce<Confidence | null>((a, s) => (a === null || confidenceRank(s.confidence) < confidenceRank(a) ? s.confidence : a), null);
  const supports = new Set(projects.map((p) => p.support));
  const plan: Plan = {
    schemaVersion: SCHEMA_VERSION,
    tool,
    digest: '',
    summary: {
      support: !projects.length ? 'none' : supports.size === 2 ? 'partial' : supports.has('full') ? 'full' : 'generic',
      projects: projects.length, steps: sorted.length, conflicts: conflicts.length, unknowns: unknowns.length, lowestStepConfidence: lowest,
    },
    projects,
    requirements: parts.requirements,
    services: parts.services,
    env: parts.env.sort((a, b) => (pOrder.get(a.project) ?? 0) - (pOrder.get(b.project) ?? 0)),
    steps: sorted,
    run,
    tasks,
    conflicts,
    unknowns,
    meta,
  };
  plan.digest = planDigest(plan);
  return plan;
}

function frameworkEcos(p: ProjectDraft): string[] {
  const recipes = new Map(loadRecipes().map((r) => [r.id, r.ecosystem as string]));
  return p.frameworks.map((f) => recipes.get(f.id) ?? '');
}

function orderOf(ctx: Ctx, id: string): number {
  return ctx.steps.find((s) => stepId(s.project, s.local) === id)?.order ?? 50;
}

function dedupeEvidence(list: Evidence[]): Evidence[] {
  const out: Evidence[] = [];
  for (const e of list) if (!out.some((x) => x.file === e.file && x.line === e.line && x.detail === e.detail)) out.push(e);
  return out;
}

/** Kahn's algorithm with a priority key, so the order is deterministic and respects every `after`. */
function topoSort(steps: Step[], key: (s: Step) => (string | number)[]): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indeg = new Map(steps.map((s) => [s.id, 0]));
  const next = new Map<string, string[]>();
  for (const s of steps) for (const a of s.after) if (byId.has(a)) {
    indeg.set(s.id, indeg.get(s.id)! + 1);
    next.set(a, [...(next.get(a) ?? []), s.id]);
  }
  const cmpKey = (a: Step, b: Step) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] === kb[i]) continue;
      return typeof ka[i] === 'number' ? (ka[i] as number) - (kb[i] as number) : cmp(String(ka[i]), String(kb[i]));
    }
    return 0;
  };
  const ready = steps.filter((s) => indeg.get(s.id) === 0);
  const out: Step[] = [];
  while (out.length < steps.length) {
    if (!ready.length) {
      // A cycle: release the lowest-keyed remaining step (counted by the caller as a plan defect).
      const rest = steps.filter((s) => !out.includes(s)).sort(cmpKey);
      ready.push(rest[0]);
      indeg.set(rest[0].id, 0);
    }
    ready.sort(cmpKey);
    const s = ready.shift()!;
    if (out.includes(s)) continue;
    out.push(s);
    for (const n of next.get(s.id) ?? []) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) ready.push(byId.get(n)!);
    }
  }
  return out;
}

/** Canonical JSON (sorted keys) for hashing. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function planDigest(plan: Plan): string {
  const { meta: _m, digest: _d, ...rest } = plan;
  void _m;
  void _d;
  return 'sha256:' + createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

export { serviceForScheme };
