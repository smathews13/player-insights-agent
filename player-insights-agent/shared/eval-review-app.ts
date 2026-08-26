import { z } from 'zod';

/**
 * MLflow Review App / labeling session.
 *
 * Schema matches what Benchmarking already stores: thumbs and SQL correct.
 * A URL is only kept when Databricks issued one. Nothing here invents a Review App.
 */

export const REVIEW_LABEL_SCHEMA = [
  { name: 'sql_correct', title: 'SQL correct?', options: ['yes', 'no'] },
  { name: 'thumbs', title: 'Answer', options: ['up', 'down'] },
] as const;

export const LabelingSessionSchema = z.strictObject({
  name: z.string().trim().max(200).default(''),
  sessionId: z.string().trim().max(120).default(''),
  runId: z.string().trim().max(80).default(''),
  url: z.string().trim().max(800).default(''),
  status: z.enum(['open', 'blocked']).default('blocked'),
  note: z.string().trim().max(800).default(''),
  at: z.string().trim().max(40).default(''),
});

export type LabelingSession = z.infer<typeof LabelingSessionSchema>;

export const EMPTY_LABELING_SESSION: LabelingSession = {
  name: '',
  sessionId: '',
  runId: '',
  url: '',
  status: 'blocked',
  note: '',
  at: '',
};

export function parseLabelingSession(value: unknown): LabelingSession {
  return LabelingSessionSchema.parse(value ?? EMPTY_LABELING_SESSION);
}

export function reviewAppUrlFromBody(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const nested = record.session && typeof record.session === 'object' ? (record.session as Record<string, unknown>) : record;
  for (const key of ['url', 'review_app_url', 'reviewAppUrl']) {
    const value = nested[key] ?? record[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return '';
}

export function labelingIdsFromBody(body: unknown): { sessionId: string; runId: string; name: string } {
  if (!body || typeof body !== 'object') return { sessionId: '', runId: '', name: '' };
  const record = body as Record<string, unknown>;
  const nested = record.session && typeof record.session === 'object' ? (record.session as Record<string, unknown>) : record;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : value != null ? String(value) : '');
  return {
    sessionId: text(nested.labeling_session_id ?? nested.session_id ?? nested.id),
    runId: text(nested.mlflow_run_id ?? nested.run_id),
    name: text(nested.name),
  };
}
