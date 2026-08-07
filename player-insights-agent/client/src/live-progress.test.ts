import { describe, expect, it } from 'vitest';
import type { TraceStage } from './answer-shape';
import { buildLiveRun, describeStage, toLiveStep } from './live-progress';

/**
 * Stages as the endpoint actually sends them.
 *
 * The values are copied from timed probes of live runs rather than invented:
 * a tool's `input` really is `json.dumps` of its arguments, and a model turn's
 * `output` really is the comma-joined names of the tools it decided to call.
 * Tests written against a guessed shape would pass while the panel showed
 * nothing.
 */
function stage(overrides: Partial<TraceStage> & Pick<TraceStage, 'id'>): TraceStage {
  return {
    name: 'Chose the next step',
    kind: 'agent',
    start: 0,
    duration: 1829,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
    startMeasured: true,
    ...overrides,
  };
}

describe('describeStage', () => {
  it('names the Genie space and quotes the question that was asked', () => {
    const asked = describeStage(stage({
        id: 'step-6-1-dictionary_genie',
        name: 'Checked field definitions',
        kind: 'tool',
        input: '{"question": "What are the date, title and country columns called?"}',
      })
    );
    expect(asked).toBe('Asked the data dictionary Genie space: \u201cWhat are the date, title and country columns called?\u201d'
    );
  });

  it('separates the two Genie spaces, which answer different questions', () => {
    const data = describeStage(stage({ id: 'step-2-1-data_genie', kind: 'tool', input: '{"question": "How many players?"}' })
    );
    expect(data).toContain('governed data Genie space');
    expect(data).not.toContain('dictionary');
  });

  it('shows the SQL that ran and the table that was described', () => {
    expect(describeStage(stage({ id: 'step-3-1-run_sql', kind: 'tool', input: '{"sql": "\\nSELECT title\\nFROM t"}' }))
    ).toBe('Ran a read-only query: SELECT title FROM t');
    expect(describeStage(stage({ id: 'step-1-1-describe_table', kind: 'tool', input: '{"full_name": "cat.sch.gold_title_daily"}' })
      )
    ).toBe('Read the columns of cat.sch.gold_title_daily');
  });

  it('says what a listing covered without inventing a scope it was not given', () => {
    expect(describeStage(stage({ id: 'step-1-1-list_data_assets', kind: 'tool', input: '{}' }))).toBe('Listed every table it is permitted to read'
    );
    expect(describeStage(stage({ id: 'step-1-1-list_data_assets', kind: 'tool', input: '{"catalog": "example"}' }))
    ).toBe('Listed the tables it may read under catalog: example');
  });

  it('names the tools a model turn decided to call, which is what happens next', () => {
    expect(describeStage(stage({ id: 'step-7', output: 'data_genie' }))).toBe('Chose to call data_genie');
    expect(describeStage(stage({ id: 'step-7', output: 'data_genie, dictionary_genie' }))).toBe('Chose to call data_genie and dictionary_genie'
    );
  });

  it('falls back to the recorded arguments for a tool it does not know by name', () => {
    // A tool added to the agent must show its real arguments rather than
    // nothing or a guess at what it does.
    expect(describeStage(stage({ id: 'step-2-1-forecast_players', kind: 'tool', input: '{"horizon": "30d"}' }))
    ).toBe('horizon: 30d');
  });

  it('does not echo the question back as if it were a step detail', () => {
    const question = 'Which titles lost the most active players last month?';
    // agent.py records `content or question` as a step's input, so a turn where
    // the model said nothing carries the question itself. Repeating it under
    // every step tells the reader nothing they cannot see above.
    expect(describeStage(stage({ id: 'step-1', input: question }), question)).toBe('');
  });

  it('surfaces a run that stopped at its own budget, in the agent\u2019s words', () => {
    expect(describeStage(stage({ id: 'cap', name: 'Stopped at the step budget', input: 'the 8-step ceiling was reached' }))).toBe('the 8-step ceiling was reached'
    );
  });
});

