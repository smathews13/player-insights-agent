/**
 * Which caveats a reader sees first, and which two of them were the same one.
 *
 * A real answer arrives with seven to thirteen caveats and every one of them
 * was rendered, in the agent's order, as an equal bullet. The report was that
 * this is unreadable, and the specific damage is that the agent's order is not a
 * risk order: on the answer that prompted this, "a governance control refused
 * part of this request" and "the sources for this answer are incomplete" sat
 * above a boilerplate identity line and two separate statements that the data is
 * synthetic, and a reader who stops after three bullets had read the two that
 * change nothing about the figures.
 *
 * So the list is ordered by what a caveat threatens, three stay visible, and
 * the rest go behind "show more". The identity-and-row-filter lecture is the
 * one exception: it is not a risk note, so it is dropped rather than folded.
 *
 * WHY THE ORDER IS DECIDED HERE AND NOT IN THE AGENT. `_assemble` in agent.py
 * chooses each insert position deliberately and documents the reason at each
 * one, and this file used to defer to that entirely. It still does for anything
 * it cannot rank: two caveats of equal risk stay in the order they arrived, so
 * the agent's reasoning survives wherever this module has nothing to say. What
 * the agent cannot know is how many of them a person will read, which is what
 * changed.
 */
import { DEGRADED_ANSWER_MARKER } from '../../shared/setup-remedies';

/**
 * How much a caveat threatens the figures above it, lowest first.
 *
 * Numbered rather than named in the sort so that the tiers are orderable, and
 * named here so a test can state which tier it expects rather than a number
 * whose meaning would drift the first time one is inserted.
 */
export const CAVEAT_RISK = {
  /**
   * The answer is not the whole answer to the question asked. A refusal, or a
   * degradation, which is the same statement in stronger form.
   *
   * ALWAYS VISIBLE. Nothing else can outrank it, so it cannot be pushed behind
   * the toggle by a run that happens to produce five other serious caveats.
   */
  refused: 0,
  /** Part of the evidence is unaccounted for: unknown tables, a truncated run. */
  evidence: 1,
  /** A number was computed over something with no governed definition. */
  undefined: 2,
  /** The window or the population is not the one the question named. */
  coverage: 3,
  /** The number is real but does not mean what its label implies. */
  aggregation: 4,
  /** Something true was left out of the figures for room. */
  omitted: 5,
  /**
   * Unrecognised.
   *
   * Deliberately ABOVE identity and deployment boilerplate rather than last. A
   * caveat this file cannot classify is one of unknown severity, and the two
   * tiers below it are the only two the reader explicitly ranked as ignorable.
   * Ranking an unknown warning under a line about synthetic data would be this
   * module asserting something about a sentence it just admitted it cannot read.
   */
  unclassified: 6,
  /** Whose grants the run read under. Boilerplate on every answer. */
  identity: 7,
  /** A standing fact about the deployment rather than about this answer. */
  deployment: 8,
} as const;

export type CaveatRisk = (typeof CAVEAT_RISK)[keyof typeof CAVEAT_RISK];

/**
 * The phrases each tier is recognised by, tested in this order.
 *
 * Phrases from live answers rather than invented, which is why several read
 * oddly specific. They are matched case-insensitively against the whole caveat,
 * and the FIRST tier with a hit wins -- so a caveat that says both that a
 * control refused something and that the data is synthetic is ranked by the
 * refusal, which is the reading a person would give it.
 *
 * Two orderings matter and neither is cosmetic. `refused` and `evidence` are
 * tested before everything else so that a caveat which also mentions
 * aggregation cannot be demoted by the mention. And `identity` is tested before
 * `deployment` but after all six risk tiers, because the identity line ends
 * "figures here may be computed from a subset of the rows another reader would
 * see" -- which is a real qualification on the numbers, and which the reader
 * nevertheless ranked below every tier above it. That instruction is followed
 * rather than second-guessed, and the pattern is anchored on the disclosure's
 * own wording so it cannot swallow a different caveat that happens to mention
 * permissions.
 */
