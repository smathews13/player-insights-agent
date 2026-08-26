import { describe, expect, it } from 'vitest';
import { labelingIdsFromBody, REVIEW_LABEL_SCHEMA, reviewAppUrlFromBody } from './eval-review-app';

describe('Review App session parsing', () => {
  it('keeps the same labels Benchmarking already stores', () => {
    expect(REVIEW_LABEL_SCHEMA.map((entry) => entry.name)).toEqual(['sql_correct', 'thumbs']);
  });

  it('accepts only a real http URL from Databricks', () => {
    expect(reviewAppUrlFromBody({ url: 'https://workspace.cloud.databricks.com/ml/reviews/abc' })).toContain(
      'https://'
    );
    expect(reviewAppUrlFromBody({ url: '/ml/reviews/abc' })).toBe('');
    expect(reviewAppUrlFromBody({ review_app_url: 'not-a-url' })).toBe('');
  });

  it('reads session ids without inventing them', () => {
    expect(labelingIdsFromBody({ labeling_session_id: 'ls-1', mlflow_run_id: 'run-9', name: 'SME review' })).toEqual({
      sessionId: 'ls-1',
      runId: 'run-9',
      name: 'SME review',
    });
    expect(labelingIdsFromBody({})).toEqual({ sessionId: '', runId: '', name: '' });
  });
});
