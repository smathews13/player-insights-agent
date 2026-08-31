/**
 * The admin list, read and edited from the Settings gear.
 *
 * One endpoint family, `/api/admins`, and it is admin-only through the prefix
 * list in admin-roles.ts rather than through a guard written here. Nothing in
 * this file checks a role: the middleware has already refused a consumer with
 * 403 by the time a handler runs, and a second check here would be a second
 * place for the answer to be wrong.
 *
 * ADDING AN ADMIN IS ONE ACTION: A ROW IN LAKEBASE. It used to be two, because the
 * add also granted Unity Catalog read on the telemetry schema and the
 * `system.billing` tables, which is what the Ops tab reads. That is gone. Granting
 * on `system` needs an account admin who is also a metastore admin, so the ordinary
 * outcome was PERMISSION_DENIED on a catalog the operator has no authority over,
 * printed beside the name of the colleague they had just appointed. It made a
 * working action look broken and made a system table a prerequisite for a role that
 * never needed one.
 *
 * So no route here grants anything. A removal still hands back what earlier
 * versions of this app granted, best effort, under the acting admin's own token;
 * see admin-access.ts. That never refuses the removal.
 *
 * WHAT THE ROLE GRANTS is no data at all. It opens tabs. A question runs under the
 * asker's own Unity Catalog grants, and somebody who needs to read billing gets
 * that from a metastore admin, not from this screen.
 */
import { z } from 'zod';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import {
  accessRunner,
  withdrawAccess,
  NO_TOKEN_REASON,
  NO_WAREHOUSE_REASON,
  type SqlRunner,
} from '../lib/admin-access';
import {
  addAdmin,
  adminListPayload,
  invalidAdminEmail,
  normalizeAdminEmail,
  recordAdminAction,
  removalRefusal,
  removeAdmin,
  REMOVAL_REFUSAL_DETAIL,
  seedAdminEmails,
  type AddedAdmin,
  type AdminStore,
} from '../lib/admin-roles';
import { readRosterForRequest } from '../lib/user-roster';
import type { AdminListPayload } from '../../shared/admin-contract';
import { executionToken } from '../lib/execution-credential';
import { userEmail, type InsightsAppKit } from './insights-routes';
import type { Request } from 'express';

const AddBody = z.object({ email: z.string().trim().max(320) });

/**
 * The stored half, and whether it could be read.
 *
 * Two fields rather than an empty array on failure, because "no added admins"
 * and "the list could not be read" put the same zero rows on screen and have
 * different remedies. The editor says which it is; conflating them sends
 * somebody looking for a person who was never removed.
 */
async function readAdded(store: AdminStore, req: Request): Promise<{ added: AddedAdmin[]; readable: boolean }> {
  try {
    const roster = await readRosterForRequest(store, req);
    return {
      added: roster.rows.map((row) => ({ email: row.email, addedBy: row.setBy, addedAt: row.setAt })),
      readable: true,
    };
  } catch (error) {
    console.warn('[admin] The stored admin list could not be read for the Settings editor:', (error as Error).message);
    return { added: [], readable: false };
  }
}

/**
 * A statement runner for this request, or the reason there is none.
 *
 * THE TOKEN IS THE SIGNED-IN ADMIN'S, never the app's. Absent, this returns no
 * runner rather than falling back to the app's own credential. That fallback is the
 * one thing this file must not do: it would make the app itself the authority over
 * Unity Catalog privileges, which is the escalation admin-access.ts exists to
 * avoid. Nothing is granted either way; what is at stake is the revoke a removal
 * attempts.
 */
export function runnerFor(req: Request): { run: SqlRunner | null; unavailable: string } {
  const host = normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
  const warehouseId = (process.env.DATABRICKS_SQL_WAREHOUSE_ID ?? '').trim();
  const token = executionToken(req);
  if (!host) {
    return {
      run: null,
      unavailable:
        'Not checked. The app does not know its own workspace URL, so it cannot reach a SQL warehouse ' +
        'to make a grant.',
    };
  }
  if (!warehouseId) return { run: null, unavailable: NO_WAREHOUSE_REASON };
  if (!token) return { run: null, unavailable: NO_TOKEN_REASON };
  return { run: accessRunner({ host, token, warehouseId }), unavailable: '' };
}

