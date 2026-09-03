import type { Request } from 'express';

import { APP_SCHEMA } from '../../shared/app-schema';
import type { LakebaseMigrationReadiness } from '../../shared/lakebase-migrations';
import { recordAdminAction, requireAdmin } from '../lib/admin-roles';
import { runMigrations, type MigrationOutcome } from '../lib/migration-runner';
import type { Migration } from '../lib/migrations';
import { schemaOwnershipQuery, schemaWriteRefusal } from '../lib/schema-ownership-guard';
import { runUserSpendReadModelRefresh } from '../lib/user-spend-read-model';
import { createUserSpendRefreshSource } from '../lib/user-spend-refresh-source';
import { userEmail, type InsightsAppKit } from './insights-routes';

export const MIGRATION_READINESS_CACHE_MS = 5_000;
export const MIGRATION_READINESS_TIMEOUT_MS = 15_000;

type Lakebase = InsightsAppKit['lakebase'];
type ReadinessStatus = 'ready' | 'blocked' | 'unavailable';

interface MigrationRouteDependencies {
  schema?: string;
  migrations: readonly Migration[];
  storeReady: Promise<void>;
  run?: typeof runMigrations;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
  audit?: typeof recordAdminAction;
  warmUserSpend?: (req: Request) => Promise<void>;
}

class TimedOut extends Error {}
class Cancelled extends Error {}

function safeName(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim()
    .slice(0, 120);
}

function requestSignal(req: Request): AbortSignal {
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  return controller.signal;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Cancelled();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new TimedOut()), timeoutMs);
    timeout.unref?.();
  });
  const cancellation = signal
    ? new Promise<never>((_, reject) => {
        abort = () => reject(new Cancelled());
        signal.addEventListener('abort', abort, { once: true });
      })
    : new Promise<never>(() => undefined);
  try {
    return await Promise.race([promise, deadline, cancellation]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abort) signal.removeEventListener('abort', abort);
  }
}

function targetVersion(migrations: readonly Migration[]): number {
  return Math.max(0, ...migrations.map((migration) => migration.version));
}

function unavailable(
  schema: string,
  target: number,
  checkedAt: string,
  appliedCount?: number
): LakebaseMigrationReadiness {
  return {
    schema,
    currentVersion: null,
    targetVersion: target,
    pendingCount: 0,
    pending: [],
    status: 'unavailable',
    canApply: false,
    checkedAt,
    detail: 'Lakebase could not be reached from the app service principal.',
    action: 'Check the app Lakebase resource, then retry.',
    ...(appliedCount === undefined ? {} : { appliedCount }),
  };
}

function readinessContract(input: {
  schema: string;
  migrations: readonly Migration[];
  outcome: MigrationOutcome;
  ownership: ReadinessStatus;
  checkedAt: string;
  appliedCount?: number;
  applyFailed?: boolean;
}): LakebaseMigrationReadiness {
  const byVersion = new Map(input.migrations.map((migration) => [migration.version, migration]));
  const pending = input.outcome.pending
    .map((version) => {
      const migration = byVersion.get(version);
      return migration ? { version, name: safeName(migration.name) } : null;
    })
    .filter((migration): migration is { version: number; name: string } => migration !== null);
  const common = {
    schema: input.schema,
    currentVersion: input.outcome.versionAfter,
    targetVersion: targetVersion(input.migrations),
    pendingCount: pending.length,
    pending,
    checkedAt: input.checkedAt,
    ...(input.appliedCount === undefined ? {} : { appliedCount: input.appliedCount }),
  };

  if (input.outcome.ahead.length > 0) {
    return {
      ...common,
      status: 'ahead',
      canApply: false,
      detail: 'This Lakebase schema is newer than the running app build.',
      action: 'Deploy the latest app source before changing Lakebase.',
    };
  }
  if (input.outcome.blocked) {
    return {
      ...common,
      status: 'blocked',
      canApply: false,
      detail: 'The running build cannot safely use its migration registry.',
      action: 'Deploy a current app build, then check again.',
    };
  }
  if (input.applyFailed) {
    return {
      ...common,
      status: 'blocked',
      canApply: input.ownership === 'ready' && pending.length > 0,
      detail: 'Lakebase stopped at the first update it could not complete. Existing data was preserved.',
      action:
        input.ownership === 'ready'
          ? 'Retry the update. If it fails again, check Lakebase availability.'
          : 'Restore app service principal ownership of the schema, then retry.',
    };
  }
  if (input.ownership === 'unavailable') {
    return unavailable(input.schema, common.targetVersion, input.checkedAt, input.appliedCount);
  }
  if (pending.length > 0 && input.ownership === 'blocked') {
    return {
      ...common,
      status: 'blocked',
      canApply: false,
      detail: 'The app service principal does not own the Lakebase schema, so no update was attempted.',
      action: 'Restore the app-owned schema before retrying. The app cannot switch Postgres identities.',
    };
  }
  if (pending.length > 0) {
    return {
      ...common,
      status: 'update_required',
      canApply: true,
      detail: 'User spend tables and other app storage updates are pending.',
      action: 'Update Lakebase from this app.',
    };
  }
  return {
    ...common,
    status: 'up_to_date',
    canApply: false,
    detail: `Schema v${common.targetVersion}.`,
    action: '',
  };
}

