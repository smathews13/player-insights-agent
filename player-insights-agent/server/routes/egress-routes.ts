/**
 * The API for watching and restricting what leaves this app.
 *
 * ── FOUR ROUTES, AND THE SPLIT BETWEEN THEM IS THE PERMISSION MODEL ──
 *
 * Two are open to any signed-in reader and two are administrators only, and the
 * split is not a convenience:
 *
 *   GET  /api/egress/controls        Any signed-in reader. WHAT IS PERMITTED.
 *   POST /api/egress/events         Any signed-in reader. RECORD MY OWN EXPORT.
 *   PUT  /api/egress/admin/controls Administrators. CHANGE WHAT IS PERMITTED.
 *   GET  /api/egress/admin/classification Administrators. WHAT THE CATALOG SAYS.
 *
 * The open pair has to be open. A consumer's browser is where the affordances
 * are, so it is the only party that can say an export happened, and a recorder
 * behind the admin guard would record nothing at all -- silently, and while
 * looking exactly like a working feature. The open pair is therefore narrow by
 * construction: the read carries no events and no identities, only which paths
 * this deployment permits, and the write can only ever record the CALLER'S OWN
 * action against the caller's own address, which the server takes from the
 * request rather than from the body.
 *
 * The admin pair is under `/api/egress/admin`, which is one prefix in
 * `ADMIN_ROUTE_PREFIXES`. A route added under it later inherits the refusal
 * without anybody remembering to wrap it, which is the whole reason this app
 * guards by prefix. {@link setupEgressRoutes} registers NOTHING if the prefix
 * does not cover them.
 *
 * ── NOTHING HERE WIDENS ANY READ ──
 *
 * The classification route asks Unity Catalog about the deployment's own declared
 * tables under THE CALLER'S OWN FORWARDED TOKEN. No route in this file reads a
 * governed row, none holds the app's service principal, and none accepts a table
 * name from a caller: an endpoint that classified whatever it was handed would be
 * a way to walk somebody else's catalog through this app, which is the opposite
 * of what the capability is for.
 *
 * ── AND NOTHING HERE STORES A PAYLOAD ──
 *
 * See `server/lib/egress-store.ts` and the migration. The body this route accepts
 * has no field through which the contents of an export could arrive, and adding
 * one would require changing the schema, the contract and the store.
 */

import { z } from 'zod';
import type { Application, Request, Response } from 'express';
import {
  controllablePaths,
  EGRESS_PATHS,
  isEgressChannel,
  type EgressClassificationPayload,
  type EgressControlsPayload,
} from '../../shared/egress-contract';
import {
  readEgressControls,
  recordEgress,
  writeEgressControl,
} from '../lib/egress-store';
import { classifyTables, NO_TOKEN_REASON, NO_WAREHOUSE_REASON } from '../lib/egress-classification';
import { accessRunner, type SqlRunner } from '../lib/admin-access';
import { accessDependenciesFrom, forwardedUserToken } from './access-verification';
import { userEmail, type InsightsAppKit } from './insights-routes';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';

/** The paths that must be behind the admin guard, checked at registration. */
export const EGRESS_ADMIN_ROUTES: readonly string[] = [
  '/api/egress/admin/controls',
  '/api/egress/admin/classification',
];

/**
 * The paths that must NOT be behind it, checked at registration for the reason
 * in the file header.
 *
 * A future edit that adds `/api/egress` to `ADMIN_ROUTE_PREFIXES` looks like
 * tightening a permission and is the one change that would turn the whole
 * capability off: consumers would be refused when they tried to record, so the
 * only exports still recorded would be administrators' own. The panel would keep
 * working and keep looking right. So the mistake is refused loudly here rather
 * than discovered from a log that is quietly one person wide.
 */
export const EGRESS_OPEN_ROUTES: readonly string[] = ['/api/egress/controls', '/api/egress/events'];

export interface EgressDeps {
  isAdminRoute: (path: string) => boolean;
  /** Injected so a test can assert against a runner rather than the network. */
  runnerFor?: (req: Request) => { run: SqlRunner | null; unavailable: string };
  now?: () => number;
}