const RISK_PATTERNS: readonly (readonly [CaveatRisk, readonly RegExp[]])[] = [
  [
    CAVEAT_RISK.refused,
    [
      /\brefus(?:ed|al|es)\b/,
      /\bdenied\b/,
      /\bnot authori[sz]ed\b/,
      /\baccess was blocked\b/,
      /\bwas blocked\b/,
    ],
  ],
  [
    CAVEAT_RISK.evidence,
    [
      /sources for this answer are incomplete/,
      /could not be determined/,
      /\bstopped early\b/,
      /turn deadline/,
      /budget (?:for this turn was spent|exhaustion|was exhausted)/,
      /\bmay be incomplete\b/,
      /\bunanaly[sz]ed\b/,
      /\bwas not queried\b/,
      /\bnot retrieved\b/,
    ],
  ],
  [
    CAVEAT_RISK.undefined,
    [
      /not (?:formally )?(?:documented|defined)/,
      /\bundocumented\b/,
      /\babsent from the governed data dictionary\b/,
      /no governed [a-z ]*definition/,
      /precise definition/,
      /\bconstructed proxy\b/,
      /\buncertified\b/,
      /\bunverified\b/,
    ],
  ],
  [
    CAVEAT_RISK.coverage,
    [
      /\bonly \d+ of\b/,
      /\bdataset ends at\b/,
      /\bmay be unpopulated\b/,
      /in-scope activity window/,
      /\bcould understate\b/,
      /\bnot independently verified\b/,
      /\babsent from both\b/,
      /\bcannot be (?:determined|established|confirmed)\b/,
    ],
  ],
  [
    CAVEAT_RISK.aggregation,
    [
      /\bnot additive\b/,
      /\bplayer-days\b/,
      /\bnot a session-weighted mean\b/,
      /\bcomputed as AVG/,
      /\baggregat(?:ed|es|ing) across\b/,
      /\bscaled relative to\b/,
      /\bper-day averages\b/,
      /\bgrain\b/,
    ],
  ],
  [
    CAVEAT_RISK.omitted,
    [/\bomitted from (?:the )?figures\b/, /\bnot shown in (?:the )?figures\b/, /\bfigure limit\b/],
  ],
  [
    CAVEAT_RISK.identity,
    [
      /\bwas produced as\b/,
      /covers only the data that identity is granted/,
      /row filters and column masks/,
      /grant evaluation happens at query time/,
      /unity catalog still evaluates/,
      /declared by the deployment/,
      /declared source set/,
      /tables this deployment declares/,
      /may not have SELECT access/,
    ],
  ],
  /**
   * NOT LEFTOVERS. Nothing in this repository produces these sentences any more:
   * the caveat constant, the deployment setting and the prompt branch that asked
   * for them were all removed, and the prompt now forbids the claim outright.
   *
   * These patterns stay because they DEMOTE such a sentence rather than emit one.
   * The synthesiser writes its own caveats and can still volunteer that the data
   * is demo data despite being told not to. Matched here it ranks last and lands
   * behind the fold; deleted from here it falls through to `unclassified`, which
   * sits five tiers HIGHER and would put a model's stray sentence in the five a
   * reader is shown. Removing them to tidy away the word makes the thing they
   * guard against more visible, not less.
   */
  [
    CAVEAT_RISK.deployment,
    [
      /\bsynthetic\b/,
      /\brepresentative,? not live production\b/,
      /\bdemonstration purposes\b/,
      /\bdoes not represent real\b/,
      /\bdo not represent real\b/,
    ],
  ],
];

/**
 * Standing fact about how Unity Catalog grants are checked later, not a denial
 * of this request.
 *
 * The usual wording says "any refused table will be named if a query fails".
 * That is a grant-timing caveat, and the word `refused` in it is why this must
 * be read before the refused regex. Today's honesty banner was treating the
 * sentence as "Request refused" on a catalog listing that had already answered.
 */
const GRANT_TIMING_NOTE =
  /grant evaluation happens at query time|unity catalog still evaluates|declared by the deployment|declared source set|tables this deployment declares|any refused table will be named|may not have SELECT access|if a query against (?:it|them) fails/i;

/**
 * The standing lecture that every authorized answer used to open with: who it
 * ran as, and that row filters can silently narrow the rows.
 *
 * Not a finding about this answer's figures. Dropped in {@link rankCaveats}
 * rather than ranked last, so a stored answer that still carries it does not
 * show it, and a model that volunteers it does not get it onto the card.
 */
const IDENTITY_GRANT_LECTURE =
  /covers only the data that identity is granted|row filters and column masks apply without reporting themselves|this answer was produced as /i;

/** Whether this caveat is the identity / row-filter lecture, not a real risk note. */
export function isIdentityGrantLecture(caveat: string): boolean {
  return IDENTITY_GRANT_LECTURE.test(caveat);
}

/**
 * The request itself was denied. A grant-timing note that also says this is
 * still a refusal; one that only mentions a table that *would* be named later
 * is not.
 */
const ACTUAL_REFUSAL =
  /governance control refused|refused part of this request|(?:this|the) request was refused|access was (?:refused|blocked|denied)|not authori[sz]ed/i;

/**
 * What this caveat threatens.
 *
 * A degradation is checked before the patterns because its marker is the app's
 * own constant rather than the agent's prose: `AnswerCard` lifts these out into
 * a banner of their own and so never asks, but the Run Explorer has no banner
 * to lift one into and renders it in the list, where it has to lead.
 *
 * Grant-timing is checked next, before the refused regex, for the reason on
 * {@link GRANT_TIMING_NOTE}.
 */
