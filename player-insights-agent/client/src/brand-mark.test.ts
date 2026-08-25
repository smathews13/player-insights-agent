import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { partial, stylesheet } from './styles/stylesheet';

/**
 * The brand mark is drawn, not shipped; and the brand column hugs its contents
 * rather than reserving the rail.
 *
 * Two unrelated-looking things in one file because they are the same header and
 * the same change, and because each of them is the kind of claim that no other
 * test in this repository can make.
 *
 * THE MARK. The header used to carry an <img> of the customer's registered
 * trademark, committed at three paths: client/public, the copy vite makes in the
 * committed client bundle, and a transparent stand-in in mirror/neutral-icons that
 * the publish step swapped in. This repository publishes to a public mirror and
 * somebody else's trademark is not ours to distribute, so the fix was to delete
 * the artwork rather than to stop pointing at it -- an unreferenced file publishes
 * exactly as readily as a referenced one, and the git history of a deleted asset
 * is a different and smaller problem than a live one in the tree.
 *
 * A two-letter plate stood in that position while the app had no identity of its
 * own. It has one now: `astrolabe-rebuild-spec.md` §1's lockup, the mark and the
 * name in lowercase, and both halves are things this app draws -- the geometry is
 * pinned to the delivered SVGs by astrolabe-mark.test.ts and the wordmark is
 * type. The assertions below are therefore about SHAPE rather than appearance:
 * that the lockup is what leads the bar, that it writes no colour of its own, and
 * that no path anywhere in the client still names the removed file. A screenshot
 * would say more about how it looks and nothing about whether the trademark came
 * back.
 *
 * THE ALIGNMENT. The nav tabs are laid out after the brand lockup, so the first
 * tab landed at "wherever the wordmark happened to measure, plus 24px". The
 * column then reserved the rail's full width so Ask would sit on the hairline,
 * which left a hole between the date and the first tab. With Benchmarking on,
 * that hole stayed empty while Built on Databricks went off the right edge.
 *
 * The used width now hugs the lockup and the date; the rail formula is only a
 * ceiling. What is pinned is that the ceiling is still an EXPRESSION over the
 * same tokens, that the used width is max-content rather than a reservation,
 * and that neither file contains the literal. A future reader who "simplifies"
 * the ceiling back to a number, or who puts the hole back as `width:`, fails
 * here rather than in somebody's screenshot a month later.
 */

const SHELL = partial('shell.css');
const TOKENS = partial('tokens.css');
const RAIL = partial('rail.css');
const RESPONSIVE = partial('responsive.css');
const LAYOUT_SOURCE = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');

/**
 * Layout.tsx with its JSX comments removed.
 *
 * The same discipline the CSS helpers below apply, and it earned its place
 * immediately: the comment that records what the mark replaced says the word
 * `<img>`, so a check for "the lockup renders no image" read the explanation of
 * the fix as the defect it describes.
 */
const LAYOUT = LAYOUT_SOURCE.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

/** The asset that was removed. Named once so every check below spells it the same. */
const REMOVED_ASSET = 't2-logo';

/** Comments stripped, so a value discussed in prose is not read as one in a rule. */
function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * One rule's body, by exact selector.
 *
 * Anchored on the whole selector so that `.brand-mark` cannot answer for
 * `.brand-mark svg`, and `.app-nav` cannot answer for `.app-nav-tab`, which is the
 * pair this file would otherwise get wrong.
 */
