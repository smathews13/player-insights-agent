import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { EntityText } from './InlineEntityText';

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
