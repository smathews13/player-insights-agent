import { appTable } from '../../shared/app-schema';
import {
  EMPTY_FLYWHEEL_STATE,
  FlywheelStateSchema,
  parseFlywheelState,
  type FlywheelState,
} from '../../shared/eval-flywheel';
import type { LakebaseReader } from './lakebase-store';

const KEY = 'effective';
export const EVAL_FLYWHEEL_TABLE = appTable('eval_flywheel');
export const EVAL_FLYWHEEL_DDL = `CREATE TABLE IF NOT EXISTS ${EVAL_FLYWHEEL_TABLE} (
  id TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

let cache = new WeakMap<object, { value: FlywheelState; at: number }>();
export const EVAL_FLYWHEEL_TTL_MS = 5_000;

export function forgetFlywheelState(): void {
  cache = new WeakMap();
}

export async function readFlywheelState(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<FlywheelState> {
  const now = options.now ?? Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < (options.maxAgeMs ?? EVAL_FLYWHEEL_TTL_MS)) return cached.value;
  try {
    const result = await client.lakebase.query(`SELECT state FROM ${EVAL_FLYWHEEL_TABLE} WHERE id = $1`, [KEY]);
    const raw = result?.rows?.[0]?.state;
    const parsed = raw === undefined ? EMPTY_FLYWHEEL_STATE : parseFlywheelState(raw);
    cache.set(client, { value: parsed, at: now });
    return parsed;
  } catch (error) {
    console.warn('[eval-flywheel] Falling back to empty flywheel state:', (error as Error).message);
    return EMPTY_FLYWHEEL_STATE;
  }
}

export async function writeFlywheelState(
  client: LakebaseReader,
  state: FlywheelState,
  updatedBy: string
): Promise<FlywheelState> {
  const parsed = FlywheelStateSchema.parse(state);
  await client.lakebase.query(
    `INSERT INTO ${EVAL_FLYWHEEL_TABLE} (id, state, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       state = EXCLUDED.state, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify(parsed), updatedBy]
  );
  forgetFlywheelState();
  return parsed;
}

export async function patchFlywheelState(
  client: LakebaseReader,
  patch: Partial<FlywheelState>,
  updatedBy: string
): Promise<FlywheelState> {
  const current = await readFlywheelState(client, { maxAgeMs: 0 });
  return writeFlywheelState(client, { ...current, ...patch }, updatedBy);
}

/**
 * The serving endpoint the next Ask should call.
 *
 * Empty or `current` means the deployed default. A named candidate is what
 * Promote saved. Ask reads this; Connections does not.
 */
export async function resolveAskEndpoint(client: LakebaseReader): Promise<string | undefined> {
  const state = await readFlywheelState(client);
  const name = state.promoted?.endpoint?.trim();
  if (!name || name === 'current') return undefined;
  return name;
}
