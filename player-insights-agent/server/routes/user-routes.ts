/**
 * The roster, read and edited by this deployment's super administrator.
 *
 * One endpoint family, `/api/users`, and it is super-admin-only through the prefix
 * list in admin-roles.ts rather than through a guard written here. Nothing in this
 * file checks a role: the middleware has already refused a consumer AND a plain
 * administrator with 403 by the time a handler runs, and a second check here would
 * be a second place for the answer to be wrong.
 *
 * EVERY CHANGE TAKES EFFECT WITHOUT A REDEPLOY, which is the entire point of the
 * file. The role is a row in Lakebase, read on the next request by resolveRole, so
 * a person appointed here holds the role before the reply reaches the browser.
 *
 * A PROMOTION IS ONE ACTION: A ROW IN LAKEBASE. It used to be two, because a
 * promotion also granted Unity Catalog read on the telemetry schema and the
 * `system.billing` tables. That is gone. Granting on `system` needs an account
 * admin who is also a metastore admin, so the ordinary outcome was a
 * PERMISSION_DENIED beside the name of the person just promoted, for read access
 * the rank never required. Somebody who needs to read billing gets that from a
 * metastore admin, not from this screen.
 *
 * A DEMOTION STILL HANDS BACK what earlier versions of this app granted, best
 * effort, under the acting super admin's own forwarded token. That is recorded in
 * the audit trail rather than on screen, and it never refuses the role change.
 *
 * WHAT THE RANK GRANTS is no data at all. A question runs under the asker's own
 * grants at every rank, and a super admin reading somebody else's conversation in
 * Monitoring sees what their own grants allow -- appointing themselves does not
 * change that by one column.
 */
import { z } from 'zod';
import { withdrawAccess } from '../lib/admin-access';
import {
  normalizeAdminEmail,
  recordAdminAction,
  seedRoles,
  invalidAdminEmail,
  type AdminStore,
} from '../lib/admin-roles';
import {
  deleteRosterRow,
  effectiveRole,
  readRoster,
  REFUSAL_DETAIL,
  removalRefusal,
  roleChangeRefusal,
  roleChangeSentence,
  rosterPayload,
  writeRole,
  type StoredRole,
} from '../lib/user-roster';
import {
  opensAdminSurfaces,
  ROLE_WORD,
  type Role,
  type RosterPayload,
  type RosterRefusal,
} from '../../shared/user-roster-contract';
import { runnerFor } from './admin-routes';
import { userEmail, type InsightsAppKit } from './insights-routes';
import type { Request, Response } from 'express';
import { parseOrganizationMappings } from '../../shared/organization-mapping';

const RoleBody = z.object({ role: z.string().trim().max(32) });
const AddBody = RoleBody.extend({ email: z.string().trim().max(320) });

/**
 * The roster as read, and whether the stored half answered.
 *
 * Two fields rather than an empty roster on failure, because "nobody has been added"
 * and "the roster could not be read" put the same rows on screen and have different
 * remedies. Conflating them sends somebody looking for a person who was never
 * removed.
 */
async function read(store: AdminStore): Promise<{ rows: StoredRole[]; readable: boolean; roleColumnPresent: boolean }> {
  try {
    const { rows, roleColumnPresent } = await readRoster(store);
    return { rows, readable: true, roleColumnPresent };
  } catch (error) {
    console.warn('[admin] The stored roster could not be read for the roster editor:', (error as Error).message);
    // Reported as present so the screen does not blame a missing column for an
    // outage. The refusal that matters is the store one, and it is above this.
    return { rows: [], readable: false, roleColumnPresent: true };
  }
}

/** The status one refusal deserves. */
function statusFor(refusal: RosterRefusal): number {
  if (refusal === 'not-found') return 404;
  if (refusal === 'unknown-role') return 400;
  // seed-floor, last-super-admin, already-holds and no-role-column are all
  // well-formed requests asking for something that cannot be done. 409, the same
  // distinction the admin list draws.
  return 409;
}

function refuse(res: Response, refusal: RosterRefusal) {
  res.status(statusFor(refusal)).json({
    error: `roster_refused_${refusal.replace(/-/g, '_')}`,
    detail: REFUSAL_DETAIL[refusal],
  });
}