async function writeReadiness(lakebase: Lakebase, schema: string): Promise<ReadinessStatus> {
  try {
    const result = await lakebase.query(schemaOwnershipQuery(), [schema]);
    const row = result.rows[0];
    if (!row) return 'unavailable';
    const refusal = schemaWriteRefusal(schema, {
      schemaExists: row.schema_exists === true,
      owner: typeof row.owner === 'string' ? row.owner : '',
      connectedRole: typeof row.connected_role === 'string' ? row.connected_role : '',
      connectedRoleHoldsOwner: row.connected_role_holds_owner === true,
    });
    return refusal ? 'blocked' : 'ready';
  } catch {
    return 'unavailable';
  }
}

/**
 * Coordinates boot, short-lived verification caching, and one apply flight.
 *
 * Verification reads may be abandoned after their deadline. Apply is different:
 * a timed-out browser request does not cancel committed DDL, and the process
 * single-flight remains held until the runner finishes so a retry joins it.
 */
export class LakebaseMigrationReadinessService {
  private readonly schema: string;
  private readonly run: typeof runMigrations;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly audit: typeof recordAdminAction;
  private cache: { value: LakebaseMigrationReadiness; expiresAt: number; generation: number } | null = null;
  private verifyFlight: Promise<LakebaseMigrationReadiness> | null = null;
  private applyFlight: Promise<LakebaseMigrationReadiness> | null = null;
  private generation = 0;

  constructor(
    private readonly lakebase: Lakebase,
    private readonly dependencies: MigrationRouteDependencies
  ) {
    this.schema = dependencies.schema ?? APP_SCHEMA;
    this.run = dependencies.run ?? runMigrations;
    this.now = dependencies.now ?? Date.now;
    this.cacheMs = dependencies.cacheMs ?? MIGRATION_READINESS_CACHE_MS;
    this.timeoutMs = dependencies.timeoutMs ?? MIGRATION_READINESS_TIMEOUT_MS;
    this.audit = dependencies.audit ?? recordAdminAction;
  }

  private checkedAt(): string {
    return new Date(this.now()).toISOString();
  }

