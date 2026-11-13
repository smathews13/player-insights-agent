/**
 * Removing stored conversations: one on request, all of one person's on
 * request, or every conversation older than a configured window.
 *
 * There are no foreign keys on this schema, so nothing cascades and every table
 * that hangs off a conversation is named here. The conversation row always goes
 * last: a failure part-way through leaves it listed and the removal retryable,
 * because every child statement is keyed on the conversation id alone.
 *
 * The persona history tables (`sp_assignment_events`, `sp_persona_use`) are
 * append-only by trigger and are not touched. They are the audit record of
 * questions answered under a persona's grants, kept on purpose.
 */
import { APP_SCHEMA } from '../../shared/app-schema';
import type { AdminStore } from './admin-identity';
import { recordAdminAction } from './admin-roles';
import { forgetRuntimeSettings } from './runtime-settings-store';

export const CONVERSATION_RETENTION_ENV = 'PLAYER_INSIGHTS_CONVERSATION_RETENTION_DAYS';
export const MIN_CONVERSATION_RETENTION_DAYS = 7;
export const MAX_CONVERSATION_RETENTION_DAYS = 3650;
export const CONVERSATION_PURGE_BATCH = 200;
export const CONVERSATION_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const RETENTION_ACTOR = 'system:conversation-retention';

export interface ConversationContentsRemoved {
  runs: number;
  runEvents: number;
  runAttempts: number;
  feedback: number;
  attachments: number;
  messages: number;
}

export interface ConversationRemoved extends ConversationContentsRemoved {
  conversations: number;
}

const count = (value: unknown) => Number(value ?? 0) || 0;

/** One statement, so a run never loses its events without losing itself. */
export const DELETE_CONVERSATION_RUNS = `WITH gone AS (
  DELETE FROM ${APP_SCHEMA}.runs WHERE conversation_id = $1 RETURNING run_id
), events AS (
  DELETE FROM ${APP_SCHEMA}.run_events WHERE run_id IN (SELECT run_id FROM gone) RETURNING 1
), attempts AS (
  DELETE FROM ${APP_SCHEMA}.run_attempts WHERE run_id IN (SELECT run_id FROM gone) RETURNING 1
), labels AS (
  DELETE FROM ${APP_SCHEMA}.run_label_overrides WHERE run_id IN (SELECT run_id FROM gone) RETURNING 1
)
SELECT (SELECT count(*) FROM gone) AS runs,
       (SELECT count(*) FROM events) AS run_events,
       (SELECT count(*) FROM attempts) AS run_attempts`;

/** Everything keyed to a conversation, but not the conversation row itself. */
export async function deleteConversationContents(
  store: AdminStore,
  conversationId: string
): Promise<ConversationContentsRemoved> {
  const runs = await store.query(DELETE_CONVERSATION_RUNS, [conversationId]);
  // Feedback before messages: it carries only a message id, so once the
  // messages are gone nothing identifies these rows any more.
  const feedback = await store.query(
    `DELETE FROM ${APP_SCHEMA}.feedback
     WHERE message_id IN (SELECT id FROM ${APP_SCHEMA}.messages WHERE conversation_id = $1)
     RETURNING id`,
    [conversationId]
  );
  const attachments = await store.query(
    `DELETE FROM ${APP_SCHEMA}.attachments WHERE conversation_id = $1 RETURNING id`,
    [conversationId]
  );
  const messages = await store.query(`DELETE FROM ${APP_SCHEMA}.messages WHERE conversation_id = $1 RETURNING id`, [
    conversationId,
  ]);
  const ledger = runs.rows[0] ?? {};
  return {
    runs: count(ledger.runs),
    runEvents: count(ledger.run_events),
    runAttempts: count(ledger.run_attempts),
    feedback: feedback.rows.length,
    attachments: attachments.rows.length,
    messages: messages.rows.length,
  };
}

/** A conversation and everything keyed to it, whoever owns it. */
export async function eraseConversation(store: AdminStore, conversationId: string): Promise<ConversationRemoved> {
  const contents = await deleteConversationContents(store, conversationId);
  const conversation = await store.query(`DELETE FROM ${APP_SCHEMA}.conversations WHERE id = $1 RETURNING id`, [
    conversationId,
  ]);
  return { ...contents, conversations: conversation.rows.length };
}

function emptyTotals(): ConversationRemoved {
  return { conversations: 0, runs: 0, runEvents: 0, runAttempts: 0, feedback: 0, attachments: 0, messages: 0 };
}

function addTotals(total: ConversationRemoved, more: ConversationRemoved): ConversationRemoved {
  for (const key of Object.keys(total) as (keyof ConversationRemoved)[]) total[key] += more[key];
  return total;
}

export interface UserDataErased extends ConversationRemoved {
  strayRuns: number;
  strayFeedback: number;
  runtimeSettings: number;
  activityMinutes: number;
}

/**
 * Everything this app stores about one person's use of it, for an erasure
 * request. The roster row and persona assignment are administration, not the
 * person's data, and stay until an admin removes them.
 */
