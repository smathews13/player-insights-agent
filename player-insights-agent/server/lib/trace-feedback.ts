/**
 * In-app ratings, copied onto the MLflow trace of the turn they rate.
 *
 * Lakebase stays the source of truth: the rating is stored there first, and this
 * write is a copy for the evaluation work that reads traces and could not see a
 * single rating. A failed copy is logged and changes nothing the user sees.
 *
 * The rater is named by an opaque id, never the email. It is an HMAC of the
 * email, because a bare digest of an email can be reversed by hashing a list of
 * guesses. With no key to make one, nothing is written.
 */
import { createHmac } from 'node:crypto';
import { APP_SCHEMA } from '../../shared/app-schema';
import { isMlflowTraceId } from '../../shared/mlflow-trace-id';

export const TRACE_FEEDBACK_NAME = 'user_feedback';
export const FEEDBACK_ID_METADATA = 'pia.feedback_id';
/** Overrides the key; otherwise the app's own OAuth secret is used. */
export const RATER_ID_KEY_ENV = 'PLAYER_INSIGHTS_RATER_ID_KEY';

const TRACE_FEEDBACK_TIMEOUT_MS = 8_000;
const BACKFILL_LIMIT = 500;

export interface TraceRating {
  feedbackId: string;
  messageId: string;
  traceId: string;
  sentiment: 'up' | 'down';
  comment: string | null;
  raterId: string;
  /** The rater's earlier assessment on this trace, which this one replaces. */
  overrides?: string;
}

export interface MlflowRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

export type MlflowTransport = (request: MlflowRequest) => Promise<unknown>;

function raterKey(env: Record<string, string | undefined>): string {
  return (env[RATER_ID_KEY_ENV] || env.DATABRICKS_CLIENT_SECRET || '').trim();
}

export function raterIdFor(email: string, env: Record<string, string | undefined> = process.env): string | null {
  const key = raterKey(env);
  const who = email.trim().toLowerCase();
  if (!key || !who) return null;
  return `rater-${createHmac('sha256', key).update(who).digest('hex').slice(0, 32)}`;
}

export function feedbackAssessmentRequest(rating: TraceRating): MlflowRequest {
  return {
    method: 'POST',
    path: `/api/3.0/mlflow/traces/${encodeURIComponent(rating.traceId)}/assessments`,
    body: {
      assessment: {
        assessment_name: TRACE_FEEDBACK_NAME,
        trace_id: rating.traceId,
        source: { source_type: 'HUMAN', source_id: rating.raterId },
        feedback: { value: rating.sentiment === 'up' },
        ...(rating.comment ? { rationale: rating.comment } : {}),
        metadata: { [FEEDBACK_ID_METADATA]: rating.feedbackId, 'pia.message_id': rating.messageId },
        ...(rating.overrides ? { overrides: rating.overrides } : {}),
      },
    },
  };
}

export function workspaceMlflowTransport(): MlflowTransport {
  return async ({ method, path, body }) => {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    const client = new WorkspaceClient({});
    return client.apiClient.request({
      method,
      path,
      headers: new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' }),
      raw: false,
      ...(body ? { payload: body } : {}),
    });
  };
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('MLflow did not answer in time')), TRACE_FEEDBACK_TIMEOUT_MS).unref()
    ),
  ]);
}

/**
 * Write one rating. One that replaces the rater's earlier rating is retried as a
 * plain write if MLflow refuses the replacement, so the newest rating is never
 * lost for the sake of retiring an old one.
 */
export async function writeTraceRating(rating: TraceRating, transport: MlflowTransport): Promise<void> {
  try {
    await withTimeout(transport(feedbackAssessmentRequest(rating)));
  } catch (error) {
    if (!rating.overrides) throw error;
    await withTimeout(transport(feedbackAssessmentRequest({ ...rating, overrides: undefined })));
  }
}

interface TraceAssessment {
  assessment_id?: unknown;
  assessment_name?: unknown;
  source?: { source_id?: unknown };
  valid?: unknown;
  create_time?: unknown;
  metadata?: Record<string, unknown>;
}

async function traceAssessments(traceId: string, transport: MlflowTransport): Promise<TraceAssessment[]> {
  const response = (await withTimeout(
    transport({ method: 'GET', path: `/api/3.0/mlflow/traces/${encodeURIComponent(traceId)}` })
  )) as { trace?: { trace_info?: { assessments?: TraceAssessment[] } } } | null;
  const assessments = response?.trace?.trace_info?.assessments;
  return Array.isArray(assessments) ? assessments : [];
}

function createdAt(assessment: TraceAssessment): string {
  return typeof assessment.create_time === 'string' ? assessment.create_time : '';
}

/**
 * The rater's current rating on the trace, if any. Each person keeps one rating
 * per answer, so a new one overrides it rather than sitting beside it.
 */
