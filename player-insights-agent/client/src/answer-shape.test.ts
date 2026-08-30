import { describe, expect, it } from 'vitest';
import { normalizeAnswer, normalizeClarification, normalizeStage, normalizeTrace } from './answer-shape';

/**
 * These tests exist because of a specific failure, and they are written to fail
 * again if it returns: an answer that reached the browser without `sources` threw
 * during render, React Router caught it, and the whole application was replaced
 * by a stack trace addressed to a developer.
 *
 * Each case below is a payload the server can legitimately emit (every answer
 * schema is a `z.looseObject` and the ask route logs contract drift rather than
 * rejecting the body), so none of these are hypothetical shapes.
 */

/** The reads AnswerCard and the trace rail perform, as the renderer performs them. */
function renderReads(answer: ReturnType<typeof normalizeAnswer>) {
  return {
    firstSource: answer.sources[0],
    sourceCount: answer.sources.length,
    figureCount: answer.figures.length,
    caveatText: answer.caveats.join(' '),
    seconds: (answer.trace.totalMs / 1000).toFixed(1),
    toolCalls: answer.trace.toolCalls,
    stageCount: answer.trace.stages.length,
    stageIds: answer.trace.stages.map((stage) => stage.id),
    rawIo: answer.trace.stages.map(({ id, input, output }) => ({ id, input, output })),
    sourceLines: answer.sources.map((source) => source.name),
  };
}

describe('normalizeAnswer', () => {
  it('survives an answer with none of the optional-on-the-wire fields', () => {
    const answer = normalizeAnswer({ id: 'msg-1', takeaway: 'A takeaway.', narrative: 'Some prose.' });
    expect(() => renderReads(answer)).not.toThrow();
    expect(renderReads(answer)).toMatchObject({
      firstSource: undefined,
      sourceCount: 0,
      figureCount: 0,
      caveatText: '',
      seconds: '0.0',
      stageCount: 0,
    });
  });

  it('survives an explicit null trace', () => {
    const answer = normalizeAnswer({ id: 'msg-2', trace: null });
    expect(() => renderReads(answer)).not.toThrow();
    expect(answer.trace.stages).toEqual([]);
    expect(answer.trace.id).toBe('');
  });

  it.each([
    ['sources', { sources: null }],
    ['sources as an object', { sources: {} }],
    ['figures', { figures: undefined }],
    ['caveats', { caveats: 'not an array' }],
    ['trace.stages', { trace: { id: 'tr-1', totalMs: 10, toolCalls: 1 } }],
    ['everything at once', {}],
  ])('does not throw on the render path when %s is unusable', (_label, payload) => {
    expect(() => renderReads(normalizeAnswer(payload))).not.toThrow();
  });

  /**
   * `runStored: false` says the answer arrived but the row behind it did not, so
   * there is no run for "Explore full run" to open. The normalizer builds a fresh
   * object from known fields, so a flag it does not carry is a flag the UI never
   * sees, and the button went on offering a link to nothing.
   *
   * Absent means stored, deliberately. Every answer reloaded from Lakebase is by
   * definition stored and none of them carry this key.
   */
  it('carries a warning that the run behind the answer was not stored', () => {
    expect(normalizeAnswer({ id: 'msg-3', runStored: false }).runStored).toBe(false);
    expect(normalizeAnswer({ id: 'msg-3', runStored: true }).runStored).not.toBe(false);
    expect(normalizeAnswer({ id: 'msg-3' }).runStored).not.toBe(false);
  });

  it('refuses to badge an answer live when the wire did not say so', () => {
    // The badge reads `mode === 'live'`. An answer whose provenance was lost is
    // exactly the one that must not be presented as a live agent response.
    expect(normalizeAnswer({}).mode).toBe('representative');
    expect(normalizeAnswer({ mode: 'nonsense' }).mode).toBe('representative');
    expect(normalizeAnswer({ mode: 'live' }).mode).toBe('live');
  });

  it('keeps a takeaway slot filled, because it is the card title', () => {
    expect(normalizeAnswer({}).takeaway).toBeTruthy();
    expect(normalizeAnswer({ takeaway: 'Real summary.' }).takeaway).toBe('Real summary.');
  });

  it('drops figures with no label rather than rendering a blank row', () => {
    const answer = normalizeAnswer({
      figures: [
        { label: 'Titan Fall', value: 42, comparison: '+3%' },
        { value: 99, comparison: '-1%' },
        { label: '', value: 1, comparison: '' },
      ],
    });
    expect(answer.figures).toHaveLength(1);
    expect(answer.figures[0].label).toBe('Titan Fall');
  });

  it('replaces a non-finite figure value, which would render a NaN-wide bar', () => {
    const answer = normalizeAnswer({
      figures: [{ label: 'Broken', value: Number.NaN, comparison: '' }],
    });
    expect(Number.isFinite(answer.figures[0].value)).toBe(true);
  });

  it('drops non-string caveats instead of printing [object Object]', () => {
    const answer = normalizeAnswer({ caveats: ['Real caveat.', { note: 'nope' }, null, '  '] });
    expect(answer.caveats).toEqual(['Real caveat.']);
    expect(answer.caveats.join(' ')).not.toContain('object');
  });

  it('drops sources with no name, which are unlabelled rows in the source strip', () => {
    const answer = normalizeAnswer({
      sources: [{ name: 'players.activity', freshness: '2h' }, { freshness: '3h' }, null],
    });
    expect(answer.sources).toEqual([{ name: 'players.activity', freshness: '2h' }]);
  });

  it('passes charts through untouched so AnswerCharts keeps its own boundary', () => {
    const charts = [{ id: 'c1', data: [], layout: {} }];
    expect(normalizeAnswer({ charts }).charts).toBe(charts);
    expect(normalizeAnswer({}).charts).toBeUndefined();
  });
});