/**
 * A statement runner under the signed-in reader's own token, or the reason none.
 *
 * THE FALLBACK TO THE APP'S OWN CREDENTIAL DOES NOT EXIST HERE, and its absence
 * is the point. Three service-principal read paths in this app were deliberately
 * closed. A capability whose job is to observe and restrict must not be the
 * fourth, so a session with no forwarded token is told the catalog was not asked.
 */
function readerRunner(req: Request): { run: SqlRunner | null; unavailable: string } {
  const host = normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
  const warehouseId = (process.env.DATABRICKS_SQL_WAREHOUSE_ID ?? '').trim();
  const token = forwardedUserToken(req);
  if (!host || !warehouseId) return { run: null, unavailable: NO_WAREHOUSE_REASON };
  if (!token) return { run: null, unavailable: NO_TOKEN_REASON };
  return { run: accessRunner({ host, token, warehouseId }), unavailable: '' };
}

/**
 * The body of a report.
 *
 * `channel` and `surface` and three optionals, and that is deliberately the whole
 * of it. There is no field for what was exported. `.strict()` so a client that
 * sends one is refused rather than silently having it dropped: a dropped field is
 * a client that believes it recorded something it did not, and the next person to
 * add the column would find callers already sending it.
 */
const ReportBody = z
  .object({
    channel: z.string().trim().max(64),
    surface: z.string().trim().max(64).default(''),
    runId: z.string().trim().max(128).nullish(),
    conversationId: z.string().trim().max(128).nullish(),
    itemCount: z.number().finite().nullish(),
  })
  .strict();

const ControlBody = z
  .object({
    channel: z.string().trim().max(64),
    allowed: z.boolean(),
  })
  .strict();

