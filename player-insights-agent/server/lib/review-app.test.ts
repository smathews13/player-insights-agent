import { describe, expect, it } from 'vitest';
import { startLabelingSession } from './review-app';

describe('Review App labeling session', () => {
  it('returns the Databricks URL when one is issued', async () => {
    const session = await startLabelingSession(
      {
        request: async () => ({
          name: 'SME review',
          labeling_session_id: 'ls-1',
          mlflow_run_id: 'run-9',
          url: 'https://workspace.cloud.databricks.com/ml/reviews/ls-1',
        }),
      },
      { name: 'SME review', experimentId: '123' }
    );
    expect(session.status).toBe('open');
    expect(session.url).toContain('https://');
    expect(session.sessionId).toBe('ls-1');
  });

  it('does not invent a Review App URL when the workspace refuses', async () => {
    const session = await startLabelingSession(
      {
        request: async () => {
          throw new Error('403 PERMISSION_DENIED: missing mlflow scope');
        },
      },
      { name: 'SME review', experimentId: '123' }
    );
    expect(session.status).toBe('blocked');
    expect(session.url).toBe('');
    expect(session.note).toContain('could not be started');
  });
});
