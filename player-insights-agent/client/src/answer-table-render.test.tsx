import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AnswerProse } from './DataEntityLinks';
import { partial } from './styles/stylesheet';

/**
 * What the agent's table LOOKS LIKE once the answer card draws it.
 *
 * The companion to the table cases in answer-markdown.test.ts, which assert the
 * parse. This file asserts the drawing, and it exists because the parse was
 * never the thing anybody complained about: what was reported was a screenful of
 * pipes and dashes in the answer body, and every assertion anyone would have
 * thought to write about the answer's TEXT was true while that was on screen.
 * Nothing short of rendering the block and reading the markup back could fail.
 *
 * So the claim each test makes is a claim about the element that appeared -- a
 * table where there was a paragraph, cells where there were pipes -- and not
 * about the class names it is made of.
 *
 * WHAT IS NOT VERIFIED HERE, and cannot be without a browser: how any of it
 * looks, where the columns actually land, and whether the wrapper scrolls at the
 * width a reader has. The stylesheet block at the end is the same trade the rest
 * of this repo's style tests make: it proves the rules exist and say what they
 * need to say, not that the result has been seen.
 *
 * Rendered through `renderToStaticMarkup`, so no effect runs and the tracked
 * table list is empty -- the state every answer passes through first. What the
 * table says must not depend on whether a cell turned out to be a link.
 */

/** The agent's own daily aggregate, off the answer this was reported from. */
const RAMP = [
  '| Date | Sessions | Active Players | Launch Campaign Sessions | Avg Session (min) | Net Bookings (USD) |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 2026-07-14 | 118 | 96 | 0 | 31.40 | $214.55 |',
  '| 2026-08-03 | 482 | 371 | 8 | 45.15 | $1,381.16 |',
  '| **Total** | **3,914** | **2,880** | **41** | **38.62** | **$9,204.73** |',
].join('\n');

/** Its country breakdown, Germany's country-level note included. */
const COUNTRIES = [
  '| Country | Sessions | Active Players |',
  '| --- | --- | --- |',
  '| GB | 482 | 371 |',
  '| DE (Germany \u2014 country level) | 96 | 74 |',
  '| FR | 61 | 48 |',
  '| ES | 44 | 35 |',
].join('\n');

function render(text: string): string {
  return renderToStaticMarkup(<AnswerProse text={text} sources={[]} />);
}

/** The text a reader sees, tags removed and the entities put back. */
function readable(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, '\u2019')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x2014;/g, '\u2014')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The contents of every element of one kind, in document order. */
function cells(markup: string, tag: 'th' | 'td'): string[] {
  return [...markup.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'g'))].map((match) => readable(match[1]));
}

