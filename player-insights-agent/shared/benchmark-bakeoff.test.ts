import { describe, expect, it } from 'vitest';
import {
  bakeOffHistoryLine,
  changedVariable,
  compareBakeOff,
  deltaTone,
  formatDelta,
  gatesSummary,
  judgeNeedTags,
  liveRunProgress,
  lowerIsBetter,
  promoteTargetCaption,
  rememberBakeOff,
  serializeEvidencePack,
} from './benchmark-bakeoff';

const baseline = {
  side: 'current',
  runId: 'run-a',
  passed: 6,
  total: 10,
  groundedness: 0.6,
  relevance: 0.7,
  guidelines: 0.8,
};

const candidate = {
  side: 'other-agent',
  runId: 'run-b',
  passed: 9,
  total: 10,
  groundedness: 0.9,
  relevance: 0.7,
  guidelines: 0.5,
};

describe('three-lane bake-off', () => {
  it('names the one variable that changed and never invents a composite score', () => {
    const comparison = compareBakeOff({ baseline, candidate });
    expect(comparison.changed).toBe('Agent endpoint: current to other-agent');
    expect(comparison.agent.map((row) => row.label)).toEqual([
      'Groundedness',
      'Relevance',
      'Guidelines',
      'Judge coverage',
    ]);
    expect(formatDelta(0.6, 0.9, 'rate')).toBe('+30 pt');
    expect(deltaTone(0.6, 0.9)).toBe('pos');
    expect(deltaTone(0.8, 0.5)).toBe('neg');
    expect(JSON.stringify(comparison)).not.toMatch(/composite/i);
    expect(formatDelta(1200, 900, 'ms')).toBe('-300 ms');
  });

  it('flags newly broken cases as the regression to inspect before applying', () => {
    const comparison = compareBakeOff({
      baseline,
      candidate,
      cases: [
        { caseId: 'c1', question: 'Happy path', baseline: 'failed', candidate: 'passed' },
        { caseId: 'c2', question: 'Edge', baseline: 'passed', candidate: 'failed' },
      ],
    });
    expect(comparison.newlyFixed.map((entry) => entry.caseId)).toEqual(['c1']);
    expect(comparison.newlyBroken.map((entry) => entry.caseId)).toEqual(['c2']);
    expect(comparison.regressionCaseId).toBe('c2');
  });

  it('counts only applicable gates, so a missing Genie lane is not a failed gate', () => {
    const comparison = compareBakeOff({ baseline, candidate });
    const gates = gatesSummary(comparison);
    expect(gates.total).toBe(1);
    expect(gates.passed).toBe(1);
    expect(gates.label).toBe('Passed 1 of 1 gates');
  });

  it('treats a groundedness drop as a failed gate even when more cases passed', () => {
    const comparison = compareBakeOff({
      baseline,
      candidate: { ...candidate, groundedness: 0.4, passed: 10 },
    });
    expect(gatesSummary(comparison).passed).toBe(0);
  });
});

describe('promote target captions', () => {
  it('does not claim the app writes Genie space instructions or Connections', () => {
    expect(promoteTargetCaption('prompt-registry')).toContain('Connections stay unchanged');
    expect(promoteTargetCaption('genie-space')).toContain('does not write Genie space instructions');
    expect(promoteTargetCaption('rag-config')).toContain('Not configured for this target');
    expect(promoteTargetCaption('genie-space')).not.toContain('wrote the space');
  });
});

describe('judge needs and live progress', () => {
  it('asks for a session id only when a multi-turn judge is on', () => {
    expect(judgeNeedTags({ enabledJudges: ['groundedness'], multiTurn: [], customCount: 0 }).map((tag) => tag.id)).toEqual([
      'response',
      'trace',
    ]);
    expect(
      judgeNeedTags({ enabledJudges: ['groundedness'], multiTurn: ['user_frustration'], customCount: 0 }).map(
        (tag) => tag.id
      )
    ).toContain('session');
  });

  it('states case n of m while a run is going', () => {
    expect(
      liveRunProgress({
        runId: 'run_058abcdef',
        side: 'candidate',
        currentCaseIndex: 11,
        total: 20,
        inProgress: true,
      })
    ).toBe('run_058a candidate in progress · case 12 of 20');
  });
});

describe('bake-off history', () => {
  it('keeps the latest bake-off first and readable', () => {
    const next = rememberBakeOff(
      [],
      {
        at: '2026-08-26T12:00:00.000Z',
        datasetSuiteId: 'operator-eval',
        baselineRunId: 'run-a',
        candidateRunId: 'run-b',
        changed: changedVariable('current', 'other-agent'),
        winner: 'candidate',
        gatesPassed: 1,
        gatesTotal: 1,
        note: '',
      }
    );
    expect(bakeOffHistoryLine(next[0])).toBe('2026-08-26: candidate · run-a vs run-b · 1 of 1 gates');
  });
});

describe('trace deltas and evidence', () => {
  it('treats latency, errors, tokens, and cost as better when they drop', () => {
    expect(lowerIsBetter({ key: 'p50', unit: 'ms' })).toBe(true);
    expect(lowerIsBetter({ key: 'execution-errors', unit: 'count' })).toBe(true);
    expect(lowerIsBetter({ key: 'groundedness', unit: 'rate' })).toBe(false);
    expect(deltaTone(1200, 900, true)).toBe('pos');
  });

  it('serializes an evidence pack without a composite score or a fake URL', () => {
    const comparison = compareBakeOff({ baseline, candidate });
    const pack = serializeEvidencePack({
      datasetSuiteId: 'operator-eval',
      changed: comparison.changed,
      comparison,
      baseline,
      candidate,
      failedCases: [],
    });
    expect(pack).toContain('operator-eval');
    expect(pack).not.toMatch(/composite/i);
    expect(pack).not.toContain('https://');
    expect(pack).not.toContain('review-app');
  });
});