describe('toLiveStep', () => {
  it('keeps the measured timing and reports an unmeasured start as absent', () => {
    const measured = toLiveStep(stage({ id: 'step-1', start: 1830, duration: 1612 }));
    expect(measured.startMs).toBe(1830);
    expect(measured.durationMs).toBe(1612);
    // A missing start arrives as 0, which is also a legitimate start. Drawing
    // it as +0ms would place a step at an origin nobody measured.
    expect(toLiveStep(stage({ id: 'step-1', startMeasured: false })).startMs).toBeNull();
  });

  it('shows a result only for tool steps', () => {
    expect(toLiveStep(stage({ id: 'step-1-1-data_genie', kind: 'tool', output: '412 rows' })).result).toBe('412 rows');
    // A model turn's output is either the tool names, already used above, or
    // the answer prose, which belongs in the answer rather than the rail.
    expect(toLiveStep(stage({ id: 'synthesis', kind: 'agent', output: 'Titles fell 12%…' })).result).toBe('');
  });
});

describe('buildLiveRun', () => {
  const now = 1_000_000;

  it('says the question is on its way before the endpoint has answered at all', () => {
    const run = buildLiveRun({ openedAt: null, lastStageAt: null, now, stages: [] });
    expect(run.phase).toBe('sending');
    expect(run.detail).toContain('Sending your question');
    expect(run.steps).toHaveLength(0);
  });

  it('says the run has started once the stream is open, and names no step', () => {
    const run = buildLiveRun({ openedAt: now - 600, lastStageAt: null, now, stages: [] });
    expect(run.phase).toBe('accepted');
    expect(run.detail).toContain('has your question');
    // The whole point. No step exists yet, so none is named: the four
    // hardcoded stage names that used to animate here are not to come back.
    expect(run.detail).not.toMatch(/analys|planning|querying|thinking/i);
    expect(run.steps).toHaveLength(0);
  });

  it('draws every reported step rather than a sample of them', () => {
    const stages = Array.from({ length: 21 }, (_, index) =>
      stage({ id: `step-${index + 1}`, start: index * 1000, duration: 500 })
    );
    const run = buildLiveRun({ openedAt: now - 30_000, lastStageAt: now, now, stages });
    expect(run.steps).toHaveLength(21);
    expect(run.phase).toBe('reporting');
    expect(run.detail).toContain('21 steps');
  });

  it('counts the quiet since the newest step arrived, from the clock it was seen on', () => {
    const run = buildLiveRun({
      openedAt: now - 20_000,
      lastStageAt: now - 12_000,
      now,
      stages: [stage({ id: 'step-1' })],
    });
    expect(run.quietMs).toBe(12_000);
  });

  it('reports the run being ahead of the list only when it demonstrably is', () => {
    // Measured: the endpoint delivers a stage when the following one is
    // produced, so a step that ended 1.8s in can surface twenty seconds later.
    const behind = buildLiveRun({
      openedAt: now - 20_000,
      lastStageAt: now,
      now,
      stages: [stage({ id: 'step-1', start: 0, duration: 1829 })],
    });
    expect(behind.lag).toEqual({ openMs: 20_000, reportedToMs: 1829 });

    // And says nothing when the gap is only the endpoint's own startup, so the
    // claim retires itself if the buffering is ever fixed upstream.
    const prompt = buildLiveRun({
      openedAt: now - 2_400,
      lastStageAt: now,
      now,
      stages: [stage({ id: 'step-1', start: 0, duration: 1829 })],
    });
    expect(prompt.lag).toBeNull();
  });

  it('makes no claim about the lag when the stage carried no measured start', () => {
    const run = buildLiveRun({
      openedAt: now - 20_000,
      lastStageAt: now,
      now,
      stages: [stage({ id: 'step-1', startMeasured: false })],
    });
    expect(run.lag).toBeNull();
  });
});
