/**
 * The two facts in a data package that are values rather than prose: the window
 * the answer covers, and the labels it was filtered to.
 *
 * The Content block already sets its source table as a chip, because the agent
 * writes that one in backticks. It writes the window and the labels as ordinary
 * words, so a reader scanning the block for "which dates" and "whose titles"
 * found two of the four facts marked and two set in the same grey as the
 * punctuation between them.
 *
 * Nothing here rewrites prose, on the same terms as data-entities.ts: every run
 * is a slice of the string it was cut from and the runs concatenate back to it
 * exactly. A badge is a boundary, never an edit.
 */

/** One run of a text leaf, plain or worth setting as a badge. */
export interface BadgeRun {
  text: string;
  /** Offset in the leaf this run was cut from, so the renderer has a stable key. */
  start: number;
  badge?: 'date' | 'tag';
}

/**
 * An ISO date, optionally to a second one, optionally with the count after it.
 *
 * The whole window is one badge rather than three, because `2026-07-22`,
 * `2026-08-03` and `(13 dates)` are one fact and three chips in a row would
 * read as three. Only ISO dates count: the agent writes the window in that
 * form, and a looser pattern would start chipping figures inside sentences.
 */
const DATE_WINDOW =
  /\d{4}-\d{2}-\d{2}(?:(?:\s*[–—]\s*|\s+-\s+|\s+to\s+)\d{4}-\d{2}-\d{2})?(?:\s*\(\d+\s+dates?\))?/g;

/** Lead-ins whose value is a list of labels rather than a sentence. */
const LABEL_LEAD_IN = /\b(?:labels?|tags?)\s*:\s*$/i;

/**
 * Longest a label may be before it is left as prose.
 *
 * A label is a name -- "Northwind", "Contoso" -- and the guard is here because the
 * agent also writes `**Labels:** none reported for this window`, which is a
 * sentence. Badging a sentence states that a filter was applied that was not.
 */
const LABEL_MAX = 40;

export function isLabelLeadIn(text: string): boolean {
  return LABEL_LEAD_IN.test(text);
}

function plain(text: string, start: number): BadgeRun[] {
  return text ? [{ text, start }] : [];
}

/** Cut `text` into runs, marking the date windows in it. */
export function dateBadgeRuns(text: string, start = 0): BadgeRun[] {
  const runs: BadgeRun[] = [];
  let plainFrom = 0;
  for (const match of text.matchAll(DATE_WINDOW)) {
    const at = match.index ?? 0;
    runs.push(...plain(text.slice(plainFrom, at), start + plainFrom));
    runs.push({ text: match[0], start: start + at, badge: 'date' });
    plainFrom = at + match[0].length;
  }
  runs.push(...plain(text.slice(plainFrom), start + plainFrom));
  return runs;
}

/**
 * Cut `text` into runs, marking the labels at the head of it.
 *
 * Only the head: the Content block writes its four facts on one line separated
 * by pipes, so the list ends at the first `|` and everything after it is the
 * next fact's lead-in. The commas and the spacing stay in the prose, so the
 * line still reads and still copies as the agent wrote it.
 */
export function labelBadgeRuns(text: string, start = 0): BadgeRun[] {
  const stop = text.search(/[|\n]/);
  const head = stop === -1 ? text : text.slice(0, stop);
  const runs: BadgeRun[] = [];
  const items = head.split(',');
  let cursor = 0;
  for (const [index, piece] of items.entries()) {
    const pieceStart = cursor;
    const value = piece.trim();
    const badgeable = value.length > 0 && value.length <= LABEL_MAX && !/[.:;]/.test(value);
    if (badgeable) {
      const at = pieceStart + piece.indexOf(value);
      runs.push(...plain(text.slice(pieceStart, at), start + pieceStart));
      runs.push({ text: value, start: start + at, badge: 'tag' });
      runs.push(...plain(text.slice(at + value.length, pieceStart + piece.length), start + at + value.length));
    } else {
      runs.push(...plain(piece, start + pieceStart));
    }
    cursor = pieceStart + piece.length;
    if (index < items.length - 1) {
      runs.push(...plain(',', start + cursor));
      cursor += 1;
    }
  }
  runs.push(...plain(text.slice(cursor), start + cursor));
  return runs;
}
