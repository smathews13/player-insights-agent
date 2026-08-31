/**
 * Judges, bake-off, apply, and failure surfaces: honesty the chrome cannot
 * check, because chrome ships empty placeholders.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BenchmarkApplyStage,
  BenchmarkBakeOffSurface,
  BenchmarkFailurePane,
  BenchmarkJudgesStage,
} from './BenchmarkLabOps';
import {
  applyDisabledReason,
  gateChip,
  genieLanePair,
  humanReviewedCaption,
  investigationCases,
  spanTreeFromCase,
  suiteIsLive,
} from './benchmark-lab-ops';
import { compareBakeOff, gatesSummary, judgeNeedTags } from '../../shared/benchmark-bakeoff';
import { MATCHING_POLICY_FACT, MATCHING_POLICY_ID, MATCHING_POLICY_REFERENCE } from '../../shared/benchmark-lab-v3';

const OPS = readFileSync(new URL('./BenchmarkLabOps.tsx', import.meta.url), 'utf8');
const HELPERS = readFileSync(new URL('./benchmark-lab-ops.ts', import.meta.url), 'utf8');

function readable(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

const emptySide = {
  side: 'current',
  runId: null,
  passed: null,
  total: null,
  groundedness: null,
  relevance: null,
  guidelines: null,
};

describe('copy rules on the filled surfaces', () => {
  it('writes no em dash in the ops modules', () => {
    expect(OPS).not.toMatch(/—/);
    expect(HELPERS).not.toMatch(/—/);
  });

  it('uses the shared missing-evidence copy for metrics', () => {
    expect(OPS).toContain('Not recorded');
    expect(HELPERS).toContain('Not recorded');
    expect(OPS).not.toContain('not set');
    expect(HELPERS).not.toContain('not set');
  });

  it('does not invent a Review App URL', () => {
    expect(OPS).not.toMatch(/review\.cloud\.databricks|Review App/i);
    expect(HELPERS).not.toMatch(/review\.cloud\.databricks|Review App/i);
  });
});

describe('agent judges', () => {
  it('always names the session-id tag on This run needs', () => {
    const off = judgeNeedTags({ enabledJudges: ['groundedness'], multiTurn: [], customCount: 0 });
    const markup = renderToStaticMarkup(
      <BenchmarkJudgesStage
        judges={['groundedness']}
        needTags={off}
        running={false}
        progress="run_058 candidate in progress · case 12 of 20"
        hasCandidate
        threadNote={null}
        onRunBaseline={() => undefined}
        onRunCandidate={() => undefined}
        onScoreSession={() => undefined}
        onCancel={() => undefined}
        onRetryFailed={() => undefined}
      />
    );
    const prose = readable(markup);
    expect(prose).toContain('SESSION ID FOR MULTI-TURN');
    expect(prose).toContain('run_058 candidate in progress · case 12 of 20');
    expect(markup).toMatch(/bench-run-progress[\s\S]*Cancel/);
  });
});

describe('apply captions stay honest', () => {
  function apply(target: 'prompt_registry' | 'genie_space' | 'rag_config') {
    return readable(
      renderToStaticMarkup(
        <BenchmarkApplyStage
          target={target}
          onTarget={() => undefined}
          approver=""
          onApprover={() => undefined}
          promptName=""
          onPromptName={() => undefined}
          gateLabel="run_057 passed 2 of 2 gates"
          rollback="No earlier promote to roll back to."
          applying={false}
          applyNote={null}
          applyPreview="Candidate run_057 · dataset ds_v003 · prompts:/ask@production"
          canApply={false}
          applyBlockedReason="Name the approver before applying the candidate."
          onApply={() => undefined}
          onViewRollback={() => undefined}
          canRollback={false}
          rollbackDisabledReason="No earlier promote to roll back to."
          onRollback={() => undefined}
        />
      )
    );
  }

  it('shows why Apply is blocked and does not lecture about how apply works', () => {
    expect(apply('prompt_registry')).toContain('Name the approver before applying the candidate.');
    expect(apply('prompt_registry')).toContain('Candidate run_057 · dataset ds_v003');
    expect(apply('prompt_registry')).not.toContain('Prompt Registry moves the production alias after approval.');
    expect(apply('genie_space')).not.toContain('This app does not write space instructions.');
    expect(apply('rag_config')).not.toContain('Hand off to the owning configuration.');
    expect(apply('prompt_registry')).not.toContain('Connections unchanged.');
  });

  it('states gate counts exactly', () => {
    expect(gateChip('run_057', 2, 2)).toBe('run_057 passed 2 of 2 gates');
    expect(gateChip(null, 0, 0)).toContain('no numeric gates set');
  });

  it('keeps View rollback path as inspection and mounts Roll back next Ask separately', () => {
    const prose = apply('prompt_registry');
    expect(prose).toContain('View rollback path');
    expect(prose).toContain('Roll back next Ask');
    expect(prose).toContain('Candidate run_057 · dataset ds_v003');
    expect(prose).toContain('Name the approver before applying the candidate.');
    const viewHandler = OPS.slice(OPS.indexOf('const viewRollback'), OPS.indexOf('const rollbackAsk'));
    expect(viewHandler).not.toContain('rollbackPromotedAsk');
    expect(viewHandler).toContain('rollbackCaption');
    expect(viewHandler).toContain('inspection only');
    const rollbackHandler = OPS.slice(OPS.indexOf('const rollbackAsk'), OPS.indexOf('const exportPack'));
    expect(rollbackHandler).toContain('rollbackPromotedAsk');
    expect(OPS).not.toContain('void rollbackAsk');
  });
});

describe('run comparison', () => {
  it('draws three lanes and no composite score', () => {
    const comparison = compareBakeOff({
      baseline: emptySide,
      candidate: { ...emptySide, side: 'candidate' },
    });
    const html = renderToStaticMarkup(
      <BenchmarkBakeOffSurface
        comparison={comparison}
        history={[]}
        genieNote={null}
        coverageNote="0 human-reviewed"
        onExport={() => undefined}
        onCopyPermalink={() => undefined}
        onInspect={() => undefined}
      />
    );
    const prose = readable(html);
    expect(prose).toContain('Genie lane');
    expect(prose).toContain('Agent lane');
    expect(prose).toContain('Trace lane');
    expect(prose).not.toContain('No composite score');
    expect(prose).not.toContain('One Genie suite is recorded');
    expect(prose).not.toContain('same on both sides');
    expect(html).not.toMatch(/—/);
    expect(JSON.stringify(comparison)).not.toMatch(/composite/i);
    expect(gatesSummary(comparison).label).toMatch(/gates/i);
  });

  it('says human-reviewed when labels were reviewed, and zero when they were not', () => {
    expect(humanReviewedCaption(true, 0.8)).toBe('human-reviewed');
    expect(humanReviewedCaption(false, 0.8)).toBe('0 human-reviewed');
    expect(humanReviewedCaption(undefined, null)).toBe('0 human-reviewed');
    expect(OPS).toContain('humanReviewedCaption(input.labelsReviewed');
    expect(OPS).not.toMatch(/coverageNote:\s*'0 human-reviewed'/);
  });

  it('refetches flywheel after a Genie suite, not only after agent runs', () => {
    expect(OPS).toContain('input.lastGenieRun?.id');
    expect(OPS).toContain('genieLanePair');
  });
});

describe('failure investigation', () => {
  it('opens MLflow only when a trace id was recorded', () => {
    const without = renderToStaticMarkup(
      <BenchmarkFailurePane
        cases={[
          {
            id: 'case_1',
            question: 'Who leads assists?',
            outcome: 'Failed',
            diagnosis: 'Wrong measure.',
            mlflowHref: '',
            sessionId: '',
            rationale: 'Fix the semantic index entry for game_mode.',
            provisional: true,
            answerId: '',
            spans: [],
          },
        ]}
        selectedId="case_1"
        onSelect={() => undefined}
        note={null}
        onAddEdge={() => undefined}
        onMarkKnown={() => undefined}
      />
    );
    const withHref = renderToStaticMarkup(
      <BenchmarkFailurePane
        cases={[
          {
            id: 'case_1',
            question: 'Who leads assists?',
            outcome: 'Failed',
            diagnosis: 'Wrong measure.',
            mlflowHref: '/runs?trace=tr-9',
            sessionId: 'sess-1',
            rationale: 'Fix the semantic index entry for game_mode.',
            provisional: false,
            answerId: 'ans-9',
            spans: [],
          },
        ]}
        selectedId="case_1"
        onSelect={() => undefined}
        note={null}
        onAddEdge={() => undefined}
        onMarkKnown={() => undefined}
      />
    );
    expect(readable(without)).not.toContain('Open MLflow trace');
    expect(readable(without)).toContain('Open MLflow when a trace id is recorded.');
    expect(withHref).toContain('href="/runs?trace=tr-9"');
    expect(readable(withHref)).toContain('Open MLflow trace');
    expect(withHref).toContain('role="region"');
    expect(withHref).toContain('aria-labelledby=');
    expect(withHref).not.toContain('role="dialog"');
    expect(readable(withHref)).toContain('Trace for case_1');
    expect(without).not.toMatch(/review\.cloud\.databricks/i);
  });

  it('lists failed, skipped, and provisional cases from a trace', () => {
    const cases = investigationCases([
      { caseId: 'a', question: 'A', outcome: 'failed' },
      { caseId: 'b', question: 'B', outcome: 'passed' },
      { caseId: 'c', question: 'C', outcome: 'skipped' },
      { caseId: 'd', question: 'D', outcome: 'passed', note: 'provisional' },
    ]);
    expect(cases.map((row) => row.id)).toEqual(['a', 'c', 'd']);
  });

  it('builds a per-case span tree from duration and stages, never a fake suite DAG', () => {
    const spans = spanTreeFromCase({
      caseId: 'case_9',
      durationMs: 1200,
      tokens: 40,
      outcome: 'failed',
      stages: [{ id: 's1', name: 'warehouse', kind: 'SQL', status: 'ok' }],
      judgements: [{ name: 'groundedness', durationMs: 80, rationale: 'Fix the index.' }],
    });
    expect(spans.some((span) => span.kind === 'AGENT' && span.durationMs === 1200)).toBe(true);
    expect(spans.some((span) => span.kind === 'SQL')).toBe(true);
    expect(spans.some((span) => span.kind === 'LLM' && span.durationMs === 80)).toBe(true);
    expect(spans.every((span) => span.cost == null)).toBe(true);
    expect(spanTreeFromCase({ caseId: 'empty' })).toEqual([]);
  });
});

describe('Genie lane pairing', () => {
  it('does not copy one snapshot onto both sides', () => {
    const one = genieLanePair({
      lastRun: {
        id: 'run_g1',
        spaceId: 'space-a',
        spaceLabel: 'Player data',
        startedAt: '2026-08-26T18:00:00.000Z',
        finishedAt: '2026-08-26T18:00:12.500Z',
        suiteKind: 'complete',
        datasetVersion: 'ds_v001',
        matchingPolicyId: MATCHING_POLICY_ID,
        matchingPolicyFact: MATCHING_POLICY_FACT,
        matchingPolicyHref: MATCHING_POLICY_REFERENCE,
        score: { passed: 8, total: 10, percent: 80, label: '8/10', excluded: 0 },
        cases: [],
      },
      history: [],
    });
    expect(one?.candidate.accuracy).toBe(0.8);
    expect(one?.baseline.accuracy).toBeNull();
    expect(one?.candidate.note).toBe('');

    const two = genieLanePair({
      lastRun: {
        id: 'run_g2',
        spaceId: 'space-a',
        spaceLabel: 'Player data',
        startedAt: '2026-08-26T19:00:00.000Z',
        finishedAt: '2026-08-26T19:00:10.000Z',
        suiteKind: 'complete',
        datasetVersion: 'ds_v001',
        matchingPolicyId: MATCHING_POLICY_ID,
        matchingPolicyFact: MATCHING_POLICY_FACT,
        matchingPolicyHref: MATCHING_POLICY_REFERENCE,
        score: { passed: 9, total: 10, percent: 90, label: '9/10', excluded: 0 },
        cases: [],
      },
      history: [{ at: '2026-08-25T12:00:00.000Z', spaceId: 'space-a', percent: 80, passed: 8, scored: 10 }],
    });
    expect(two?.baseline.accuracy).toBe(0.8);
    expect(two?.candidate.accuracy).toBe(0.9);
  });
});

describe('apply and live-run gates', () => {
  it('does not block Apply just because no numeric gates exist yet', () => {
    expect(
      applyDisabledReason({
        approver: 'sam@example.com',
        target: 'prompt_registry',
        gatesPassed: 0,
        gatesTotal: 0,
        askEndpoint: 'agent-prod',
        candidateRunId: 'run_1',
      })
    ).toBe('');
    expect(
      applyDisabledReason({
        approver: '',
        target: 'prompt_registry',
        gatesPassed: 0,
        gatesTotal: 0,
        askEndpoint: 'agent-prod',
        candidateRunId: 'run_1',
      })
    ).toContain('approver');
    expect(
      applyDisabledReason({
        approver: 'sam@example.com',
        target: 'prompt_registry',
        gatesPassed: 1,
        gatesTotal: 2,
        askEndpoint: 'agent-prod',
        candidateRunId: 'run_1',
      })
    ).toContain('passed 1 of 2');
  });

  it('does not freeze the Lab on a leftover cancel flag or an old stored run', () => {
    expect(
      suiteIsLive({
        running: false,
        lastRunId: null,
        lastRunFound: false,
        lastRunInProgress: false,
        liveRun: { runId: 'run_old', cancelRequested: true },
      })
    ).toBe(false);
    expect(
      suiteIsLive({
        running: false,
        lastRunId: 'run_new',
        lastRunFound: true,
        lastRunInProgress: true,
        liveRun: null,
      })
    ).toBe(true);
  });
});
