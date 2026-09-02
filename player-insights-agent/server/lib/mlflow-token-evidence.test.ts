import { describe, expect, it } from 'vitest';

import { tokenEvidenceSpans } from './mlflow-token-evidence';

describe('the MLflow token evidence boundary', () => {
  it('keeps correlation and usage while dropping prompts, responses, events, and unrelated attributes', () => {
    expect(
      tokenEvidenceSpans([
        {
          span_id: 'span-1',
          parent_span_id: 'parent',
          name: 'orchestrator.synthesis',
          attributes: {
            'mlflow.spanType': '"LLM"',
            'mlflow.chat.tokenUsage': '{"input_tokens":10,"output_tokens":2}',
            'mlflow.spanInputs': '{"messages":["secret prompt"]}',
            'mlflow.spanOutputs': '{"content":"secret answer"}',
            authorization: 'secret',
          },
          events: [{ name: 'secret event' }],
          links: [{ attributes: { secret: true } }],
        },
      ])
    ).toEqual([
      {
        span_id: 'span-1',
        parent_span_id: 'parent',
        name: 'orchestrator.synthesis',
        attributes: {
          'mlflow.spanType': '"LLM"',
          'mlflow.chat.tokenUsage': '{"input_tokens":10,"output_tokens":2}',
        },
      },
    ]);
  });
});
