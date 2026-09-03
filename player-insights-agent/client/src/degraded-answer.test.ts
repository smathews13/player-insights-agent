import { describe, expect, it } from 'vitest';
import {
  answerBadge,
  answerContentProvenance,
  answerFallback,
  answerFallbackNotice,
  ANSWER_FALLBACK_NOTICES,
  DEGRADED_ANSWER_MARKER,
  isDegradationCaveat,
  splitCaveats,
} from './degraded-answer';
import { REPRESENTATIVE_ANSWER_CAVEAT } from '../../shared/representative-answer';

/**
 * Whether the app can still tell that an answer was built on fallback data.
 *
 * The incident: a Genie space that had never been shared with the agent's
 * serving principal refused every call, the agent answered from its SQL
 * fallback instead, and the only sign was one sentence third in a list of five
 * under the heading "Caveats", beneath four boilerplate caveats
 * the reader had seen on every previous answer. The figure was acted on.
 *
 * These cover the two halves of the fix that live in the browser: recognising
 * the sentence, and (just as important), not recognising sentences that are
 * not it.
 */

describe('recognising a degradation', () => {
  it('matches the marker the agent actually writes', () => {
    // Pinned literally, on both sides of the wire. The agent is a serving
    // endpoint released separately from this app and in either order, so
    // nothing at build time can catch the two disagreeing, only a test that
    // writes the string out in full, in each repository, and fails when
    // somebody edits one of them.
    expect(DEGRADED_ANSWER_MARKER).toBe('This answer is degraded:');
  });

  it('recognises the Genie refusal caveat', () => {
    expect(
      isDegradationCaveat(
        'This answer is degraded: Genie space 01ef REFUSED the agent’s serving principal, so it was ' +
          'not consulted and anything answered here came from another surface instead.'
      )
    ).toBe(true);
  });

  it('recognises the surface-outage caveat, which is the same class of statement', () => {
    expect(
      isDegradationCaveat('This answer is degraded: the governed data Genie space did not respond during this run.')
    ).toBe(true);
  });

  it('tolerates leading whitespace, which string concatenation produces', () => {
    expect(isDegradationCaveat('  This answer is degraded: something happened.')).toBe(true);
  });
});

describe('not crying wolf', () => {
  it('leaves an ordinary caveat alone', () => {
    expect(isDegradationCaveat('Refunds are already netted into the bookings figure.')).toBe(false);
  });

  it('does not fire on an analytical finding that happens to use the word', () => {
    // A keyword search for "degraded" would light a red panel over a correct
    // answer, and a warning shown when nothing is wrong is one nobody reads
    // when something is. This is a perfectly ordinary sentence in this domain.
    expect(isDegradationCaveat('Session throughput degrades above 40k concurrent players in this window.')).toBe(false);
  });

  it('does not fire on a caveat that merely mentions Genie or a permission', () => {
    expect(isDegradationCaveat('The Genie space rounds figures below 100 to the nearest ten.')).toBe(false);
  });
});

describe('splitting an answer’s caveats', () => {
  it('lifts the degradations out and keeps everything else in order', () => {
    const { degraded, ordinary } = splitCaveats([
      'This answer is degraded: Genie space 01ef refused the serving principal.',
      'Refunds are already netted into bookings.',
      'Acme player data in this demo is synthetic.',
    ]);

    expect(degraded).toHaveLength(1);
    // Order preserved: the ordinary list is read as prose and reshuffling it
    // would put the qualifier after the thing it qualifies.
    expect(ordinary).toEqual([
      'Refunds are already netted into bookings.',
      'Acme player data in this demo is synthetic.',
    ]);
  });

  it('drops nothing when it recognises nothing', () => {
    // The failure mode that must not exist. If the agent's wording changes and
    // the marker stops matching, the caveat has to keep appearing in the
    // ordinary list, less prominent, never absent. A split that silently ate
    // an unrecognised caveat would turn a wording drift into a suppression.
    const caveats = ['Refunds are already netted into bookings.', 'A caveat in some future wording.'];
    const { degraded, ordinary } = splitCaveats(caveats);

    expect(degraded).toEqual([]);
    expect(ordinary).toEqual(caveats);
  });

  it('reports nothing degraded for a correctly configured run', () => {
    // The other half of "no new warnings where things are right": an answer
    // from a deployment whose Genie spaces are shared carries no marker, so
    // the red panel and the badge never appear.
    const { degraded } = splitCaveats([
      'Active means an in-scope gameplay session in the latest 30-day window.',
      'Acme player data in this demo is synthetic.',
    ]);

    expect(degraded).toEqual([]);
  });
});

