import { describe, expect, it } from 'vitest';
import { CAVEAT_RISK, caveatRisk, rankCaveats } from './caveat-priority';
import { DEGRADED_ANSWER_MARKER } from '../../shared/setup-remedies';

/**
 * The order and the fold, against the answer that prompted them.
 *
 * These ten are one real answer's caveats with the workspace's own catalog name,
 * the reader's address and the title roster replaced. They are kept whole and in
 * the order they arrived, because the property under test is what this module
 * does to that order, and paraphrasing them would test the paraphrase.
 */
const REPORTED = [
  'A governance control refused part of this request, so that part is not answered here and was not ' +
    'answered another way.',
  'The sources for this answer are incomplete: part of it came from a query whose tables could not be ' +
    'determined, so the list below may omit one.',
  'This answer was produced as analyst@example.com and covers only the data that identity is granted. ' +
    'Unity Catalog row filters and column masks apply without reporting themselves, so figures here may ' +
    'be computed from a subset of the rows another reader would see.',
  'All player data behind these figures is synthetic and does not represent real players or real revenue.',
  'Source table is a_catalog.a_schema.gold_title_daily_summary (uncertified); figures are aggregated ' +
    'across all countries and labels.',
  'The field launch_campaign_sessions is not documented in the data dictionary; its precise definition ' +
    'and counting rule are unknown.',
  'The dataset ends at 2026-08-03; whether the spike sustained, declined, or continued rising after ' +
    'that date cannot be determined from this data.',
  'avg_session_minutes is computed as AVG() across country-level rows, not a session-weighted mean, so ' +
    'it may slightly misstate the true average.',
  'Bar widths (value field) are scaled relative to the spike-day maximum within each metric pair and ' +
    'are not comparable between pairs.',
  'Player records in this deployment are synthetic: the figures are representative of production, not ' +
    'drawn from real players.',
];

const REFUSAL = REPORTED[0];
const INCOMPLETE_SOURCES = REPORTED[1];
const IDENTITY = REPORTED[2];
const SYNTHETIC_FIRST = REPORTED[3];
const UNCERTIFIED = REPORTED[4];
const UNDOCUMENTED_FIELD = REPORTED[5];
const DATASET_ENDS = REPORTED[6];
const SESSION_MINUTES = REPORTED[7];
const BAR_WIDTHS = REPORTED[8];
const SYNTHETIC_LAST = REPORTED[9];

describe('what a caveat is read as threatening', () => {
  it('puts anything that says part of the request was refused at the top', () => {
    expect(caveatRisk(REFUSAL)).toBe(CAVEAT_RISK.refused);
  });

  /**
   * A degradation is the same statement in stronger form -- this may not be read
   * as an answer at all -- and it reaches this module only on the Run Explorer,
   * which has no banner to lift it into. Ranked here so that the one surface
   * showing it in the list shows it first.
   */
  it('reads a degradation as the strongest of them', () => {
    expect(caveatRisk(`${DEGRADED_ANSWER_MARKER} the agent fell back to stored data.`)).toBe(CAVEAT_RISK.refused);
  });

  it('ranks unaccounted evidence above an undefined metric, and both above coverage', () => {
    expect(caveatRisk(INCOMPLETE_SOURCES)).toBe(CAVEAT_RISK.evidence);
    expect(caveatRisk(UNDOCUMENTED_FIELD)).toBe(CAVEAT_RISK.undefined);
    expect(caveatRisk(UNCERTIFIED)).toBe(CAVEAT_RISK.undefined);
    expect(caveatRisk(DATASET_ENDS)).toBe(CAVEAT_RISK.coverage);
    expect(caveatRisk(SESSION_MINUTES)).toBe(CAVEAT_RISK.aggregation);
    expect(caveatRisk(BAR_WIDTHS)).toBe(CAVEAT_RISK.aggregation);
  });

  it('reads a truncated run as unaccounted evidence rather than as a slow one', () => {
    expect(caveatRisk('The analysis stopped early because the 90s budget for this turn was spent, so it may be incomplete.')
    ).toBe(CAVEAT_RISK.evidence);
    expect(caveatRisk('The turn deadline was reached before the answer could be written.')).toBe(CAVEAT_RISK.evidence);
    expect(caveatRisk('gold_player_180d_summary player-level data was not queried due to query budget exhaustion.')
    ).toBe(CAVEAT_RISK.evidence);
  });

  /**
   * The instruction was explicit: identity and permission notes rank below
   * everything that threatens a figure. Pinned because the identity caveat ends
   * with a real qualification on the numbers -- "figures here may be computed
   * from a subset of the rows another reader would see" -- so the natural
   * reading of its text alone would promote it, and the reader who has to
   * skim it on every single answer has ranked it anyway.
   */
  it('ranks the identity disclosure below every risk tier, and boilerplate below that', () => {
    expect(caveatRisk(IDENTITY)).toBe(CAVEAT_RISK.identity);
    expect(caveatRisk(SYNTHETIC_FIRST)).toBe(CAVEAT_RISK.deployment);
    expect(caveatRisk(SYNTHETIC_LAST)).toBe(CAVEAT_RISK.deployment);
    expect(CAVEAT_RISK.identity).toBeGreaterThan(CAVEAT_RISK.omitted);
    expect(CAVEAT_RISK.deployment).toBeGreaterThan(CAVEAT_RISK.identity);
  });

  /**
   * The tier for a sentence this module cannot read, and it is above the two the
   * reader called ignorable rather than below them. Filing an unknown warning
   * under the synthetic-data line would be this module ranking a caveat it has
   * just admitted it cannot classify.
   */
  it('files a caveat it cannot classify above identity, not last', () => {
    const unknown = 'Weekend traffic was excluded by the upstream ingestion job for reasons it does not record.';

    expect(caveatRisk(unknown)).toBe(CAVEAT_RISK.unclassified);
    expect(CAVEAT_RISK.unclassified).toBeLessThan(CAVEAT_RISK.identity);
  });
});

