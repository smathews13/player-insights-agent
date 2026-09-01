import { describe, expect, it } from 'vitest';
import {
  attachRecordedStages,
  carriesEvidence,
  foldRecordedStages,
  proseOnlyAnswer,
  PROSE_ONLY_ANSWER_CAVEAT,
  PROSE_ONLY_FALLBACK_TAKEAWAY,
} from './prose-only-answer';
import { DEGRADED_ANSWER_MARKER } from './setup-remedies';

const PROSE = 'VLH Online leads the last 30 days.\n\nThe gap widened after the summer update.';

/**
 * Populated sections to assert against, defined here rather than imported.
 *
 * They used to be the app's own stored demo answer, which is gone. Local
 * fixtures are better for this file anyway: what these assertions care about is
 * that a section is non-empty, not what was in it, and a shared constant made
 * the test read as though the prose-only answer had a seed to borrow from.
 */
const SOME_FIGURES = [{ label: 'Title A', value: 100, display: '1,000', comparison: '#1' }];
const SOME_SOURCES = [{ name: '<catalog>.<schema>.some_table', freshness: 'Current' }];
const SOME_SQL = 'SELECT 1';

describe('the answer for a prose-only reply', () => {
  it('keeps every word the agent sent', () => {
    expect(proseOnlyAnswer('msg-1', PROSE).narrative).toBe(PROSE);
  });

  it('carries nothing a reader would read as a measurement', () => {
    const answer = proseOnlyAnswer('msg-1', PROSE);
    expect(answer.figures).toEqual([]);
    expect(answer.charts).toEqual([]);
    expect(answer.sources).toEqual([]);
    expect(answer.sql).toBe('');
    expect(answer.trace.stages).toEqual([]);
  });

  /**
   * The regression this module exists to prevent, asserted section by section
   * rather than on the answer as a whole. A future edit that repopulates one of
   * them passes the test above only if it happens to populate all four.
   */
  it('leaves every evidence section empty, one at a time', () => {
    const answer = proseOnlyAnswer('msg-1', PROSE);
    expect(answer.figures as unknown[]).toHaveLength(0);
    expect(answer.sources as unknown[]).toHaveLength(0);
    expect(answer.sql).toHaveLength(0);
    expect(answer.charts as unknown[]).toHaveLength(0);
  });

  it('mints no trace id, because there is no trace to find', () => {
    // A synthesised id here is worse than none: the Run Explorer and the MLflow
    // link both take it at face value and send someone looking for a trace that
    // was never recorded.
    expect(proseOnlyAnswer('msg-1', PROSE).trace.id).toBe('');
  });

  it('takes the takeaway from the agent, not from a template', () => {
    expect(proseOnlyAnswer('msg-1', PROSE).takeaway).toBe('VLH Online leads the last 30 days.');
  });

  it('skips leading blank lines rather than showing an empty takeaway', () => {
    expect(proseOnlyAnswer('msg-1', `\n\n   \n${PROSE}`).takeaway).toBe('VLH Online leads the last 30 days.');
  });

  it('describes the shape of the reply when there is no first line to use', () => {
    // Not a sentence about the question. A default takeaway with the subject in
    // it would be this module writing a finding.
    expect(proseOnlyAnswer('msg-1', '   ').takeaway).toBe(PROSE_ONLY_FALLBACK_TAKEAWAY);
  });

  it('says what is missing where the client renders it in red', () => {
    const answer = proseOnlyAnswer('msg-1', PROSE);
    expect(answer.caveats).toEqual([PROSE_ONLY_ANSWER_CAVEAT]);
    expect(PROSE_ONLY_ANSWER_CAVEAT.startsWith(DEGRADED_ANSWER_MARKER)).toBe(true);
  });

  it('does not claim tool calls or elapsed time it never measured', () => {
    const answer = proseOnlyAnswer('msg-1', PROSE);
    expect(answer.trace.toolCalls).toBe(0);
    expect(answer.trace.totalMs).toBe(0);
  });

  it('keeps the steps the stream recorded instead of storing an empty path', () => {
    const answer = proseOnlyAnswer('msg-1', PROSE, [
      { id: 'step-1', name: 'Chose the next step', kind: 'agent', status: 'complete', duration: 12 },
      { id: 'step-2', name: 'Querying governed data', kind: 'tool', status: 'running', duration: 40 },
    ]);
    expect(answer.trace.stages).toHaveLength(2);
    expect(answer.trace.stages[1]?.status).toBe('failed');
    expect(answer.trace.stages[1]?.output).toBe('');
    expect(answer.trace.toolCalls).toBe(1);
    expect(answer.trace.totalMs).toBe(52);
    expect(answer.caveats[0]).toContain('response ended before the answer format completed');
    expect(answer.caveats[0]).not.toMatch(/stopped after|no tool steps were recorded/);
  });
});