describe('a table the agent wrote is drawn as a table', () => {
  it('puts a real table on screen, with its column names in header cells', () => {
    const markup = render(RAMP);
    expect(markup).toContain('<table');
    expect(markup).toContain('<thead>');
    expect(cells(markup, 'th')).toEqual([
      'Date',
      'Sessions',
      'Active Players',
      'Launch Campaign Sessions',
      'Avg Session (min)',
      'Net Bookings (USD)',
    ]);
  });

  it('shows the reader no pipe and no run of dashes, which is the whole defect', () => {
    // The reported bug, stated as the one assertion that would have caught it.
    // Both characters are the Markdown's own punctuation: on screen they are
    // noise between the figures, and the figures are what the block is for.
    const shown = readable(render(RAMP));
    expect(shown).not.toContain('|');
    expect(shown).not.toContain('---');
  });

  it('associates every figure with the column it is in, for a reader who cannot see the grid', () => {
    // `scope="col"` is what makes a header cell the heading OF something. Without
    // it a screen reader is handed thirty numbers in a row and no statement of
    // which is a session count and which is a booking.
    expect([...render(RAMP).matchAll(/<th[^>]*scope="col"/g)]).toHaveLength(6);
  });

  it('draws every row of the body, the bolded total included', () => {
    const markup = render(RAMP);
    expect([...markup.matchAll(/<tr>/g)]).toHaveLength(4);
    expect(cells(markup, 'td')).toEqual([
      '2026-07-14', '118', '96', '0', '31.40', '$214.55',
      '2026-08-03', '482', '371', '8', '45.15', '$1,381.16',
      'Total', '3,914', '2,880', '41', '38.62', '$9,204.73',
    ]);
    // Bold as an element, so the total row is emphasised by the document rather
    // than by the asterisks the agent typed.
    expect(markup).toContain('<strong>Total</strong>');
  });

  it('right-aligns the figures and not the dates', () => {
    const markup = render(RAMP);
    expect([...markup.matchAll(/<td data-align="right"/g)]).toHaveLength(15);
    expect([...markup.matchAll(/<td data-align="left"/g)]).toHaveLength(3);
  });

  it('keeps a country cell exactly as the agent wrote it, em dash and parentheses', () => {
    // Germany is reported at country level and the cell says so. A renderer that
    // reflows a cell it does not understand is a renderer that can change what
    // the answer claimed, and the em dash here is a character in a sentence
    // rather than a delimiter of anything.
    expect(cells(render(COUNTRIES), 'td')).toContain('DE (Germany \u2014 country level)');
  });

  it('draws a fenced table as a table, which is the other way the pipes leaked out', () => {
    const markup = render('Totals below.\n\n```\n' + COUNTRIES + '\n```');
    expect(markup).toContain('<table');
    expect(readable(markup)).not.toContain('|');
    expect(readable(markup)).not.toContain('```');
    expect(cells(markup, 'th')).toEqual(['Country', 'Sessions', 'Active Players']);
  });

  it('draws the stray single row as a headerless table rather than as punctuation', () => {
    const markup = render('| 2026-08-03 | 482 | 371 | 8 | 45.15 | $1,381.16 |');
    expect(markup).toContain('<table');
    expect(markup).not.toContain('<thead>');
    expect(cells(markup, 'td')).toEqual(['2026-08-03', '482', '371', '8', '45.15', '$1,381.16']);
  });

  it('leaves the headings, the bullets and the code spans around it alone', () => {
    // The regression guard on the whole change. A table renderer that turns the
    // prose beside it into rows has replaced one unreadable answer with another.
    const markup = render(
      '### Spike ramp \u2014 aggregated daily totals\n\n' +
        RAMP +
        '\n\n- Launch-campaign phase begins 2026-07-28.\n- Peak is the final day, `2026-08-03`.'
    );
    expect(markup).toContain('<h4 class="answer-heading answer-subheading">');
    expect([...markup.matchAll(/<li>/g)]).toHaveLength(2);
    expect(markup).toContain('<ul class="answer-list">');
    expect(markup).toContain('<code class="answer-code entity-quote">');
    // And nothing in the bullets became a cell: three body rows of six.
    expect(cells(markup, 'td')).toHaveLength(18);
  });

  it('leaves a sentence with a pipe in it a sentence', () => {
    const markup = render('Sessions concentrate in GB | DE | FR, in that order.');
    expect(markup).not.toContain('<table');
    expect(readable(markup)).toBe('Sessions concentrate in GB | DE | FR, in that order.');
  });

  it('cannot carry markup out of a cell, the same as everywhere else in an answer', () => {
    // The answer is untrusted and a cell is not an exception to that. The tree
    // has no node that holds markup, so a tag in a cell reaches the DOM as the
    // characters it is. See answer-markdown.ts.
    const markup = render('| Note | Value |\n| --- | --- |\n| <script>alert(1)</script> | 1 |');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});

describe('the table is styled as part of the answer, not as a new design', () => {
  /**
   * Asserted against the stylesheet, for the reason the rest of this repo's
   * style tests are: the effect is a painted pixel and there is no browser here.
   * This proves the rules exist and say what they need to say. It cannot prove
   * the table looks right, and nothing here should be read as saying it has been
   * seen.
   */
  const ANSWER_CSS = partial('answer.css');

  function rule(selector: string): string {
    const at = ANSWER_CSS.indexOf(`\n${selector} {`);
    if (at === -1) return '';
    const open = ANSWER_CSS.indexOf('{', at);
    const close = ANSWER_CSS.indexOf('}', open);
    return open === -1 || close === -1 ? '' : ANSWER_CSS.slice(open + 1, close);
  }

  it('gives a wide table somewhere to go other than through the card', () => {
    // Six columns of daily figures do not fit the transcript column at every
    // width. The alternative to scrolling is a table whose numbers wrap
    // mid-figure, and a figure that wraps has to be re-read to be believed.
    expect(rule('.answer-table-wrap')).toContain('overflow-x: auto');
    expect(rule('.answer-table-wrap')).toContain('border: 1px solid var(--ast-hairline)');
    expect(rule('.answer-table-wrap')).toContain('border-radius: var(--ast-radius-card)');
  });

  it('takes the app’s own table treatment rather than inventing a second one', () => {
    // The band, the hairline rules and the tinted header are `.sources-module`'s
    // and the results table's. An answer's table is the same kind of object and
    // must not be a third look.
    expect(rule('.answer-table thead th')).toContain('background: var(--ast-fill-band)');
    expect(rule('.answer-table thead th')).toContain('border-bottom: 1px solid var(--ast-hairline)');
    expect(rule('.answer-table tbody tr + tr td')).toContain('border-top: 1px solid var(--ast-hairline)');
    expect(rule('.answer-table')).toContain('border-collapse: collapse');
  });

  it('sets a column of figures in the face that lines them up', () => {
    // `.bench-num`'s pair of declarations, for `.bench-num`'s reason: DM Sans
    // carries no `tnum` feature, so a column of proportional digits jitters by
    // most of a digit as the values change.
    const figures = rule(".answer-table tbody td[data-align='right']");
    expect(figures).toContain('font-family: var(--font-mono)');
    expect(figures).toContain('font-variant-numeric: tabular-nums');
    expect(rule(".answer-table [data-align='right']")).toContain('text-align: right');
  });

  it('refuses to break a figure, which is the card’s wrapping rule turned off here', () => {
    // The card's content slot sets `overflow-wrap: anywhere`, which is right for
    // a table name in a sentence and wrong for a number: it broke "$1,381.16"
    // after the thousands separator. Same exception as `.bar-row b`.
    const figures = rule(".answer-table tbody td[data-align='right']");
    expect(figures).toContain('overflow-wrap: normal');
    expect(figures).toContain('word-break: normal');
  });

  it('keeps the I-beam over cells a reader can select', () => {
    expect(partial('ask.css')).toContain('.answer-prose td,');
  });
});