/**
 * Hand back the access an earlier version of this app granted, when a rank falls
 * below the administrator line.
 *
 * NOTHING IS EVER GRANTED HERE. A rise in rank writes a row and stops; see this
 * file's header. What is left is the debt: a deployment that ran the earlier
 * version recorded privileges this app added, and somebody who is no longer an
 * administrator should not keep a privilege they only held because this app handed
 * it to them.
 *
 * Only what the provenance table can show this app granted is revoked, which is the
 * whole of why a demotion does not take away access somebody holds for a reason we
 * know nothing about. Never allowed to fail the role change it follows: the role is
 * what the caller asked for, and this is the tidying up.
 */
async function withdrawOnDemotion(input: {
  req: Request;
  store: AdminStore;
  email: string;
  actor: string;
  from: Role;
  to: Role;
}): Promise<void> {
  if (!opensAdminSurfaces(input.from) || opensAdminSurfaces(input.to)) return;
  const { run, unavailable } = runnerFor(input.req);
  const withdrawal = await withdrawAccess({ run, store: input.store, email: input.email, unavailable });
  if (withdrawal.revoked === 0 && withdrawal.refused.length === 0) return;
  await recordAdminAction(input.store, {
    actor: input.actor,
    action: 'access-revoked',
    subject: input.email,
    detail:
      `${input.actor} took ${input.email} out of the administrator ranks, and the access an earlier version ` +
      `of this app had granted them: ${withdrawal.summary} ${withdrawal.note}`.trim(),
  });
}