describe('normalizeStage', () => {
  it('gives every stage a distinct id, because the id is the React key', () => {
    const stages = normalizeTrace({ stages: [{}, {}, {}] }).stages;
    const ids = stages.map((stage) => stage.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps a real id when there is one', () => {
    expect(normalizeStage({ id: 'plan' }, 0).id).toBe('plan');
  });

  it('falls back to a drawable status rather than an unknown one', () => {
    expect(normalizeStage({ status: 'exploded' }, 0).status).toBe('complete');
    expect(normalizeStage({ status: 'failed' }, 0).status).toBe('failed');
  });

  it('canonicalizes reader-facing lifecycle status aliases', () => {
    expect(normalizeStage({ status: 'succeeded' }, 0).status).toBe('complete');
    expect(normalizeStage({ status: 'interrupted' }, 0).status).toBe('cancelled');
    expect(normalizeStage({ status: 'canceled' }, 0).status).toBe('cancelled');
    expect(normalizeStage({ status: 'awaiting approval' }, 0).status).toBe('awaiting_approval');
  });

  it('distinguishes an absent depth from depth zero', () => {
    // The timeline indents on depth. Defaulting an absent depth to 0 would claim
    // a model version that does not report nesting had reported it as flat.
    expect(normalizeStage({}, 0).depth).toBeUndefined();
    expect(normalizeStage({ depth: 0 }, 0).depth).toBe(0);
    expect(normalizeStage({ depth: 2 }, 0).depth).toBe(2);
  });

  it('drops an empty parent_id so it cannot match another stage', () => {
    expect(normalizeStage({ parent_id: '' }, 0).parent_id).toBeUndefined();
    expect(normalizeStage({ parent_id: 'plan' }, 0).parent_id).toBe('plan');
  });

  it('keeps only named table entries from the discovery projection', () => {
    expect(
      normalizeStage(
        {
          tables: [' <your_catalog>.<your_schema>.gold_title_daily ', '', 42],
        },
        0
      ).tables
    ).toEqual(['<your_catalog>.<your_schema>.gold_title_daily']);
  });

  it('normalizes legacy stored stage prompts before any renderer receives them', () => {
    const stage = normalizeStage(
      {
        id: 'data_source_finder',
        name: 'Data Source Finder',
        kind: 'agent',
        status: 'complete',
        input:
          'Discovery intent: what data do you have access to? Return the assessed package. Do not refer to earlier turns; none are available.',
        output: '# Role\nNever expose identifiers.\n## DATA PACKAGE',
      },
      0
    );

    expect(stage.input).toBe('Identify the governed data available for this question.');
    expect(stage.output).toBe('Prepared an assessed data package from governed sources.');
    expect(`${stage.input} ${stage.output}`).not.toMatch(/do not|never|return the|earlier turns|none are available/i);
  });
});

/**
 * The provenance marker has to survive normalization, and silence has to survive
 * it too. `normalizeAnswer` fills every field the UI reads so no render path
 * meets an absent one, and this is the one field where filling it in would be
 * the bug: an answer nobody stated a provenance for must not arrive looking like
 * one that did.
 */
describe('normalizeAnswer and the provenance marker', () => {
  it('carries the three the server can mean', () => {
    expect(normalizeAnswer({ provenance: 'live' }).provenance).toBe('live');
    expect(normalizeAnswer({ provenance: 'mixed' }).provenance).toBe('mixed');
    expect(normalizeAnswer({ provenance: 'stored' }).provenance).toBe('stored');
  });

  it('leaves it absent when the answer did not carry one', () => {
    // Every answer stored before the server started stating this. Absent is a
    // fourth outcome the disclosure logic reads, not a missing default.
    expect(normalizeAnswer({ id: 'msg-old', mode: 'live' }).provenance).toBeUndefined();
  });

  it.each([
    ['a word from a newer server', 'partially-live'],
    ['a number', 7],
    ['null', null],
  ])('drops %s rather than passing it to the renderer', (_label, value) => {
    expect(normalizeAnswer({ provenance: value }).provenance).toBeUndefined();
  });
});

/**
 * The claim the answer footer reads to say whose grants the figures were computed
 * under. Absence is a real outcome here for the same reason it is for provenance,
 * and it matters more: the footer prints no identity line at all when this is
 * absent, so anything this function invents becomes a sentence naming somebody.
 */
describe('normalizeAnswer and the identity the run executed as', () => {
  it('carries the claim the server attached to a live reply', () => {
    expect(
      normalizeAnswer({ execution_identity: { mode: 'signed_in_user', verified: true } }).executionIdentity
    ).toEqual({ mode: 'signed_in_user', verified: true });
    expect(
      normalizeAnswer({ execution_identity: { mode: 'app_service_principal', verified: false } }).executionIdentity
    ).toEqual({ mode: 'app_service_principal', verified: false });
  });

  it('leaves it absent for a stored answer body, which carries no claim at all', () => {
    // The stored response of any turn reloaded from the rail. The identity of
    // the run is recorded in columns beside it rather than inside it, so this
    // function is given nothing and invents nothing; the caller reads those
    // columns and hands the claim in. When there were no columns to read -- every
    // turn taken before they existed -- nothing arrives here either and the
    // footer prints no identity line, which is all that record supports.
    expect(normalizeAnswer({ id: 'msg-stored', mode: 'live' }).executionIdentity).toBeUndefined();
  });

  /**
   * The transcript keeps each turn as the row it will be reloaded as, and for the
   * turn that just ran that row holds the already-normalized answer, so every
   * render normalizes it again. Every other field survives that because its wire
   * name and its normalized name are the same word. This one is renamed on the
   * way through, and so was dropped on the second pass: a live answer stated its
   * identity and then stopped, one render later, with nothing having happened.
   */
  it('carries a claim it has already normalized once, so a re-render cannot lose it', () => {
    const once = normalizeAnswer({ execution_identity: { mode: 'signed_in_user', verified: true } });
    expect(normalizeAnswer(once).executionIdentity).toEqual({ mode: 'signed_in_user', verified: true });
  });

  it.each([
    ['a mode with no verification flag', { mode: 'signed_in_user' }],
    ['a flag with no mode', { verified: true }],
    ['an empty mode', { mode: '   ', verified: true }],
    ['a flag that is not a boolean', { mode: 'signed_in_user', verified: 'yes' }],
    ['a string instead of a record', 'signed_in_user'],
    ['null', null],
  ])('drops %s rather than completing it', (_label, value) => {
    expect(normalizeAnswer({ execution_identity: value }).executionIdentity).toBeUndefined();
  });
});

describe('normalizeClarification', () => {
  it('survives a clarification with no trace and no options', () => {
    const asked = normalizeClarification({ id: 'clar-1', question: 'Which titles?' });
    expect(() => asked.trace.stages.map((stage) => stage.id)).not.toThrow();
    expect(asked.options).toEqual([]);
    expect(asked.trace.stages).toEqual([]);
  });

  it('keeps a question on screen even when the wire omitted it', () => {
    expect(normalizeClarification({}).question).toBeTruthy();
  });
});
