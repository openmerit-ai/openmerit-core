import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ScoutScope } from './scout-credentials.ts';
import { scoutSkill } from './scout-instructions.ts';

export const piVersion = '1.5.0';
type RecordValue = Record<string, unknown>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const optional = async (path: string): Promise<string | null> => {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
};
async function object(path: string): Promise<RecordValue> {
  const value: unknown = JSON.parse(await optional(path) ?? '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Scout installation metadata at ${path}; nothing changed.`);
  return value as RecordValue;
}
export function piPaths(root: string, scope: ScoutScope) {
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent'));
  const base = scope === 'user' ? agentDir : join(root, '.pi');
  return { skill: join(base, 'skills/openmerit-scout/SKILL.md'), rule: join(base, 'extensions/openmerit-scout.ts'),
    connection: join(base, 'extensions/openmerit-scout.json'), record: join(base, 'openmerit-install.json'),
    mcpFile: join(base, 'mcp.json'), mcpScope: scope, agentDir };
}
export async function inspectPi(root: string, scope: ScoutScope) {
  const paths = piPaths(root, scope);
  const otherPaths = piPaths(root, scope === 'user' ? 'project' : 'user');
  const [record, connection, installedSkill, installedRule, mcp, otherMcp, other] = await Promise.all([
    object(paths.record), optional(paths.connection), optional(paths.skill), optional(paths.rule), object(paths.mcpFile),
    object(otherPaths.mcpFile), optional(otherPaths.rule),
  ]);
  const owned = record.version === 1 && record.client === 'pi' && record.scope === scope;
  const matches = (value: string | null, field: string) => value === null || owned && [record[field], record[`pending${field[0]!.toUpperCase()}${field.slice(1)}`]].includes(hash(value));
  return { paths, record, owned, current: connection, installedSkill, installedRule,
    serverOwned: matches(connection, 'serverHash'), skillOwned: matches(installedSkill, 'skillHash'), ruleOwned: matches(installedRule, 'ruleHash'),
    updates: { saved: null, active: false, conflicts: [] as string[] }, legacyRule: 'none',
    shadowed: other !== null || [mcp, otherMcp].some(config => config.mcpServers && typeof config.mcpServers === 'object' && 'openmerit' in config.mcpServers),
  };
}
export function piConflicts(state: Awaited<ReturnType<typeof inspectPi>>): string[] {
  return [
    ...(!state.serverOwned ? [`${state.paths.connection} was edited or is unowned.`] : []),
    ...(!state.skillOwned ? [`${state.paths.skill} was edited or is unowned.`] : []),
    ...(!state.ruleOwned ? [`${state.paths.rule} was edited or is unowned.`] : []),
    ...(state.shadowed ? ['Another Pi Scout installation or an openmerit MCP entry shadows this installation. Resolve the duplicate before installing.'] : []),
  ];
}
export async function configurePi(root: string, scope: ScoutScope, credentialsPath: string, ids: RecordValue) {
  const state = await inspectPi(root, scope);
  const conflicts = piConflicts(state);
  if (conflicts.length) throw new Error(conflicts.join('\n'));
  const extension = await readFile(new URL('../../../dist/pi/scout-extension.mjs', import.meta.url), 'utf8');
  const connection = `${JSON.stringify({ credentialsPath }, null, 2)}\n`;
  const skill = scoutSkill('pi');
  const next = { version: 1, client: 'pi', scope, ...ids, serverHash: hash(connection), skillHash: hash(skill), ruleHash: hash(extension), installedAt: new Date().toISOString() };
  const save = async (path: string, value: string | RecordValue) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  };
  // Record intent before writing files, so interrupted installs are recoverable.
  await save(state.paths.record, { ...state.record, version: 1, client: 'pi', scope,
    pendingServerHash: next.serverHash, pendingSkillHash: next.skillHash, pendingRuleHash: next.ruleHash });
  await save(state.paths.connection, connection);
  await save(state.paths.skill, skill);
  await save(state.paths.rule, extension);
  await save(state.paths.record, next);
}
export async function removePi(state: Awaited<ReturnType<typeof inspectPi>>) {
  if (state.current !== null && state.serverOwned) await rm(state.paths.connection, { force: true });
  if (state.installedRule !== null && state.ruleOwned) await rm(state.paths.rule, { force: true });
  if (state.installedSkill !== null && state.skillOwned) await rm(state.paths.skill, { force: true });
  // Keep ownership of edited files, so a future install does not adopt them.
  if (state.serverOwned && state.ruleOwned && state.skillOwned) await rm(state.paths.record, { force: true });
}
