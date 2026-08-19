/**
 * How much reading the access check asks for before it lets somebody in.
 *
 * This screen is the first thing any reader meets and the only thing standing
 * between them and the app, and it had grown into a wall: a five-line opening
 * paragraph, four more paragraphs of refusal above the list of refusals, an amber
 * panel of caveats with a three-line explanation under each one, and three action
 * buttons carrying three lines apiece. Every sentence in it was true and most were
 * load-bearing somewhere, which is exactly how it happened.
 *
 * SO THESE ARE LENGTH ASSERTIONS, deliberately. Nothing else stops prose growing
 * back one defensible sentence at a time. The facts themselves are pinned in
 * `access-gate-copy.test.ts`; what is pinned here is that each of them is said
 * once, in a bounded number of words, with the rest behind a disclosure.
 *
 * Rendered rather than read from source, because the count line is computed and
 * the collapsed caveats have to be collapsed in markup rather than in intent.
 * Nothing here says anything about pixels.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DenialReport, GateIntro, LimitsReport, tableCountLine } from './AccessGate';

/** What a reader sees, with the markup taken out. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function words(markup: string): number {
  return text(markup).split(' ').filter(Boolean).length;
}

/** Twelve tables, of which the reader holds nine and two were never reached. */
function partialResult() {
  const readable = Array.from({ length: 9 }, (_, at) => ({
    table: `cat.schema.readable_${at}`,
    status: 'ok' as const,
    detail: 'You hold SELECT on it.',
  }));
  return {
    verified: false,
    ok: 9,
    denied: 1,
    errored: 2,
    impact: ['Genie is all-or-nothing per space, so a question it would have answered may fall back.'],
    verdicts: [
      ...readable,
      {
        table: 'cat.schema.raw_purchases',
        status: 'denied' as const,
        detail: 'You do not hold SELECT on cat.schema.raw_purchases, and the API said so in those terms.',
        missing: { object: 'cat.schema.raw_purchases', permission: 'SELECT', objectKind: 'table' },
        remedy: {
          kind: 'sql' as const,
          statement: 'GRANT SELECT ON TABLE `cat`.`schema`.`raw_purchases` TO `reader@example.com`;',
          // Empty, as it is on the real `tableGrant`: that statement already
          // carries the traversal grants, so there is nothing a reader needs
          // beyond it.
          guidance: '',
        },
        apiMessage: '[INSUFFICIENT_PERMISSIONS] SQLSTATE: 42501',
      },
      {
        table: 'cat.schema.sessions',
        status: 'error' as const,
        detail: 'Not checked: the access check reached its budget.',
      },
      {
        table: 'cat.schema.ratings',
        status: 'error' as const,
        detail: 'Not checked: the access check reached its budget.',
        apiMessage: 'socket hang up',
      },
    ],
  };
}

const LIMITS = [
  {
    what: 'Whether the answers you get would be limited to what you can see in Genie.',
    why: 'Your own access to the spaces was checked and is reported above.',
    insteadAs: 'Also checked as the agent serving principal: Data Genie space (ok).',
  },
  {
    what: 'Whether a row filter or a column mask narrows what you would see.',
    why: 'Neither reports itself. A filtered query succeeds and returns fewer rows.',
  },
];

describe('the opening block', () => {
  const markup = renderToStaticMarkup(<GateIntro signedInAs="reader@example.com" />);

  it('is a single paragraph', () => {
    // It was one paragraph of five lines, and two paragraphs before that. A
    // reader deciding between three doors gets one.
    expect(markup.match(/<p>/g)).toHaveLength(1);
  });

  it('is short enough to be read rather than skipped', () => {
    // Forty-five words is roughly two lines at the panel's 640px. The paragraph
    // this replaced was just over a hundred.
    expect(words(markup), text(markup)).toBeLessThanOrEqual(45);
  });

  it('still says what was checked and what the check does not decide', () => {
    const read = text(markup);
    expect(read).toContain('Signed in as reader');
    expect(markup).toContain('identity-chip identity-chip--compact');
    expect(read).toContain('under your own token');
    expect(read).toContain('SQL warehouse');
    expect(read).toContain('tables behind answers');
    expect(read).toContain('Genie spaces');
    expect(read).toContain('does not decide who runs the questions that follow');
  });

  it('does not explain the epistemology of the check on the way past', () => {
    // True, worth saying, and not worth saying here. It is beside the result now.
    expect(text(markup)).not.toContain('have read the data behind an answer');
  });
});

