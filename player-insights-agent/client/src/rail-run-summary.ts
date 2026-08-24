/**
 * What the conversation rail can say about a conversation beyond its title: the
 * status of its most recent answered turn, how long that turn took, and the
 * rating the reader gave it.
 *
 * The rail row and the Run Explorer's recorded-runs card now draw the same four
 * things, because they are two views of one list. The Explorer reads
 * `/api/runs` directly, one row per answered turn; the rail lists conversations,
 * so a conversation's several turns have to collapse into the one that is true
 * of it now. That collapse is the whole of this module, and it is here rather
 * than inline in the page so it can be tested without a browser.
 *
 * NOTHING IS INVENTED FOR A CONVERSATION WITH NO RUN. A conversation that has
 * been started and not asked, and one whose runs belong to somebody else and
 * were never sent to this browser, both arrive here as an absent entry, and the
 * row draws no status pill at all. A neutral pill reading "complete" over a
 * conversation nobody has asked anything is the kind of claim this app does not
 * make.
 */
import type { Run } from './app-types';

/**
 * The tones the status pill has, named as the classes the CSS defines rather
 * than as colours, so a rename of one is a compile error rather than a silently
 * uncoloured pill.
 *
 * These are `.ast-pill`'s own families now, not names of the rail's choosing.
 * §2 of the rebuild spec allows the app ONE status recipe, so the rail stopped
 * restating the run card's rule in its own stylesheet and started seating the
 * shared one; what is left in rail.css is the three properties a 264px column
 * needs on top of it. The neutral family is the outlined one because the
 * selected row carries a tint, and a grey fill on that wash reads as a
 * rendering fault rather than as a chip.
 */
export type RailStatusTone = 'ast-pill--pos' | 'ast-pill--neg' | 'ast-pill--warn' | 'ast-pill--neutral-outline';

export interface RailRunSummary {
  /** The store's own word for the status, unaltered. */
  status: string;
  tone: RailStatusTone;
  /** Wall time of the turn, in milliseconds, or null when it was not recorded. */
  durationMs: number | null;
  /** The reader's own rating, 1-5, or null when nobody rated it. */
  rating: number | null;
  /**
   * Whether that turn stopped before it had finished.
   *
   * True only when the server said so. An older server does not report the fact
   * at all and a run from before the column existed has no answer either way, so
   * this is false in both of those cases and the row draws nothing -- the same
   * rule the Explorer's row applies, for the same reason: a mark that is always
   * absent reads as a positive claim that nothing was cut short.
   */
  truncated: boolean;
}

/**
 * A status as one of the four tones, keyed on the word the store recorded.
 *
 * The same mapping the Run Explorer applies, deliberately restated here rather
 * than imported from it: the Explorer's copy is a local function inside a page
 * that another set of hands is working in. The RECIPE is now shared and the
 * MAPPING still is not, which is the split the rebuild spec asks for -- one
 * chip, drawn the same way everywhere, and each screen still deciding for
 * itself which of its words is a good outcome.
 *
 * An unrecognised status takes the neutral tone rather than a guess. Conversation
 * turns are labelled 'complete', 'partial' or 'failed' by the runs query today;
 * anything else is a word this client has not been taught, and it still reads as
 * itself in a neutral pill.
 */
export function railStatusTone(status: string | null | undefined): RailStatusTone {
  const word = (status ?? '').trim().toLowerCase();
  if (word === 'complete' || word === 'completed' || word === 'succeeded' || word === 'answered')
    return 'ast-pill--pos';
  if (word === 'failed' || word === 'error' || word === 'refused') return 'ast-pill--neg';
  if (word === 'partial') return 'ast-pill--warn';
  return 'ast-pill--neutral-outline';
}

/**
 * The latest run of each conversation, keyed by conversation id.
 *
 * Compared on `created_at` rather than trusting the endpoint's ordering. The
 * runs list is sorted newest-first today and taking the first match would be
 * right, but the rail would then be quietly wrong the day that ORDER BY
 * changes, and "the newest turn" is the claim the pill makes.
 *
 * Benchmark runs are skipped: they carry no conversation id, and a suite run is
 * not a turn in anybody's conversation.
 */
export function railRunSummaries(runs: readonly Run[]): Map<string, RailRunSummary> {
  const latest = new Map<string, Run>();
  for (const run of runs) {
    const id = run.conversation_id;
    if (!id) continue;
    const held = latest.get(id);
    if (!held || isNewer(run, held)) latest.set(id, run);
  }
  const summaries = new Map<string, RailRunSummary>();
  for (const [id, run] of latest) {
    summaries.set(id, {
      // 'unknown' rather than an empty pill: the row is only given a pill when a
      // run exists, and a run whose status column is null is a run whose status
      // is unknown, which is a different statement from having no run.
      status: run.status?.trim() || 'unknown',
      tone: railStatusTone(run.status),
      durationMs: typeof run.duration_ms === 'number' && Number.isFinite(run.duration_ms) ? run.duration_ms : null,
      rating: typeof run.rating === 'number' && Number.isFinite(run.rating) ? run.rating : null,
      truncated: run.truncated === true,
    });
  }
  return summaries;
}

/**
 * The badge a conversation row can draw from the rail's own list, for the rows
 * `/api/runs` will never describe.
 *
 * `railRunSummaries` above is built from runs the reader owns, because that is
 * all the runs route returns. The rail, when the shared rail is on, lists
 * everyone's conversations -- so every row belonging to somebody else drew a
 * title and a date and nothing else, while the reader's own rows carried a
 * Complete badge and a wall time beside them. That asymmetry is what was
 * reported, twice.
 *
 * The conversation list now derives the verdict and the wall clock for every
 * row it returns, and this turns that into the same summary shape so the row
 * has one thing to read regardless of which read supplied it.
 *
 * NO RATING, and the null is not an oversight. A rating is one reader's
 * opinion of an answer; the scoped runs route knows whose it is and this one
 * does not. A row that falls back to this draws its badge and its duration and
 * no star, which is correct -- not "nobody rated it", but "this read cannot say".
 */
export function conversationRunSummary(conversation: {
  status?: string | null;
  truncated?: boolean | null;
  duration_ms?: number | null;
}): RailRunSummary | null {
  const status = conversation.status?.trim();
  // Absent, not unknown. A conversation nobody has asked anything has no turn
  // to report on, and a pill over it would be a claim about a run that does not
  // exist -- the rule the module header states and the reason this returns null
  // rather than a summary reading 'unknown'.
  if (!status) return null;
  return {
    status,
    tone: railStatusTone(status),
    durationMs:
      typeof conversation.duration_ms === 'number' && Number.isFinite(conversation.duration_ms)
        ? conversation.duration_ms
        : null,
    rating: null,
    truncated: conversation.truncated === true,
  };
}

function isNewer(candidate: Run, held: Run) {
  const a = Date.parse(candidate.created_at);
  const b = Date.parse(held.created_at);
  // An unparseable timestamp never displaces one that parses, so a malformed row
  // cannot become "the latest turn" for a conversation that has real ones.
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a > b;
}

/**
 * A turn's wall time in the words a 264px rail has room for.
 *
 * Seconds to one decimal, as the Explorer's card prints it, so the same run
 * reads the same on both surfaces. Null when it was not recorded: a turn stored
 * before the trace carried `totalMs` did not take zero seconds.
 */
export function railDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs)) return null;
  return `${(durationMs / 1000).toFixed(1)}s`;
}
