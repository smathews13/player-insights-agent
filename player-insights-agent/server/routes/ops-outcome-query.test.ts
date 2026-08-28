import { describe, expect, it } from 'vitest';
import { RUN_OUTCOMES_QUERY } from './ops-routes';

describe('Ops failure and refusal population', () => {
  it('combines durable ledger outcomes with stored-answer verdicts', () => {
    expect(RUN_OUTCOMES_QUERY).toContain('WITH answers AS');
    expect(RUN_OUTCOMES_QUERY).toContain("jsonb_typeof(m.response_json->'trace') = 'object'");
    expect(RUN_OUTCOMES_QUERY).toContain('ledger_events AS');
    expect(RUN_OUTCOMES_QUERY).toContain('legacy_answer_events AS');
    expect(RUN_OUTCOMES_QUERY).toContain('UNION ALL');
  });

  it('deduplicates stored answers against terminal message and trace identifiers', () => {
    expect(RUN_OUTCOMES_QUERY).toContain('a.id = r.terminal_message_id');
    expect(RUN_OUTCOMES_QUERY).toContain('a.trace_id = r.trace_id');
    expect(RUN_OUTCOMES_QUERY).toContain('WHERE NOT EXISTS');
    expect(RUN_OUTCOMES_QUERY).toContain('r.terminal_message_id = a.id');
  });

  it('keeps refusals distinct and promotes visible failed answers', () => {
    expect(RUN_OUTCOMES_QUERY).toContain("WHEN r.state = 'REFUSED' THEN 'REFUSED'");
    expect(RUN_OUTCOMES_QUERY).toContain("WHEN a.answer_status = 'failed' THEN 'FAILED'");
    expect(RUN_OUTCOMES_QUERY).toContain("WHEN a.answer_status = 'failed' THEN 'NO_VALID_EVIDENCE'");
    expect(RUN_OUTCOMES_QUERY).toContain("r.state IN ('FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED')");
  });
});
