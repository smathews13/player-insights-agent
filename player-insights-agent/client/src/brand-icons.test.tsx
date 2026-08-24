import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BrandIcon } from './BrandIcon';
import {
  BRAND_MARKS,
  BRAND_MARK_FILES,
  BRAND_PRODUCT_NAMES,
  BRAND_THEME_FILES,
  BRAND_THEME_MARKS,
  mappedTools,
  productForTool,
  type BrandProduct,
  type BrandTone,
} from './brand-icons';
import { partial, partialNames, stylesheet } from './styles/stylesheet';

/**
 * The product marks: the right drawing for the right product, unaltered, and in
 * one place.
 *
 * Three defects sit behind this file, and each has an assertion here.
 *
 * The first is the one a reader would notice. The agent map chipped Unity
 * Catalog, Databricks SQL and Genie with DuBois INTERFACE glyphs -- a bookmarked
 * document, the letters S/Q/L, a sparkle -- filed under those product names in a
 * map inside `TraceDag.tsx`. They are not the product marks and they never were;
 * they are the icons that sit beside carets and padlocks, drawn in #5F7281 and
 * #6F6F6F. Somebody who knows the Databricks marks reads a lookalike as one and
 * is then wrong about which product ran, which is worse than an honest app
 * glyph, and it is the one failure a screenshot review does not catch because the
 * chips look deliberate.
 *
 * The second is why the mapping now lives in a module of its own. It used to be
 * declared at the top of a 600-line component, so the only person who could see
 * it was the one editing that component, and the three other screens the handoff
 * puts the same per-tool marks on had no way to agree with it. Two marks for one
 * product are never on screen together for anyone to compare.
 *
 * The third is what the artwork assertions are for. "Never redrawn" cannot be
 * held by a `<path>` typed into JSX: it starts identical and is then indented,
 * minified or tidied by somebody with nothing to compare it against. So the
 * component inlines the committed file, and these read the file off disk and find
 * it in the rendered markup. They fail on any edit to the artwork, which is the
 * point.
 *
 * What none of this can do is say the marks look right on screen. It can say
 * which file rendered, at what size, in which ink; it cannot say the 12px chip is
 * legible at 12px. That needs eyes.
 */

const HERE = new URL('./assets/brand/', import.meta.url);
const THEME = new URL('./assets/logo/theme/', import.meta.url);

/** The published file, as committed. */
function asset(file: string): string {
  return readFileSync(new URL(file, HERE), 'utf8').trim();
}

/** The recoloured cut, as committed. */
function themed(file: string): string {
  return readFileSync(new URL(file, THEME), 'utf8').trim();
}

const PRODUCTS = Object.keys(BRAND_MARK_FILES) as BrandProduct[];
const TONES: BrandTone[] = ['light', 'dark'];

/**
 * A drawing with every fill removed, which is the part of it that may not change.
 *
 * The ruling this file now enforces has two halves and they need separating
 * mechanically: recolouring is permitted, redrawing is not. Strip the colours and
 * what is left is the geometry, the node count, the order and the viewBox -- so
 * "the same drawing in a different ink" compares equal here and "the same ink on
 * a tidied path" does not.
 */