export function caveatRisk(caveat: string): CaveatRisk {
  const text = caveat.trim();
  if (text.startsWith(DEGRADED_ANSWER_MARKER)) return CAVEAT_RISK.refused;
  if (GRANT_TIMING_NOTE.test(text) && !ACTUAL_REFUSAL.test(text)) return CAVEAT_RISK.identity;
  for (const [risk, patterns] of RISK_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) return risk;
  }
  return CAVEAT_RISK.unclassified;
}

/**
 * The claims two different caveats can confidently be making at once.
 *
 * A whitelist, and a short one, because the cost of the two errors is nowhere
 * near equal: showing one redundant line wastes a reader's time, and merging two
 * caveats that were not the same warning deletes a disclosure nobody will know
 * was missing. So this collapses only where the topic is a STANDING FACT about
 * the deployment or the run rather than a finding about this answer's numbers.
 *
 * `synthetic` is here for the reported case, in which the same claim about the
 * whole dataset arrived twice from two different producers. NEITHER PRODUCER
 * EXISTS NOW -- the appended constant and the prompt branch that asked the
 * synthesiser for it were both removed -- so this entry is a BACKSTOP rather
 * than a leftover, and deleting it is not the tidy-up it looks like. The
 * synthesiser can still volunteer the claim against instructions, and if it ever
 * volunteers it twice this is what stops a reader being told the same thing in
 * two consecutive bullets. It is safe to collapse because such sentences make
 * one claim about the whole dataset and carry no figure, table, date or
 * threshold, so there is no detail in one that the other could be losing.
 *
 * NOTHING THAT NAMES A NUMBER OR A COLUMN BELONGS IN THIS LIST. Two coverage
 * caveats about two different date ranges, or two aggregation caveats about two
 * different columns, read as near-duplicates to any similarity measure and are
 * not duplicates at all. That is why this is a topic whitelist and not a
 * distance threshold.
 *
 * EACH CLAIM IS GATED ON THE TIER IT BELONGS TO, which is the guard that makes
 * the whitelist safe rather than merely short. Matching `synthetic` on wording
 * alone would collapse "a governance control refused part of this request, and
 * the figures that remain are synthetic" into a line about synthetic data and
 * lose the refusal -- a sentence no reviewer would write on purpose and exactly
 * the sentence a model eventually will. Requiring the tier as well means only
 * caveats that this module has already read as standing deployment facts can
 * merge with one another.
 */
const SAME_CLAIM: readonly (readonly [string, CaveatRisk, RegExp])[] = [
  ['synthetic', CAVEAT_RISK.deployment, /\bsynthetic\b/i],
  ['identity', CAVEAT_RISK.identity, /covers only the data that identity is granted/i],
];

/**
 * The claim a caveat is making, or its own normalised text when it makes none
 * this module recognises.
 *
 * Falling back to the normalised text means two caveats that differ only in
 * casing, punctuation or whitespace still collapse, which is the one merge that
 * needs no judgement at all.
 */
function claimOf(caveat: string, risk: CaveatRisk): string {
  for (const [claim, tier, pattern] of SAME_CLAIM) {
    if (risk === tier && pattern.test(caveat)) return claim;
  }
  return caveat
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface RankedCaveats {
  /** Shown by default, highest risk first. */
  top: string[];
  /** Behind the toggle, the same ranking continued. Never dropped. */
  rest: string[];
  /** How many were collapsed as restatements, for a test to hold this honest. */
  merged: number;
  /** Identity / row-filter lectures that never reach the card. */
  dropped: number;
}

/**
 * The caveats as they should be read: ranked, deduplicated, split at the fold.
 *
 * The sort is by tier and then by arrival, and `Array.prototype.sort` has been
 * stable since ES2019, but the index is compared explicitly anyway. A reader
 * comparing two answers has to see the same list in the same order both times,
 * and that guarantee is worth more than the two characters saved by relying on
 * it.
 */
export function rankCaveats(caveats: readonly string[], limit = 5): RankedCaveats {
  const kept: { text: string; risk: CaveatRisk; index: number }[] = [];
  const claims = new Set<string>();
  let merged = 0;
  let dropped = 0;

  caveats.forEach((caveat, index) => {
    const text = caveat.trim();
    if (!text) return;
    if (isIdentityGrantLecture(text)) {
      dropped += 1;
      return;
    }
    const risk = caveatRisk(text);
    const claim = claimOf(text, risk);
    if (claims.has(claim)) {
      merged += 1;
      return;
    }
    claims.add(claim);
    kept.push({ text, risk, index });
  });

  kept.sort((left, right) => left.risk - right.risk || left.index - right.index);
  const ordered = kept.map((entry) => entry.text);
  return { top: ordered.slice(0, limit), rest: ordered.slice(limit), merged, dropped };
}
