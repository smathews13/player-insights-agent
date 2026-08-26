import { describe, expect, it } from 'vitest';
import { PRODUCTION_PROMPT_ALIAS } from './eval-flywheel';
import {
  applyCandidateDecision,
  auditHeldOutEdits,
  CANCEL_RUN_NOTE,
  compareExecutedResults,
  commitDatasetVersion,
  DEFAULT_PASS_GATES,
  duplicateAsEdgeCase,
  EMPTY_LAB_STATE,
  evaluatePassGates,
  formatLabNumber,
  gateStatusLine,
  genieLaneReady,
  genieSuitePlan,
  heldOutScorerRows,
  labCaseFromRow,
  labDatasetCounts,
  labWorkspacePayload,
  mergeLabRowExtras,
  missingSqlGateCopy,
  newlyFixedAndBroken,
  nextDatasetVersionId,
  parseLabState,
  passGatesStripLine,
  pocContractView,
  runPermalink,
  signedDelta,
  STAGE_04_CAPTIONS,
  type EvalRowLike,
} from './benchmark-lab-v3';
import type { Scorecard } from './scorecard-contract';

function row(overrides: Partial<EvalRowLike> = {}) {
  return labCaseFromRow({
    id: 'c-1',
    question: 'How many active players?',
    groundTruthSql: 'SELECT 1',
    expectedAnswer: '',
    sqlCorrect: '',
    thumbs: '',
    ...overrides,
  });
}