function geometry(svg: string): string {
  return (
    svg
      .replace(/\s*fill="[^"]*"/g, '')
      // The MLflow wordmark's `d` carries its line breaks as `&#xA;&#x9;`
      // entities and the re-cut writes them as spaces. Both are whitespace inside
      // path data and neither moves a coordinate, so they are normalised rather
      // than reported: a check that failed on the encoding of a newline would be
      // read as noise and then routed around, which is the last thing this one
      // can afford to be.
      .replace(/&#x[aA];|&#x9;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The two files in `assets/brand/` that are not a product's mark.
 *
 * These are the Databricks corporate symbol and the horizontal logo, and they are
 * the ONLY two places in the app permitted to draw a colour that is not in the
 * palette: the bricks symbol in the "Built on Databricks" attribution, and the logo
 * on the login gate. Neither is a tool a run can call, so neither belongs in
 * `BRAND_MARK_FILES`, and the bijection below is over what remains.
 *
 * Named one at a time rather than filtered by a pattern. A pattern would also
 * excuse the next file somebody drops in this directory, and the bijection's whole
 * job is to notice that.
 */
const NOT_A_PRODUCT_MARK = ['databricks-logo-full-color.svg', 'databricks-symbol-color.svg'];

/** The two-colour pair the six icons are published in, and MLflow's black. */
const OFFICIAL_INK = /#FF5F46|#FABFBA/i;

describe('every product resolves to its own published mark', () => {
  it('has an asset for each product and a product for each asset', () => {
    // Both directions. A file with no product is dead weight nobody will notice
    // is unused; a product with no file is the substitution this whole module
    // exists to make impossible.
    const onDisk = readdirSync(HERE)
      .filter((name) => name.endsWith('.svg'))
      .filter((name) => !NOT_A_PRODUCT_MARK.includes(name))
      .sort();
    expect(Object.values(BRAND_MARK_FILES).sort()).toEqual(onDisk);
  });

  it('carries the two corporate marks the chrome and the gate need', () => {
    // Held here rather than left to the surfaces that will use them, because
    // neither surface is built yet and an absent file is the failure that is
    // discovered late: `assets/brand/README.md` says these two exist, the astrolabe
    // spec allows non-palette colour nowhere else, and nothing else would notice
    // them going missing while they are still unreferenced.
    const onDisk = readdirSync(HERE);
    for (const file of NOT_A_PRODUCT_MARK) {
      expect(onDisk, file).toContain(file);
      expect(asset(file), file).toMatch(/#FF3621/i);
    }
  });

  it('has a recoloured cut of each product in each tone', () => {
    // Both directions again, over the directory the app actually draws from. A
    // theme file with no product is dead weight; a product with no theme file is
    // a mark that would fall back to nothing on screen.
    const onDisk = readdirSync(THEME)
      .filter((name) => name.endsWith('.svg'))
      .sort();
    const declared = TONES.flatMap((tone) => Object.values(BRAND_THEME_FILES[tone])).sort();
    expect(declared).toEqual(onDisk);
  });

  it.each(PRODUCTS)('renders %s from its own recoloured file and no other', (product) => {
    // An explicit light surface is used here because MLflow's ordinary page
    // seating resolves this same reviewed cut through `--foreground`; the
    // geometry guard below proves that substitution moved no path.
    const markup = renderToStaticMarkup(<BrandIcon product={product} tone="light" />);
    const own = themed(BRAND_THEME_FILES.light[product]);

    // The whole file, verbatim, apart from an XML prolog -- which is legal in an
    // .svg and a bogus comment node in HTML, and is the only thing this module
    // removes from any of them.
    expect(markup).toContain(own.replace(/^\s*<\?xml[^>]*\?>\s*/, ''));

    // And nobody else's. The failure this catches is a copy-paste in the map
    // above: two products pointing at one file renders green everywhere else,
    // because the icon that appears is a real Databricks mark either way.
    for (const other of PRODUCTS) {
      if (other === product) continue;
      expect(markup).not.toContain(themed(BRAND_THEME_FILES.light[other]).slice(0, 400));
    }
  });

  it('draws the dark cut only where a caller says the surface is navy', () => {
    // The light cut's #2272B4 is 1.6:1 on #11171C, so a mark that inherits the
    // default onto a navy band is present in the DOM and invisible on screen --
    // the exact failure the delivered MLflow pair shipped with. Nothing in the
    // DOM tells this component what it is sitting on, so the band asks.
    const light = renderToStaticMarkup(<BrandIcon product="genie" />);
    const dark = renderToStaticMarkup(<BrandIcon product="genie" tone="dark" />);
    expect(light).toContain('#2272B4');
    expect(dark).toContain('#6FAEDD');
    expect(dark).not.toContain('#2272B4');
  });

  it('lets the one-colour MLflow wordmark follow the page theme', () => {
    /*
     * The app defaults to the night sky but can switch while this component is
     * mounted. Baking the ink cut into an ordinary link left black lettering on
     * the dark page; reading `--foreground` means the same markup follows both
     * root themes, while an explicitly navy seating still gets the reviewed
     * white cut.
     */
    const adaptive = renderToStaticMarkup(<BrandIcon product="mlflow" size={12} />);
    const fixedDark = renderToStaticMarkup(<BrandIcon product="mlflow" size={12} tone="dark" />);

    expect(adaptive).toContain('fill="var(--foreground)"');
    expect(adaptive).not.toContain('fill="#11171C"');
    expect(fixedDark).toContain('fill="#FFFFFF"');
    expect(geometry(adaptive)).toContain(geometry(BRAND_THEME_MARKS.light.mlflow));
  });

  it('recolours the official geometry rather than redrawing it', () => {
    // THE ONE MECHANICAL GUARD THE RULING HAS. Example User settled on 2026-08-17
    // that recolouring a product mark into the astrolabe palette is permitted and
    // redrawing it is not, which leaves "is this the same drawing" as the thing a
    // test has to answer. Strip the fills from both the published file and the
    // recoloured cut and the remainder has to be identical: same paths, same
    // order, same viewBox. A tracing, a re-export from a design tool, or a path
    // somebody tidied all fail here, and none of them would be visible at 14px.
    //
    // This replaces an assertion that every mark still matched its published ink.
    // That check was the previous answer to the same question and it now has the
    // meaning inverted -- the whole point is that the ink CHANGED -- so it is
    // replaced rather than deleted, and the geometry it was standing guard over
    // is held more directly than it was before.
    for (const product of PRODUCTS) {
      for (const tone of TONES) {
        expect(geometry(BRAND_THEME_MARKS[tone][product]), `${product} ${tone}`).toEqual(
          geometry(BRAND_MARKS[product])
        );
      }
    }
  });

  it('keeps the published artwork in the ink it was published in', () => {
    // The recolour is a second cut, not an edit of the first. `assets/brand/`
    // remains the geometry of record and is what the check above compares
    // against, so it has to stay as the brand library published it.
    for (const product of PRODUCTS) {
      if (product === 'mlflow') continue;
      expect(BRAND_MARKS[product], product).toMatch(OFFICIAL_INK);
    }
  });

  it('paints the recoloured cuts out of the astrolabe palette and nothing else', () => {
    // Two blues and one tint, per §2 and `assets/logo/README.md`: #2272B4 over
    // #B7D6EE on white, #6FAEDD over #B7D6EE on navy, with MLflow keyed to ink
    // and white because a wordmark takes no two-tone recolour. An #FF5F46 left
    // behind by a half-finished recolour is the failure this names, and it is
    // one nobody spots in a row of chips.
    const ALLOWED: Record<BrandTone, RegExp> = {
      light: /^(#2272B4|#B7D6EE|#11171C|none)$/i,
      dark: /^(#6FAEDD|#B7D6EE|#FFFFFF|none)$/i,
    };
    for (const tone of TONES) {
      for (const product of PRODUCTS) {
        const fills = [...BRAND_THEME_MARKS[tone][product].matchAll(/fill="([^"]*)"/g)].map((match) => match[1]);
        expect(fills.length, `${product} ${tone} declares a fill on every path`).toBeGreaterThan(0);
        for (const fill of fills) expect(fill, `${product} ${tone}`).toMatch(ALLOWED[tone]);
      }
    }
  });

  it('strips the XML prolog rather than shipping it into the document', () => {
    expect(asset(BRAND_MARK_FILES.mlflow)).toMatch(/^<\?xml/);
    expect(BRAND_MARKS.mlflow).toMatch(/^<svg/);
  });
});

describe('the mark is decorative, because the name is already beside it', () => {
  it('hides itself from a screen reader by default', () => {
    // Every placement the handoff asks for sits the mark immediately left of the
    // product's own name. Announcing it there reads the product twice. This is
    // what PiaRobotMark already does, for the same reason.
    const markup = renderToStaticMarkup(<BrandIcon product="unity-catalog" />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('title=');
  });

  it('names the product only where nothing else does', () => {
    // The one seating with no text: a 22px kind chip on an agent-map card, whose
    // line below names the tool but not the product behind it.
    const markup = renderToStaticMarkup(<BrandIcon product="genie" size={14} labelled />);
    expect(markup).toContain('title="Genie"');
    expect(markup).not.toContain('aria-hidden');
  });

  it('spells each product the way a reader should see it written', () => {
    // `mosaic-ai` renders as Agents. The slug is the artwork's filename and the
    // key half this repository's tool map is written against, so it stays; the
    // string is what a reader sees, and a reader is shown the product's current
    // name. The two are allowed to differ precisely because this map is the one
    // place they are paired.
    expect(BRAND_PRODUCT_NAMES).toMatchObject({
      'unity-catalog': 'Unity Catalog',
      'databricks-sql': 'Databricks SQL',
      'mosaic-ai': 'Agents',
      mlflow: 'MLflow',
    });
    expect(Object.values(BRAND_PRODUCT_NAMES).join(' ')).not.toContain('Mosaic');
  });
});

describe('sizing follows the handoff, and cannot go under it', () => {
  it('carries the size as the property the stylesheet reads', () => {
    expect(renderToStaticMarkup(<BrandIcon product="apps" size={18} />)).toContain('--brand-icon-size:18px');
    // The default is the row size, which is the commonest seating by a distance.
    expect(renderToStaticMarkup(<BrandIcon product="apps" />)).toContain('--brand-icon-size:16px');
  });

  it('states the four sizes as a type, so 11px is a compile error', () => {
    // Not a runtime claim -- there is nothing to run. `BrandIconSize` is a union
    // of 12 | 14 | 16 | 18, so "never below 12px" is enforced by tsc at every
    // call site rather than by a review comment. This pins the union so widening
    // it is a deliberate edit here as well as there.
    const source = readFileSync(new URL('./brand-icons.ts', import.meta.url), 'utf8');
    expect(source).toContain('export type BrandIconSize = 12 | 14 | 16 | 18;');
  });

  it('sizes the MLflow wordmark by height and lets its width follow', () => {
    // 954x408. A square box either squashes it to a fifth of its length or crops
    // the flow off the end, and both are redrawings of it.
    const wordmark = renderToStaticMarkup(<BrandIcon product="mlflow" size={12} />);
    expect(wordmark).toContain('class="brand-icon wordmark"');
    expect(renderToStaticMarkup(<BrandIcon product="genie" />)).toContain('class="brand-icon"');

    const css = partial('brand.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).toMatch(/\.brand-icon\.wordmark,\s*\.brand-icon\.wordmark > svg \{\s*width: auto;/);
  });
});

describe('the stylesheet sets geometry and never ink', () => {
  it('reaches the sheet the app ships rather than only sitting on disk', () => {
    // partial() reads a file directly; the import list is the cascade. A partial
    // that exists and is not imported leaves every rule above unloaded and every
    // claim about it passing.
    expect(partialNames()).toContain('brand.css');
    expect(stylesheet()).toContain('.brand-icon {');
  });

  it('declares no colour of its own', () => {
    const css = partial('brand.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).not.toMatch(/(?:^|[;{\s])(?:color|fill|stroke|background)\s*:/);
  });
});

describe('one map, and it is this one', () => {
  it('keeps the artwork out of every other source file', () => {
    // The consolidation, asserted rather than described. TraceDag.tsx used to
    // import three of these directly; anything that does so again has made a
    // second pairing of product to drawing, and the two are never on screen
    // together for anyone to notice they disagree.
    // Matched on the IMPORT rather than on the text. A bare `includes` also fired
    // on FirstOpenGate.tsx, whose header explains at length why it draws no brand
    // artwork -- so the one file that reasoned itself into compliance was the only
    // one the check named, and the finding said nothing about a second pairing.
    // Prose about the directory is not a second drawing of anything; a module
    // resolving a file out of it is.
    // Both directories, since the recolour gave the app a second place to reach
    // into. A component importing `assets/logo/theme/genie-blue-light.svg`
    // directly is the same second pairing as the old `assets/brand/` import was,
    // and it now has the extra hazard of picking a tone the surface is not.
    const importsArtwork = /(?:import\s[^;]*?from\s*|import\s*)['"][^'"]*assets\/(brand|logo\/theme)\/[^'"]*['"]/s;
    const dir = new URL('./', import.meta.url);
    const offenders = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'))
      .filter((name) => name !== 'brand-icons.ts')
      .filter((name) => importsArtwork.test(readFileSync(new URL(name, dir), 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('files each tool under one product, and leaves an unknown tool alone', () => {
    // The agent map, the Run Explorer's "what ran" strips and the Monitoring
    // drawer's timeline show the same runs from three angles. They agree because
    // they read this, not because three call sites were kept in step.
    expect(productForTool('search_semantics')).toBe('mosaic-ai');
    expect(productForTool('describe_table')).toBe('unity-catalog');
    expect(productForTool('run_sql')).toBe('databricks-sql');
    expect(productForTool('dictionary_genie')).toBe('genie');
    expect(productForTool('something_nobody_has_classified')).toBeNull();

    // No tool filed under two products, and every product it names is one we have
    // a mark for.
    expect(new Set(mappedTools()).size).toBe(mappedTools().length);
    for (const tool of mappedTools()) {
      expect(PRODUCTS).toContain(productForTool(tool));
    }
  });

  it('keeps the attribution beside the artwork', () => {
    // These are trademarks reproduced to identify the products this app is built
    // on. The README is the only record of where they came from and what may be
    // done to them, and a publishing script has dropped a licence file before.
    const readme = readFileSync(new URL('README.md', HERE), 'utf8');
    expect(readme).toContain('trademark');
    for (const file of Object.values(BRAND_MARK_FILES)) {
      expect(readme, file).toContain(file);
    }
    // And beside the cuts that actually render, which is the directory a reader
    // of the published repository meets first. It has to carry the ruling that
    // permits the recolour as well as the attribution, because "why is the Genie
    // mark blue" is the question the recolour invites and an unanswered one gets
    // reopened.
    const themeReadme = readFileSync(new URL('../README.md', THEME), 'utf8');
    expect(themeReadme).toMatch(/recolour/i);
    expect(themeReadme).toMatch(/never redraw/i);
  });
});