describe('the count line', () => {
  it('leads with how many are readable, how many refused, and how many were not checked', () => {
    expect(tableCountLine(partialResult())).toBe('9 of 12 tables readable \u00b7 1 refused \u00b7 2 not checked');
  });

  it('never renders a zero', () => {
    // The app's count line everywhere else drops a zero rather than printing
    // "0 refused", which reads as a category the reader has to think about.
    expect(tableCountLine({ verified: false, ok: 12, denied: 0, errored: 0, verdicts: [] })).toBe(
      '12 of 12 tables readable',
    );
  });

  it('keeps refused and not-checked apart, in both directions', () => {
    // A 403 and a check that never ran are different events, and merging them to
    // shorten the line would be the one shortening this screen may not have.
    const refusedOnly = tableCountLine({ verified: false, ok: 1, denied: 1, errored: 0, verdicts: [] });
    expect(refusedOnly).toContain('1 refused');
    expect(refusedOnly).not.toContain('not checked');
    const uncheckedOnly = tableCountLine({ verified: false, ok: 1, denied: 0, errored: 1, verdicts: [] });
    expect(uncheckedOnly).toContain('1 not checked');
    expect(uncheckedOnly).not.toContain('refused');
  });

  it('counts the tables even when the verdicts did not travel with them', () => {
    // A reader can fail on the Genie spaces alone, with every table green and no
    // per-table verdict to count. The tally still has to be right.
    expect(tableCountLine({ verified: false, ok: 2, denied: 0, errored: 0 })).toBe('2 of 2 tables readable');
  });
});

describe('the result panel', () => {
  const markup = renderToStaticMarkup(<DenialReport result={partialResult()} />);
  const read = text(markup);

  it('opens on the count rather than on a paragraph about it', () => {
    // Four paragraphs used to come first: what your access does not cover, that
    // you may continue anyway, the count in prose, and the degradation.
    expect(read.indexOf('9 of 12 tables readable')).toBe(0);
  });

  it('says the consequence once and does not repeat the count in prose', () => {
    expect(read).toContain('all-or-nothing per space');
    expect(read).not.toContain('You can read 9 of the 12');
  });

  it('names the tables it could not check, and calls them unknown rather than refused', () => {
    expect(read).toContain('Not checked, so unknown rather than refused');
    expect(read).toContain('sessions');
    expect(read).toContain('ratings');
    // Named compactly, with the whole name available to hover rather than printed.
    expect(markup).toContain('title="cat.schema.sessions"');
  });

  it('offers no grant for a check that did not run', () => {
    // There is nothing to grant. A remedy beside an unreached table sends
    // somebody to fix a permission nobody has established is missing.
    const unchecked = markup.slice(markup.indexOf('Not checked, so unknown'));
    expect(unchecked).not.toContain('GRANT');
  });

  it('still gives a refused table its object, its privilege and its statement', () => {
    expect(read).toContain('cat.schema.raw_purchases');
    expect(read).toContain('missing SELECT');
    expect(read).toContain('GRANT SELECT ON TABLE');
  });

  it('keeps what the service said, and drops the argument for the statement', () => {
    // The row says which object and which privilege, and the statement clears
    // it. Why that statement is the fix was an argument for the line above it,
    // and it went with its fold. What Databricks itself returned is not an
    // argument, so it stays, behind its own disclosure.
    expect(markup).not.toContain('Why this is the fix');
    expect(markup).toContain('<summary>What Databricks actually returned</summary>');
    // Collapsed: no `open` attribute anywhere in the panel.
    expect(markup).not.toContain('<details open');
  });

  it('is short enough that the list is the bulk of it', () => {
    // Everything outside the per-table rows: the count line, the consequence, and
    // the not-checked line. Three short lines, where this was four paragraphs.
    const chrome = words(markup.slice(0, markup.indexOf('<ul>'))) + words(markup.slice(markup.indexOf('</ul>')));
    expect(chrome, text(markup)).toBeLessThanOrEqual(60);
  });
});

describe('the caveats', () => {
  const markup = renderToStaticMarkup(<LimitsReport limits={LIMITS} />);

  it('are one collapsed disclosure rather than an open panel', () => {
    expect(markup.startsWith('<details')).toBe(true);
    expect(markup).not.toContain('<details open');
    expect(markup).toContain('<summary>What this check does not tell you</summary>');
  });

  it('keep every word that was in the panel', () => {
    // Collapsed, not cut. This screen's job is to let somebody in; the caveats'
    // job is to stop them over-claiming afterwards, and it can wait for the click.
    const read = text(markup);
    for (const limit of LIMITS) {
      expect(read).toContain(limit.what);
      expect(read).toContain(limit.why);
    }
    expect(read).toContain('Also checked as the agent serving principal');
    expect(read).toContain('have read the data behind an answer');
  });

  it('shows only the summary line before it is opened', () => {
    // What a reader meets, in the closed state, is one line.
    const summary = markup.slice(markup.indexOf('<summary>'), markup.indexOf('</summary>'));
    expect(words(summary)).toBeLessThanOrEqual(8);
  });
});