/**
 * Whether the card leads with the answer or with a warning about it.
 *
 * The server can serve its own stored demo response and still return HTTP 200
 * with `type: 'answer'`, deliberately, so a live customer demo keeps working
 * when the endpoint does not. What it must never do is let that answer look
 * like the others: complete, confident, five plausible figures, and a grey
 * chip reading "Representative response" that scans as a mode label rather
 * than as a warning.
 */
describe('deciding whether a card may be read as an answer', () => {
  const liveCaveats = ['Active means an in-scope gameplay session in the latest 30-day window.'];

  it('leaves a live answer alone', () => {
    expect(answerFallback({ mode: 'live', caveats: liveCaveats })).toBeNull();
  });

  /**
   * The route that produced this is gone: the ask path no longer answers a
   * failed question with the stored demo response on any target. The rule is
   * kept because it still fires on rows stored while it did, which reload from
   * `response_json` and must keep the warning they were written with, and on
   * the seeded conversations a demo deployment still shows.
   */
  it('flags a stored demo response that reached the card with a reason attached', () => {
    expect(
      answerFallback({
        mode: 'representative',
        caveats: [
          `${DEGRADED_ANSWER_MARKER} the agent endpoint call failed (socket hang up), so every figure ` +
            'below is the stored demo response.',
          ...liveCaveats,
        ],
      })
    ).toBe('representative');
  });

  it('flags a stored demo conversation, which carries no reason to quote', () => {
    // The rows served when Lakebase is unreachable, and the client's own
    // fallback answer. Neither carries a degradation caveat, and both are just
    // as canned, so the card still has to lead with a warning.
    expect(answerFallback({ mode: 'representative', caveats: liveCaveats })).toBe('representative');
  });

  it('separates the agent answering on fallback data from the app answering instead of it', () => {
    // Two different failures with two different owners. The agent answered
    // here, from a surface it fell back to; nobody answered in the case above.
    expect(
      answerFallback({
        mode: 'live',
        caveats: [`${DEGRADED_ANSWER_MARKER} the governed data Genie space did not respond.`],
      })
    ).toBe('degraded-data');
  });

  /**
   * The guard against the bug that put a "Synthetic demo data" badge over a
   * customer's production figures.
   *
   * `REPRESENTATIVE_ANSWER_CAVEAT` looks like the signal to key on and is not
   * one: the server derives it from the absence of an MLflow trace id, so a
   * genuinely live answer from a workspace with tracing switched off carries
   * it too. Leading that answer with "these are not your figures" would be a
   * false alarm on real data, and false alarms are how a warning stops being
   * read.
   */
  it('does not call a live answer representative just because it has no MLflow trace', () => {
    expect(answerFallback({ mode: 'live', caveats: [REPRESENTATIVE_ANSWER_CAVEAT, ...liveCaveats] })).toBeNull();
  });

  it('errs toward warning when the wire lost the mode', () => {
    // `normalizeAnswer` defaults an unreadable mode to 'representative' rather
    // than to 'live', and this agrees with it: an answer whose provenance did
    // not survive is exactly the one not to badge as a live agent response.
    expect(answerFallback({ mode: '', caveats: liveCaveats })).toBe('representative');
  });
});

/**
 * The half-live answer, and the two ways of getting it wrong.
 *
 * The endpoint can reply in prose rather than with a result. The ask route keeps
 * the words and puts them over the stored demo response's figures, sources, SQL
 * and stages, and labels the whole thing `mode: 'live'`, correctly, since a run did
 * happen. The card badged it "Live agent response" and said nothing else, so a
 * reader was told five invented numbers had been computed for their question.
 *
 * The fix is a marker the server sets, not a sentence the browser recognises.
 * The failure mode on the other side is worse than the bug: hedging every
 * ordinary answer makes a demo unusable and teaches people to skip the warning
 * that matters, so both directions are pinned here.
 */