function body(selector: string, css: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withoutComments(css).match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

/** Every file under a directory, recursively, as absolute paths. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    if (entry === 'node_modules' || entry === 'dist') return [];
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const CLIENT = fileURLToPath(new URL('..', import.meta.url));

describe('the header leads with the lockup, which is the app’s own mark and name', () => {
  it('draws the lockup, the release chip and the divider in the brand column', () => {
    // The column holds three things and they are all small. The release chip
    // joined it when it was moved out of the right-hand cluster, where it was in
    // the half of the header that gives and had its label cut off. It sits
    // between the wordmark and the divider; the column hugs those three rather
    // than reserving a hole after the date.
    const column = LAYOUT.match(/<div className="brand-lockup">([\s\S]*?)<\/div>/)?.[1] ?? '';
    expect(column, 'the header still has a brand lockup column').not.toEqual('');
    expect(column).toContain('<AstrolabeLockup');
    expect(column).toContain('<DeploymentTimeChip');
    expect(column).toContain('app-chrome-rule');
    // The partner plate and the "PLAYER INTELLIGENCE" kicker are gone, not merely
    // restyled. The plate reserved a position for a customer trademark this
    // repository must not carry, and the kicker was a second name under the first.
    expect(column).not.toMatch(/brand-mark|brand-full|brand-name/);
    expect(column).not.toMatch(/<img/);
  });

  it('puts that column before the nav in the header, and the chip inside it', () => {
    // The chip must be a child of the column and not a sibling of it. Placed
    // between the column and the nav it would sit in the gap the tabs now occupy
    // next to the date, which is the leftover the seventh tab needs.
    const header = LAYOUT.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
    expect(header, 'the header is still rendered here').not.toEqual('');
    expect(header.indexOf('<HeaderBrand')).toBeGreaterThan(-1);
    expect(header.indexOf('<HeaderBrand')).toBeLessThan(header.indexOf('<NavLinks'));
    expect(header).not.toContain('<DeploymentTimeChip');
  });

  it('takes the top bar’s pair of sizes rather than a size of its own', () => {
    // §1 gives two lockups and only two: 22px + 15px in the top bar, 26px + 17px
    // on a dark band. A mark and a wordmark sized separately at a call site is
    // how a third lockup appears that nobody drew.
    //
    // THE SEATING IS THE CLAIM, NOT THE EXACT TAG. This read
    // `<AstrolabeLockup as="h1" seat="bar" />` verbatim, and it failed the day the
    // login transition put a class on this element for the 1.2s it pops in over
    // (`login-transition.md` phase 5) -- for the class, not for a size. So the
    // assertion is the two props that fix the sizing, plus a refusal of anything
    // that would set a size beside them.
    const props = LAYOUT.match(/<AstrolabeLockup as="h1" seat="bar"([^>]*)\/>/)?.[1] ?? null;
    expect(props, 'the header lockup is still seated on the bar').not.toBeNull();
    expect(props).not.toMatch(/\b(size|width|height|scale)\b/);
    // A motion class is fine here; a typographic one is the third lockup this test
    // exists to prevent.
    expect(props).not.toMatch(/text-|font-|tracking-/);
  });

  it('sets the name in the app’s own type rather than shipping a logotype', () => {
    // The wordmark is a string in a component and a font-weight in a rule. There
    // is no artwork of it, which is what makes the lockup survive a font change
    // and what keeps a logotype file out of a tree that publishes publicly.
    const wordmark = body('.ast-wordmark', partial('astrolabe-mark.css'));
    expect(wordmark, 'astrolabe-mark.css has a .ast-wordmark rule').not.toEqual('');
    expect(wordmark).toMatch(/font-family:\s*var\(--font-sans\)/);
    expect(wordmark).toMatch(/font-weight:\s*700/);
    expect(wordmark).toMatch(/letter-spacing:\s*var\(--ast-tracking-tight\)/);
    // Lowercase because that is the name, and lowercased in the string rather
    // than by `text-transform`, so a reader copying it out of the page gets what
    // the app is called instead of what CSS made of it.
    expect(wordmark).not.toMatch(/text-transform/);
    expect(readFileSync(new URL('astrolabe-mark.ts', import.meta.url), 'utf8')).toMatch(
      /WORDMARK = 'astrolabe'/
    );
  });

  it('keeps the mark out of the accessibility tree, because the wordmark names the app', () => {
    // A decorative mark announced beside the wordmark it introduces is the same
    // information twice. The component hides itself unless a caller passes a
    // label, and the lockup never does -- the word is right there.
    const mark = readFileSync(new URL('AstrolabeMark.tsx', import.meta.url), 'utf8');
    expect(mark).toMatch(/aria-hidden=\{label \? undefined : true\}/);
    expect(mark).toMatch(/<AstrolabeMark size=\{mark\} ink=\{ink\} \/>/);
  });

  it('writes no colour in the drawing, so one rule inks every seating', () => {
    // The same discipline the retired robot followed. The mark is navy-on-white
    // in the bar, white-on-navy on a band and all-white on the blue button, and
    // that is three rules over one drawing rather than three drawings.
    // Comments stripped, so the note explaining WHY the mono cut exists -- which
    // has to quote the two hexes and their contrast ratio to explain it -- is not
    // read as a colour written into the drawing.
    const source = readFileSync(new URL('AstrolabeMark.tsx', import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      ' '
    );
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const css = withoutComments(partial('astrolabe-mark.css'));
    for (const ink of ['light', 'dark', 'mono']) {
      expect(css, ink).toMatch(new RegExp(`\\.ast-mark--${ink}\\s*\\{[^}]*--ast-mark-ink:`));
    }
  });

  it('drops the WORDMARK on a phone and keeps the mark, which is the way round §1 makes it', () => {
    // The reverse of what this rule used to do, and the reversal is the point.
    // The header used to carry a partner plate beside a two-line wordmark, so the
    // plate was the expendable half. The mark is the app's own now, it reads at
    // 22px, and a lockup that keeps the word and drops the drawing says nothing
    // the tab row does not.
    expect(withoutComments(RESPONSIVE)).toMatch(
      /@media \(max-width: 480px\)[\s\S]*?\.app-header \.ast-wordmark\s*\{\s*display:\s*none/
    );
    expect(withoutComments(RESPONSIVE)).not.toContain('.partner-mark');
    expect(withoutComments(stylesheet())).not.toContain('.brand-mark');
  });

  it('closes the row with the attribution, which is the one full-colour asset', () => {
    // §1: "role chip · avatar · divider · Built on Databricks", and §2 makes the
    // bricks symbol one of the only two non-palette pixels in the product. So the
    // rule that sizes it must set no ink at all: a `fill` here would be the app
    // recolouring a corporate trademark on the surface that exists to attribute
    // it.
    const symbol = body('.built-on-databricks-symbol', partial('astrolabe-chrome.css'));
    expect(symbol, 'astrolabe-chrome.css sizes the symbol').not.toEqual('');
    expect(symbol).toMatch(/width:\s*13px/);
    expect(symbol).not.toMatch(/(?:^|[;{\s])(?:color|fill|stroke|background)\s*:/);
  });
});

describe('the removed trademark is gone from the tree, not merely unreferenced', () => {
  it('no longer carries the asset file anywhere in the client', () => {
    const strays = filesUnder(CLIENT).filter((path) => path.toLowerCase().includes(REMOVED_ASSET));
    expect(strays).toEqual([]);
  });

  it('names the asset nowhere in the client source, its markup or its manifest', () => {
    // The stylesheet, the components, index.html and site.webmanifest all resolve
    // URLs into client/public, so any one of them naming the file is a request the
    // app makes for something that is not there -- and, worse, a filename in a
    // published tree that says who the partner is even with no bytes behind it.
    const named = filesUnder(CLIENT)
      .filter((path) => /\.(ts|tsx|css|html|json|webmanifest)$/.test(path))
      // This file, which has to spell the name in order to forbid it.
      .filter((path) => !path.endsWith('brand-mark.test.ts'))
      .filter((path) => readFileSync(path, 'utf8').toLowerCase().includes(REMOVED_ASSET))
      .map((path) => path.slice(CLIENT.length));
    expect(named).toEqual([]);
  });

  it('leaves no rule for the element that used to hold the image', () => {
    expect(withoutComments(stylesheet())).not.toContain('.partner-mark');
  });
});

describe('the brand column hugs the lockup and the date, and does not reserve the rail', () => {
  it('uses the rail formula as a ceiling, not as the column’s used width', () => {
    // The used width used to BE this calc, which left a hole between the date
    // and Ask the size of the unused rail. Benchmarking's seventh tab then
    // shoved Built on Databricks off the right while that hole stayed empty.
    // Hugging the contents closes the hole; the same expression remains the
    // max so a longer wordmark still cannot grow past the rail.
    const lockup = body('.brand-lockup', SHELL);
    expect(lockup).toMatch(/width:\s*max-content/);
    expect(lockup).toMatch(
      /max-width:\s*calc\(\s*var\(--conversation-width\)\s*-\s*var\(--app-header-pad-x\)\s*\+\s*var\(--app-nav-inset\)\s*\)/,
    );
    expect(lockup).not.toMatch(/(?:^|[;{\s])width:\s*calc\(/);
  });

  it('states that ceiling once, as a token, rather than as a length in the header', () => {
    const declarations = [...withoutComments(TOKENS).matchAll(/--app-nav-inset:\s*([^;]+);/g)];
    expect(declarations).toHaveLength(1);
    expect(declarations[0][1].trim()).toEqual('16px');
  });

  it('draws the rail’s own column from the same token', () => {
    expect(body('.ask-layout', RAIL)).toMatch(/grid-template-columns:[^;]*var\(--conversation-width\)/);
  });

  it('declares that width exactly once, in the file both of them read', () => {
    const declarations = [...withoutComments(TOKENS).matchAll(/--conversation-width:\s*([^;]+);/g)];
    expect(declarations).toHaveLength(1);
    expect(declarations[0][1].trim()).toEqual('340px');
    expect(withoutComments(RAIL)).not.toMatch(/--conversation-width:\s*\d/);
  });

  it('writes neither offset as a literal in the rules that use them', () => {
    const shell = withoutComments(SHELL);
    expect(shell).not.toMatch(/\b264px\b/);
    expect(body('.app-header', SHELL)).toMatch(/padding:\s*0 var\(--app-header-pad-x\)/);
    expect(withoutComments(RESPONSIVE)).not.toMatch(/\.app-header\s*\{\s*padding:/);
  });

  it('lets the column alone decide where the tabs begin', () => {
    expect(body('.app-nav', SHELL)).not.toMatch(/margin-left/);
  });

  it('gives every tab the same inset before its icon, the first one included', () => {
    expect(body('.app-nav-tab', SHELL)).toMatch(/padding:\s*0 12px/);
    expect(withoutComments(SHELL)).not.toMatch(/\.app-nav-tab:first-child/);
  });

  it('keeps Built on Databricks from shrinking or wrapping when Benchmarking adds a seventh tab', () => {
    // The hole the column used to reserve is what the seventh tab needed. The
    // attribution itself must not be the thing that gives: flex-none and nowrap
    // are what keep the bricks and the words on screen instead of clipping or
    // folding once the tabs have moved left. The 1365 band may hide the WORDS
    // (font-size: 0) and keep the symbol; it must not hide the mark at the
    // widths where the desktop nav is still drawn.
    const attribution = body('.built-on-databricks', partial('astrolabe-chrome.css'));
    expect(attribution).toMatch(/flex:\s*none/);
    expect(attribution).toMatch(/white-space:\s*nowrap/);
    expect(body('.app-header', SHELL)).not.toMatch(/overflow:\s*hidden/);
    expect(withoutComments(SHELL)).toMatch(/\.app-header > nav\s*\{\s*flex:\s*none/);
    const tight = withoutComments(RESPONSIVE).match(/@media \(max-width: 1365px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(tight).toMatch(/\.app-header \.built-on-databricks\s*\{\s*font-size:\s*0/);
    expect(tight).not.toMatch(/\.built-on-databricks[^{]*\{[^}]*display:\s*none/);
  });
});

describe('the header measures what --app-header-h says it measures', () => {
  /** A `<n>px` declaration's number, from a rule body. */
  function px(ruleBody: string, property: string) {
    const found = ruleBody.match(new RegExp(`${property}:\\s*([\\d.]+)px`));
    expect(found, `${property} is a px value`).not.toBeNull();
    return Number(found![1]);
  }

  it('is §1’s 52px, stated once rather than derived from what is inside it', () => {
    // The token used to be `--logo-mark-size + 22px`, describing a stack of a
    // brand rule, two paddings, a mark and a hairline -- so it was a claim about
    // the header's contents that somebody had to keep true by hand. It has been
    // caught lying once already, reading 52px while the header stood at 58 with
    // six pixels of the transcript underneath it. A stated height cannot drift
    // from itself.
    expect(px(TOKENS, '--app-header-h')).toEqual(52);
    expect(body('.app-header', SHELL)).toMatch(/height:\s*var\(--app-header-h\)/);
    expect(LAYOUT).toMatch(/<header className="app-header border-b/);
  });

  it('leaves the mark size out of the arithmetic entirely, because nothing derives from it', () => {
    // --logo-mark-size went with the derivation. Its only other reader was the
    // partner plate the lockup replaced, and the lockup's two size pairs are the
    // component's -- a 22px mark beside a 17px wordmark is neither of the two
    // lockups §1 has, and a stylesheet that can set them separately can produce
    // it.
    expect(withoutComments(stylesheet())).not.toContain('--logo-mark-size');
  });

  it('fits the tallest thing in the bar inside that height', () => {
    // The 22px mark plus the padding either side of it is what has to clear the
    // bottom hairline. Recomputed rather than trusted, for the same reason the
    // height is stated: the failure this catches is a lockup taken up a size
    // "because it looked small", which pushes the row against the hairline
    // without changing any number anybody would think to check.
    const lockup = readFileSync(new URL('astrolabe-mark.ts', import.meta.url), 'utf8');
    const bar = lockup.match(/bar:\s*\{\s*mark:\s*(\d+),\s*wordmark:\s*(\d+)\s*\}/);
    expect(bar, 'astrolabe-mark.ts states the bar lockup as a pair').not.toBeNull();
    const [mark, wordmark] = [Number(bar![1]), Number(bar![2])];
    expect(mark).toEqual(22);
    expect(wordmark).toEqual(15);
    const hairline = 1;
    expect(Math.max(mark, wordmark) + hairline).toBeLessThan(px(TOKENS, '--app-header-h'));
  });
});