describe('folding recorded steps', () => {
  it('replaces an announcement with its completion rather than appending both', () => {
    const folded = foldRecordedStages([
      { id: 'step-1', status: 'running', duration: 0 },
      { id: 'step-1', status: 'complete', duration: 9 },
    ]);
    expect(folded.stages).toHaveLength(1);
    expect(folded.stages[0]?.status).toBe('complete');
  });

  it('re-projects generated output after settling a final running step as failed', () => {
    const folded = foldRecordedStages([
      {
        id: 'step-1',
        name: 'Choosing the next step',
        kind: 'agent',
        status: 'running',
        output: '',
      },
    ]);

    expect(folded.stages[0]?.status).toBe('failed');
    expect(folded.stages[0]?.output).toBe('The reasoning step did not complete.');
  });

  it.each(['cancelled', 'interrupted'])('normalizes a running step followed by %s', (terminalStatus) => {
    const folded = foldRecordedStages([
      { id: 'step-1', status: 'running', output: '' },
      { id: 'step-1', status: terminalStatus, output: 'Reasoning is in progress.' },
    ]);

    expect(folded.stages).toHaveLength(1);
    expect(folded.stages[0]?.status).toBe('cancelled');
    expect(folded.stages[0]?.output).toBe('The reasoning step was cancelled before completion.');
  });
});

describe('grafting stream stages onto a stored answer', () => {
  const recorded = [{ id: 's1', name: 'Chose the next step', kind: 'agent', status: 'complete', duration: 9 }];

  it('does not graft stream stages onto an answer with no MLflow id', () => {
    const answer = { trace: { id: 'trace-local', stages: [] as unknown[], totalMs: 0, toolCalls: 0 } };
    expect(attachRecordedStages(answer, recorded).trace.stages).toEqual([]);
  });

  it('does graft stream stages once a real MLflow id is present', () => {
    const answer = { trace: { id: 'tr-abc', stages: [] as unknown[], totalMs: 0, toolCalls: 0 } };
    expect(attachRecordedStages(answer, recorded).trace.stages).toHaveLength(1);
  });
});

describe('whether an answer carries evidence', () => {
  it('is false for the prose-only answer', () => {
    expect(carriesEvidence(proseOnlyAnswer('msg-1', PROSE))).toBe(false);
  });

  it('is true when any one section is populated', () => {
    const empty = proseOnlyAnswer('msg-1', PROSE);
    expect(carriesEvidence({ ...empty, figures: SOME_FIGURES })).toBe(true);
    expect(carriesEvidence({ ...empty, sources: SOME_SOURCES })).toBe(true);
    expect(carriesEvidence({ ...empty, sql: SOME_SQL })).toBe(true);
    expect(carriesEvidence({ ...empty, trace: { ...empty.trace, stages: [{}] } })).toBe(true);
  });

  it('does not count whitespace as SQL', () => {
    expect(carriesEvidence({ ...proseOnlyAnswer('msg-1', PROSE), sql: '   \n' })).toBe(false);
  });

  it('treats an answer missing the fields entirely as carrying nothing', () => {
    // Stored rows predate several of these keys. Reading an absent section as
    // present would put the stored-demo caveat on an answer nobody can check.
    expect(carriesEvidence({})).toBe(false);
  });
});

