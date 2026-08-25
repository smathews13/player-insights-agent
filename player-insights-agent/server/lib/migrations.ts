import { APP_SCHEMA, appTable } from '../../shared/app-schema';
import { DEPLOYMENT_DECISIONS_TABLE_NAME, deploymentDecisionsDdl } from './deployment-decisions';
import { REQUEST_LATENCY_DDL, REQUEST_LATENCY_INDEX_DDL } from './request-latency';
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
