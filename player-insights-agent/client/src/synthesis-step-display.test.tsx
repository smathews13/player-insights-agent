import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TraceTimeline } from './TraceTimeline';
import type { TraceStage } from './answer-shape';

function synthesis(status: TraceStage['status']): TraceStage {
  return {
    id: 'synthesis',
    name: 'Prepared the answer',
    kind: 'agent',
    start: 0,
    duration: 4_180,
    status,
    calls: 1,
    input: '| Table | Purpose |\n| gold_player_180d_summary | Per-player aggregates |',
    output: 'This deployment has access to 12 declared tables.',
  };
}

describe('Prepared the answer matches the run verdict', () => {
  it('does not show PARTIAL on that step when the answer is Complete', () => {
    const markup = renderToStaticMarkup(
      <TraceTimeline
        trace={{ id: 'tr', totalMs: 4_180, toolCalls: 1, stages: [synthesis('partial')] }}
        verdict="complete"
      />
    );
    expect(markup).toContain('Prepared the answer');
    expect(markup).not.toContain('trace-status');
    expect(markup).not.toContain('ended partial');
  });

  it('keeps Partial on that step when synthesis actually stopped short', () => {
    const markup = renderToStaticMarkup(
      <TraceTimeline
        trace={{ id: 'tr', totalMs: 4_180, toolCalls: 1, stages: [synthesis('partial')] }}
        verdict="partial"
      />
    );
    expect(markup).toContain('Prepared the answer');
    expect(markup).toContain('trace-status partial');
  });
});
