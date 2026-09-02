import { APP_SCHEMA, appTable } from '../../shared/app-schema';
import { DEPLOYMENT_DECISIONS_TABLE_NAME, deploymentDecisionsDdl } from './deployment-decisions';
import { REQUEST_LATENCY_DDL, REQUEST_LATENCY_INDEX_DDL } from './request-latency';
import { APP_ACTIVITY_DDL, APP_ACTIVITY_TABLE } from './app-activity';
import { APP_SESSION_TABLE } from './app-session';
import {
  APP_ACTIVITY_ROLLUP_TABLE,
  REQUEST_LATENCY_ROLLUP_TABLE,
  TELEMETRY_HOUSEKEEPING_STATE_TABLE,
  TELEMETRY_ROLLUP_DAYS_TABLE,
  TELEMETRY_ROLLUP_MIGRATION_DDL,
  TRAFFIC_EVIDENCE_V2_MIGRATION_DDL,
  TRAFFIC_ROLLUP_MIGRATION_DDL,
} from './telemetry-retention';
import { TRAFFIC_DAILY_ROLLUP_TABLE } from './ops-traffic';
import { USER_SPEND_DAILY_TABLE, USER_SPEND_READ_MODEL_DDL, USER_SPEND_REFRESH_TABLE } from './user-spend-read-model';
import {
  USER_SPEND_HOURLY_READ_MODEL_DDL,
  USER_SPEND_HOURLY_REFRESH_TABLE,
  USER_SPEND_HOURLY_TABLE,
} from './user-spend-hourly-read-model';
/**
 * The numbered schema versions, and the rules for adding one.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERS ──
 *
 * Every table this app stores into used to be created by a flat list of
 * `CREATE TABLE IF NOT EXISTS` run on every boot. That list still exists, and it
 * is still the definition of version 1, because a database that already holds
 * the customer's history has to converge on it without a single destructive
 * statement. What has changed is that it is now a NUMBERED VERSION with a row in
 * `schema_version` recording that it was applied, which buys three things the
 * flat list could not give:
 *
 *   1. A statement added tomorrow runs ONCE, in order, after the statements it
 *      depends on, instead of being replayed against every database forever and
 *      relying on `IF NOT EXISTS` to make that harmless.
 *   2. An operator can ask the database what version it is at, and a release can
 *      refuse to promote a build whose migrations have not been applied. Before
 *      this, "did the DDL run" was answerable only by reading boot logs.
 *   3. A migration can be UNDONE, because it says how. See `down` below.
 *
 * ── ADDING A MIGRATION: READ THIS FIRST ──
 *
 * Append to {@link LATER_MIGRATIONS}. Never edit an existing entry's
 * `statements`, and never renumber: a version already recorded as applied will
 * not be re-run, so editing it changes what fresh databases get and leaves every
 * existing one behind, which is the specific failure that makes hand-rolled
 * migration tables worse than no migration table at all.
 *
 * **Every statement must still be idempotent.** That is not the usual migration
 * rule and it is not laziness. AppKit hands this app a `pg.Pool` and a bare
 * `query(text, params)` with no way to hold one connection across calls, so
 * THERE ARE NO TRANSACTIONS available to it — the same constraint that put the
 * run ledger's lease on one row. A migration is therefore a sequence of
 * separately-committed statements followed by a separate `INSERT` into
 * `schema_version`, and any of those can be the last one to succeed. Idempotent
 * statements make the re-run that follows a partial application harmless;
 * non-idempotent ones make it a second failure with a different cause.
 *
 * **Nothing here may drop, rename or rewrite a column or table that holds the
 * customer's history.** The `down` of a migration that adds a column drops that
 * column, which is fine because the column is this migration's own. The `down`
 * of a migration that removes data does not exist, and such a migration does not
 * belong in this file — see the lifecycle work, which is a separate piece with
 * its own retention and export decisions.
 *
 * **`CREATE INDEX` and `ALTER TABLE` check ownership before they check
 * `IF NOT EXISTS`.** Postgres refuses them outright when the app's role does not
 * own the table, even when the statement would change nothing. That is not
 * hypothetical here; it is why `run-ledger-schema.ts` declares every constraint
 * inside its own `CREATE TABLE`. The runner survives it by reading the schema to
 * see whether the end state is already in place, but a new `ALTER` against a
 * table the app may not own is still a statement that will be refused on some
 * deployments, so prefer a new table to an altered old one.
 */

/** One numbered schema version. */
export interface Migration {
  /** Unique, ascending, never renumbered. Recorded in `schema_version`. */
  version: number;
  /**
   * Short, stable, and safe to print. It reaches deploy logs and the
   * `schema_version` table, so it names objects and never people or questions.
   */
  name: string;
  /** Applied in order. Each must be idempotent; see the file header. */
  statements: readonly string[];
  /**
   * Hold one session-level advisory lock while applying this version.
   *
   * Online index builds need this when multiple app replicas can observe the
   * same pending version. It serializes the builders without a transaction,
   * because CREATE INDEX CONCURRENTLY is forbidden inside one.
   */
  lock?: 'session';
  /**
   * How to undo this version, or `null` when it cannot be undone.
   *
   * `null` is a first-class answer and the runner treats it as one: a rollback
   * that reaches a `null` STOPS and says which version blocked it, rather than
   * deleting the `schema_version` row for a migration whose objects are still
   * there. A rollback that silently left the database ahead of the version it
   * claims to be at is the worst outcome available here, because the next
   * deployment would then skip the migration that would have repaired it.
   *
   * Statements run in the order given, which for a `down` means the reverse of
   * whatever `statements` did.
   */
  down: readonly string[] | null;
}