/**
 * The reported defect, which is what a reader saw on a run that ended in the
 * finder: a card headed "This question was not answered." with the model's own
 * working notes printed underneath it as though they were the answer.
 */
const PACKAGE = [
  'This question was not answered.',
  '',
  'All the data I need is in hand. Let me assemble the package.',
  '',
  '## DATA PACKAGE',
  '',
  '- **Interpretation:** Assess null ratios across the latest player activity table.',
  '- **Sources used:** a_catalog.a_schema.silver_gameplay_activity, queried via run_sql.',
  '- **Columns assessed** (grain: 1 row = 1 session):',
  '- **Findings / data:** 156,447 session rows spanning 2026-02-05 to 2026-08-03.',
  '- **Caveats & rules applied:**',
  '  - Rows outside the signup window were excluded.',
  '- **Package note:** Optional detail was clipped at the DSF handoff bound.',
].join('\n');

describe('the finder’s internal package', () => {
  it('does not reach the card as the answer', () => {
    const { narrative } = proseOnlyAnswer('msg-1', PACKAGE);

    // The apparatus, none of which is a finding and all of which was on screen.
    expect(narrative).not.toContain('DATA PACKAGE');
    expect(narrative).not.toContain('Sources used');
    expect(narrative).not.toContain('Columns assessed');
    expect(narrative).not.toContain('Package note');
    // And the scratchpad above the heading, which read as the answer's opening
    // sentence because it is the first prose on the card.
    expect(narrative).not.toContain('Let me assemble the package');
  });

  it('keeps the two sections a reader is actually shown', () => {
    const { narrative } = proseOnlyAnswer('msg-1', PACKAGE);

    expect(narrative).toContain('Assess null ratios across the latest player activity table.');
    expect(narrative).toContain('156,447 session rows spanning 2026-02-05 to 2026-08-03.');
  });

  it('moves the conditions on the answer into the caveats, without their bullets', () => {
    const { caveats } = proseOnlyAnswer('msg-1', PACKAGE);

    expect(caveats[0]).toBe(PROSE_ONLY_ANSWER_CAVEAT);
    expect(caveats).toContain('Rows outside the signup window were excluded.');
    // The card is what makes these a list; a leading dash inside a list item
    // renders as a literal dash.
    expect(caveats.some((caveat) => caveat.startsWith('-'))).toBe(false);
  });

  /**
   * The takeaway is read off the ORIGINAL text, not the split. The agent's
   * verdict is in the preamble, which the split drops, so reading it from the
   * cleaned narrative would head the card with the internal report instead of
   * removing it -- the exact opposite of the fix.
   */
  it('still headlines the card with the agent’s own verdict', () => {
    expect(proseOnlyAnswer('msg-1', PACKAGE).takeaway).toBe('This question was not answered.');
  });

  it('does not headline unanswered once the findings already hold a table', () => {
    const packaged = PACKAGE.replace(
      '156,447 session rows spanning 2026-02-05 to 2026-08-03.',
      '156,447 session rows spanning 2026-02-05 to 2026-08-03.\n\n| Title | Players |\n| VLH Online | 9575 |'
    );
    const answer = proseOnlyAnswer('msg-1', packaged);
    expect(answer.takeaway).toBe('The run reached its time limit before the answer could be composed.');
    expect(answer.narrative).toContain('| VLH Online | 9575 |');
  });

  it('does not headline a canned completion line as a finding', () => {
    const answer = proseOnlyAnswer('msg-1', 'The analysis completed from assessed sources.');
    expect(answer.takeaway).toBe(PROSE_ONLY_FALLBACK_TAKEAWAY);
    expect(answer.narrative).toBe('');
    expect(answer.takeaway).not.toContain('analysis completed');
  });

  it('leaves an ordinary prose reply completely alone', () => {
    // The common case, and the one this must not touch: no lead-ins means there
    // is no package here, only somebody's sentences.
    expect(proseOnlyAnswer('msg-1', PROSE).narrative).toBe(PROSE);
    expect(proseOnlyAnswer('msg-1', PROSE).caveats).toEqual([PROSE_ONLY_ANSWER_CAVEAT]);
  });
});
