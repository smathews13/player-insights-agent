import {
  labelingIdsFromBody,
  REVIEW_LABEL_SCHEMA,
  reviewAppUrlFromBody,
  type LabelingSession,
} from '../../shared/eval-review-app';

export const LABELING_SESSION_PATHS = [
  '/api/2.0/mlflow/labeling-sessions',
  '/api/2.0/mlflow/genai/labeling-sessions',
] as const;

export interface ReviewAppClient {
  request(input: { method: string; path: string; payload?: Record<string, unknown> }): Promise<unknown>;
}

export async function startLabelingSession(
  client: ReviewAppClient,
  input: { name: string; experimentId: string }
): Promise<LabelingSession> {
  const name = input.name.trim() || `PIA SME review ${new Date().toISOString().slice(0, 10)}`;
  const at = new Date().toISOString();
  let lastError: unknown = new Error('No labeling-session path answered.');
  for (const path of LABELING_SESSION_PATHS) {
    try {
      const body = await client.request({
        method: 'POST',
        path,
        payload: {
          name,
          experiment_id: input.experimentId.trim() || undefined,
          label_schemas: REVIEW_LABEL_SCHEMA.map((entry) => entry.name),
          enable_multi_turn_chat: true,
        },
      });
      const ids = labelingIdsFromBody(body);
      const url = reviewAppUrlFromBody(body);
      if (!url) {
        return {
          name: ids.name || name,
          sessionId: ids.sessionId,
          runId: ids.runId,
          url: '',
          status: 'blocked',
          note: 'A labeling session was created but Databricks did not return a Review App URL. Nothing was invented. SMEs can still label thumbs and SQL correct on this tab.',
          at,
        };
      }
      return {
        name: ids.name || name,
        sessionId: ids.sessionId,
        runId: ids.runId,
        url,
        status: 'open',
        note: 'Share this Review App with SMEs. Labels use the same thumbs and SQL-correct fields already stored here.',
        at,
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    name,
    sessionId: '',
    runId: '',
    url: '',
    status: 'blocked',
    note: `Review App could not be started: ${lastError instanceof Error ? lastError.message : String(lastError)} Apps often cannot create labeling sessions. SMEs can still label thumbs and SQL correct on this tab.`,
    at,
  };
}