describe('the five a reader sees', () => {
  it('is the reported answer’s five riskiest, in risk order', () => {
    const { top } = rankCaveats(REPORTED);

    expect(top).toEqual([REFUSAL, INCOMPLETE_SOURCES, UNCERTIFIED, UNDOCUMENTED_FIELD, DATASET_ENDS]);
  });

  it('holds the rest back rather than dropping them', () => {
    const { top, rest, merged } = rankCaveats(REPORTED);

    // Ten in, one collapsed as a restatement, nine out. Asserted as a sum so
    // that a change which quietly drops one fails here rather than on a screen.
    expect(top.length + rest.length + merged).toBe(REPORTED.length);
    expect(rest).toEqual([SESSION_MINUTES, BAR_WIDTHS, IDENTITY, SYNTHETIC_FIRST]);
  });

  /**
   * The guarantee, tested as a guarantee rather than as a consequence of the
   * example above. A run can produce five caveats more alarming than a refusal
   * without the refusal becoming less important than any of them.
   */
  it('always shows a refusal, whatever else the run produced', () => {
    const crowded = [
      SESSION_MINUTES,
      DATASET_ENDS,
      UNDOCUMENTED_FIELD,
      INCOMPLETE_SOURCES,
      UNCERTIFIED,
      BAR_WIDTHS,
      REFUSAL,
    ];

    expect(rankCaveats(crowded).top[0]).toBe(REFUSAL);
  });

  /**
   * Where this module has nothing to say, the agent still decides. `_assemble`
   * chooses each insert position for a documented reason, and two caveats of
   * equal risk must not be reshuffled by a sort that has no opinion about them.
   */
  it('leaves two caveats of equal risk in the order the agent sent them', () => {
    expect(rankCaveats([BAR_WIDTHS, SESSION_MINUTES]).top).toEqual([BAR_WIDTHS, SESSION_MINUTES]);
    expect(rankCaveats([SESSION_MINUTES, BAR_WIDTHS]).top).toEqual([SESSION_MINUTES, BAR_WIDTHS]);
  });

  it('folds nothing when the answer sent five or fewer', () => {
    const { top, rest } = rankCaveats([REFUSAL, IDENTITY, SYNTHETIC_FIRST]);

    expect(top).toHaveLength(3);
    expect(rest).toEqual([]);
  });

  it('drops the empty strings a stored row can carry rather than drawing blank bullets', () => {
    const { top, rest, merged } = rankCaveats([REFUSAL, '   ', '']);

    expect(top).toEqual([REFUSAL]);
    expect(rest).toEqual([]);
    expect(merged).toBe(0);
  });
});

describe('the two bullets that were saying the same thing', () => {
  /**
   * The reported duplicate. Two producers write it -- the synthesiser's own
   * sentence, and a constant a deployment that declared itself synthetic
   * appends -- so an answer carries both, 200 words apart, and the reader saw
   * the same claim twice in a list they had already called too long.
   *
   * This reverses a decision documented in caveat-list.test.ts, which kept both
   * on the grounds that fuzzy-matching a model-written sentence in order to
   * delete a governance line is a failure mode that must not exist. That
   * reasoning stands and is why the collapse is a tier-gated whitelist rather
   * than a similarity threshold. What changed is the specific judgement about
   * this specific pair, which the reader has now made: both are standing claims
   * about the whole dataset, neither carries a figure, a column, a date or a
   * threshold, and so there is no detail in one that the other can lose.
   */
  it('collapses the two synthetic-data disclosures to one', () => {
    const { top, rest, merged } = rankCaveats(REPORTED);
    const synthetic = [...top, ...rest].filter((caveat) => caveat.includes('synthetic'));

    expect(synthetic).toEqual([SYNTHETIC_FIRST]);
    expect(merged).toBe(1);
  });

  /**
   * The failure mode the tier gate exists to prevent, and the one worth a test
   * of its own: a serious caveat that happens to use the word cannot be
   * collapsed into the boilerplate that shares it. Matching on wording alone
   * would have deleted a refusal here.
   */
  it('never merges a caveat that only mentions the word in passing', () => {
    const refusalMentioningSynthetic =
      'A governance control refused part of this request; the synthetic figures that remain cover the ' +
      'rest of it.';
    const { top, merged } = rankCaveats([refusalMentioningSynthetic, SYNTHETIC_FIRST]);

    expect(top).toEqual([refusalMentioningSynthetic, SYNTHETIC_FIRST]);
    expect(merged).toBe(0);
  });

  it('collapses two that differ only in casing, punctuation or spacing', () => {
    const { top, merged } = rankCaveats([DATASET_ENDS, `  ${DATASET_ENDS.toUpperCase()}  `]);

    expect(top).toEqual([DATASET_ENDS]);
    expect(merged).toBe(1);
  });

  /**
   * The conservative half of the rule, and the one that matters more. Two
   * coverage caveats about two different windows read as near-duplicates to any
   * distance measure and are two different warnings.
   */
  it('keeps two caveats of the same kind that report different facts', () => {
    const other = 'The dataset ends at 2026-07-11; anything after that date is absent.';
    const { top, merged } = rankCaveats([DATASET_ENDS, other]);

    expect(top).toEqual([DATASET_ENDS, other]);
    expect(merged).toBe(0);
  });
});
