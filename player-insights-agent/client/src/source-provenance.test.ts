import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Whether a cited source still wears a label about the data behind it.
 *
 * The row under an answer names a Unity Catalog table, calls it governed, and
 * prints the freshness the server reported. It also used to end with a chip
 * reading "Synthetic data", switched on in the browser by pattern-matching the
 * wording of the answer's caveats. It is gone, and this pins that it stays gone.
 *
 * Two reasons, of which the second is the one that matters. It was a claim about
 * a named table made by a surface with no way to look inside it -- the app is
 * deployed against whatever catalog the operator configured -- so the chip
 * printed a guess as a fact, immediately beside a real table name, and had
 * already been reported over a customer's own production view. And when a
 * deployment does have something to disclose about its data, the answer's own
 * caveats say so in the agent's words in the list below the strip, so the chip
 * was that disclosure restated more shortly and less carefully.
 *
 * These are source-text assertions because the assertion worth making is about
 * what the card can render at all, not about what one fixture happens to
 * produce: a rendering test passes as soon as its fixture stops matching
 * whatever condition would bring the chip back.
 */

const CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
const RUN_EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
/**
 * The module itself, which both surfaces now render instead of building. It was
 * written out twice, and the copies disagreed about the separator between the
 * table name and the text after it; unifying them moved the markup these
 * assertions are about into one file, so this is where they now look for it.
 */
const MODULE = readFileSync(new URL('./SourcesModule.tsx', import.meta.url), 'utf8');
/** Where the chip's words are decided, which is the file a label would come back in. */
const ROWS = readFileSync(new URL('./source-rows.ts', import.meta.url), 'utf8');

/**
 * Comments stripped, so the note in the card explaining why the chip was removed
 * is not read as the chip coming back. The note names the old wording on purpose:
 * a removal nobody wrote down is one somebody re-adds as an improvement.
 */
function withoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/**
 * The markup of one source row. Scoped rather than searched for across the file
 * because a chip is legitimate on the row: the module gives every row one, and
 * what must never come back is a SECOND chip making a claim about the data
 * inside the table rather than about what the run read it for.
 */
function sourceLine(source: string) {
  const line = /<p className="source-line">([\s\S]*?)<\/p>/.exec(withoutComments(source));
  if (!line) throw new Error('The source provenance is no longer rendered as .source-line');
  return line[1];
}

describe('the source line under an answer', () => {
  it('carries exactly one recorded role after each table name', () => {
    // The row's own qualifier and nothing else. A "Synthetic data" chip sat at
    // the end of this row and was switched on in the browser by pattern-matching
    // the wording of the answer's caveats; the shape that let it exist was a row
    // that could carry any number of labels.
    const line = sourceLine(MODULE);
    expect(line.match(/source-line-role/g)).toHaveLength(1);
    expect(line.indexOf('SourceEntityName')).toBeLessThan(line.indexOf('source-line-role'));
    expect(line).not.toContain('<Badge');
  });

  it('says nothing anywhere about the data being synthetic', () => {
    // Deliberately the whole card rather than the row: the chip was one
    // rendering of a decision the card was making, and the decision is what has
    // been removed. Reaching for the word again anywhere in these files, for a
    // tooltip or a footnote, is the same claim in a different shape. The chip
    // vocabulary is included because that is where a new label would be written.
    for (const source of [CARD, MODULE, ROWS]) {
      expect(withoutComments(source)).not.toMatch(/synthetic/i);
    }
  });

  it('no longer asks the browser to decide where the data came from', () => {
    // `data-provenance.ts` existed only to feed the chip: it read the caveats and
    // returned 'synthetic' or 'unknown'. Asserted as the absence of the module,
    // not just of the import, because a helper left in the tree with no caller is
    // an invitation to find it a new one.
    const helper = fileURLToPath(new URL('./data-provenance.ts', import.meta.url));
    expect(existsSync(helper)).toBe(false);
    expect(CARD).not.toContain('data-provenance');
  });

  it('still names the source and the freshness the server reported', () => {
    // The other direction. The row is how a reader gets from a figure to the
    // table it came from, and deleting a chip must not quietly take the row's
    // actual content with it. The freshness is in the row's tooltip -- still the
    // server's words, still in the document.
    //
    // The governance claim is not, anywhere. It went to the module's header when
    // the strip was replaced, so it was said once instead of once per row, and
    // the detail spec then removed it from there too: the Unity Catalog mark
    // heading the card carries it, and a sentence restating it is the interface
    // explaining its own design. Nothing was lost with it that the row was the
    // only record of, which is what this assertion is really guarding.
    const line = sourceLine(MODULE);
    expect(line).toContain('<SourceEntityName name={row.name} />');
    expect(line).toContain('row.freshness');
    expect(withoutComments(ROWS)).not.toMatch(/governed/i);
  });
});

describe('the source row on a past run', () => {
  it('carries no data label either, on the surface that shows stored answers', () => {
    // The Run Explorer draws the same strip over a run read back out of the
    // store -- now literally the same one, rather than a copy of it, so the
    // badge claim above covers this surface as well and is not repeated here.
    // What is still worth asserting over this file is the word itself: it never
    // had the chip, and "the answer card no longer labels its data" must not be
    // satisfiable by moving the label one surface across.
    expect(withoutComments(RUN_EXPLORER)).not.toMatch(/synthetic/i);
  });
});
