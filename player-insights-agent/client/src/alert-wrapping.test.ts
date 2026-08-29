import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The call-site half of the alert-layout fix, which shipped without it.
 *
 * `alert-layout.test.ts` asserts the stylesheet no longer pins the description slot
 * to `display: block`. That pin was a real defect -- it outranked every flex and grid
 * utility written inside an alert -- and removing it was right. What removing it hands
 * back is AppKit's own `grid`, and a grid gives every direct child of the slot a row of
 * its own. A description written as a bold lead plus the text after it is two children,
 * so it becomes two rows.
 *
 * For most of this page that is what was wanted: a heading over a detail, or two
 * sentences, read better stacked. For two of them it was a rendering fault in front of
 * a customer. The drift notice broke after `<strong>Intended: …</strong>` onto a line
 * beginning with a comma, and the immutability notice broke into four rows around an
 * inline `<em>`, three of which started mid-sentence.
 *
 * The fix is one wrapper element around the run of inline content, so the sentence is
 * one child and wraps as prose. Putting the `display` pin back would fix these two and
 * re-break every flex layout inside every alert in the app, which is the trade the
 * foundation work deliberately refused.
 *
 * So this file asserts the shape rather than the pixels: that no description on this
 * page splits in the middle of a phrase. A break at a sentence boundary is a design
 * decision and stays allowed -- six of them are deliberate. A break before a comma or
 * a lowercase word is never one, and it is the difference this can measure. Asserted
 * against the source because the repo has no jsdom and no React testing library; the
 * Playwright spec is where the same claim meets a real layout, and a human still has
 * to look at the page to say the deliberate stacks read as deliberate.
 */

const CONNECTIONS = readFileSync(new URL('./ConnectionsPage.tsx', import.meta.url), 'utf8');

/** The inner source of every `<AlertDescription>` on the page, in document order. */
function descriptions(source: string): string[] {
  const found: string[] = [];
  const OPEN = '<AlertDescription>';
  const CLOSE = '</AlertDescription>';
  let at = source.indexOf(OPEN);
  while (at !== -1) {
    const from = at + OPEN.length;
    const to = source.indexOf(CLOSE, from);
    if (to === -1) break;
    found.push(source.slice(from, to));
    at = source.indexOf(OPEN, to);
  }
  return found;
}

/**
 * The direct children of one description, as the grid will see them: elements,
 * `{…}` expressions, and the runs of literal text between them. A JSX comment is not
 * a child and is dropped first.
 */
function children(inner: string): string[] {
  const source = inner.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const found: string[] = [];
  let text = '';
  let at = 0;

  const flush = () => {
    if (text.trim()) found.push(text);
    text = '';
  };

  while (at < source.length) {
    const char = source[at];
    if (char === '{') {
      flush();
      let depth = 0;
      const from = at;
      while (at < source.length) {
        if (source[at] === '{') depth += 1;
        if (source[at] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        at += 1;
      }
      found.push(source.slice(from, at + 1));
      at += 1;
      continue;
    }
    if (char === '<' && /[A-Za-z>]/.test(source[at + 1] ?? '')) {
      flush();
      // Tag-by-tag rather than by matching the name: a fragment has no name, and an
      // element's own children may repeat the parent's tag.
      let depth = 0;
      const from = at;
      while (at < source.length) {
        if (source[at] === '<') {
          const closing = source[at + 1] === '/';
          const end = source.indexOf('>', at);
          if (end === -1) break;
          const selfClosing = source[end - 1] === '/';
          depth += closing ? -1 : selfClosing ? 0 : 1;
          at = end;
          if (depth === 0) break;
        }
        at += 1;
      }
      found.push(source.slice(from, at + 1));
      at += 1;
      continue;
    }
    text += char;
    at += 1;
  }
  flush();
  return found;
}

/**
 * A child that continues the sentence the child before it started. A comma, a
 * semicolon or a lowercase word cannot begin a row; anything else -- a capital, an
 * element, an expression whose text is not knowable from here -- might legitimately.
 */
function beginsMidPhrase(child: string): boolean {
  const lead = child.trimStart();
  return /^[,;:]/.test(lead) || /^[a-z]/.test(lead);
}

describe('an alert description breaks where a sentence does, or not at all', () => {
  it('finds every alert on the Connections page, so a pass is not an empty pass', () => {
    // The scanner is the load-bearing part of this file. If a rename or a reformat
    // stopped it matching, every assertion below would pass over nothing.
    expect(descriptions(CONNECTIONS).length).toBeGreaterThanOrEqual(6);
  });

  it('never lets a row start with a comma or a lowercase word', () => {
    const splits = descriptions(CONNECTIONS)
      .flatMap((inner) => children(inner))
      .filter(beginsMidPhrase)
      .map((child) => child.replace(/\s+/g, ' ').trim().slice(0, 60));
    expect(splits).toEqual([]);
  });

  it('keeps the pending-intention sentence inside one wrapper', () => {
    // The first of the two that shipped split. Named directly as well as caught by
    // the rule above, because the rule reads the absence of a defect and this reads
    // the presence of the fix.
    expect(CONNECTIONS).toMatch(
      /<span>\s*<strong>\s*\{pendingState\}: \{row\.intended\}\s*<\/strong>\s*\{row\.intendedBy[\s\S]*?<\/span>/
    );
  });

  /**
   * The second of the two that shipped split was the immutability notice, and it
   * is no longer on the page in any form: a sentence that is permanently true was
   * being printed above the summary, where the reader looks first. Each row says
   * whether it can be changed with a pencil or a padlock instead.
   *
   * Asserted as an absence rather than deleted outright, because the sentence is
   * the kind that comes back -- it is true, and it explains something real. If it
   * does come back it must not come back here, above everything a reader came to
   * read.
   */
  it('no longer prints the standing immutability sentence at all', () => {
    expect(CONNECTIONS).not.toMatch(/Most values here cannot be changed from a form/);
  });

  it('does not fix either of them by pinning the slot’s display again', () => {
    // The wrapper is the fix. Restating the layout on the slot itself -- as a utility
    // class or an inline style on `<AlertDescription>` -- would be the same mistake one
    // layer down: it would settle these two and take the flex layouts inside other
    // alerts with it. A `block` on something further in is fine, and one of these
    // alerts uses one to put each of two error sentences on its own line.
    expect([...CONNECTIONS.matchAll(/<AlertDescription\b[^>]*>/g)].map(([tag]) => tag)).toEqual(
      Array(descriptions(CONNECTIONS).length).fill('<AlertDescription>')
    );
  });
});