/**
 * The version {@link buildMigrations} assigns to the pre-existing schema.
 *
 * 1 rather than 0 so that "no rows in `schema_version`" and "at version 1" are
 * different states. An empty table means the runner has never completed here,
 * which is a thing an operator needs to be able to see.
 */
export const BASELINE_VERSION = 1;

/** The name recorded for {@link BASELINE_VERSION}. */
export const BASELINE_NAME = 'baseline schema';

/**
 * Versions after the baseline, in ascending order. Append only.
 */
export const LATER_MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    name: 'run correlation id',
    statements: [
      /**
       * The id that joins this run to the app's log, the model span, the Genie
       * and Vector Search calls and the MLflow trace. See
       * `shared/correlation.ts` for why it is a column of its own rather than
       * the primary key: `run_id` is minted by the server, and a caller may not
       * name a row.
       *
       * AN `ALTER`, WHICH THE FILE HEADER SAYS TO PREFER A NEW TABLE OVER. The
       * exception is deliberate and narrow: the value is one field of the run,
       * it has to be readable in the same row as the run's state and outcome for
       * the join to be one query, and a `run_correlations` side table would be an
       * extra write on every ask and an outer join on every read of the ledger.
       * The refusal risk the header warns about does not apply here, because
       * `runs` is created by version 1 as the app, so the app owns it. On a
       * deployment where somebody created it by hand, the runner recognises the
       * refusal, reports it, and leaves the ledger in shadow mode where a missing
       * column warns rather than failing an ask.
       */
      `ALTER TABLE ${APP_SCHEMA}.runs
         ADD COLUMN IF NOT EXISTS correlation_id TEXT`,
      /**
       * The lookup this exists for: an operator holding one id from a reader,
       * from a log line or from a trace, asking which run it was.
       *
       * Partial, because the column is null for every row written before this
       * version and for every caller that sends no id. Indexing those would be
       * indexing the absence of the thing being looked up.
       */
      `CREATE INDEX IF NOT EXISTS runs_correlation_idx
         ON ${APP_SCHEMA}.runs (correlation_id)
         WHERE correlation_id IS NOT NULL`,
    ],
    // Both objects are this migration's own, so undoing it destroys nothing that
    // predates it. Dropped in the reverse of the order they were created, which
    // for an index on a column being dropped is not strictly required and is
    // still the habit worth keeping.
    down: [
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.runs_correlation_idx`,
      `ALTER TABLE ${APP_SCHEMA}.runs DROP COLUMN IF EXISTS correlation_id`,
    ],
  },
  {
    version: 3,
    name: 'admin role column',
    statements: [
      /**
       * Which of the three roles a named person holds, requested in
       * `docs/superadmin-migration-request.md` and carried here rather than in
       * `admin-roles-schema.ts` for the reason that file's own header gives:
       * Postgres checks ownership BEFORE it finds an `ADD COLUMN IF NOT EXISTS`
       * to be a no-op, so a boot-time `ALTER` fails on every deployment where
       * the app's role does not own the table and succeeds only where it was
       * never needed.
       *
       * Values are `super_admin`, `admin`, `consumer`. The default is `admin`
       * because that is what every row already in the table means -- somebody
       * named from inside the app as an administrator of this deployment -- so
       * applying it changes nobody's role. No index: the table is read whole on
       * every role check and holds one row per person.
       *
       * NO REWRITE, so this finishes in milliseconds whatever the row count:
       * Postgres records a non-volatile default in the catalog rather than
       * writing it into every row. It does still take an `ACCESS EXCLUSIVE`
       * lock, and the wait for that lock is charged to `statement_timeout`
       * rather than to the reader holding it up -- which is the failure this
       * runner was built around. All DDL here runs inside `withoutReadTimeout`,
       * so the wait is not being charged to a thirty-second read budget.
       *
       * The app works without it: `readRoster` asks for the column, catches
       * `42703`, re-reads without it and reads every row as `admin`, and a write
       * that would need it is refused with this statement attached rather than
       * attempted. So this is safe to run while serving, safe to run twice, and
       * needs no restart -- nothing caches whether the column exists.
       */
      `ALTER TABLE ${APP_SCHEMA}.admin_emails
         ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'`,
    ],
    /**
     * Undoing this drops the column and with it every role anybody was given,
     * which is the whole of what it added and nothing that predates it. The
     * roster falls back to reading every row as `admin`, so a rollback leaves a
     * working two-role deployment rather than a broken three-role one.
     */
    down: [`ALTER TABLE ${APP_SCHEMA}.admin_emails DROP COLUMN IF EXISTS role`],
  },
  {
    version: 4,
    name: 'declared connections',
    statements: [
      /**
       * The assets this deployment says the agent should consider, added from the
       * Connections tab or published by a notebook.
       *
       * A NEW TABLE RATHER THAN COLUMNS ON `deployment_settings`, which is the
       * preference this file's header states and here it is also a modelling
       * fact: a settings row is one value per known resource, keyed by a
       * registry id that ships in the source. These rows are open ended, are
       * named by whoever adds them, and there are many of them.
       *
       * NOTHING HERE GRANTS ANYTHING. A row means the deployment intends the
       * agent to consider an asset. Whether any particular person may read it is
       * answered by Unity Catalog against that person's own grants, which is why
       * there is no principal column and no permission column: there is nothing
       * true this table could say about either.
       *
       * `state` is what makes removal recoverable. A withdrawal sets it to
       * `withdrawn` and keeps the row, so a demo that loses an asset mid
       * conversation can have it back without anyone retyping a three-part name
       * from memory. Values are `declared` and `withdrawn`.
       */
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.declared_connections (
         id TEXT PRIMARY KEY,
         label TEXT NOT NULL,
         kind TEXT NOT NULL,
         value TEXT NOT NULL,
         note TEXT NOT NULL DEFAULT '',
         state TEXT NOT NULL DEFAULT 'declared',
         origin TEXT NOT NULL DEFAULT 'app',
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         created_by TEXT NOT NULL,
         changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         changed_by TEXT NOT NULL DEFAULT ''
       )`,
      /**
       * The read this table exists for: everything still declared. Partial,
       * because a withdrawn row is only ever fetched by the one screen offering
       * to restore it, and indexing withdrawals would be indexing the absence of
       * the thing being looked up.
       */
      `CREATE INDEX IF NOT EXISTS declared_connections_state_idx
         ON ${APP_SCHEMA}.declared_connections (state)
         WHERE state = 'declared'`,
    ],
    /**
     * Both objects are this migration's own, so undoing it destroys nothing that
     * predates it. It does discard every declaration somebody added, which is
     * why this is the `down` of a version that can be rolled back rather than a
     * statement anything runs routinely: the rows are intent, they are re-addable
     * from the tab that wrote them, and no answer anyone received depends on one.
     */
    down: [
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.declared_connections_state_idx`,
      `DROP TABLE IF EXISTS ${APP_SCHEMA}.declared_connections`,
    ],
  },
  {
    version: 5,
    name: 'egress record and controls',
    statements: [
      /**
       * That an export happened. NEVER WHAT WAS IN IT.
       *
       * ── THE COLUMN LIST IS THE CONSTRAINT, AND IT IS NOT NEGOTIABLE ──
       *
       * There is no payload column, no value column, no content column and no
       * filename column, and none may be added by a later migration. An egress
       * log holding the data it watches is a second copy of that data, in a
       * table read by a different set of people, under a name nobody would think
       * to check. It is the leak this table was built to notice.
       *
       * `item_count` is a COUNT and never a sample. Eleven figures left; which
       * eleven is answered by opening the run, under the reader's own grants,
       * which is what `run_id` and `conversation_id` are for. That indirection
       * is the design: this table grants nothing on its own.
       *
       * NO FOREIGN KEY on `run_id`, deliberately. `${APP_SCHEMA}.runs` is
       * created by a statement a database can legitimately refuse when the app's
       * role does not own the schema, and a constraint against it would make
       * recording an export fail on exactly the deployments where the ledger is
       * already degraded. A pointer that does not resolve is reported as a run
       * that cannot be opened, which is honest; a write that fails loses the
       * only record that anything left.
       *
       * `actor` is the signed-in address, which is the same identifier
       * `conversations.user_email` already holds. Nothing here is a display name
       * this app invented and nothing here is a token.
       */
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.egress_events (
         id TEXT PRIMARY KEY,
         occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         actor TEXT NOT NULL,
         channel TEXT NOT NULL,
         shape TEXT NOT NULL,
         outcome TEXT NOT NULL,
         surface TEXT NOT NULL DEFAULT '',
         run_id TEXT,
         conversation_id TEXT,
         item_count INTEGER
       )`,
      /**
       * The one read this table exists for: what left recently, newest first.
       *
       * Not partial. Every row is a candidate for that read, unlike the two
       * partial indexes above, which index a state a minority of rows are in.
       */
      `CREATE INDEX IF NOT EXISTS egress_events_occurred_idx
         ON ${APP_SCHEMA}.egress_events (occurred_at DESC)`,
      /**
       * Whether each path out is permitted on this deployment.
       *
       * ONE ROW PER PATH, AND THE PATHS THEMSELVES ARE IN SOURCE. See
       * `shared/egress-contract.ts`: the set of ways out of an app is a fact
       * about the build, so a row here is only ever a yes or a no about a path
       * that already exists. A row naming a channel the running build does not
       * know is read back and dropped rather than honoured, because the only
       * thing that could have written it is a newer build.
       *
       * Absent means the default, which is why there is no seeding statement
       * here and no NOT NULL default that would have to agree with the source.
       * Two places declaring the same default is how they come to disagree.
       */
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.egress_controls (
         channel TEXT PRIMARY KEY,
         allowed BOOLEAN NOT NULL,
         changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         changed_by TEXT NOT NULL
       )`,
    ],
    /**
     * Both tables are this migration's own, so undoing it destroys nothing that
     * predates it. It does discard the record of what has left, which is why
     * this is the `down` of a version that CAN be rolled back rather than
     * something to run routinely: the rows are an audit trail, and an audit
     * trail deleted to tidy up a schema is the one kind of row worth being
     * uncomfortable about dropping.
     */
    down: [
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.egress_events_occurred_idx`,
      `DROP TABLE IF EXISTS ${APP_SCHEMA}.egress_events`,
      `DROP TABLE IF EXISTS ${APP_SCHEMA}.egress_controls`,
    ],
  },
  {
    version: 6,
    name: 'model release requests',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.model_release_requests (
         id TEXT PRIMARY KEY,
         status TEXT NOT NULL CHECK (status IN ('approved', 'running', 'succeeded', 'failed')),
         requested_by TEXT NOT NULL,
         requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         declaration JSONB NOT NULL,
         declaration_revision TEXT NOT NULL,
         target TEXT NOT NULL,
         endpoint_name TEXT NOT NULL,
         model_name TEXT NOT NULL,
         v_from TEXT,
         v_to TEXT,
         preflight_at_request JSONB,
         preflight_result JSONB,
         started_at TIMESTAMPTZ,
         completed_at TIMESTAMPTZ,
         execution_id TEXT,
         claimed_by TEXT,
         completed_by TEXT,
         error_summary TEXT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS model_release_requests_requested_idx
         ON ${APP_SCHEMA}.model_release_requests (requested_at DESC)`,
    ],
    down: [
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.model_release_requests_requested_idx`,
      `DROP TABLE IF EXISTS ${APP_SCHEMA}.model_release_requests`,
    ],
  },
  {
    version: 7,
    name: 'runtime settings',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.runtime_settings (
         id TEXT PRIMARY KEY,
         settings JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
    ],
    down: [`DROP TABLE IF EXISTS ${APP_SCHEMA}.runtime_settings`],
  },
  {
    version: 8,
    name: 'app request timings',
    // A numbered migration, not an edit to the recorded baseline. Existing
    // deployments already have version 1, so adding these statements there
    // caused the writer to start without ever creating its destination.
    statements: [REQUEST_LATENCY_DDL, REQUEST_LATENCY_INDEX_DDL],
    down: [
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.request_latencies_recorded_route_idx`,
      `DROP TABLE IF EXISTS ${APP_SCHEMA}.request_latencies`,
    ],
  },
  {
    version: 9,
    name: 'deployment decisions',
    // Four columns holding what this deployment decided about itself, so a
    // Deploy-from-Git — which replaces app.yaml and therefore every value a
    // release filled in — can read the decision back instead of taking the
    // public artifact's placeholder for an answer. See
    // lib/deployment-decisions.ts for why a policy cannot be discovered from
    // Postgres the way the owned schema can.
    statements: [deploymentDecisionsDdl(appTable(DEPLOYMENT_DECISIONS_TABLE_NAME))],
    down: [`DROP TABLE IF EXISTS ${appTable(DEPLOYMENT_DECISIONS_TABLE_NAME)}`],
  },
  {
    version: 10,
    name: 'run label overrides',
    statements: [
      /**
       * Administrator corrections of a run’s outcome and rating after the fact.
       *
       * A NEW TABLE rather than columns on messages or feedback: those already
       * hold the customer’s history, and an ALTER against them is refused when
       * the app’s role does not own the table. The classified outcome stays
       * where it is; this row is only the words an admin chose on the rail.
       */
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.run_label_overrides (
         run_id TEXT PRIMARY KEY,
         status TEXT,
         rating TEXT,
         updated_by TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    ],
    down: [`DROP TABLE IF EXISTS ${APP_SCHEMA}.run_label_overrides`],
  },
  {
    version: 11,
    name: 'benchmark settings',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.benchmark_settings (
         id TEXT PRIMARY KEY,
         settings JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
    ],
    down: [`DROP TABLE IF EXISTS ${APP_SCHEMA}.benchmark_settings`],
  },
  {
    version: 12,
    name: 'evaluation dataset',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.eval_dataset (
         id TEXT PRIMARY KEY,
         rows JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
    ],
    down: [`DROP TABLE IF EXISTS ${APP_SCHEMA}.eval_dataset`],
  },
  {
    version: 13,
    name: 'evaluation flywheel',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.eval_flywheel (
         id TEXT PRIMARY KEY,
         state JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
    ],
    down: [`DROP TABLE IF EXISTS ${APP_SCHEMA}.eval_flywheel`],
  },
  {
    version: 14,
    name: 'live eval scores',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.eval_live_scores (
         id TEXT PRIMARY KEY,
         scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         conversation_id TEXT NOT NULL,
         message_id TEXT NOT NULL,
         score JSONB NOT NULL
       )`,
    ],
    down: [`DROP TABLE IF EXISTS ${APP_SCHEMA}.eval_live_scores`],
  },
  {
    version: 15,
    name: 'benchmark lab v3 state',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.benchmark_lab (
         id TEXT PRIMARY KEY,
         state JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
    ],
    down: [`DROP TABLE IF EXISTS ${APP_SCHEMA}.benchmark_lab`],
  },
  {
    version: 16,
    name: 'cost budgets',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.cost_budgets (
         id TEXT PRIMARY KEY,
         settings JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
    ],
    down: [`DROP TABLE IF EXISTS ${APP_SCHEMA}.cost_budgets`],
  },
  {
    version: 17,
    name: 'service principal personas',
    statements: [
      /**
       * Admin-defined identities the experimental SP-identity pivot may run as.
       *
       * A NEW TABLE rather than JSON on deployment_settings: there are many
       * rows, they are named by administrators, and a settings row is one
       * value per known resource. `secret_scope` and `secret_key` are
       * references into Databricks Secrets. There is no secret-value column
       * and none may be added — a credential in this table would be copied
       * to every replica and would be a leak the public mirror must never
       * see.
       */
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.sp_personas (
         id TEXT PRIMARY KEY,
         display_name TEXT NOT NULL,
         client_id TEXT NOT NULL,
         secret_scope TEXT NOT NULL,
         secret_key TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
      /**
       * One persona per signed-in address. Unassigned people stay on OAuth
       * when the pivot is on, which is why a missing row is a valid state
       * rather than a default persona.
       */
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.sp_assignments (
         email TEXT PRIMARY KEY,
         persona_id TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS sp_assignments_persona_idx
         ON ${APP_SCHEMA}.sp_assignments (persona_id)`,
    ],
    down: [
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.sp_assignments_persona_idx`,
      `DROP TABLE IF EXISTS ${APP_SCHEMA}.sp_assignments`,
      `DROP TABLE IF EXISTS ${APP_SCHEMA}.sp_personas`,
    ],
  },
  {
    version: 18,
    name: 'recorded app activity minutes',
    // Additive by construction: existing customer-history tables are untouched.
    // The composite primary key is declared with the new table, so boot needs no
    // ownership-sensitive ALTER or CREATE INDEX against an existing object.
    statements: [APP_ACTIVITY_DDL],
    down: [`DROP TABLE IF EXISTS ${APP_ACTIVITY_TABLE}`],
  },
  {
    version: 19,
    name: 'service principal persona definitions',
    /**
     * Credential-free plans are separate from executable `sp_personas`.
     * The app cannot administer account service principals with its declared
     * scopes, so these rows describe operator work without placeholder client
     * ids, secret references, or any claim that an external identity exists.
     */
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.sp_persona_definitions (
         id TEXT PRIMARY KEY,
         display_name TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         capabilities JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
    ],
    down: [`DROP TABLE IF EXISTS ${APP_SCHEMA}.sp_persona_definitions`],
  },
  {
    version: 20,
    name: 'structured service principal grants',
    /**
     * Keep the old `capabilities` JSON intact for rolling clients. Existing
     * rows read a null `legacy_capabilities` as "all capabilities are legacy";
     * new writes set both columns explicitly. No customer-entered string is
     * rewritten or discarded by this migration.
     */
    statements: [
      `ALTER TABLE ${APP_SCHEMA}.sp_persona_definitions
         ADD COLUMN IF NOT EXISTS grants JSONB NOT NULL DEFAULT '[]'::jsonb,
         ADD COLUMN IF NOT EXISTS legacy_capabilities JSONB`,
    ],
    down: [
      `ALTER TABLE ${APP_SCHEMA}.sp_persona_definitions DROP COLUMN IF EXISTS legacy_capabilities`,
      `ALTER TABLE ${APP_SCHEMA}.sp_persona_definitions DROP COLUMN IF EXISTS grants`,
    ],
  },
  {
    version: 21,
    name: 'declared connection resource type',
    /**
     * The broad `kind` column cannot distinguish a catalog from a schema or
     * table, or a Vector Search endpoint from an index. Keep legacy rows valid
     * with an empty value; the client renders those with a neutral inferred
     * category rather than inventing provenance or a more specific type.
     */
    statements: [
      `ALTER TABLE ${APP_SCHEMA}.declared_connections
         ADD COLUMN IF NOT EXISTS resource_type TEXT NOT NULL DEFAULT ''`,
    ],
    down: [`ALTER TABLE ${APP_SCHEMA}.declared_connections DROP COLUMN IF EXISTS resource_type`],
  },
  {
    version: 22,
    name: 'app idle sessions',
    /**
     * Browser cookies carry a random opaque identifier. Only its SHA-256 digest
     * is persisted here, alongside the normalized proxy-authenticated subject
     * and deployment that may use it. One browser gets one row; email alone is
     * never a session key.
     */
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SESSION_TABLE} (
         session_hash TEXT PRIMARY KEY,
         subject TEXT NOT NULL,
         deployment_key TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL,
         last_active_at TIMESTAMPTZ NOT NULL,
         idle_expires_at TIMESTAMPTZ NOT NULL,
         absolute_expires_at TIMESTAMPTZ NOT NULL,
         retention_expires_at TIMESTAMPTZ NOT NULL,
         revoked_at TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS app_sessions_retention_idx
         ON ${APP_SESSION_TABLE} (retention_expires_at)`,
      `CREATE INDEX IF NOT EXISTS app_sessions_subject_deployment_idx
         ON ${APP_SESSION_TABLE} (subject, deployment_key)`,
    ],
    down: [
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.app_sessions_subject_deployment_idx`,
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.app_sessions_retention_idx`,
      `DROP TABLE IF EXISTS ${APP_SESSION_TABLE}`,
    ],
  },
  {
    version: 23,
    name: 'daily telemetry rollups',
    /**
     * New app-owned tables rather than changes to raw telemetry. The rollup-day
     * marker is the deletion fence: housekeeping cannot remove a raw row until
     * the transaction that filled both rollup tables committed its day.
     */
    statements: TELEMETRY_ROLLUP_MIGRATION_DDL,
    down: [
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.runs_created_at_idx`,
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.app_activity_minutes_active_idx`,
      `DROP TABLE IF EXISTS ${TELEMETRY_HOUSEKEEPING_STATE_TABLE}`,
      `DROP TABLE IF EXISTS ${TELEMETRY_ROLLUP_DAYS_TABLE}`,
      `DROP TABLE IF EXISTS ${APP_ACTIVITY_ROLLUP_TABLE}`,
      `DROP TABLE IF EXISTS ${REQUEST_LATENCY_ROLLUP_TABLE}`,
    ],
  },
  {
    version: 24,
    name: 'query path indexes',
    lock: 'session',
    /**
     * The three uncovered ordered lookups in application SQL are one owner's
     * conversation rail, one owner's attachments in a conversation, and one
     * owner's latest feedback for a message.
     *
     * `CONCURRENTLY` is valid because this runner deliberately does not wrap
     * migrations in a transaction. Existing reads and writes continue while
     * old rows are indexed. Each create is preceded by an online drop so a
     * cancelled earlier build cannot leave an invalid same-named index that
     * `IF NOT EXISTS` would mistake for success. The session lock and its
     * in-lock version recheck keep a stale replica from dropping the valid
     * indexes another replica just recorded.
     *
     * Runs, Monitoring, and session retention already have matching indexes;
     * adding overlapping prefixes there would only amplify writes.
     */
    statements: [
      `DROP INDEX CONCURRENTLY IF EXISTS ${APP_SCHEMA}.conversations_owner_updated_idx`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_owner_updated_idx
         ON ${APP_SCHEMA}.conversations (user_email, updated_at DESC)`,
      `DROP INDEX CONCURRENTLY IF EXISTS ${APP_SCHEMA}.attachments_conversation_owner_created_idx`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS attachments_conversation_owner_created_idx
         ON ${APP_SCHEMA}.attachments (conversation_id, user_email, created_at)`,
      `DROP INDEX CONCURRENTLY IF EXISTS ${APP_SCHEMA}.feedback_message_owner_created_idx`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS feedback_message_owner_created_idx
         ON ${APP_SCHEMA}.feedback (message_id, user_email, created_at DESC)`,
    ],
    down: [
      `DROP INDEX CONCURRENTLY IF EXISTS ${APP_SCHEMA}.feedback_message_owner_created_idx`,
      `DROP INDEX CONCURRENTLY IF EXISTS ${APP_SCHEMA}.attachments_conversation_owner_created_idx`,
      `DROP INDEX CONCURRENTLY IF EXISTS ${APP_SCHEMA}.conversations_owner_updated_idx`,
    ],
  },
  {
    version: 25,
    name: 'conversation message keyset index',
    lock: 'session',
    statements: [
      `DROP INDEX CONCURRENTLY IF EXISTS ${APP_SCHEMA}.messages_conversation_keyset_idx`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_conversation_keyset_idx
         ON ${APP_SCHEMA}.messages (conversation_id, created_at DESC, id DESC)`,
    ],
    down: [`DROP INDEX CONCURRENTLY IF EXISTS ${APP_SCHEMA}.messages_conversation_keyset_idx`],
  },
  {
    version: 26,
    name: 'recorded run persona',
    /**
     * Snapshots the human-facing persona on the run itself. A later assignment
     * or rename must not rewrite what an earlier question actually ran as.
     * Null is intentional for OAuth runs and all history from before this
     * column existed; those conversations stay in the unfiltered rail without
     * becoming a selectable persona option.
     */
    statements: [
      `ALTER TABLE ${APP_SCHEMA}.runs
         ADD COLUMN IF NOT EXISTS persona_id TEXT,
         ADD COLUMN IF NOT EXISTS persona_name TEXT`,
    ],
    down: [
      `ALTER TABLE ${APP_SCHEMA}.runs DROP COLUMN IF EXISTS persona_name`,
      `ALTER TABLE ${APP_SCHEMA}.runs DROP COLUMN IF EXISTS persona_id`,
    ],
  },
  {
    version: 27,
    name: 'traffic evidence rollups',
    /**
     * Version 23 preserved request latency and active minutes but omitted the
     * outcome causes and named tool calls shown by Traffic. This new table
     * preserves those aggregates without altering or deleting raw history.
     */
    statements: TRAFFIC_ROLLUP_MIGRATION_DDL,
    down: [`DROP TABLE IF EXISTS ${TRAFFIC_DAILY_ROLLUP_TABLE}`],
  },
  {
    version: 28,
    name: 'versioned app settings',
    /**
     * Existing JSON documents keep their values byte-for-byte. Revision 1 means
     * "the row predates conflict protection"; no default or build value is
     * written into either document. Experimental settings start with no row,
     * so first boot reads source defaults without turning startup into a write.
     */
    statements: [
      `ALTER TABLE ${APP_SCHEMA}.runtime_settings
         ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1`,
      `ALTER TABLE ${APP_SCHEMA}.benchmark_settings
         ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1`,
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.experimental_settings (
         id TEXT PRIMARY KEY,
         settings JSONB NOT NULL,
         revision BIGINT NOT NULL DEFAULT 1,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_by TEXT NOT NULL
       )`,
    ],
    down: [
      `DROP TABLE IF EXISTS ${APP_SCHEMA}.experimental_settings`,
      `ALTER TABLE ${APP_SCHEMA}.benchmark_settings DROP COLUMN IF EXISTS revision`,
      `ALTER TABLE ${APP_SCHEMA}.runtime_settings DROP COLUMN IF EXISTS revision`,
    ],
  },
  {
    version: 29,
    name: 'traffic evidence coverage',
    /**
     * Version 27 stored the right population but recognized only the obsolete
     * `kind=tool` shape. Mark every old row as evidence version 1; housekeeping
     * then replays at most 31 bounded complete days per pass and atomically
     * replaces each row from the still-retained durable evidence.
     */
    statements: TRAFFIC_EVIDENCE_V2_MIGRATION_DDL,
    down: [
      `ALTER TABLE ${TRAFFIC_DAILY_ROLLUP_TABLE} DROP COLUMN IF EXISTS evidence_version`,
      `ALTER TABLE ${TRAFFIC_DAILY_ROLLUP_TABLE} DROP COLUMN IF EXISTS tool_covered_count`,
      `ALTER TABLE ${TRAFFIC_DAILY_ROLLUP_TABLE} DROP COLUMN IF EXISTS outcome_covered_count`,
    ],
  },
  {
    version: 30,
    name: 'app budget approvals',
    /**
     * One durable, bounded approval per UTC month and exact app-budget
     * fingerprint. Changing either budget slot changes the fingerprint, and a
     * new month changes the period, so neither can inherit an old approval.
     */
    statements: [
      `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.app_budget_approvals (
         id TEXT PRIMARY KEY,
         period_start DATE NOT NULL,
         period_end DATE NOT NULL,
         budget_fingerprint TEXT NOT NULL,
         budget_unit TEXT NOT NULL CHECK (budget_unit IN ('USD', 'DBU')),
         budget_value NUMERIC NOT NULL,
         measured_amount NUMERIC NOT NULL,
         coverage JSONB NOT NULL,
         approved_by TEXT NOT NULL,
         approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         revoked_by TEXT,
         revoked_at TIMESTAMPTZ,
         UNIQUE (period_start, budget_fingerprint, budget_unit, budget_value)
       )`,
      `CREATE INDEX IF NOT EXISTS app_budget_approvals_current_idx
         ON ${APP_SCHEMA}.app_budget_approvals
         (period_start, budget_fingerprint, budget_unit, budget_value)
         WHERE revoked_at IS NULL`,
    ],
    down: [
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.app_budget_approvals_current_idx`,
      `DROP TABLE IF EXISTS ${APP_SCHEMA}.app_budget_approvals`,
    ],
  },
  {
    version: 31,
    name: 'daily user spend read model',
    /**
     * Two new app-owned serving tables. Existing conversation, run, billing,
     * and telemetry history stays untouched. The composite primary key makes a
     * trailing late-data replay an idempotent correction rather than a duplicate.
     */
    statements: USER_SPEND_READ_MODEL_DDL,
    down: [
      `DROP TABLE IF EXISTS ${USER_SPEND_REFRESH_TABLE}`,
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.user_spend_daily_date_scope_idx`,
      `DROP TABLE IF EXISTS ${USER_SPEND_DAILY_TABLE}`,
    ],
  },
  {
    version: 32,
    name: 'hourly user spend read model',
    /**
     * A short-lived, content-free UTC-hour projection serves the rolling 24-hour
     * filter without presenting one calendar day as a rolling window. It derives
     * exact activity timing from Lakebase and allocates the finest durable daily
     * billing basis; the quality remains partial/estimated on the wire.
     */
    statements: USER_SPEND_HOURLY_READ_MODEL_DDL,
    down: [
      `DROP TABLE IF EXISTS ${USER_SPEND_HOURLY_REFRESH_TABLE}`,
      `DROP INDEX IF EXISTS ${APP_SCHEMA}.user_spend_hourly_hour_scope_idx`,
      `DROP TABLE IF EXISTS ${USER_SPEND_HOURLY_TABLE}`,
    ],
  },
  {
    version: 33,
    name: 'canonical feedback sentiment',
    /**
     * Preserve every historical usefulness value for audit compatibility while
     * filling only the direction it unambiguously represented. Neutral 3 and
     * unknown values remain null. The predicate makes a partial retry harmless
     * and never overwrites an explicit sentiment.
     */
    statements: [
      `UPDATE ${APP_SCHEMA}.feedback
          SET sentiment = CASE
            WHEN usefulness BETWEEN 4 AND 5 THEN 'up'
            WHEN usefulness BETWEEN 1 AND 2 THEN 'down'
            ELSE NULL
          END
        WHERE sentiment IS NULL
          AND (usefulness BETWEEN 4 AND 5 OR usefulness BETWEEN 1 AND 2)`,
    ],
    // The original usefulness values remain intact. Clearing derived sentiment
    // later could also clear an explicit value written by a mixed-version app,
    // so this safe backfill is intentionally not reversible.
    down: null,
  },
  {
    version: 34,
    name: 'user spend token coverage',
    statements: [
      `ALTER TABLE ${USER_SPEND_DAILY_TABLE} ADD COLUMN IF NOT EXISTS token_covered_runs INTEGER`,
      `ALTER TABLE ${USER_SPEND_DAILY_TABLE} ADD COLUMN IF NOT EXISTS token_covered_questions INTEGER`,
      `ALTER TABLE ${USER_SPEND_HOURLY_TABLE} ADD COLUMN IF NOT EXISTS token_covered_runs INTEGER`,
      `ALTER TABLE ${USER_SPEND_HOURLY_TABLE} ADD COLUMN IF NOT EXISTS token_covered_questions INTEGER`,
    ],
    down: [
      `ALTER TABLE ${USER_SPEND_HOURLY_TABLE} DROP COLUMN IF EXISTS token_covered_questions`,
      `ALTER TABLE ${USER_SPEND_HOURLY_TABLE} DROP COLUMN IF EXISTS token_covered_runs`,
      `ALTER TABLE ${USER_SPEND_DAILY_TABLE} DROP COLUMN IF EXISTS token_covered_questions`,
      `ALTER TABLE ${USER_SPEND_DAILY_TABLE} DROP COLUMN IF EXISTS token_covered_runs`,
    ],
  },
];

/**
 * The full ordered list: the baseline, then everything after it.
 *
 * The baseline's statements are passed in rather than declared here, and the
 * reason is not style. `bundle/preflight.sh`, `scripts/grant-app-db-access.mjs`
 * and `scripts/check-db-ownership.mjs` all learn the app's schema name by
 * parsing `CREATE SCHEMA IF NOT EXISTS <name>` out of
 * `server/routes/insights-routes.ts`. Moving that text into this file would
 * leave three checks — one of them in the release path — silently finding
 * nothing and falling back to a guess. So the DDL text stays where they look for
 * it, and this file owns the numbering, the ordering and the undo.
 */
export function buildMigrations(baselineStatements: readonly string[]): readonly Migration[] {
  return [
    {
      version: BASELINE_VERSION,
      name: BASELINE_NAME,
      statements: baselineStatements,
      // Not `DROP SCHEMA ... CASCADE`. The baseline is the only version whose
      // objects hold conversations, runs and feedback that predate the runner,
      // so its undo would be a data-loss statement dressed as a rollback. A
      // release that needs to go back past version 1 is restoring a database,
      // not rolling back a migration, and those are different operations with
      // different approvals.
      down: null,
    },
    ...LATER_MIGRATIONS,
  ];
}

/**
 * Why this list could not be trusted, or `null` when it can.
 *
 * Checked by a test rather than at boot, because a duplicate or descending
 * version number is a mistake in the source and not a state a running
 * deployment can get into. Catching it in the suite is what stops it reaching a
 * database, where "applied version 3" would become ambiguous.
 */
export function migrationRegistryFault(migrations: readonly Migration[]): string | null {
  if (migrations.length === 0) return 'There are no migrations at all, so nothing would create the schema.';
  const seen = new Set<number>();
  let previous = -Infinity;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      return `Version ${String(migration.version)} ("${migration.name}") is not a positive whole number.`;
    }
    if (seen.has(migration.version)) {
      return `Version ${migration.version} appears twice. A recorded version cannot mean two different things.`;
    }
    if (migration.version <= previous) {
      return `Version ${migration.version} ("${migration.name}") comes after ${previous}. Migrations must ascend.`;
    }
    if (migration.statements.length === 0) {
      return `Version ${migration.version} ("${migration.name}") has no statements, so applying it would record a change nobody made.`;
    }
    if (!migration.name.trim()) {
      return `Version ${migration.version} has no name, and the name is what reaches the deploy log.`;
    }
    seen.add(migration.version);
    previous = migration.version;
  }
  return null;
}