describe('evaluation set projection', () => {
  it('does not treat SQL-backed cases as agent-ready', () => {
    const sqlOnly = row();
    expect(genieLaneReady(sqlOnly)).toBe(true);
    expect(labDatasetCounts([sqlOnly]).agentLaneReady).toBe(0);
    expect(labDatasetCounts([row({ expectedFacts: 'active_players is the measure' })]).agentLaneReady).toBe(1);
  });

  it('counts active, held-out, reviewed, and the reviewer queue separately', () => {
    const counts = labDatasetCounts([
      row({ id: 'a', review: 'approved' }),
      row({ id: 'b', split: 'held_out', review: 'draft', groundTruthSql: '' }),
      row({ id: 'c', retired: true, review: 'reviewed' }),
    ]);
    expect(counts.cases).toBe(3);
    expect(counts.active).toBe(2);
    expect(counts.retired).toBe(1);
    expect(counts.heldOut).toBe(1);
    expect(counts.reviewed).toBe(1);
    expect(counts.reviewerOpen).toBe(1);
  });

  it('keeps v3 extras when a later save omits them', () => {
    const merged = mergeLabRowExtras(
      { tag: 'edge_case', split: 'held_out', heldOutLockedAt: '2026-08-01T00:00:00.000Z' },
      {}
    );
    expect(merged.tag).toBe('edge_case');
    expect(merged.split).toBe('held_out');
    expect(merged.heldOutLockedAt).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('dataset versions', () => {
  it('commits an immutable snapshot and numbers versions', () => {
    expect(nextDatasetVersionId([])).toBe('ds_v001');
    const first = commitDatasetVersion({
      state: EMPTY_LAB_STATE,
      rows: [
        {
          id: 'c-1',
          question: 'How many active players?',
          groundTruthSql: 'SELECT 1',
          expectedAnswer: '',
          sqlCorrect: '',
          thumbs: '',
        },
      ],
      actor: 'admin@example.com',
      at: '2026-08-26T00:00:00.000Z',
    });
    expect(first.version.id).toBe('ds_v001');
    expect(first.state.currentVersionId).toBe('ds_v001');
    const second = commitDatasetVersion({
      state: first.state,
      rows: [
        {
          id: 'c-1',
          question: 'How many active players?',
          groundTruthSql: 'SELECT 1',
          expectedAnswer: '',
          sqlCorrect: '',
          thumbs: '',
        },
        {
          id: 'c-2',
          question: 'Who churned?',
          groundTruthSql: '',
          expectedAnswer: '',
          sqlCorrect: '',
          thumbs: '',
        },
      ],
      actor: 'admin@example.com',
      at: '2026-08-26T01:00:00.000Z',
    });
    expect(second.version.id).toBe('ds_v002');
    expect(second.version.parentId).toBe('ds_v001');
    expect(first.version.rows).toHaveLength(1);
  });

  it('writes an audit entry when a locked held-out case is edited', () => {
    const prior = row({ id: 'h-1', split: 'held_out', heldOutLockedAt: '2026-08-01T00:00:00.000Z' });
    const next = { ...prior, groundTruthSql: 'SELECT 2' };
    const audit = auditHeldOutEdits({
      prior: [prior],
      next: [next],
      actor: 'admin@example.com',
      versionId: 'ds_v001',
      at: '2026-08-26T00:00:00.000Z',
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.note).toContain('edited after the split');
  });

  it('duplicates a case as an unlocked tuning edge case', () => {
    const copy = duplicateAsEdgeCase(row({ split: 'held_out', tag: 'happy_path' }), 'c-2');
    expect(copy.id).toBe('c-2');
    expect(copy.tag).toBe('edge_case');
    expect(copy.split).toBe('tuning');
    expect(copy.heldOutLockedAt).toBe('');
  });
});

describe('Genie matching policy', () => {
  it('allows extra columns and reordering, and rejects under-selection', () => {
    const ground = {
      rowCount: 2,
      columns: [
        { name: 'title', values: ['a', 'b'] },
        { name: 'active_players', values: [10, 20] },
      ],
    };
    const extraAndReordered = {
      rowCount: 2,
      columns: [
        { name: 'active_players', values: [20, 10] },
        { name: 'title', values: ['b', 'a'] },
        { name: 'sessions', values: [2, 1] },
      ],
    };
    expect(compareExecutedResults(extraAndReordered, ground).equivalent).toBe(true);
    const under = {
      rowCount: 2,
      columns: [{ name: 'title', values: ['a', 'b'] }],
    };
    const missing = compareExecutedResults(under, ground);
    expect(missing.equivalent).toBe(false);
    expect(missing.underSelected).toBe(true);
    expect(missing.reason).toContain('active_players');
  });

  it('names a wrong measure when the row count matches', () => {
    const compared = compareExecutedResults(
      {
        rowCount: 2,
        columns: [
          { name: 'title', values: ['a', 'b'] },
          { name: 'active_players', values: [1, 2] },
        ],
      },
      {
        rowCount: 2,
        columns: [
          { name: 'title', values: ['a', 'b'] },
          { name: 'active_players', values: [10, 20] },
        ],
      }
    );
    expect(compared.equivalent).toBe(false);
    expect(compared.underSelected).toBe(false);
    expect(compared.reason).toContain('active_players');
  });

  it('states the missing-SQL denominator for a partial suite', () => {
    const plan = genieSuitePlan([row({ id: 's-1' }), row({ id: 's-2', groundTruthSql: '' })]);
    expect(plan.canRunComplete).toBe(false);
    expect(plan.kind).toBe('partial');
    expect(plan.gateCopy).toBe(missingSqlGateCopy(1, 2));
    expect(plan.gateCopy).toContain('1 of 2 selected cases are missing SQL');
  });
});

describe('run comparison', () => {
  it('signs deltas without a composite score', () => {
    expect(signedDelta(0.8, 0.9).sign).toBe('positive');
    expect(signedDelta(0.9, 0.8).sign).toBe('regression');
    expect(formatLabNumber(null)).toBe('-');
    expect(newlyFixedAndBroken(
      [
        { caseId: 'a', passed: false },
        { caseId: 'b', passed: true },
      ],
      [
        { caseId: 'a', passed: true },
        { caseId: 'b', passed: false },
      ]
    )).toEqual({ newlyFixed: ['a'], newlyBroken: ['b'] });
  });

  it('builds an in-app permalink, not a fabricated workspace URL', () => {
    expect(runPermalink({ datasetVersionId: 'ds_v001', candidateRunId: 'run_058' })).toBe(
      '/benchmarking?dataset=ds_v001&candidate=run_058'
    );
  });
});

describe('apply candidate', () => {
  const gates = evaluatePassGates({
    gates: {
      ...DEFAULT_PASS_GATES,
      genieAccuracy: { id: 'genie_accuracy', label: 'Genie accuracy', minimum: 0.9 },
    },
    candidate: { genieAccuracy: 0.95 },
    regressions: [],
  });

  it('requires a named approver and never writes Genie or Connections', () => {
    const blocked = applyCandidateDecision({
      target: { kind: 'prompt_registry', identifier: 'main.default.pia', snapshotId: '' },
      approver: '',
      candidateRunId: 'run_057',
      datasetVersionId: 'ds_v001',
      gates,
    });
    expect(blocked.status).toBe('blocked');
    expect(blocked.wroteGenieInstructions).toBe(false);
    expect(blocked.connectionsChanged).toBe(false);
  });

  it('moves the production alias only for Prompt Registry after approval', () => {
    const moved = applyCandidateDecision({
      target: { kind: 'prompt_registry', identifier: 'main.default.pia', snapshotId: '' },
      approver: 'approver@example.com',
      candidateRunId: 'run_057',
      datasetVersionId: 'ds_v001',
      gates,
    });
    expect(moved.status).toBe('moved');
    expect(moved.movesProductionAlias).toBe(true);
    expect(moved.caption).toContain(PRODUCTION_PROMPT_ALIAS);
    expect(moved.connectionsChanged).toBe(false);
  });

  it('hands Genie and RAG off without writing them', () => {
    expect(STAGE_04_CAPTIONS.genie_space).toContain('does not write space instructions');
    expect(
      applyCandidateDecision({
        target: { kind: 'genie_space', identifier: 'space-1', snapshotId: '' },
        approver: 'approver@example.com',
        candidateRunId: 'run_057',
        datasetVersionId: 'ds_v001',
        gates,
      }).status
    ).toBe('handoff');
    expect(
      applyCandidateDecision({
        target: { kind: 'rag_config', identifier: '', snapshotId: '' },
        approver: 'approver@example.com',
        candidateRunId: 'run_057',
        datasetVersionId: 'ds_v001',
        gates,
      }).status
    ).toBe('not_configured');
  });

  it('states exact gate counts and always keeps regressions visible', () => {
    const failed = evaluatePassGates({
      gates: {
        ...DEFAULT_PASS_GATES,
        genieAccuracy: { id: 'genie_accuracy', label: 'Genie accuracy', minimum: 0.9 },
        groundedness: { id: 'groundedness', label: 'Groundedness', minimum: 0.8 },
      },
      candidate: { genieAccuracy: 0.5, groundedness: 0.9 },
      regressions: ['c-9'],
    });
    expect(gateStatusLine('run_057', failed)).toBe('run_057 passed 1 of 2 gates');
    expect(failed.regressions).toEqual(['c-9']);
    expect(DEFAULT_PASS_GATES.regressionsAlwaysShown).toBe(true);
  });
});

describe('held-out scorers', () => {
  it('hides non-applicable scorers and counts them', () => {
    const scorecard = {
      provenance: { labelsReviewed: false },
      aggregates: [
        { scorerId: 'sql_validity', state: 'scored', value: 1, scored: 4, notApplicable: 0, errored: 0, reason: '' },
        { scorerId: 'identity_mismatch', state: 'unimplementable', value: null, scored: 0, notApplicable: 0, errored: 0, reason: 'no persona' },
      ],
    } as Scorecard;
    const view = heldOutScorerRows({ scorecard, labelsReviewed: false });
    expect(view.rows.some((entry) => entry.id === 'sql_validity')).toBe(true);
    expect(view.rows.some((entry) => entry.id === 'identity_mismatch')).toBe(false);
    expect(view.hiddenNonApplicable).toBeGreaterThan(0);
  });
});

describe('POC contract and cancel honesty', () => {
  it('names version, held-out lock count, and snapshot as an in-app link', () => {
    const view = pocContractView({
      counts: labDatasetCounts([row({ split: 'held_out' })]),
      versionId: 'ds_v003',
      contract: parseLabState(undefined).contract,
      scorerSet: { version: 'ss-1', activeCount: 3, nonApplicableCount: 3 },
    });
    expect(view.dataset).toContain('ds_v003');
    expect(view.dataset).toContain('1 held out');
    expect(view.snapshotHref).toBe('/benchmarking');
    expect(view.passGates).toContain('Regressions are always shown');
    expect(view.passGates).toContain('No numeric thresholds set');
  });

  it('names configured genie and groundedness minimums on the contract strip', () => {
    const state = parseLabState(undefined);
    const contract = {
      ...state.contract,
      gates: {
        ...DEFAULT_PASS_GATES,
        genieAccuracy: { id: 'genie_accuracy' as const, label: 'Genie accuracy', minimum: 0.9 },
        groundedness: { id: 'groundedness' as const, label: 'Groundedness', minimum: 0.8 },
      },
    };
    expect(passGatesStripLine(contract.gates)).toContain('Genie accuracy 90%');
    expect(passGatesStripLine(contract.gates)).toContain('Groundedness 80%');
    expect(passGatesStripLine(contract.gates)).not.toContain('No numeric thresholds set');
    const payload = labWorkspacePayload({
      rows: [],
      state: { ...state, contract },
      enabledJudges: [],
    });
    expect(payload.contractView.passGates).toContain('Genie accuracy 90%');
    expect(payload.contractView.passGates).toContain('Groundedness 80%');
    expect(payload.contractView.passGates).not.toContain('No numeric thresholds set');
  });

  it('does not claim the serving call can be aborted', () => {
    expect(CANCEL_RUN_NOTE).toContain('not aborted');
    expect(CANCEL_RUN_NOTE).not.toMatch(/https?:\/\//);
  });
});