export function setupAdminRoutes(appkit: InsightsAppKit) {
  appkit.server.extend((app) => {
    /**
     * The whole list, seed rows and added rows, marked with what may be done to
     * each. Answers 200 with `addedAdminsReadable: false` when Lakebase is out,
     * because the seed rows are still true and still the deployment's
     * administrators, and a 503 would hide them behind the outage they survive.
     *
     * A PURE READ. It runs no statement at all, so the list appears without
     * waiting on a warehouse that may be cold.
     */
    app.get('/api/admins', async (req, res) => {
      const payload: AdminListPayload = await listPayload(req, userEmail(req));
      res.json(payload);
    });

    /** The list as the store now holds it, for whoever is reading the screen. */
    async function listPayload(req: Request, reader: string): Promise<AdminListPayload> {
      const { added, readable } = await readAdded(appkit.lakebase, req);
      return adminListPayload({
        seed: seedAdminEmails(),
        added,
        addedAdminsReadable: readable,
        reader,
      });
    }

    /**
     * Add one administrator.
     *
     * 409 rather than 400 on an address already on the list: the request was
     * well formed and the address exists, what cannot be done is the thing
     * asked for. The same distinction the settings write route draws.
     *
     * ONE WRITE, AND UNITY CATALOG IS NOT CONSULTED. The role is a row in
     * Lakebase. This route used to follow the write with grants on the telemetry
     * schema and the `system.billing` tables, which meant an operator who is not a
     * metastore admin saw PERMISSION_DENIED on `system` every time they appointed
     * a colleague, for read access the role never required. A 201 here now means
     * exactly what it says: this address is an administrator.
     */
    app.post('/api/admins', async (req, res) => {
      const parsed = AddBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_admin_body', detail: 'Send one email address.' });
        return;
      }
      const invalid = invalidAdminEmail(parsed.data.email);
      if (invalid) {
        res.status(400).json({ error: 'invalid_admin_email', detail: invalid });
        return;
      }
      const email = normalizeAdminEmail(parsed.data.email);
      const actor = userEmail(req);
      if (seedAdminEmails().includes(email)) {
        res.status(409).json({
          error: 'already_an_admin',
          detail: 'That address is already an administrator, set at deployment.',
        });
        return;
      }
      try {
        const inserted = await addAdmin(appkit.lakebase, { email, addedBy: actor });
        if (!inserted) {
          res.status(409).json({ error: 'already_an_admin', detail: 'That address is already an administrator.' });
          return;
        }
        // After the write, so a row here means the change happened. Awaited, but
        // its own failure never fails the request: see recordAdminAction.
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'admin-added',
          subject: email,
          detail: `${actor} added ${email} as an administrator of this deployment.`,
        });
        res.status(201).json(await listPayload(req, actor));
      } catch (error) {
        console.error(`[admin] ${email} could not be added:`, (error as Error).message);
        res.status(503).json({
          error: 'admin_store_unavailable',
          detail:
            'The administrator was not added. The app stores added administrators in Lakebase, and it is ' +
            'not answering: reporting success here would leave a name on screen that no reload would keep.',
        });
      }
    });

    /**
     * Remove one administrator, or refuse and say why.
     *
     * Three refusals, and each is a different status because each is a different
     * kind of no: a seed row and the last administrator are 409, because the
     * request was well formed and the thing asked for cannot be done, and an
     * address that is not on the list is 404.
     *
     * The last-administrator refusal is checked against the list as READ, in
     * this request, rather than against what the screen believed. Two admins
     * removing each other at once would otherwise both pass a check made in the
     * browser and leave the deployment with nobody.
     *
     * ACCESS EARLIER VERSIONS GRANTED IS HANDED BACK BEFORE THE ROW IS DELETED,
     * because the record of what this app granted is keyed by the address and the
     * withdrawal path needs to read it. Only privileges this app can show it added
     * are revoked; see withdrawAccess. It is best effort, it is recorded in the
     * audit trail rather than on screen, and it never refuses the removal.
     */
    app.delete('/api/admins/:email', async (req, res) => {
      const email = normalizeAdminEmail(req.params.email);
      const actor = userEmail(req);
      let added: AddedAdmin[];
      try {
        const roster = await readRosterForRequest(appkit.lakebase, req);
        added = roster.rows.map((row) => ({ email: row.email, addedBy: row.setBy, addedAt: row.setAt }));
      } catch (error) {
        console.error(
          '[admin] The stored admin list could not be read, so no removal was attempted:',
          (error as Error).message
        );
        res.status(503).json({
          error: 'admin_store_unavailable',
          detail:
            'Nobody was removed. The list could not be read, and removing an administrator without knowing ' +
            'who else is on it could leave this deployment with none.',
        });
        return;
      }
      const refusal = removalRefusal({ email, seed: seedAdminEmails(), added });
      if (refusal === 'not-found') {
        res.status(404).json({ error: 'no_such_admin', detail: REMOVAL_REFUSAL_DETAIL['not-found'] });
        return;
      }
      if (refusal) {
        res
          .status(409)
          .json({ error: `removal_refused_${refusal.replace('-', '_')}`, detail: REMOVAL_REFUSAL_DETAIL[refusal] });
        return;
      }
      try {
        const { run, unavailable } = runnerFor(req);
        const withdrawal = await withdrawAccess({ run, store: appkit.lakebase, email, unavailable });
        await removeAdmin(appkit.lakebase, email);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'admin-removed',
          subject: email,
          detail: `${actor} removed ${email} as an administrator of this deployment.`,
        });
        if (withdrawal.revoked > 0 || withdrawal.refused.length > 0) {
          await recordAdminAction(appkit.lakebase, {
            actor,
            action: 'access-revoked',
            subject: email,
            detail:
              `${actor} removed ${email}, and the access an earlier version of this app had granted them: ` +
              `${withdrawal.summary} ${withdrawal.note}`.trim(),
          });
        }
        res.json(await listPayload(req, actor));
      } catch (error) {
        console.error(`[admin] ${email} could not be removed:`, (error as Error).message);
        res.status(503).json({ error: 'admin_store_unavailable', detail: 'Nobody was removed.' });
      }
    });
  });
}