  private async waitForBoot(): Promise<boolean> {
    try {
      await bounded(this.dependencies.storeReady, this.timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  private async compute(): Promise<LakebaseMigrationReadiness> {
    if (!(await this.waitForBoot())) {
      return unavailable(this.schema, targetVersion(this.dependencies.migrations), this.checkedAt());
    }
    try {
      // A successful connection read distinguishes a fresh schema, whose version
      // table is legitimately absent, from an unavailable pool. runMigrations
      // intentionally treats both version reads as unknown so apply can recover.
      await this.lakebase.query('SELECT 1 AS lakebase_migration_readiness');
      const outcome = await this.run(
        { lakebase: this.lakebase },
        {
          schema: this.schema,
          migrations: this.dependencies.migrations,
          mode: 'verify',
          appliedBy: 'migration readiness check',
        }
      );
      const ownership = outcome.pending.length > 0 ? await writeReadiness(this.lakebase, this.schema) : 'ready';
      return readinessContract({
        schema: this.schema,
        migrations: this.dependencies.migrations,
        outcome,
        ownership,
        checkedAt: this.checkedAt(),
      });
    } catch {
      return unavailable(this.schema, targetVersion(this.dependencies.migrations), this.checkedAt());
    }
  }

  private startVerify(): Promise<LakebaseMigrationReadiness> {
    if (this.verifyFlight) return this.verifyFlight;
    const generation = this.generation;
    const operation = bounded(this.compute(), this.timeoutMs).catch(() =>
      unavailable(this.schema, targetVersion(this.dependencies.migrations), this.checkedAt())
    );
    const flight = operation
      .then((value) => {
        if (this.generation === generation) {
          this.cache = { value, expiresAt: this.now() + this.cacheMs, generation };
        }
        return value;
      })
      .finally(() => {
        this.verifyFlight = null;
      });
    this.verifyFlight = flight;
    return flight;
  }

  async read(signal?: AbortSignal): Promise<LakebaseMigrationReadiness> {
    const cached = this.cache;
    if (cached && cached.generation === this.generation && cached.expiresAt > this.now()) return cached.value;
    try {
      return await bounded(this.startVerify(), this.timeoutMs, signal);
    } catch {
      return unavailable(this.schema, targetVersion(this.dependencies.migrations), this.checkedAt());
    }
  }

  async apply(actor: string, signal?: AbortSignal): Promise<LakebaseMigrationReadiness> {
    if (!this.applyFlight) {
      this.generation += 1;
      const generation = this.generation;
      this.cache = null;
      const operation = this.applyOnce(actor).then((value) => {
        if (this.generation === generation) {
          this.cache = { value, expiresAt: this.now() + this.cacheMs, generation };
        }
        return value;
      });
      const flight = operation.finally(() => {
        this.applyFlight = null;
      });
      this.applyFlight = flight;
    }
    try {
      return await bounded(this.applyFlight, this.timeoutMs, signal);
    } catch {
      return unavailable(this.schema, targetVersion(this.dependencies.migrations), this.checkedAt(), 0);
    }
  }

  private async applyOnce(actor: string): Promise<LakebaseMigrationReadiness> {
    const before = await bounded(this.compute(), this.timeoutMs).catch(() =>
      unavailable(this.schema, targetVersion(this.dependencies.migrations), this.checkedAt())
    );
    if (before.status !== 'update_required' || !before.canApply) return { ...before, appliedCount: 0 };

    let outcome: MigrationOutcome;
    try {
      outcome = await this.run(
        { lakebase: this.lakebase },
        {
          schema: this.schema,
          migrations: this.dependencies.migrations,
          mode: 'apply',
          appliedBy: actor,
        }
      );
    } catch {
      return {
        ...before,
        status: 'blocked',
        canApply: true,
        checkedAt: this.checkedAt(),
        detail: 'Lakebase stopped before it could complete the update. Existing data was preserved.',
        action: 'Retry the update. If it fails again, check Lakebase availability.',
        appliedCount: 0,
      };
    }

    const ownership = await writeReadiness(this.lakebase, this.schema);
    const afterVerify = await this.run(
      { lakebase: this.lakebase },
      {
        schema: this.schema,
        migrations: this.dependencies.migrations,
        mode: 'verify',
        appliedBy: 'migration readiness check',
      }
    );
    const appliedCount = Math.max(0, before.pendingCount - afterVerify.pending.length);
    const value = readinessContract({
      schema: this.schema,
      migrations: this.dependencies.migrations,
      outcome: afterVerify,
      ownership,
      checkedAt: this.checkedAt(),
      appliedCount,
      applyFailed: !outcome.ok,
    });

    console.log(
      JSON.stringify({
        event: 'lakebase_migrations_apply',
        actor,
        schema: this.schema,
        versionBefore: outcome.versionBefore,
        versionAfter: outcome.versionAfter,
        appliedCount,
        status: value.status,
        checkedAt: value.checkedAt,
      })
    );
    if (appliedCount > 0) {
      await this.audit(this.lakebase, {
        actor,
        action: 'lakebase-migrations-applied',
        subject: this.schema,
        detail: `Applied ${appliedCount} Lakebase schema version(s); schema is now at v${String(
          value.currentVersion ?? 'unknown'
        )}.`,
      });
    }
    return value;
  }
}

export function setupLakebaseMigrationRoutes(
  appkit: InsightsAppKit,
  dependencies: MigrationRouteDependencies
): LakebaseMigrationReadinessService {
  const service = new LakebaseMigrationReadinessService(appkit.lakebase, dependencies);
  const admin = requireAdmin(appkit.lakebase, userEmail);
  const warmUserSpend =
    dependencies.warmUserSpend ??
    (async (req: Request) => {
      const source = createUserSpendRefreshSource(appkit, req);
      if (!source) return;
      await runUserSpendReadModelRefresh(appkit.lakebase, source);
    });
  appkit.server.extend((app) => {
    app.get('/api/admin/lakebase/migrations', admin, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.read(requestSignal(req)));
    });
    app.post('/api/admin/lakebase/migrations/apply', admin, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const value = await service.apply(userEmail(req), requestSignal(req));
      if (value.status === 'up_to_date' && (value.appliedCount ?? 0) > 0) {
        // Start the first durable projection before returning. The refresh owns
        // its own process single-flight and database lock; the first Monitoring
        // read joins it and waits, while this migration response stays bounded.
        void warmUserSpend(req).catch((error: Error) => {
          console.warn(`[user-spend-read-model] post-migration warmup failed (${error.name}); first read will retry.`);
        });
      }
      res.json(value);
    });
  });
  return service;
}
