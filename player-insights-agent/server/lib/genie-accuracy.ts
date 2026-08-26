import {
  MATCHING_POLICY_FACT,
  MATCHING_POLICY_ID,
  MATCHING_POLICY_REFERENCE,
  compareExecutedResults,
  genieLaneReady,
  genieSuitePlan,
  labCaseFromRow,
  missingSqlGateCopy,
  type ExecutedTable,
  type SuiteKind,
} from '../../shared/benchmark-lab-v3';
import { type EvalRow } from '../../shared/eval-dataset';
import {
  tableView,
  type GenieAccuracyCaseView,
  type GenieAccuracyOutcome,
  type GenieAccuracyRunView,
} from '../../shared/eval-genie-run';
import {
  classifyGenieMiss,
  isExcludedGenieMiss,
  scoredAccuracy,
  type GenieMissKind,
} from '../../shared/eval-flywheel';
import { executeMissKind, type SqlExecuteResult, type SqlExecutor } from './genie-result-execute';

/**
 * Ask a connected Genie space each SQL-backed question and score predicted
 * result tables against the operator's ground-truth result tables.
 *
 * Matching is executed-result equivalence: extra columns and row reorder are
 * allowed; under-selection is a miss. SQL text is shown on a failure, not used
 * as the pass test. Injected `asker` / `executor` so a test can script the
 * space without inventing a pass.
 */

type FetchLike = typeof fetch;

export const GENIE_ACCURACY_POLL_MS = 2_000;
export const GENIE_ACCURACY_TIMEOUT_MS = 90_000;

export type { GenieAccuracyOutcome, GenieAccuracyCaseView as GenieAccuracyCase, GenieAccuracyRunView as GenieAccuracyRun };

export class MissingSqlGateError extends Error {
  readonly missing: number;
  readonly selected: number;
  constructor(missing: number, selected: number) {
    super(missingSqlGateCopy(missing, selected));
    this.name = 'MissingSqlGateError';
    this.missing = missing;
    this.selected = selected;
  }
}

export interface GenieAskResult {
  sql: string;
  note: string;
  rows?: ExecutedTable | null;
  conversationId?: string;
  messageId?: string;
}