export async function eraseUserData(store: AdminStore, email: string): Promise<UserDataErased> {
  const address = email.trim().toLowerCase();
  const owned = await store.query(`SELECT id FROM ${APP_SCHEMA}.conversations WHERE lower(user_email) = $1`, [address]);
  const totals = emptyTotals();
  for (const row of owned.rows) {
    if (typeof row.id === 'string') addTotals(totals, await eraseConversation(store, row.id));
  }
  const strayRuns = await store.query(
    `WITH gone AS (
       DELETE FROM ${APP_SCHEMA}.runs WHERE lower(user_email) = $1 RETURNING run_id
     ), events AS (
       DELETE FROM ${APP_SCHEMA}.run_events WHERE run_id IN (SELECT run_id FROM gone) RETURNING 1
     ), attempts AS (
       DELETE FROM ${APP_SCHEMA}.run_attempts WHERE run_id IN (SELECT run_id FROM gone) RETURNING 1
     ), labels AS (
       DELETE FROM ${APP_SCHEMA}.run_label_overrides WHERE run_id IN (SELECT run_id FROM gone) RETURNING 1
     )
     SELECT (SELECT count(*) FROM gone) AS runs`,
    [address]
  );
  const strayFeedback = await store.query(
    `DELETE FROM ${APP_SCHEMA}.feedback WHERE lower(user_email) = $1 RETURNING id`,
    [address]
  );
  const settings = await store.query(`DELETE FROM ${APP_SCHEMA}.runtime_settings WHERE id = $1 RETURNING id`, [
    `user:${address}`,
  ]);
  forgetRuntimeSettings();
  const activity = await store.query(
    `DELETE FROM ${APP_SCHEMA}.app_activity_minutes WHERE lower(user_email) = $1 RETURNING 1`,
    [address]
  );
  return {
    ...totals,
    strayRuns: count(strayRuns.rows[0]?.runs),
    strayFeedback: strayFeedback.rows.length,
    runtimeSettings: settings.rows.length,
    activityMinutes: activity.rows.length,
  };
}

/**
 * The configured window, or null when retention is off.
 *
 * Off unless set. A value outside the allowed range is refused rather than
 * clamped, because a typo that purged a week of history would not be undoable.
 */
export function conversationRetentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[CONVERSATION_RETENTION_ENV]?.trim();
  if (!raw || raw === '0') return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < MIN_CONVERSATION_RETENTION_DAYS || days > MAX_CONVERSATION_RETENTION_DAYS) {
    console.warn(
      `[retention] ${CONVERSATION_RETENTION_ENV}=${raw} is not a whole number of days between ` +
        `${MIN_CONVERSATION_RETENTION_DAYS} and ${MAX_CONVERSATION_RETENTION_DAYS}. Conversation retention stays off.`
    );
    return null;
  }
  return days;
}

export const EXPIRED_CONVERSATIONS_QUERY = `SELECT id FROM ${APP_SCHEMA}.conversations
WHERE updated_at < NOW() - make_interval(days => $1::int)
ORDER BY updated_at
LIMIT $2`;

export interface ConversationPurgeResult extends ConversationRemoved {
  enabled: boolean;
  retentionDays: number | null;
}

/**
 * Remove every conversation untouched for longer than the window, a batch at a
 * time until none is left, then audit it. A batch that removes nothing ends the
 * pass, so a row that cannot be deleted is retried tomorrow, not forever.
 */
export async function purgeExpiredConversations(
  store: AdminStore,
  options: { env?: NodeJS.ProcessEnv; batch?: number } = {}
): Promise<ConversationPurgeResult> {
  const retentionDays = conversationRetentionDays(options.env);
  if (retentionDays === null) return { enabled: false, retentionDays, ...emptyTotals() };
  const batch = Math.max(1, Math.min(1_000, Math.trunc(options.batch ?? CONVERSATION_PURGE_BATCH)));
  const totals = emptyTotals();
  for (;;) {
    const expired = await store.query(EXPIRED_CONVERSATIONS_QUERY, [retentionDays, batch]);
    const before = totals.conversations;
    for (const row of expired.rows) {
      if (typeof row.id === 'string') addTotals(totals, await eraseConversation(store, row.id));
    }
    if (expired.rows.length < batch || totals.conversations === before) break;
  }
  if (totals.conversations > 0) {
    console.log(
      `[retention] Removed ${totals.conversations} conversation(s) untouched for over ${retentionDays} days ` +
        `(${totals.messages} messages, ${totals.runs} runs, ${totals.attachments} attachments).`
    );
    await recordAdminAction(store, {
      actor: RETENTION_ACTOR,
      action: 'conversations-purged',
      subject: `${retentionDays}-day retention`,
      detail:
        `Removed ${totals.conversations} conversation(s) untouched for over ${retentionDays} days, with ` +
        `${totals.messages} messages, ${totals.runs} runs, ${totals.attachments} attachments and ` +
        `${totals.feedback} feedback rows.`,
    });
  }
  return { enabled: true, retentionDays, ...totals };
}

let stopActivePurge: (() => void) | null = null;

/** Start the daily purge when retention is configured; a no-op otherwise. */
export function startConversationRetention(
  store: AdminStore,
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = CONVERSATION_PURGE_INTERVAL_MS
): () => void {
  stopActivePurge?.();
  const days = conversationRetentionDays(env);
  if (days === null) {
    console.log(`[retention] Conversation retention is off. Set ${CONVERSATION_RETENTION_ENV} to enable it.`);
    return () => undefined;
  }
  console.log(`[retention] Conversations untouched for over ${days} days are removed daily.`);
  const run = () => {
    void purgeExpiredConversations(store, { env }).catch((error: Error) => {
      console.warn(`[retention] The conversation purge did not complete and will retry: ${error.message}`);
    });
  };
  run();
  const timer = setInterval(run, Math.max(60_000, intervalMs));
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (stopActivePurge === stop) stopActivePurge = null;
  };
  stopActivePurge = stop;
  return stop;
}
