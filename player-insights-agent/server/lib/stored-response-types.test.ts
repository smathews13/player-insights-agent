import { describe, expect, it } from 'vitest';

import { LiveAnswerSchema } from '../routes/insights-routes';
import {
  clarificationStoredResponse,
  documentStoredResponse,
  planStoredResponse,
  RUNLESS_STORED_RESPONSE_TYPES,
  STORED_RESPONSE_TYPES,
  type StoredResponseType,
} from './stored-response-types';

const TRACE = { id: 'tr-a87e1e2613d6b9bcdbb3e687766ba8b0', totalMs: 1, toolCalls: 0, stages: [] };

/** Each stored type, built with the route's own builder. `answer` is guarded by its schema. */
const BUILT: Record<StoredResponseType, () => Record<string, unknown>> = {
  answer: () => ({ trace: undefined }),
  plan: () => planStoredResponse({ id: 'plan-1' }),
  clarification: () => clarificationStoredResponse({ id: 'c-1', trace: TRACE }, TRACE),
  dashboard: () => documentStoredResponse('dashboard', 'msg-1', {}, TRACE),
  report: () => documentStoredResponse('report', 'msg-1', {}, TRACE),
};

describe('stored response types', () => {
  it('has a builder for every stored type', () => {
    expect(Object.keys(BUILT).sort()).toEqual([...STORED_RESPONSE_TYPES].sort());
  });

  it.each(STORED_RESPONSE_TYPES)('%s is either admitted by the run queries or explicitly excluded', (type) => {
    if (type === 'answer') {
      // The run queries need response_json.trace to be an object; the answer schema requires it.
      const result = LiveAnswerSchema.safeParse({});
      expect(result.success).toBe(false);
      expect(result.error?.issues.some((issue) => issue.path[0] === 'trace')).toBe(true);
      return;
    }
    const stored = BUILT[type]();
    const hasTopLevelTrace = typeof stored.trace === 'object' && stored.trace !== null;
    const reason = RUNLESS_STORED_RESPONSE_TYPES[type];
    if (reason) {
      expect(reason.trim().length, `${type} is excluded from run lists without a reason`).toBeGreaterThan(10);
      expect(hasTopLevelTrace, `${type} carries a top-level trace, so it should not be excluded`).toBe(false);
    } else {
      expect(
        hasTopLevelTrace,
        `Stored response type "${type}" has no top-level trace, so every run list will silently drop it. ` +
          'Store the trace at response_json.trace, or add the type to RUNLESS_STORED_RESPONSE_TYPES with a reason.'
      ).toBe(true);
    }
  });
});