export function setupUserRoutes(appkit: InsightsAppKit) {
  appkit.server.extend((app) => {
    /**
     * The whole roster: everybody either half of the list knows, with the role each
     * holds and what may be done to the row.
     *
     * Answers 200 with `storedRosterReadable: false` when Lakebase is out, because
     * the seed rows are still true and still this deployment's administration, and a
     * 503 would hide them behind the outage they survive.
     *
     * A PURE READ. It runs no `GRANT` and no `SHOW GRANTS`, so the roster appears
     * without waiting on a warehouse that may be cold.
     */
    app.get('/api/users', async (req, res) => {
      const { rows, readable, roleColumnPresent } = await read(appkit.lakebase);
      const payload: RosterPayload = rosterPayload({
        seed: seedRoles(),
        stored: rows,
        storedRosterReadable: readable,
        roleColumnPresent,
        reader: userEmail(req),
      });
      payload.organizations = parseOrganizationMappings(process.env.PLAYER_INSIGHTS_ORGANIZATIONS);
      res.json(payload);
    });

    /**
     * Put one address on the roster at one role.
     *
     * The same route shape as a change, and deliberately so: "add somebody as an
     * admin" and "make this consumer an admin" are one write and one audit row, and
     * two routes for them would be two places for the last-super-admin refusal to
     * be checked. The POST exists because the browser has no row to address yet.
     */
    app.post('/api/users', async (req, res) => {
      const parsed = AddBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_roster_body', detail: 'Send one email address and one role.' });
        return;
      }
      const invalid = invalidAdminEmail(parsed.data.email);
      if (invalid) {
        res.status(400).json({ error: 'invalid_roster_email', detail: invalid });
        return;
      }
      await setRole(req, res, normalizeAdminEmail(parsed.data.email), parsed.data.role);
    });

    /**
     * Change one person's role.
     *
     * PATCH rather than PUT because the address is the row and only the role moves.
     */
    app.patch('/api/users/:email', async (req, res) => {
      const parsed = RoleBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_roster_body', detail: 'Send one role.' });
        return;
      }
      await setRole(req, res, normalizeAdminEmail(req.params.email), parsed.data.role);
    });

    /**
     * Take one person off the roster entirely.
     *
     * They become a consumer, because a consumer is what anybody the roster does not
     * name already is. Access an earlier version of this app granted them is handed
     * back BEFORE the row goes, because the record of what was granted is keyed by
     * the address and the withdrawal path has to read it.
     */
    app.delete('/api/users/:email', async (req, res) => {
      const email = normalizeAdminEmail(req.params.email);
      const actor = userEmail(req);
      const seed = seedRoles();
      let rows: StoredRole[];
      let roleColumnPresent: boolean;
      try {
        ({ rows, roleColumnPresent } = await readRoster(appkit.lakebase));
      } catch (error) {
        console.error('[admin] The roster could not be read, so no removal was attempted:', (error as Error).message);
        res.status(503).json({
          error: 'roster_store_unavailable',
          detail:
            'Nobody was removed. The roster could not be read, and removing somebody without knowing who ' +
            'else is on it could leave this deployment with no super admin.',
        });
        return;
      }
      const refusal = removalRefusal({ email, seed, stored: rows });
      if (refusal) {
        refuse(res, refusal);
        return;
      }
      const from = effectiveRole({ seed, stored: rows, email });
      try {
        await withdrawOnDemotion({ req, store: appkit.lakebase, email, actor, from, to: 'consumer' });
        await deleteRosterRow(appkit.lakebase, email);
        // After the write, so a row here means the change happened. Awaited, and its
        // own failure never fails the request: see recordAdminAction.
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'user-removed',
          subject: email,
          detail: `${actor} removed ${email} from this deployment's roster, held as ${ROLE_WORD[from].toLowerCase()}.`,
        });
        await replyWithRoster(res, appkit.lakebase, actor, roleColumnPresent);
      } catch (error) {
        console.error(`[admin] ${email} could not be removed:`, (error as Error).message);
        res.status(503).json({ error: 'roster_store_unavailable', detail: 'Nobody was removed.' });
      }
    });

    /**
     * The one write path, behind both routes that change a role.
     *
     * THE REFUSALS ARE CHECKED AGAINST THE ROSTER AS READ IN THIS REQUEST rather
     * than against what the screen believed. Two super admins demoting each other at
     * once would otherwise both pass a check made in a browser and leave the
     * deployment with none.
     */
    async function setRole(req: Request, res: Response, email: string, role: string) {
      const actor = userEmail(req);
      const seed = seedRoles();
      let rows: StoredRole[];
      let roleColumnPresent: boolean;
      try {
        ({ rows, roleColumnPresent } = await readRoster(appkit.lakebase));
      } catch (error) {
        console.error('[admin] The roster could not be read, so no role was changed:', (error as Error).message);
        res.status(503).json({
          error: 'roster_store_unavailable',
          detail:
            'No role was changed. The roster could not be read, and changing a role without knowing who ' +
            'else holds one could leave this deployment with no super admin.',
        });
        return;
      }
      const refusal = roleChangeRefusal({ email, role, seed, stored: rows, roleColumnPresent });
      if (refusal) {
        refuse(res, refusal);
        return;
      }
      // Safe: roleChangeRefusal answered 'unknown-role' for anything else.
      const to = role as Role;
      const from = effectiveRole({ seed, stored: rows, email });
      try {
        await writeRole(appkit.lakebase, { email, role: to, actor, roleColumnPresent });
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'role-changed',
          subject: email,
          detail: roleChangeSentence({ actor, email, from, to }),
        });
        await withdrawOnDemotion({ req, store: appkit.lakebase, email, actor, from, to });
        await replyWithRoster(res, appkit.lakebase, actor, roleColumnPresent);
      } catch (error) {
        console.error(`[admin] ${email} could not be set to ${role}:`, (error as Error).message);
        res.status(503).json({
          error: 'roster_store_unavailable',
          detail:
            'The role was not changed. The app keeps the roster in Lakebase, and it is not answering: ' +
            'reporting success here would leave a role on screen that no reload would keep.',
        });
      }
    }

    /**
     * Read the roster back and answer with it.
     *
     * READ BACK RATHER THAN PATCHED IN MEMORY, so the screen shows the roster as the
     * store now holds it. A payload assembled from what the handler believed it wrote
     * is a payload that agrees with the handler rather than with the database.
     */
    async function replyWithRoster(res: Response, store: AdminStore, reader: string, roleColumnPresent: boolean) {
      const after = await read(store);
      const payload: RosterPayload = rosterPayload({
        seed: seedRoles(),
        stored: after.rows,
        storedRosterReadable: after.readable,
        roleColumnPresent: after.readable ? after.roleColumnPresent : roleColumnPresent,
        reader,
      });
      res.json(payload);
    }
  });
}