export interface GenieAsker {
  ask(input: { spaceId: string; question: string }): Promise<GenieAskResult>;
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

function numberish(value: unknown): number | string | boolean | null {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  return null;
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

/**
 * Pull a result table Genie already ran, if the attachment carried one.
 * Missing columns are not invented.
 */
export function extractGenieResultTable(payload: unknown): ExecutedTable | null {
  const root = asRecord(payload);
  if (!root) return null;
  const message = asRecord(root.message) ?? root;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const entry of attachments) {
    const attachment = asRecord(entry);
    if (!attachment) continue;
    const query = asRecord(attachment.query) ?? attachment;
    const columnsRaw = query.columns ?? query.schema ?? attachment.columns;
    const rowsRaw = query.rows ?? query.data ?? attachment.rows ?? attachment.data;
    if (!Array.isArray(columnsRaw) || !Array.isArray(rowsRaw)) continue;
    const names = columnsRaw.map((columnEntry, index) => {
      if (typeof columnEntry === 'string') return columnEntry;
      const column = asRecord(columnEntry);
      return text(column?.name) || text(column?.display_name) || `col_${index}`;
    });
    const values = names.map(() => [] as (number | string | boolean | null)[]);
    for (const row of rowsRaw) {
      if (Array.isArray(row)) {
        names.forEach((_, index) => values[index].push(numberish(row[index])));
      } else {
        const record = asRecord(row);
        names.forEach((name, index) => values[index].push(record ? numberish(record[name]) : null));
      }
    }
    return { rowCount: rowsRaw.length, columns: names.map((name, index) => ({ name, values: values[index] })) };
  }
  return null;
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

function fromPayload(payload: Record<string, unknown>, fallbackNote: string): GenieAskResult {
  const ids = conversationIds(payload);
  return {
    sql: extractGenieSql(payload),
    note: fallbackNote,
    rows: extractGenieResultTable(payload),
    conversationId: ids.conversationId || undefined,
    messageId: ids.messageId || undefined,
  };
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
      const immediate = fromPayload(start, 'Genie returned SQL.');
      if (immediate.sql && ['COMPLETED', 'EXECUTED'].includes(messageStatus(start))) {
        return immediate;
      }
      const ids = conversationIds(start);
      if (!ids.conversationId || !ids.messageId) {
        if (immediate.sql) return immediate;
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
        const asked = fromPayload(polled, 'Genie returned SQL.');
        if (['COMPLETED', 'EXECUTED'].includes(status) && asked.sql) {
          return asked;
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

async function resolveTable(
  sql: string,
  already: ExecutedTable | null | undefined,
  executor: SqlExecutor | null | undefined
): Promise<{ table: ExecutedTable | null; execute: SqlExecuteResult | null }> {
  if (already && already.columns.length > 0) return { table: already, execute: null };
  if (!executor) return { table: already ?? null, execute: null };
  if (!sql.trim()) return { table: null, execute: null };
  const execute = await executor(sql);
  return { table: execute.ok ? execute.table : null, execute };
}

function excludedCase(
  row: EvalRow,
  note: string,
  durationMs: number,
  extras: Partial<GenieAccuracyCaseView> = {}
): GenieAccuracyCaseView {
  const missKind = extras.missKind ?? classifyGenieMiss(note);
  return {
    id: row.id,
    question: row.question,
    outcome: 'excluded',
    predictedSql: extras.predictedSql ?? '',
    groundTruthSql: row.groundTruthSql,
    note,
    durationMs,
    missKind,
    excluded: true,
    conversationId: extras.conversationId ?? '',
    comparisonReason: extras.comparisonReason ?? '',
    predictedTable: extras.predictedTable,
    groundTable: extras.groundTable,
  };
}

function scoredCase(input: {
  row: EvalRow;
  outcome: GenieAccuracyOutcome;
  predictedSql: string;
  note: string;
  durationMs: number;
  missKind: GenieMissKind | null;
  excluded: boolean;
  conversationId?: string;
  comparisonReason?: string;
  predictedTable?: ExecutedTable | null;
  groundTable?: ExecutedTable | null;
}): GenieAccuracyCaseView {
  return {
    id: input.row.id,
    question: input.row.question,
    outcome: input.outcome,
    predictedSql: input.predictedSql,
    groundTruthSql: input.row.groundTruthSql,
    note: input.note,
    durationMs: input.durationMs,
    missKind: input.missKind,
    excluded: input.excluded,
    conversationId: input.conversationId ?? '',
    comparisonReason: input.comparisonReason ?? '',
    predictedTable: tableView(input.predictedTable),
    groundTable: tableView(input.groundTable),
  };
}

function newRunId(now: number): string {
  return `run_${now.toString(36)}`;
}

export async function runGenieAccuracy(input: {
  spaceId: string;
  spaceLabel?: string;
  rows: readonly EvalRow[];
  asker: GenieAsker;
  now?: () => number;
  suiteKind?: SuiteKind;
  datasetVersion?: string;
  caseIds?: readonly string[];
  executor?: SqlExecutor | null;
}): Promise<GenieAccuracyRunView> {
  const now = input.now ?? Date.now;
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const suiteKind = input.suiteKind ?? 'complete';
  const plan = genieSuitePlan(input.rows.map(labCaseFromRow), input.caseIds);
  const byId = new Map(input.rows.map((row) => [row.id, row]));

  if (suiteKind === 'complete' && !plan.canRunComplete) {
    throw new MissingSqlGateError(plan.missingSql.length, plan.selected.length);
  }

  const cases: GenieAccuracyCaseView[] = [];

  for (const labCase of plan.selected) {
    const row = byId.get(labCase.id);
    if (!row) continue;
    if (!genieLaneReady(labCase)) {
      if (labCase.question.trim()) {
        cases.push(excludedCase(row, 'Missing ground-truth SQL. Out of the accuracy denominator.', 0));
      }
      continue;
    }

    const caseStarted = now();
    try {
      const asked = await input.asker.ask({ spaceId: input.spaceId, question: row.question });
      const durationMs = Math.max(0, now() - caseStarted);
      const predicted = await resolveTable(asked.sql, asked.rows, input.executor);
      const ground = await resolveTable(row.groundTruthSql, null, input.executor);

      if (predicted.execute && !predicted.execute.ok) {
        const missKind = executeMissKind(predicted.execute.note);
        const excluded = isExcludedGenieMiss(missKind);
        cases.push(
          scoredCase({
            row,
            outcome: excluded ? 'excluded' : 'fail',
            predictedSql: asked.sql,
            note: predicted.execute.note,
            durationMs,
            missKind,
            excluded,
            conversationId: asked.conversationId,
            predictedTable: null,
            groundTable: ground.table,
          })
        );
        continue;
      }

      if (ground.execute && !ground.execute.ok) {
        const missKind = executeMissKind(ground.execute.note);
        cases.push(
          excludedCase(row, `Ground-truth SQL did not produce a result table: ${ground.execute.note}`, durationMs, {
            predictedSql: asked.sql,
            conversationId: asked.conversationId ?? '',
            predictedTable: tableView(predicted.table),
            missKind,
          })
        );
        continue;
      }

      if (!predicted.table || !ground.table) {
        cases.push(
          excludedCase(
            row,
            'No executed result table to score. Matching is result equivalence, not SQL text, and this workspace has no warehouse result to compare.',
            durationMs,
            {
              predictedSql: asked.sql,
              conversationId: asked.conversationId ?? '',
              predictedTable: tableView(predicted.table),
              groundTable: tableView(ground.table),
            }
          )
        );
        continue;
      }

      const compared = compareExecutedResults(predicted.table, ground.table);
      cases.push(
        scoredCase({
          row,
          outcome: compared.equivalent ? 'pass' : 'fail',
          predictedSql: asked.sql,
          note: compared.equivalent ? asked.note : compared.reason,
          durationMs,
          missKind: null,
          excluded: false,
          conversationId: asked.conversationId,
          comparisonReason: compared.reason,
          predictedTable: predicted.table,
          groundTable: ground.table,
        })
      );
    } catch (error) {
      const durationMs = Math.max(0, now() - caseStarted);
      const note = messageOf(error);
      const missKind = classifyGenieMiss(note);
      const excluded = isExcludedGenieMiss(missKind);
      cases.push(
        scoredCase({
          row,
          outcome: excluded ? 'excluded' : 'error',
          predictedSql: '',
          note,
          durationMs,
          missKind,
          excluded,
        })
      );
    }
  }

  const passed = cases.filter((entry) => entry.outcome === 'pass').length;
  const excluded = cases.filter((entry) => entry.excluded).length;
  const scored = cases.filter((entry) => !entry.excluded).length;
  return {
    id: newRunId(startedAtMs),
    spaceId: input.spaceId,
    spaceLabel: input.spaceLabel?.trim() || input.spaceId,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    suiteKind,
    datasetVersion: input.datasetVersion?.trim() || 'unversioned',
    matchingPolicyId: MATCHING_POLICY_ID,
    matchingPolicyFact: MATCHING_POLICY_FACT,
    matchingPolicyHref: MATCHING_POLICY_REFERENCE,
    score: scoredAccuracy(passed, scored, excluded),
    cases,
  };
}
