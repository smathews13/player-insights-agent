import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_LAB_STATE, labWorkspacePayload, type EvalRowLike } from '../../shared/benchmark-lab-v3';
import { POC_STARTER_QUESTIONS } from '../../shared/eval-dataset';
import { CurateStageControls, EvaluationSet, EvaluationSetTable } from './EvaluationSet';
import type { EvaluationLabModel } from './use-evaluation-lab';

function row(overrides: Partial<EvalRowLike> & Pick<EvalRowLike, 'id' | 'question'>): EvalRowLike {
  return {
    groundTruthSql: '',
    expectedAnswer: '',
    sqlCorrect: '',
    thumbs: '',
    tag: 'happy_path',
    split: 'tuning',
    review: 'draft',
    ...overrides,
  };
}

function workspace(rows: EvalRowLike[]) {
  return labWorkspacePayload({
    rows,
    state: { ...EMPTY_LAB_STATE, currentVersionId: rows.length ? 'ds_v001' : '' },
    enabledJudges: [],
  });
}

function model(lab: ReturnType<typeof workspace>, extra: Partial<EvaluationLabModel> = {}): EvaluationLabModel {
  const noop = async () => {};
  return {
    lab,
    lastGenieRun: null,
    lastSuiteKind: 'complete',
    spaces: [],
    spaceId: '',
    setSpaceId: () => {},
    selectedIds: [],
    setSelectedIds: () => {},
    reviewerOnly: false,
    setReviewerOnly: () => {},
    expandedId: '',
    setExpandedId: () => {},
    importFilters: ['low_judge_score', 'tool_failure', 'latency', 'customer_feedback'],
    setImportFilters: () => {},
    candidates: [],
    picked: [],
    setPicked: () => {},
    alignDraft: '',
    setAlignDraft: () => {},
    notice: null,
    error: null,
    busy: null,
    reload: noop,
    setLab: () => {},
    commitVersion: noop,
    loadImportCandidates: noop,
    importPicked: noop,
    addSamples: noop,
    assignSplit: async () => {},
    duplicateSelected: noop,
    saveCase: async () => {},
    setReview: async () => {},
    previewAlign: noop,
    commitAlign: noop,
    runSuite: async () => {},
    rerunLast: noop,
    ...extra,
  };
}

function readable(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
}

describe('Evaluation set', () => {
  it('states counts, lane readiness, and the spec columns', () => {
    const lab = workspace([
      row({ id: 'case_001', question: 'How many active players?', groundTruthSql: 'SELECT 1', expectedFacts: '10', review: 'reviewed' }),
      row({ id: 'case_002', question: 'Held out', split: 'held_out', review: 'draft' }),
      row({ id: 'case_003', question: 'Retired', retired: true, review: 'approved', groundTruthSql: 'SELECT 2' }),
    ]);
    const prose = readable(
      renderToStaticMarkup(
        <EvaluationSetTable
          lab={lab}
          selectedIds={[]}
          expandedId=""
          reviewerOnly={false}
          onToggle={() => {}}
          onExpand={() => {}}
        />
      )
    );
    expect(lab.headerLine).toBe('3 cases · 2 active · 1 retired · 1 reviewed · 1 held out');
    expect(lab.laneLine).toBe('Genie lane ready 1 · agent lane ready 1');
    expect(prose).toContain('Question or conversation');
    expect(prose).toContain('case_001');
    expect(prose).toContain('locked held-out');
    expect(prose).toContain('Reviewed');
    expect(prose).toContain('manual');
  });

  it('keeps sample questions in the empty state and has no demo-data header button', () => {
    const source = readFileSync(new URL('./EvaluationSet.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Load the six demo/i);
    expect(source).not.toMatch(/demo-data/i);
    const markup = renderToStaticMarkup(<EvaluationSet lab={model(workspace([]))} />);
    const prose = readable(markup);
    expect(prose).toContain(POC_STARTER_QUESTIONS[0]);
    expect(prose).toContain('Add these sample questions');
    expect(prose).not.toContain('Sample questions for an empty set');
    expect(prose).not.toContain('They are not a scored result');
    expect(prose).toContain('Import from traces');
    expect(prose).not.toContain('Import filters:');
  });

  it('lays matching turns as a four-across card grid without reason tags', () => {
    const questions = [
      'how many users used either a northwind game or a 2k game this year?',
      'show me VLH player trends',
    ];
    const markup = renderToStaticMarkup(
      <EvaluationSet
        lab={model(workspace([]), {
          candidates: questions.map((question) => ({
            question,
            sourceTraceId: question,
            reasons: ['latency' as const],
          })),
          picked: questions,
        })}
      />
    );
    const prose = readable(markup);
    expect(markup).toContain('bench-turn-grid');
    expect(markup).toContain('bench-turn-card');
    expect(markup).toContain('bench-turn-icon');
    expect(prose).toContain('Keep turns with');
    expect(prose).toContain('Add 2 to the dataset');
    expect(prose).toContain(questions[0]);
    expect(markup).not.toContain('eval-curate-list');
    expect(prose).not.toContain('Pick the matching turns to add');
    const cards = markup.match(/bench-turn-question[^>]*>([^<]*)</g)?.join(' ') ?? '';
    expect(cards).toContain(questions[0]);
    expect(cards).not.toContain('latency');
  });

  it('names stage 01 actions the spec uses', () => {
    const markup = renderToStaticMarkup(<CurateStageControls lab={model(workspace([]))} />);
    const prose = readable(markup);
    expect(prose).toContain('Import from Ask and Monitoring traces');
    expect(prose).toContain('New dataset version');
    expect(prose).toContain('Assign tuning / held-out split');
    expect(prose).toContain('Open reviewer queue');
    expect(prose).toContain('Duplicate as edge case');
    expect(markup).toContain('bench-chip');
  });

  it('renders tags as capsules and per-case guidelines in the editor', () => {
    const markup = renderToStaticMarkup(
      <EvaluationSet lab={model(workspace([row({ id: 'case_001', question: 'How many active players?' })]), { expandedId: 'case_001' })} />
    );
    expect(markup).toContain('bench-tag-capsule');
    expect(readable(markup)).toContain('Per-case guidelines');
  });
});
