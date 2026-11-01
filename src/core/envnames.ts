// The content of an env file created from variable names alone (the `env-names` action): used when a project has no
// env template, so the names come from reading the code. Names only, never values: a plan cannot carry a value
// here, and every name must look like a variable name (no `=`, spaces or line breaks can slip into the file).
import type { Action } from './schema.js';

export type EnvNamesAction = Extract<Action, { type: 'env-names' }>;

const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function isEnvName(name: string): boolean {
  return NAME.test(name);
}

/**
 * The file's lines. Names the framework requires are written `NAME=` (to fill in); the others are commented out,
 * because an empty value is not the same as an unset variable (`process.env.PORT ?? 3000` would get "").
 */
export function envNamesLines(action: EnvNamesAction): string[] {
  const bad = [...action.names, ...action.required].filter((n) => !isEnvName(n));
  if (bad.length) throw new Error(`not variable names: ${bad.slice(0, 3).join(', ')}`);
  const required = new Set(action.required);
  return [
    '# Variables the code reads (found by SeeFast). Uncomment the ones you need and add values.',
    ...(required.size ? ['# Lines without "#" are required.'] : []),
    ...action.names.map((n) => (required.has(n) ? `${n}=` : `# ${n}=`)),
  ];
}
