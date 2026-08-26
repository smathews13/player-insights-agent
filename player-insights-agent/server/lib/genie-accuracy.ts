import { sqlBackedRows, sqlMatches, type EvalRow } from '../../shared/eval-dataset';
import {
  classifyGenieMiss,
  deterministicChecks,
  isExcludedGenieMiss,
  scoredAccuracy,
  type DeterministicCheck,
  type GenieMissKind,
} from '../../shared/eval-flywheel';

/**
 * Ask a connected Genie space each SQL-backed question and score predicted SQL
 * against the operator's ground truth.
 *
 * Uses the Genie Conversation API the workspace already exposes. Injected
 * `fetch` so a test can script the space without inventing a pass.
 */

type FetchLike = typeof fetch;

export const GENIE_ACCURACY_POLL_MS = 2_000;
export const GENIE_ACCURACY_TIMEOUT_MS = 90_000;

export type GenieAccuracyOutcome = 'pass' | 'fail' | 'error';

export interface GenieAccuracyCase {
  id: string;
  question: string;
  outcome: GenieAccuracyOutcome;
  predictedSql: string;
  groundTruthSql: string;
  note: string;
  durationMs: number;
  missKind: GenieMissKind | null;
  excluded: boolean;
  checks: DeterministicCheck[];
}

export interface GenieAccuracyRun {
  spaceId: string;
  spaceLabel: string;
  startedAt: string;
  finishedAt: string;
  score: ReturnType<typeof scoredAccuracy>;
  cases: GenieAccuracyCase[];
}

export interface GenieAsker {
  ask(input: { spaceId: string; question: string }): Promise<{ sql: string; note: string }>;
}

function messageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Pull the generated statement out of a Genie message, wherever this API
 * version put it.
 */
export function extractGenieSql(payload: unknown): string {
  const root = asRecord(payload);
  if (!root) return '';
  const message = asRecord(root.message) ?? root;
  const attachments = message.attachments;
  if (Array.isArray(attachments)) {
    for (const entry of attachments) {
      const attachment = asRecord(entry);
      if (!attachment) continue;
      const query = asRecord(attachment.query) ?? attachment;
      const sql = text(query.query) || text(query.sql) || text(attachment.query) || text(attachment.sql);
      if (sql) return sql;
    }
  }
  return text(message.query) || text(root.query) || text(root.sql);
}

function messageStatus(payload: unknown): string {
  const root = asRecord(payload);
  const message = asRecord(root?.message) ?? root;
  return text(message?.status).toUpperCase();
}

function conversationIds(payload: unknown): { conversationId: string; messageId: string } {
  const root = asRecord(payload) ?? {};
  const conversation = asRecord(root.conversation);
  const message = asRecord(root.message);
  return {
    conversationId: text(conversation?.id) || text(root.conversation_id),
    messageId: text(message?.id) || text(root.message_id),
  };
}

async function jsonRequest(
  call: FetchLike,
  url: string,
  token: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await call(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(GENIE_ACCURACY_TIMEOUT_MS),
  });
  const payload = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    const detail = text(payload.message) || text(payload.error) || `workspace returned HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

export function createGenieAsker(options: {
  host: string;
  token: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): GenieAsker {
  const call = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const base = options.host.replace(/\/+$/, '');

  return {
    async ask({ spaceId, question }) {
      if (!base || !options.token) {
        throw new Error('This app cannot reach the workspace to ask the Genie space.');
      }
      const start = await jsonRequest(
        call,
        `${base}/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/start-conversation`,
        options.token,
        'POST',
        { content: question }
      );
      const immediate = extractGenieSql(start);
      if (immediate && ['COMPLETED', 'EXECUTED'].includes(messageStatus(start))) {
        return { sql: immediate, note: 'Genie returned SQL.' };
      }
      const ids = conversationIds(start);
      if (!ids.conversationId || !ids.messageId) {
        if (immediate) return { sql: immediate, note: 'Genie returned SQL.' };
        throw new Error('Genie did not return a conversation to poll.');
      }
      const deadline = now() + GENIE_ACCURACY_TIMEOUT_MS;
      while (now() < deadline) {
        const polled = await jsonRequest(
          call,
          `${base}/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(ids.conversationId)}/messages/${encodeURIComponent(ids.messageId)}`,
          options.token,
          'GET'
        );
        const status = messageStatus(polled);
        const sql = extractGenieSql(polled);
        if (['COMPLETED', 'EXECUTED'].includes(status) && sql) {
          return { sql, note: 'Genie returned SQL.' };
        }
        if (['FAILED', 'CANCELLED', 'QUERY_RESULT_EXPIRED'].includes(status)) {
          throw new Error(`Genie finished with status ${status}.`);
        }
        await sleep(GENIE_ACCURACY_POLL_MS);
      }
      throw new Error('Genie did not finish before the wait ran out.');
    },
  };
}

export async function runGenieAccuracy(input: {
  spaceId: string;
  spaceLabel?: string;
  rows: readonly EvalRow[];
  asker: GenieAsker;
  now?: () => number;
}): Promise<GenieAccuracyRun> {
  const now = input.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const cases: GenieAccuracyCase[] = [];
  for (const row of sqlBackedRows(input.rows)) {
    const caseStarted = now();
    try {
      const asked = await input.asker.ask({ spaceId: input.spaceId, question: row.question });
      const durationMs = Math.max(0, now() - caseStarted);
      const passed = sqlMatches(asked.sql, row.groundTruthSql);
      const note = passed ? asked.note : 'Predicted SQL did not match the ground-truth SQL.';
      cases.push({
        id: row.id,
        question: row.question,
        outcome: passed ? 'pass' : 'fail',
        predictedSql: asked.sql,
        groundTruthSql: row.groundTruthSql,
        note,
        durationMs,
        missKind: null,
        excluded: false,
        checks: deterministicChecks({ sql: asked.sql, note, durationMs }),
      });
    } catch (error) {
      const durationMs = Math.max(0, now() - caseStarted);
      const note = messageOf(error);
      // Duration is not a timeout signal. A real Genie FAILED after 50s is still
      // a scored miss; only warehouse-start / cancel / wait-ran-out drop out.
      const missKind = classifyGenieMiss(note);
      const excluded = isExcludedGenieMiss(missKind);
      cases.push({
        id: row.id,
        question: row.question,
        outcome: 'error',
        predictedSql: '',
        groundTruthSql: row.groundTruthSql,
        note,
        durationMs,
        missKind,
        excluded,
        checks: deterministicChecks({ sql: '', note, durationMs }),
      });
    }
  }
  const passed = cases.filter((entry) => entry.outcome === 'pass').length;
  const excluded = cases.filter((entry) => entry.excluded).length;
  const scored = cases.length - excluded;
  return {
    spaceId: input.spaceId,
    spaceLabel: input.spaceLabel?.trim() || input.spaceId,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    score: scoredAccuracy(passed, scored, excluded),
    cases,
  };
}
