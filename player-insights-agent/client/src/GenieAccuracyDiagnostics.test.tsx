import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  MATCHING_POLICY_FACT,
  MATCHING_POLICY_ID,
  MATCHING_POLICY_REFERENCE,
} from '../../shared/benchmark-lab-v3';
import type { GenieAccuracyRunView } from '../../shared/eval-genie-run';
import { GenieAccuracyResult, GenieStageControls } from './GenieAccuracyDiagnostics';
import type { EvaluationLabModel } from './use-evaluation-lab';
import { EMPTY_LAB_STATE, labWorkspacePayload } from '../../shared/benchmark-lab-v3';

function readable(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
}

const RUN: GenieAccuracyRunView = {
  id: 'run_lab1',
  spaceId: 'space-data',
  spaceLabel: 'Player data',
  startedAt: '2026-08-26T18:00:00.000Z',
  finishedAt: '2026-08-26T18:00:12.500Z',
  suiteKind: 'complete',
  datasetVersion: 'ds_v001',
  matchingPolicyId: MATCHING_POLICY_ID,
  matchingPolicyFact: MATCHING_POLICY_FACT,
  matchingPolicyHref: MATCHING_POLICY_REFERENCE,
  score: { passed: 1, total: 2, percent: 50, label: '1/2 = 50%', excluded: 1 },
  cases: [
    {
      id: 'case_001',
      question: 'How many active players?',
      outcome: 'pass',
      predictedSql: 'SELECT 1',
      groundTruthSql: 'SELECT 1',
      note: 'Executed results match under reordering and extra-column tolerance.',
      durationMs: 40,
      missKind: null,
      excluded: false,
      conversationId: 'conv-1',
      comparisonReason: 'Executed results match under reordering and extra-column tolerance.',
    },
    {
      id: 'case_002',
      question: 'Wrong measure',
      outcome: 'fail',
      predictedSql: 'SELECT sessions',
      groundTruthSql: 'SELECT active_players',
      note: 'Wrong measure column: `sessions` for `active_players`. Row count matches, values do not. Execution clean.',
      durationMs: 40,
      missKind: null,
      excluded: false,
      conversationId: '',
      comparisonReason: 'Wrong measure column: `sessions` for `active_players`. Row count matches, values do not. Execution clean.',
    },
    {
      id: 'case_003',
      question: 'Warehouse still starting',
      outcome: 'excluded',
      predictedSql: '',
      groundTruthSql: 'SELECT 1',
      note: 'warehouse is starting',
      durationMs: 51_000,
      missKind: 'warehouse',
      excluded: true,
      conversationId: '',
      comparisonReason: '',
    },
  ],
};

describe('Genie accuracy diagnostics', () => {
  it('names the run, matching policy, and per-case Pass Fail Excluded', () => {
    const markup = renderToStaticMarkup(<GenieAccuracyResult run={RUN} accuracyGateMinimum={0.9} />);
    const prose = readable(markup);
    expect(prose).toContain('run_lab1');
    expect(prose).toContain('ds_v001');
    expect(prose).toContain('complete suite');
    expect(prose).toContain('executed-result equivalence');
    expect(prose).toContain('1 of 2 · below gate');
    expect(prose).toContain('Excluded');
    expect(prose).toContain('Pass');
    expect(prose).toContain('Fail');
    expect(prose).toContain('Generated SQL');
    expect(prose).toContain('Ground truth');
    expect(prose).toContain('SELECT sessions');
    expect(prose).toContain('Wrong measure column');
    expect(markup).toContain('href="/runs?trace=conv-1"');
    expect(prose).toContain('warehouse startup is not Genie-wrong');
  });

  it('keeps complete suite as the primary action and states the missing-SQL gate', () => {
    const lab = labWorkspacePayload({
      rows: [
        { id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
        { id: '2', question: 'Skipped', groundTruthSql: '', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
      ],
      state: EMPTY_LAB_STATE,
      enabledJudges: [],
    });
    const model = {
      lab,
      lastGenieRun: null,
      lastSuiteKind: 'complete',
      spaces: [{ id: 'space-data', label: 'Player data' }],
      spaceId: 'space-data',
      setSpaceId: () => {},
      selectedIds: [],
      runSuite: async () => {},
      rerunLast: async () => {},
      busy: null,
    } as unknown as EvaluationLabModel;
    const prose = readable(renderToStaticMarkup(<GenieStageControls lab={model} />));
    expect(prose).toContain('Run complete suite');
    expect(prose).toContain('Run partial suite');
    expect(prose).toContain('matching · executed-result equivalence');
    expect(prose).toContain('1 of 2 selected cases are missing SQL');
    expect(prose).toContain('Re-run last suite');
  });
});
