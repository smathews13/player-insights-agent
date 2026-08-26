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
import { gateChip, humanReviewedCaption, investigationCases } from './benchmark-lab-ops';
import { compareBakeOff, gatesSummary, judgeNeedTags } from '../../shared/benchmark-bakeoff';
import { STAGE_04_CAPTIONS } from '../../shared/benchmark-lab-v3';

const OPS = readFileSync(new URL('./BenchmarkLabOps.tsx', import.meta.url), 'utf8');
const HELPERS = readFileSync(new URL('./benchmark-lab-ops.ts', import.meta.url), 'utf8');

function readable(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
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

  it('does not invent a Review App URL', () => {
    expect(OPS).not.toMatch(/review\.cloud\.databricks|Review App/i);
    expect(HELPERS).not.toMatch(/review\.cloud\.databricks|Review App/i);
  });
});

describe('agent judges', () => {
  it('omits the session tag unless multi-turn judges are on', () => {
    const off = judgeNeedTags({ enabledJudges: ['groundedness'], multiTurn: [], customCount: 0 });
    const on = judgeNeedTags({
      enabledJudges: ['groundedness'],
      multiTurn: ['conversation_completeness'],
      customCount: 0,
    });
    const without = renderToStaticMarkup(
      <BenchmarkJudgesStage
        judges={['groundedness']}
        needTags={off}
        running={false}
        progress={null}
        hasCandidate
        threadNote={null}
        onRunBaseline={() => undefined}
        onRunCandidate={() => undefined}
        onScoreSession={() => undefined}
        onCancel={() => undefined}
        onRetryFailed={() => undefined}
      />,
    );
    const withSession = renderToStaticMarkup(
      <BenchmarkJudgesStage
        judges={['groundedness']}
        needTags={on}
        running={false}
        progress={null}
        hasCandidate
        threadNote={null}
        onRunBaseline={() => undefined}
        onRunCandidate={() => undefined}
        onScoreSession={() => undefined}
        onCancel={() => undefined}
        onRetryFailed={() => undefined}
      />,
    );
    expect(readable(without)).not.toContain('SESSION ID FOR MULTI-TURN');
    expect(readable(withSession)).toContain('SESSION ID FOR MULTI-TURN');
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
          caption={STAGE_04_CAPTIONS[target]}
          rollback="No earlier promote to roll back to."
          applying={false}
          applyNote={null}
          canApply={false}
          canRollback={false}
          onApply={() => undefined}
          onViewRollback={() => undefined}
          onRollback={() => undefined}
        />,
      ),
    );
  }

  it('names production alias, Genie handoff, and RAG not configured', () => {
    expect(apply('prompt_registry')).toContain('Prompt Registry moves the production alias after approval.');
    expect(apply('genie_space')).toContain('This app does not write space instructions.');
    expect(apply('rag_config')).toContain('Not configured for this target.');
    expect(apply('rag_config')).toContain('Hand off to the owning configuration.');
    expect(apply('prompt_registry')).toContain('Connections unchanged.');
  });

  it('states gate counts exactly', () => {
    expect(gateChip('run_057', 2, 2)).toBe('run_057 passed 2 of 2 gates');
    expect(gateChip(null, 0, 0)).toContain('no numeric gates set');
  });

  it('keeps View rollback path as inspection and Rollback as the destructive control', () => {
    const prose = apply('prompt_registry');
    expect(prose).toContain('View rollback path');
    expect(prose).toContain('Rollback');
    const viewHandler = OPS.slice(OPS.indexOf('const viewRollback'), OPS.indexOf('const rollbackAsk'));
    expect(viewHandler).not.toContain('rollbackPromotedAsk');
    expect(viewHandler).toContain('rollbackCaption');
    const rollbackHandler = OPS.slice(OPS.indexOf('const rollbackAsk'), OPS.indexOf('const exportPack'));
    expect(rollbackHandler).toContain('rollbackPromotedAsk');
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
        genieNote="Last space snapshot, same on both sides. Not a per-side Genie score."
        coverageNote="0 human-reviewed"
        onExport={() => undefined}
        onCopyPermalink={() => undefined}
        onInspect={() => undefined}
      />,
    );
    const prose = readable(html);
    expect(prose).toContain('Genie lane');
    expect(prose).toContain('Agent lane');
    expect(prose).toContain('Trace lane');
    expect(prose).toContain('No composite score');
    expect(prose).toContain('Last space snapshot, same on both sides');
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
    expect(OPS).toContain('genieLaneFromRun(input.lastGenieRun ?? null)');
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
          },
        ]}
        selectedId="case_1"
        onSelect={() => undefined}
        note={null}
        onAddEdge={() => undefined}
        onMarkKnown={() => undefined}
      />,
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
          },
        ]}
        selectedId="case_1"
        onSelect={() => undefined}
        note={null}
        onAddEdge={() => undefined}
        onMarkKnown={() => undefined}
      />,
    );
    expect(readable(without)).not.toContain('Open MLflow trace');
    expect(readable(without)).toContain('Open MLflow when a trace id is recorded.');
    expect(withHref).toContain('href="/runs?trace=tr-9"');
    expect(readable(withHref)).toContain('Open MLflow trace');
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
});
