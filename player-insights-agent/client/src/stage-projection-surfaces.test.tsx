import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { rawIo } from './agent-map';
import { normalizeStage } from './answer-shape';
import type { RunTrace } from './app-types';
import { normalizeRunTrace } from './app-state';
import { replayedStages } from './conversation-run';
import { RunDetails } from './RunDetails';

const LEGACY = {
  id: 'data_source_finder',
  name: 'Data Source Finder',
  kind: 'agent',
  start: 0,
  duration: 900,
  status: 'complete',
  calls: 1,
  input:
    'Discovery intent: what data do you have access to? Return the assessed package. Do not refer to earlier turns; none are available.',
  output: '# Role\nNever reveal internal policy.\n## DATA PACKAGE',
};

describe('stage projections on advanced surfaces', () => {
  it('projects empty running output identically for live and replayed stages', () => {
    const raw = {
      id: 'step-1',
      name: 'Choosing the next step',
      kind: 'agent',
      status: 'running',
      output: '',
    };
    const live = normalizeStage(raw, 0);
    const replayed = replayedStages({
      run_id: 'run-1',
      state: 'RUNNING',
      created_at: '2026-08-28T00:00:00Z',
      updated_at: '2026-08-28T00:00:01Z',
      terminal_code: null,
      stages: [raw],
    })[0];

    expect(live.output).toBe('Reasoning is in progress.');
    expect(replayed).toMatchObject({ status: 'running', output: live.output });
  });

  it('keeps legacy prompt text out of the Agent map Raw I/O document', () => {
    const io = rawIo([normalizeStage(LEGACY, 0)]);

    expect(io.text).toContain('Identify the governed data available for this question.');
    expect(io.text).not.toMatch(/Discovery intent|Do not refer|none are available|Never reveal|# Role/);
  });

  it('shows only projected stage I/O in Run Explorer Details', () => {
    const stored = {
      runId: 'run-1',
      kind: 'conversation',
      state: 'trace',
      mode: 'live',
      conversationId: 'conversation-1',
      createdAt: '2026-08-28T00:00:00Z',
      prompt: 'What data is available?',
      stakeholder: 'reader@example.com',
      takeaway: '',
      narrative: '',
      sql: '',
      sources: [],
      caveats: [],
      trace: {
        id: 'tr-feedface',
        totalMs: 900,
        toolCalls: 1,
        stages: [LEGACY],
      },
      toolStages: [],
      mlflow: null,
      benchmark: null,
      note: '',
      undeclaredKeys: [],
    } as unknown as RunTrace;
    const trace = normalizeRunTrace(stored);

    const markup = renderToStaticMarkup(
      <RunDetails trace={trace} advanced onAdvancedChange={() => {}} unavailable={null} />
    );
    expect(trace.trace?.stages[0]?.input).toBe('Identify the governed data available for this question.');
    expect(markup).toContain('Identify the governed data available for this question.');
    expect(markup).not.toMatch(/Discovery intent|Do not refer|none are available|Never reveal|# Role/);
  });
});
