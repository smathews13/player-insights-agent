/**
 * Reading and writing the egress record and the egress controls.
 *
 * ── WHAT THIS FILE MAY NOT DO, STATED FIRST BECAUSE IT IS THE POINT ──
 *
 * It writes no payload, no value, no content and no filename. Not "does not
 * today": there is no parameter through which one could arrive.
 * {@link recordEgress} takes a channel, a surface, two pointers and a count, and
 * every one of those is either an enum this build declares or a number. A
 * caller wanting to record what was exported has to change the migration, the
 * contract and this signature, in that order, and each of those files says why
 * they should not.
 *
 * ── THIS FILE WIDENS NOTHING ──
 *
 * It observes and it restricts. It reads no governed table, holds no credential,
 * and never runs as the app's own identity against anybody's data. The two
 * tables it touches are in the app's own schema and hold the app's own record of
 * its own behaviour. If a future edit here needs a Databricks token, that is the
 * signal that the edit belongs somewhere else.
 *
 * ── FAILING SOFT, AND WHERE IT IS NOT ALLOWED TO ──
 *
 * Recording is best effort and never fails the thing being recorded. A copy
 * button that threw because an audit row could not be written would be an audit
 * mechanism that broke the app, and the first fix anybody reached for would be to
 * remove the mechanism.
 *
 * The events table is still written by {@link recordEgress}. Nothing in the app
 * reads it back into a UI any more; the table stays so live deployments keep
 * their history and a future surface can without a destructive migration.
 */

import { APP_SCHEMA } from '../../shared/app-schema';
import crypto from 'node:crypto';
import {
  defaultEgressControls,
  egressAllowed,
  egressControlsFrom,
  egressPath,
  type EgressChannel,
  type EgressControls,
  type EgressEvent,
  type EgressOutcome,
  type EgressReport,
} from '../../shared/egress-contract';
import { readStored, type LakebaseReader } from './lakebase-store';

/** The tables, named once. */
export const EGRESS_EVENTS_TABLE = `${APP_SCHEMA}.egress_events`;
export const EGRESS_CONTROLS_TABLE = `${APP_SCHEMA}.egress_controls`;

/**
 * The SQLSTATE for a table that is not there.
 *
 * Told apart from every other failure because it means one specific, actionable
 * thing on this deployment: migration 5 has not been applied. Reporting that as
 * "unavailable" would send somebody to look at a Lakebase endpoint that is fine.
 */
const UNDEFINED_TABLE = '42P01';

/**
 * The longest a surface may hold a value this app clamps rather than trusts.
 *
 * A client names its own surface, so it can name a very long one. Clamped rather
 * than refused: losing the row because a page name was odd would be losing the
 * record of an export over a label.
 */
const SURFACE_MAX = 64;
const IDENTIFIER_MAX = 128;

/* ── The controls ──────────────────────────────────────────────────────────── */

/**
 * How long a resolved control set may be reused.
 *
 * These rows are moved by an administrator occasionally and read on paths that
 * serve a page. Fifteen seconds rather than the settings table's forty five, and
 * shorter on purpose: this is a restriction. An administrator turning a path off
 * because they have just been asked to is entitled to have it take effect while
 * they are still in the conversation where they were asked, and a write clears
 * the entry anyway so their own change is immediate.
 */
export const EGRESS_CONTROLS_TTL_MS = 15_000;

interface CachedControls {
  at: number;
  controls: EgressControls;
  stored: boolean;
}

/**
 * Held per client rather than per process, the same way `app-settings.ts` holds
 * its own: the key is whoever asked, so two readers pointed at different
 * databases cannot answer each other's questions.
 */
let controlsCache = new WeakMap<object, CachedControls>();

/** Forget the cached controls. Called by the writer, and by tests. */
export function forgetEgressControls(): void {
  controlsCache = new WeakMap();
}

export interface EgressControlsReading {
  controls: EgressControls;
  /** Whether the stored rows were read. False means these are the defaults. */
  stored: boolean;
}