describe('reading the provenance the server stated', () => {
  const liveCaveats = ['Active means an in-scope gameplay session in the latest 30-day window.'];

  it('warns on an answer whose figures are stored, however it is worded', () => {
    // No degradation caveat at all: the point of the marker is that the badge
    // stops depending on a sentence surviving a wording change downstream.
    expect(answerFallback({ mode: 'live', provenance: 'mixed', caveats: liveCaveats })).toBe('degraded-data');
  });

  it('leaves a fully live answer completely alone', () => {
    // The regression that would be worse than the bug. This is the ordinary
    // path, the one a customer sees all day.
    expect(answerFallback({ mode: 'live', provenance: 'live', caveats: liveCaveats })).toBeNull();
  });

  it('still reports the agent’s own fallback on a fully live answer', () => {
    // 'live' means the contents came from the run, not that the run went well.
    // A Genie space that refused is the agent's report about its own sources and
    // the marker says nothing about it, so it must still reach the card.
    expect(
      answerFallback({
        mode: 'live',
        provenance: 'live',
        caveats: [`${DEGRADED_ANSWER_MARKER} the governed data Genie space did not respond.`],
      })
    ).toBe('degraded-data');
  });

  it('treats a live badge over wholly stored contents as the stronger warning', () => {
    // Not reachable from the route today. If it becomes reachable, the answer is
    // that nothing on the card was queried, which is the thing worth saying.
    expect(answerFallback({ mode: 'live', provenance: 'stored', caveats: liveCaveats })).toBe('representative');
  });

  it('lets mode overrule a provenance that contradicts it', () => {
    expect(answerContentProvenance({ mode: 'representative', provenance: 'live' })).toBe('stored');
  });
});

/**
 * The card the ask route serves when the endpoint replies in prose.
 *
 * It used to be the agent's words over the stored demo response's figures,
 * sources, SQL and stage timings. Now it is the words and four empty sections,
 * and the warning over it has to say that rather than "built on fallback data",
 * which names data the reader cannot see because it is not there.
 */
describe('an answer carrying prose and nothing else', () => {
  const proseOnly = {
    mode: 'live',
    provenance: 'live',
    caveats: [`${DEGRADED_ANSWER_MARKER} the agent replied in prose rather than with a result.`],
    figures: [],
    sources: [],
    sql: '',
    trace: { id: '', stages: [] },
  };

  it('is its own state, not the agent reporting a fallback surface', () => {
    expect(answerFallback(proseOnly)).toBe('no-evidence');
  });

  it('gives an actionable retry without narrating absent work', () => {
    const notice = ANSWER_FALLBACK_NOTICES['no-evidence'];
    expect(notice.headline).not.toContain('fallback data');
    expect(notice.headline).toContain('Retry the question');
    expect(notice.headline).not.toMatch(/no steps|no structured result/i);
    expect(notice.badge).not.toBe(ANSWER_FALLBACK_NOTICES['degraded-data'].badge);
  });

  it('does not relabel successful live evidence as fallback data when another step failed', () => {
    // Partial and Caveats already disclose the failed step. These sections
    // came from this run and retain their own SQL/source provenance.
    expect(answerFallback({ ...proseOnly, figures: [{ label: 'Active', value: 1 }] })).toBeNull();
    expect(answerFallback({ ...proseOnly, sources: [{ name: 'main.player_insights.x' }] })).toBeNull();
    expect(answerFallback({ ...proseOnly, sql: 'SELECT 1' })).toBeNull();
  });

  it('uses the same actionable failure for an incomplete response after steps', () => {
    const withSteps = { ...proseOnly, trace: { id: '', stages: [{}, {}] } };
    expect(answerFallback(withSteps)).toBe('failed-after-steps');
    const notice = answerFallbackNotice(withSteps);
    expect(notice?.badge).toBe('Answer incomplete');
    expect(notice?.headline).toBe(
      'The response ended before the answer was complete. Retry the question before using this result.'
    );
    expect(notice?.tone).toBe('failed');
    expect(notice?.headline).not.toMatch(/steps|structured result/i);
  });

  it('keeps the older wording for a payload that states no sections at all', () => {
    // A stub, or a row from a build that predates the keys. An absent section is
    // not an empty one, and claiming otherwise would print "no figures" over a
    // card that has five.
    expect(
      answerFallback({
        mode: 'live',
        caveats: [`${DEGRADED_ANSWER_MARKER} the governed data Genie space did not respond.`],
      })
    ).toBe('degraded-data');
  });

  it('is not reached by an answer with no degradation caveat', () => {
    // An agent that legitimately answers a definitional question with prose and
    // no figures says so itself. Nothing here overrides that into a warning.
    expect(answerFallback({ ...proseOnly, caveats: [] })).toBeNull();
  });
});

