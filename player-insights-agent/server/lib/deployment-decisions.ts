/**
 * Per-deployment decisions that have to outlive the file they were written in.
 *
 * WHY THIS EXISTS. `app.yaml` is the only place a deployment states what it has
 * decided about itself, and Deploy-from-Git REPLACES that file with the one
 * committed in `build/deploy/`. The App keeps its name, its service principal
 * and its Lakebase store; what it loses is every value a bundle release had
 * filled in. `shared/app-schema.ts` already carries the first casualty of that
 * -- the Postgres schema -- and solves it by asking the database which schema
 * this role already owns. A schema can be discovered that way because it is an
 * object with an owner. A POLICY cannot: nothing in Postgres knows whether this
 * deployment meant its conversation rail to be shared.
 *
 * So the app records the decision itself, in its own store, at the one moment it
 * can be sure the environment is stating rather than defaulting: a boot whose
 * `PLAYER_INSIGHTS_TARGET` is filled, which only a bundle release does. A later
 * source-only Git deploy, whose app.yaml carries the public artifact's authored
 * placeholder, reads the recorded value back instead of taking the placeholder
 * for an answer.
 *
 * WHAT THIS DELIBERATELY CANNOT DO. It cannot widen anything on its own. A Git
 * deploy never records, so a placeholder can never overwrite a release's
 * decision; and a deployment that has recorded nothing keeps the authored value,
 * which for the rail is per-user. A fresh clone of this repository deployed by
 * anybody has an empty table and therefore the closed default, unchanged.
 */

/** The one Lakebase shape this module needs, so a test needs no pool. */
export interface DecisionStore {
  query(text: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>;
}

/** Filled by bundle releases and empty in the public Git deployment artifact. */
export const APP_TARGET_ENV = 'PLAYER_INSIGHTS_TARGET';

/** Present when the app is actually attached to Lakebase; absent in local tests. */
export const LAKEBASE_ENDPOINT_ENV = 'LAKEBASE_ENDPOINT';

/**
 * Bare table name. Qualified by the caller through `appTable`, so this module
 * holds no opinion about the schema and the DDL, the read and the write cannot
 * disagree about it.
 */
export const DEPLOYMENT_DECISIONS_TABLE_NAME = 'deployment_decisions';

/** Whether the conversation rail lists everyone's conversations or only the caller's. */
export const SHARED_RAIL_DECISION = 'shared_conversation_rail';

/**
 * Where the value in the environment came from, which is the only thing that
 * decides whether it may be recorded or has to be looked up.
 *
 * `release` is a boot whose bundle target is filled: the environment is a
 * statement. `git-deploy` is a Lakebase-bound boot with no target, which is the
 * artifact's placeholder rather than a statement. `local` is everything else --
 * a laptop, a test -- which never touches the store at all.
 */
export type DecisionSource = 'release' | 'git-deploy' | 'local';

export function decisionSource(env: Record<string, string | undefined>): DecisionSource {
  if ((env[APP_TARGET_ENV] ?? '').trim()) return 'release';
  return (env[LAKEBASE_ENDPOINT_ENV] ?? '').trim() ? 'git-deploy' : 'local';
}

export function deploymentDecisionsDdl(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
         decision TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         recorded_by TEXT NOT NULL
       )`;
}

/**
 * The recorded value, or null when there is none and when it cannot be read.
 *
 * The two are the same answer here on purpose. A missing table on a store that
 * has not migrated yet, a refused SELECT and a decision nobody has recorded all
 * mean the same thing to the caller: there is nothing to restore, so keep what
 * the environment carried. Every one of those falls back to the closed default,
 * which is the direction a failure has to fail in.
 */
export async function readDeploymentDecision(
  store: DecisionStore,
  table: string,
  decision: string,
): Promise<string | null> {
  try {
    const result = await store.query(`SELECT value FROM ${table} WHERE decision = $1`, [decision]);
    const value = result.rows?.[0]?.value;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * What one decision resolved to, and which of the three ways it got there.
 *
 * `restored` is the case worth naming: a Git deploy that found a recorded value
 * and used it in place of the artifact's placeholder. It is what the boot log
 * prints, because "the rail is shared and nothing in app.yaml says so" is
 * otherwise unanswerable from outside the container.
 */
export interface PreservedDecision {
  /** What the process should use. */
  value: string | undefined;
  source: DecisionSource;
  /** Whether {@link value} came from the store rather than from the environment. */
  restored: boolean;
  /** What the environment actually carried, for the same log line. */
  authored: string | undefined;
}

/**
 * Resolve one env-carried decision so that a Git deploy keeps what a release
 * decided.
 *
 * THE ORDER IS THE WHOLE RULE:
 *
 * - A release boot (`PLAYER_INSIGHTS_TARGET` filled) is the authority. Its value
 *   is used and recorded, so the next Git deploy has something to find.
 * - A Git-deploy boot uses the recorded value when there is one, because its own
 *   app.yaml is the public artifact's placeholder rather than a statement. It
 *   RECORDS NOTHING, which is what stops a placeholder overwriting a release.
 * - Anything else (a laptop, the suite) never touches the store.
 *
 * Nothing here interprets the value: the caller owns the parse, and a stored
 * value that the caller's parse rejects fails the same way an environment value
 * would. That keeps one parser for one decision.
 */
export async function preserveEnvDecision(input: {
  store: DecisionStore;
  table: string;
  decision: string;
  authored: string | undefined;
  env: Record<string, string | undefined>;
  recordedBy: string;
}): Promise<PreservedDecision> {
  const { store, table, decision, authored, env, recordedBy } = input;
  const source = decisionSource(env);
  const stated = (authored ?? '').trim();

  if (source === 'local') return { value: authored, source, restored: false, authored };

  if (source === 'release') {
    if (stated) await recordDeploymentDecision(store, table, decision, stated, recordedBy);
    return { value: authored, source, restored: false, authored };
  }

  const recorded = await readDeploymentDecision(store, table, decision);
  if (recorded === null) return { value: authored, source, restored: false, authored };
  return { value: recorded, source, restored: recorded !== stated, authored };
}

/**
 * Record what this boot's environment stated. Never throws: a decision that
 * could not be written is a decision that will not survive the next Git deploy,
 * which is worth a log line and not a failed boot.
 */
export async function recordDeploymentDecision(
  store: DecisionStore,
  table: string,
  decision: string,
  value: string,
  recordedBy: string,
): Promise<boolean> {
  try {
    await store.query(
      `INSERT INTO ${table} (decision, value, recorded_by, recorded_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (decision) DO UPDATE SET
         value = EXCLUDED.value, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
      [decision, value, recordedBy],
    );
    return true;
  } catch {
    return false;
  }
}