/**
 * What this deployment permits, from the table or from the defaults.
 *
 * ── A FAILED READ FALLS BACK TO THE DEFAULTS, AND SAYS SO ──
 *
 * The alternative is refusing every path when the store is unreachable, and it
 * is the wrong reading twice over. It would turn a Lakebase blip into an app
 * whose copy buttons have silently stopped working, with nothing on screen
 * saying why. And it would be a restriction nobody chose: the defaults ARE this
 * build's decision about what is safe, so falling back to them is falling back
 * to a considered answer rather than to an accident.
 *
 * `stored: false` is carried to the panel so an administrator can see they are
 * looking at the build's decision rather than their own. That distinction is the
 * whole value of the flag and it must not be collapsed.
 *
 * A FAILED READ IS NEVER CACHED. Caching the defaults an outage produced would
 * turn one unreadable moment into fifteen seconds of a deployment quietly
 * ignoring a switch an administrator had set.
 */
export async function readEgressControls(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<EgressControlsReading> {
  const maxAge = options.maxAgeMs ?? EGRESS_CONTROLS_TTL_MS;
  const now = options.now ?? Date.now();
  const cached = controlsCache.get(client);
  if (cached && maxAge > 0 && now - cached.at < maxAge) {
    return { controls: cached.controls, stored: cached.stored };
  }

  const read = await readStored(
    client,
    'egress controls',
    `SELECT channel, allowed FROM ${EGRESS_CONTROLS_TABLE}`
  );
  if (!read.available) {
    if (read.code !== UNDEFINED_TABLE) {
      console.warn(
        `[egress] The egress controls could not be read (${read.code || 'no code'}): ${read.error}. ` +
          "This build's own defaults are in force, and the panel says they are defaults rather than a " +
          'stored decision.'
      );
    }
    return { controls: defaultEgressControls(), stored: false };
  }

  const controls = egressControlsFrom(
    read.rows.map((row) => ({
      channel: typeof row.channel === 'string' ? row.channel : '',
      // Postgres hands back a real boolean here; anything else is read as the
      // permissive value ONLY when it is exactly true, so a null or a string
      // lands on the default rather than on a guess.
      allowed: row.allowed === true,
    }))
  );
  controlsCache.set(client, { at: now, controls, stored: true });
  return { controls, stored: true };
}

/**
 * Record one administrator's decision about one path.
 *
 * Refuses a channel this build does not know and a channel nothing can enforce,
 * rather than writing a row that would be read back and dropped. A switch that
 * accepted a write and then ignored it is the shape of dishonesty the whole
 * feature is written against, and it is worse arriving through a 200.
 *
 * Throws on a store failure, deliberately. This is somebody pressing a control
 * and being told it was saved; reporting success on a write that did not land
 * would leave a switch on screen that no reload keeps.
 */
export async function writeEgressControl(
  client: LakebaseReader,
  change: { channel: string; allowed: boolean; actor: string }
): Promise<{ channel: EgressChannel; allowed: boolean } | { refusal: string }> {
  const path = egressPath(change.channel);
  if (!path) {
    return { refusal: 'That is not a path this app knows about.' };
  }
  if (path.enforcement === 'uncontrollable') {
    return {
      refusal: `${path.label} cannot be switched off by this app, so there is nothing to store about it.`,
    };
  }
  await client.lakebase.query(
    `INSERT INTO ${EGRESS_CONTROLS_TABLE} (channel, allowed, changed_by, changed_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (channel) DO UPDATE
       SET allowed = EXCLUDED.allowed, changed_by = EXCLUDED.changed_by, changed_at = now()`,
    [path.channel, change.allowed, clamp(change.actor, IDENTIFIER_MAX)]
  );
  forgetEgressControls();
  return { channel: path.channel, allowed: change.allowed };
}

/**
 * Whether a workspace or MLflow URL may be put in a response.
 *
 * ── THE ONE CONTROL THAT IS ACTUALLY WIRED, AND WHY IT IS THIS ONE ──
 *
 * A deep link is a different shape of egress from the others: the data does not
 * leave through this app, the link hands somebody a route to it. And unlike every
 * other path in the registry, it can be shut off WITHOUT touching a component,
 * because the URL is minted on the server. When this answers false the field is
 * null and the browser never has a link to suppress -- which is what makes this
 * enforcement rather than a request.
 *
 * The surfaces that render these already draw nothing for a null: a deployment
 * with no `DATABRICKS_HOST` has always produced one, and "absent rather than
 * dead" is the rule they were written to. So this needs no client change and
 * cannot leave a dead anchor on a page.
 *
 * Errs OPEN, like {@link readEgressControls} it is built on. A store that cannot
 * be read falls back to the defaults, and the default here is that links work: a
 * Lakebase blip must not silently strip the provenance links out of Monitoring
 * with nothing on screen saying why.
 */
export async function workspaceLinksAllowed(client: LakebaseReader): Promise<boolean> {
  const { controls } = await readEgressControls(client);
  return egressAllowed(controls, 'workspace-link');
}

/* ── The record ────────────────────────────────────────────────────────────── */

function clamp(raw: unknown, max: number): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * A pointer, or null. Empty string is null, because a client sending `''` for a
 * run id means it had none, and storing that makes a row look as though it
 * pointed somewhere.
 */
function pointer(raw: unknown): string | null {
  const text = clamp(raw, IDENTIFIER_MAX);
  return text === '' ? null : text;
}

/**
 * A count, or null.
 *
 * Zero reads back as null, because an export of nothing is not an export and a
 * zero in that column would be a row claiming to have measured something it did
 * not. Non-integers and negatives are read as absent for the same reason: a
 * count nobody can vouch for is not a count.
 */
function count(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const whole = Math.trunc(raw);
  return whole > 0 ? whole : null;
}

export interface RecordedEgress {
  event: EgressEvent;
  /** Whether the row was written. False means the store refused it. */
  written: boolean;
}

/**
 * Write down that something left, or that something tried to.
 *
 * ── THE OUTCOME IS DECIDED HERE AND NOT BY THE CALLER ──
 *
 * The client reports an attempt. Whether it was permitted is answered against
 * the stored controls, on the server, in this function. A client that reports an
 * export through a path this deployment has turned off is recorded as `refused`
 * and the row stands: that is a client running an old bundle, or one whose
 * affordance was put back by hand, and it is the single most interesting row this
 * table can hold. Believing the client's own account of whether it was allowed
 * would make the record agree with whatever the browser felt like saying.
 *
 * ── WHAT THIS DOES NOT CLAIM ──
 *
 * Recording is reporting, not interception. A row here means the app was told an
 * export happened. Nothing in a browser is obliged to tell it, so the absence of
 * a row is not evidence that nothing left.
 *
 * Never throws. See the file header.
 */
export async function recordEgress(
  client: LakebaseReader,
  input: { actor: string; report: EgressReport; controls: EgressControls; now?: Date }
): Promise<RecordedEgress> {
  const path = egressPath(input.report.channel);
  const outcome: EgressOutcome =
    path && egressAllowed(input.controls, path.channel) ? 'left' : 'refused';
  const occurredAt = input.now ?? new Date();
  const event: EgressEvent = {
    id: crypto.randomUUID(),
    occurredAt: occurredAt.toISOString(),
    actor: clamp(input.actor, IDENTIFIER_MAX),
    // A channel this build does not know cannot reach here: the route validates
    // it before calling. The fallback keeps the type honest rather than covering
    // for a caller.
    channel: path?.channel ?? (input.report.channel),
    shape: path?.shape ?? 'prose',
    outcome,
    surface: clamp(input.report.surface, SURFACE_MAX),
    runId: pointer(input.report.runId),
    conversationId: pointer(input.report.conversationId),
    itemCount: count(input.report.itemCount),
  };

  try {
    await client.lakebase.query(
      `INSERT INTO ${EGRESS_EVENTS_TABLE}
         (id, occurred_at, actor, channel, shape, outcome, surface, run_id, conversation_id, item_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        event.id,
        occurredAt,
        event.actor,
        event.channel,
        event.shape,
        event.outcome,
        event.surface,
        event.runId,
        event.conversationId,
        event.itemCount,
      ]
    );
    return { event, written: true };
  } catch (error) {
    // Warned rather than errored, and never rethrown. The export either happened
    // or was refused before this call; losing the row costs the record, and
    // failing the request would cost the reader their copy button.
    console.warn(
      `[egress] A ${event.channel} export by ${event.actor} was not recorded: ${(error as Error).message}. ` +
        'The control decision itself was applied. The record for this one is lost.'
    );
    return { event, written: false };
  }
}
