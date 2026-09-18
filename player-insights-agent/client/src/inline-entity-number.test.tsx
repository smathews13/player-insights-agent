import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { EntityText, PlanText } from './InlineEntityText';

/**
 * A digit fused into a title must not be pulled out into a number badge.
 *
 * Every franchise in this estate is named with an embedded digit (`rdr2`,
 * `bio1`, `hoops26`, `gta5`), and a plan candidate's `why`/`definition` now
 * names several at once. The `INLINE_NUMBER` regex used to match the bare digit
 * inside those words and wrap it in the `ast-num` badge, which is laid out for a
 * standalone step marker and forced the rest of the word onto its own line. The
 * fix guards the pattern with a boundary; these tests pin both halves of it.
 */
function markup(text: string) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <EntityText text={text} sources={[]} />
    </MemoryRouter>
  );
}

describe('inline number highlighting leaves identifiers whole', () => {
  it('does not fragment a why that names titles with embedded digits', () => {
    const html = markup('carries gtaiv, rdr2, bio1/bio2/bio_inf play flags');
    // Each identifier survives intact: if a digit had been wrapped, the literal
    // token would be split by a <span> and these would not be found.
    for (const token of ['rdr2', 'bio1', 'bio2', 'bio_inf']) {
      expect(html).toContain(token);
    }
    // And no number badge fired at all for this string, because none of its
    // digits is a standalone figure.
    expect(html).not.toContain('answer-inline-number');
  });

  it('still highlights a real standalone figure', () => {
    const days = markup('aggregated over the trailing 180 days');
    expect(days).toContain('answer-inline-number');
    expect(days).toMatch(/answer-inline-number[^>]*>180</);

    const percent = markup('coverage reached 12% of runs');
    expect(percent).toMatch(/answer-inline-number[^>]*>12%</);
  });
});

/**
 * A plan candidate's prose is ABOUT a source, not the answer's figures, so it
 * turns number highlighting off entirely. A title with a space before its
 * version -- "Outfit 3", "Dyn 6", "Hoops" -- carries a standalone digit that the
 * word-boundary guard cannot catch (it is genuinely a standalone figure), and
 * badging it dropped the "3" onto its own line so the definition read as a
 * fourth labelled row of the candidate. `PlanText` passes `numbers={false}`.
 */
describe('plan prose does not badge the version digit in a title', () => {
  function planMarkup(text: string) {
    return renderToStaticMarkup(
      <MemoryRouter>
        <PlanText text={text} columns={[]} />
      </MemoryRouter>
    );
  }

  it('leaves "Outfit 3" whole with no number badge', () => {
    const html = planMarkup("Play activity indicator for Outfit 3; value = 'True' if player has played");
    expect(html).not.toContain('answer-inline-number');
    expect(html).toContain('Outfit 3');
  });

  it('does not badge a real figure inside plan prose either', () => {
    // The trade the field makes: a genuine "180 days" in a plan summary also
    // goes unbadged, which is fine -- a plan is not the figure surface.
    expect(planMarkup('aggregated over the trailing 180 days')).not.toContain('answer-inline-number');
  });
});