/**
 * Silence is a fourth answer, and it is not 'live'.
 *
 * Every answer in the history table written before the marker existed comes back
 * without one, and most of them are fully live. Warning on all of them would be
 * the same false alarm this module already refuses to raise off
 * `REPRESENTATIVE_ANSWER_CAVEAT`. Claiming they are fully live is the bug the
 * marker was added to fix. So neither: the answer is "the server did not say".
 */
describe('an answer that stated no provenance', () => {
  const liveCaveats = ['Active means an in-scope gameplay session in the latest 30-day window.'];

  it('is not reported as fully live', () => {
    expect(answerContentProvenance({ mode: 'live' })).toBe('unstated');
  });

  it('does not have a word this build does not recognise read as one', () => {
    expect(answerContentProvenance({ mode: 'live', provenance: 'partially-live' })).toBe('unstated');
  });

  it('is not hedged either, so old live answers do not start disclaiming themselves', () => {
    expect(answerFallback({ mode: 'live', caveats: liveCaveats })).toBeNull();
  });

  it('still shows a degradation it does carry', () => {
    expect(
      answerFallback({
        mode: 'live',
        caveats: [`${DEGRADED_ANSWER_MARKER} the governed data Genie space did not respond.`],
      })
    ).toBe('degraded-data');
  });
});

/**
 * The chip the reader sees before anything else.
 *
 * The reported defect was a half-live answer wearing "Live agent response", so
 * the case that matters is that the chip stops saying it while the answer is
 * still not demoted to representative: the narrative really is the agent's.
 */
describe('the headline badge', () => {
  it('does not call a half-live answer a live one', () => {
    const badge = answerBadge({ mode: 'live', provenance: 'mixed' });
    expect(badge.label).toBe('Live answer, stored figures');
    expect(badge.variant).toBe('destructive');
  });

  it('does not demote a half-live answer to representative either', () => {
    expect(answerBadge({ mode: 'live', provenance: 'mixed' }).label).not.toContain('Representative');
  });

  it('leaves a fully live answer unhedged', () => {
    expect(answerBadge({ mode: 'live', provenance: 'live' })).toEqual({
      label: 'Live agent response',
      variant: 'outline',
      tone: 'live',
    });
  });

  it('gives an answer that stated nothing the live wording, as the banner does', () => {
    expect(answerBadge({ mode: 'live' }).label).toBe('Live agent response');
  });

  it('warns hardest when no run produced the contents', () => {
    expect(answerBadge({ mode: 'representative' })).toEqual({
      label: 'Representative response, not your data',
      variant: 'destructive',
      tone: 'stored',
    });
  });

  it('separates the half-stored answer from the wholly stored one for the chip', () => {
    // `variant` cannot: it is AppKit's and has no rung between fine and failure,
    // so both of these came back `destructive` and the card drew them as one
    // chip. They are different amounts of wrong. A mixed answer IS an answer to
    // the question asked and its numbers are not yours; a representative one is
    // not an answer to the question at all, and a reader has to do something
    // different about each. `tone` is what lets the stylesheet say so, and it is
    // derived here from the same decision rather than chosen again beside it.
    expect(answerBadge({ mode: 'live', provenance: 'mixed' }).tone).toBe('mixed');
    expect(answerBadge({ mode: 'representative' }).tone).toBe('stored');
    expect(answerBadge({ mode: 'live', provenance: 'mixed' }).variant).toBe(
      answerBadge({ mode: 'representative' }).variant
    );
  });
});