export function currentRatingBy(assessments: TraceAssessment[], raterId: string): string | undefined {
  const current = assessments
    .filter(
      (assessment) =>
        assessment.assessment_name === TRACE_FEEDBACK_NAME &&
        assessment.source?.source_id === raterId &&
        assessment.valid !== false &&
        typeof assessment.assessment_id === 'string' &&
        assessment.assessment_id
    )
    .sort((left, right) => createdAt(left).localeCompare(createdAt(right)));
  const latest = current[current.length - 1];
  return latest ? String(latest.assessment_id) : undefined;
}

const traceWrites = new Map<string, Promise<unknown>>();

/** Writes to one trace run in order, so rapid re-rating cannot race to the same predecessor. */
function inOrder<T>(traceId: string, work: () => Promise<T>): Promise<T> {
  const previous = traceWrites.get(traceId) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => undefined);
  traceWrites.set(traceId, settled);
  void settled.then(() => {
    if (traceWrites.get(traceId) === settled) traceWrites.delete(traceId);
  });
  return next;
}

export const TRACE_ID_FOR_MESSAGE = `SELECT trace_id FROM ${APP_SCHEMA}.messages WHERE id = $1`;

export interface TraceFeedbackStore {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Copy one new rating to its trace. Turns with no MLflow trace, benchmark runs
 * among them, are skipped, as is a rating with no key to name its rater.
 */
export async function copyRatingToTrace(
  store: TraceFeedbackStore,
  transport: MlflowTransport,
  input: { feedbackId: string; messageId: string; sentiment: 'up' | 'down'; comment: string | null; email: string }
): Promise<'written' | 'skipped'> {
  const raterId = raterIdFor(input.email);
  if (!raterId) return 'skipped';
  const read = await store.query(TRACE_ID_FOR_MESSAGE, [input.messageId]);
  const traceId = read.rows[0]?.trace_id;
  if (!isMlflowTraceId(traceId)) return 'skipped';
  const trace = String(traceId);
  await inOrder(trace, async () => {
    const overrides = currentRatingBy(await traceAssessments(trace, transport).catch(() => []), raterId);
    await writeTraceRating({ ...input, traceId: trace, raterId, overrides }, transport);
  });
  return 'written';
}

/** Each person's final rating of each answer; an earlier tap they changed is not copied. */
export const RATINGS_FOR_BACKFILL = `
  SELECT * FROM (
    SELECT DISTINCT ON (f.message_id, lower(f.user_email))
           f.id AS feedback_id, f.message_id, f.user_email, f.comment, m.trace_id, f.created_at,
           CASE
             WHEN lower(f.sentiment) IN ('up', 'down') THEN lower(f.sentiment)
             WHEN f.usefulness BETWEEN 4 AND 5 THEN 'up'
             WHEN f.usefulness BETWEEN 1 AND 2 THEN 'down'
           END AS direction
      FROM ${APP_SCHEMA}.feedback f
      JOIN ${APP_SCHEMA}.messages m ON m.id = f.message_id
     WHERE m.trace_id IS NOT NULL
     ORDER BY f.message_id, lower(f.user_email), f.created_at DESC, f.id DESC
  ) latest
   ORDER BY latest.created_at DESC
   LIMIT ${BACKFILL_LIMIT}`;

export interface RatingBackfillResult {
  written: number;
  alreadyCopied: number;
  skipped: number;
  failed: number;
}

/**
 * Copy the ratings given before this existed. Safe to repeat: a rating whose id
 * is already on its trace is left alone, so a restart after a partial run only
 * finishes the job.
 */
export async function backfillTraceRatings(
  store: TraceFeedbackStore,
  transport: MlflowTransport
): Promise<RatingBackfillResult> {
  const result: RatingBackfillResult = { written: 0, alreadyCopied: 0, skipped: 0, failed: 0 };
  if (!raterKey(process.env)) return result;
  const rows = (await store.query(RATINGS_FOR_BACKFILL)).rows;
  for (const row of rows) {
    const traceId = row.trace_id;
    const direction = row.direction;
    const raterId = raterIdFor(typeof row.user_email === 'string' ? row.user_email : '');
    if (!isMlflowTraceId(traceId) || (direction !== 'up' && direction !== 'down') || !raterId) {
      result.skipped += 1;
      continue;
    }
    const feedbackId = String(row.feedback_id);
    try {
      const assessments = await traceAssessments(String(traceId), transport);
      if (assessments.some((assessment) => assessment.metadata?.[FEEDBACK_ID_METADATA] === feedbackId)) {
        result.alreadyCopied += 1;
        continue;
      }
      const comment = typeof row.comment === 'string' && row.comment.trim() ? row.comment.trim() : null;
      await writeTraceRating(
        {
          feedbackId,
          messageId: String(row.message_id),
          traceId: String(traceId),
          sentiment: direction,
          comment,
          raterId,
          overrides: currentRatingBy(assessments, raterId),
        },
        transport
      );
      result.written += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