export function setupEgressRoutes(appkit: InsightsAppKit, deps: EgressDeps) {
  if (typeof deps?.isAdminRoute !== 'function') {
    console.error(
      '[egress] NOT REGISTERED: no admin-route predicate was supplied, so there is no way to confirm the ' +
        'admin paths are guarded. They serve what every person has exported. Pass isAdminRoute.'
    );
    return;
  }
  const uncovered = EGRESS_ADMIN_ROUTES.filter((path) => !deps.isAdminRoute(path));
  if (uncovered.length > 0) {
    console.error(
      `[egress] NOT REGISTERED: the admin guard does not cover ${uncovered.join(', ')}. Add ` +
        "'/api/egress/admin' to ADMIN_ROUTE_PREFIXES in lib/admin-roles.ts. Registering these unguarded " +
        'would serve the record of what everyone has exported to any signed-in reader.'
    );
    return;
  }
  const guarded = EGRESS_OPEN_ROUTES.filter((path) => deps.isAdminRoute(path));
  if (guarded.length > 0) {
    console.error(
      `[egress] NOT REGISTERED: the admin guard covers ${guarded.join(', ')}, which have to stay open to ` +
        'every signed-in reader. A consumer refused on those cannot report an export, so the record would ' +
        'quietly narrow to administrators only while continuing to look complete.'
    );
    return;
  }
  const runnerFor = deps.runnerFor ?? readerRunner;
  const clock = deps.now ?? Date.now;

  appkit.server.extend((app: Application) => {
    /**
     * What this deployment permits, and what the build can do about each path.
     *
     * Open to every signed-in reader, because it is what their own copy buttons
     * and chart controls are drawn from. It carries no events, no addresses and
     * no counts: the answer to "may I copy this" is not information about anybody.
     *
     * The path registry travels with it rather than being a second copy in the
     * client bundle. A browser running an older build would otherwise draw a
     * switch for a path the server has reclassified, or miss one it has added.
     */
    app.get('/api/egress/controls', async (_req: Request, res: Response) => {
      const reading = await readEgressControls(appkit);
      res.json({
        controls: reading.controls,
        stored: reading.stored,
        paths: EGRESS_PATHS,
      } satisfies EgressControlsPayload);
    });

    /**
     * Record that the caller exported something, or tried to.
     *
     * ── THE ACTOR IS TAKEN FROM THE REQUEST AND NEVER FROM THE BODY ──
     *
     * A body field for who did it would make this endpoint a way to write rows
     * against somebody else's name into the app's own audit record, which is a
     * worse defect than the one the record was built to notice.
     *
     * 202 rather than 200 or 201. The export has already happened or already been
     * refused in the browser by the time this arrives: this route accepts an
     * account of it. Answering 201 would say a resource was created, which is not
     * reliably true -- the write is best effort and `recorded` says whether it
     * landed.
     */
    app.post('/api/egress/events', async (req: Request, res: Response) => {
      const parsed = ReportBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_egress_report',
          detail: 'Send one known channel and a surface. Nothing about what was exported is accepted here.',
        });
        return;
      }
      if (!isEgressChannel(parsed.data.channel)) {
        res.status(400).json({
          error: 'unknown_egress_channel',
          detail: 'That is not a path this app knows about.',
        });
        return;
      }
      const { controls } = await readEgressControls(appkit);
      const recorded = await recordEgress(appkit, {
        actor: userEmail(req),
        report: {
          channel: parsed.data.channel,
          surface: parsed.data.surface,
          runId: parsed.data.runId ?? null,
          conversationId: parsed.data.conversationId ?? null,
          itemCount: parsed.data.itemCount ?? null,
        },
        controls,
        now: new Date(clock()),
      });
      res.status(202).json({
        outcome: recorded.event.outcome,
        recorded: recorded.written,
      });
    });

    /**
     * Move one switch. Administrators only.
     *
     * One path per request rather than the whole set. A single switch is what an
     * administrator actually moves, and a whole-set write turns a stale panel into
     * a silent revert of somebody else's change.
     */
    app.put('/api/egress/admin/controls', async (req: Request, res: Response) => {
      const parsed = ControlBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_egress_control',
          detail: 'Send one channel and whether it is allowed.',
        });
        return;
      }
      let outcome: Awaited<ReturnType<typeof writeEgressControl>>;
      try {
        outcome = await writeEgressControl(appkit, {
          channel: parsed.data.channel,
          allowed: parsed.data.allowed,
          actor: userEmail(req),
        });
      } catch (error) {
        console.error(`[egress] A control could not be saved: ${(error as Error).message}`);
        res.status(503).json({
          error: 'egress_store_unavailable',
          detail:
            'The control was not saved. Reporting success here would leave a switch on screen that no ' +
            'reload would keep.',
        });
        return;
      }
      if ('refusal' in outcome) {
        // 409 rather than 400. The request was well formed; what cannot be done
        // is the thing asked for, which is the distinction the admin routes draw.
        res.status(409).json({ error: 'egress_control_refused', detail: outcome.refusal });
        return;
      }
      const reading = await readEgressControls(appkit, { maxAgeMs: 0 });
      res.json({
        controls: reading.controls,
        stored: reading.stored,
        paths: EGRESS_PATHS,
      } satisfies EgressControlsPayload);
    });

    /**
     * What the catalog says about the tables this deployment reads.
     * Administrators only.
     *
     * ── THE TABLE LIST IS THE DEPLOYMENT'S, NOT THE CALLER'S ──
     *
     * Taken from the declared manifest, through the same resolver the access gate
     * uses. A caller cannot name a table: an endpoint that classified whatever it
     * was handed would be a catalog walker wearing an audit panel's clothes, and
     * it would be one whichever credential it ran under.
     *
     * The reads run as the CALLER. So an administrator without privileges on a
     * table's tags is told the tags could not be read, rather than being shown
     * tags they hold no grant for. See `egress-classification.ts`.
     */
    app.get('/api/egress/admin/classification', async (req: Request, res: Response) => {
      const tables = accessDependenciesFrom({ env: process.env }).tables;
      const { run, unavailable } = runnerFor(req);
      const { classifications, blocked } = await classifyTables(run, tables, { unavailable });
      res.json({
        tables: classifications,
        blocked,
        readAt: new Date(clock()).toISOString(),
      } satisfies EgressClassificationPayload);
    });
  });
}

/** Exported for the panel's own tests, so the two cannot disagree about the set. */
export { controllablePaths };
