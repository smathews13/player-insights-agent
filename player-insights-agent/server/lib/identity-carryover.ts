/**
 * Identity configuration a deployment stated once and must keep after its
 * artifact stops stating it.
 *
 * Customer people and access-group names do not belong in a public artifact,
 * so a Deploy from Git can ship these keys empty. Whatever a deployment last
 * stated is recorded in the app-owned store and restored while the artifact is
 * silent. A stated value always wins and replaces its part of the record.
 */
import { appTable } from '../../shared/app-schema';
import {
  DEPLOYMENT_DECISIONS_TABLE_NAME,
  decisionSource,
  readDeploymentDecision,
  recordDeploymentDecision,
  type DecisionStore,
} from './deployment-decisions';

export const IDENTITY_CARRYOVER_DECISION = 'identity_carryover_v1';

export const IDENTITY_CARRYOVER_KEYS = [
  'PLAYER_INSIGHTS_ADMIN_GROUP',
  'PLAYER_INSIGHTS_CONSUMER_GROUPS',
  'PLAYER_INSIGHTS_SUPER_ADMINS',
  'PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER',
] as const;

type IdentityCarryoverKey = (typeof IDENTITY_CARRYOVER_KEYS)[number];
type Env = Record<string, string | undefined>;

function decisionTable(): string {
  return appTable(DEPLOYMENT_DECISIONS_TABLE_NAME);
}

function stated(env: Env): Partial<Record<IdentityCarryoverKey, string>> {
  return Object.fromEntries(
    IDENTITY_CARRYOVER_KEYS.flatMap((key) => {
      const value = (env[key] ?? '').trim();
      return value ? [[key, value] as const] : [];
    })
  );
}

function parsedRecord(value: string | null): Partial<Record<IdentityCarryoverKey, string>> {
  if (!value) return {};
  try {
    const candidate = JSON.parse(value) as unknown;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
    return stated(candidate as Env);
  } catch {
    return {};
  }
}

/** Fill the keys this artifact leaves empty from the record. Returns how many were restored. */
export async function restoreIdentityCarryover(store: DecisionStore, env: Env = process.env): Promise<number> {
  if (decisionSource(env) === 'local') return 0;
  const silent = IDENTITY_CARRYOVER_KEYS.filter((key) => !(env[key] ?? '').trim());
  if (silent.length === 0) return 0;
  const record = parsedRecord(await readDeploymentDecision(store, decisionTable(), IDENTITY_CARRYOVER_DECISION));
  let restored = 0;
  for (const key of silent) {
    const value = record[key];
    if (!value) continue;
    env[key] = value;
    restored += 1;
  }
  return restored;
}

/** Record what this boot states over the previous record, so a key the artifact is silent on keeps its value. */
export async function recordIdentityCarryover(store: DecisionStore, env: Env = process.env): Promise<boolean> {
  if (decisionSource(env) === 'local') return false;
  const current = stated(env);
  if (Object.keys(current).length === 0) return false;
  const previous = parsedRecord(await readDeploymentDecision(store, decisionTable(), IDENTITY_CARRYOVER_DECISION));
  return recordDeploymentDecision(
    store,
    decisionTable(),
    IDENTITY_CARRYOVER_DECISION,
    JSON.stringify({ ...previous, ...current }),
    'app boot'
  );
}
