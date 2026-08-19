/**
 * Which Databricks product a thing on screen belongs to, and the official mark
 * that says so. One map, for the whole application.
 *
 * The handoff's rule is short: a brand icon renders wherever the UI names a
 * Databricks product or a resource owned by one -- a row, a tile, a chip, an
 * architecture node, a step in a plan. Lucide line icons keep the actions and the
 * generic concepts, the refreshes and carets and padlocks. Never both on one
 * element, and never a Lucide glyph standing in for a product.
 *
 * THIS FILE IS THE ONLY PLACE A PRODUCT IS PAIRED WITH ITS ARTWORK. Before it,
 * `TraceDag.tsx` held its own three-product map inlined at the top of a 600-line
 * component, which is how the agent map came to chip Unity Catalog with a DuBois
 * document glyph: the mapping lived where only the person editing that component
 * would ever read it. A second copy of the pairing is the same bug waiting, and
 * it is invisible, because two marks for one product are never on screen
 * together for anyone to compare.
 *
 * ## Adding a product
 *
 * 1. Put the official SVG in `assets/brand/` under its published filename. Get
 *    it from the brand asset library; do not export one from a slide, do not
 *    take a DuBois interface glyph, and do not redraw it. Read that folder's
 *    README before you copy anything into it.
 * 2. Add the slug to `BrandProduct`, and an entry to each of the three records
 *    below. TypeScript will not let you forget one -- they are all keyed on the
 *    union, which is the point of writing them as three records rather than one
 *    object of triples.
 * 3. If it is a wordmark rather than a square icon, add it to `WORDMARKS`, which
 *    is what stops it being squashed into a box.
 * 4. `brand-icons.test.ts` covers the rest: it will fail until the file exists,
 *    is the artwork it claims to be, and renders for its slug.
 *
 * If the design asks for a product whose SVG nobody has, say so and leave a
 * Lucide glyph there. An approximate mark is worse than an honest one, because a
 * reader who knows the real marks reads the lookalike as one and is then wrong
 * about which product they are looking at.
 */

// The published files themselves, inlined rather than redrawn as JSX paths. A
// copy of a drawing starts out identical and is then tidied, re-indented or
// "fixed" by somebody with nothing to compare it against; imported raw, the
// committed asset IS what renders, and a test can read the file off disk and
// find it in the markup.
//
// TWO SETS, AND THE SECOND IS WHAT RENDERS. `assets/brand/` is the official
// full-colour artwork, which is now the record of the GEOMETRY rather than the
// thing on screen: `assets/logo/theme/` holds the same paths with the fills
// substituted for the astrolabe palette, and the app draws those. Example User
// settled that on 2026-08-17 -- recolouring is permitted, redrawing is not --
// and the ruling is written into both asset READMEs. The full-colour set stays
// imported because it is what the recolour is checked AGAINST: brand-icons.test
// strips every `fill` from both and requires the remainder to be identical, so
// a "recoloured" file that quietly moved a node fails here rather than on a
// customer's screen. That check is the only mechanical guard the never-redraw
// half of the ruling has.
import appsMark from './assets/brand/apps-icon-full-color.svg?raw';
import databricksSqlMark from './assets/brand/databricks-sql-icon-full-color.svg?raw';
import genieMark from './assets/brand/genie-icon-full-color.svg?raw';
import lakebaseMark from './assets/brand/lakebase-icon-full-color.svg?raw';
import mlflowMark from './assets/brand/mlflow-logo-black-rgb.svg?raw';
import mosaicAiMark from './assets/brand/mosaic-ai-icon-full-color.svg?raw';
import unityCatalogMark from './assets/brand/unity-catalog-icon-full-color.svg?raw';
// The two CORPORATE marks, which are not products and are not in the records
// below. They are here because this file is the only one allowed to resolve
// anything out of assets/brand/ -- see "one map, and it is this one" in
// brand-icons.test.tsx -- rather than because they belong to the product map.
import databricksSymbol from './assets/brand/databricks-symbol-color.svg?raw';
import databricksLogo from './assets/brand/databricks-logo-full-color.svg?raw';

import appsLight from './assets/logo/theme/apps-blue-light.svg?raw';
import databricksSqlLight from './assets/logo/theme/databricks-sql-blue-light.svg?raw';
import genieLight from './assets/logo/theme/genie-blue-light.svg?raw';
import lakebaseLight from './assets/logo/theme/lakebase-blue-light.svg?raw';
import mlflowLight from './assets/logo/theme/mlflow-ink.svg?raw';
import mosaicAiLight from './assets/logo/theme/mosaic-ai-blue-light.svg?raw';
import unityCatalogLight from './assets/logo/theme/unity-catalog-blue-light.svg?raw';

import appsDark from './assets/logo/theme/apps-blue.svg?raw';
import databricksSqlDark from './assets/logo/theme/databricks-sql-blue.svg?raw';
import genieDark from './assets/logo/theme/genie-blue.svg?raw';
import lakebaseDark from './assets/logo/theme/lakebase-blue.svg?raw';
import mlflowDark from './assets/logo/theme/mlflow-white.svg?raw';
import mosaicAiDark from './assets/logo/theme/mosaic-ai-blue.svg?raw';
import unityCatalogDark from './assets/logo/theme/unity-catalog-blue.svg?raw';

/** The products PIA has an official mark for. */
export type BrandProduct = 'apps' | 'databricks-sql' | 'genie' | 'lakebase' | 'mlflow' | 'mosaic-ai' | 'unity-catalog';

/**
 * The product's name as a reader should see it written.
 *
 * Used for the tooltip on a mark that sits without a text label beside it, and
 * nowhere else: the icon never REPLACES the name. Where the name is already on
 * screen -- which is nearly everywhere -- the mark is decorative and this string
 * is not rendered at all, or a screen reader would read the product twice.
 */
export const BRAND_PRODUCT_NAMES: Record<BrandProduct, string> = {
  apps: 'Databricks Apps',
  'databricks-sql': 'Databricks SQL',
  genie: 'Genie',
  lakebase: 'Lakebase',
  mlflow: 'MLflow',
  // `Agents` is the visible name. The internal slug stays `mosaic-ai` because it
  // names the artwork and keys the tool map; changing it would rename files and
  // maps without changing what a reader sees.
  'mosaic-ai': 'Agents',
  'unity-catalog': 'Unity Catalog',
};

/**
 * Which surface a mark is being drawn on, which is the whole of what picks a cut.
 *
 * `light` is the blue-on-white cut and is the default because nearly every
 * surface in this app is white. `dark` is the cut for a navy band, where the
 * light cut's #2272B4 falls to 1.6:1 against #11171C and the mark reads as a
 * smudge. Not a theme in the CSS sense and deliberately not derived from one:
 * the navy bands here are individual panels on an otherwise white page, so the
 * component that draws the band is the only thing that knows.
 */
export type BrandTone = 'light' | 'dark';

/** The file each mark's OFFICIAL geometry came from, and what the recolour is checked against. */
export const BRAND_MARK_FILES: Record<BrandProduct, string> = {
  apps: 'apps-icon-full-color.svg',
  'databricks-sql': 'databricks-sql-icon-full-color.svg',
  genie: 'genie-icon-full-color.svg',
  lakebase: 'lakebase-icon-full-color.svg',
  mlflow: 'mlflow-logo-black-rgb.svg',
  'mosaic-ai': 'mosaic-ai-icon-full-color.svg',
  'unity-catalog': 'unity-catalog-icon-full-color.svg',
};

/**
 * An XML prolog, which is legal in a `.svg` file and meaningless in an HTML
 * document.
 *
 * These marks are inlined into the page rather than loaded as images, and a
 * parser that meets `<?xml version="1.0"?>` in HTML emits a bogus comment node
 * for it. Only the MLflow wordmark carries one. Stripping it is the one edit
 * made to any of these files, it removes no artwork, and it is done here rather
 * than in the committed asset so the asset stays byte-identical to what the
 * brand library published.
 */
const XML_PROLOG = /^\s*<\?xml[^>]*\?>\s*/;

/**
 * The official full-colour artwork, keyed on the product.
 *
 * NOT what renders. This is the geometry of record, against which the recoloured
 * cut below is checked; the app draws `BRAND_THEME_MARKS`. It is exported so that
 * check can be written where the two are paired, and so that a surface which one
 * day genuinely needs a full-colour mark asks for it by name rather than by
 * reaching into the assets directory and making a second pairing.
 */
export const BRAND_MARKS: Record<BrandProduct, string> = {
  apps: appsMark.replace(XML_PROLOG, '').trim(),
  'databricks-sql': databricksSqlMark.replace(XML_PROLOG, '').trim(),
  genie: genieMark.replace(XML_PROLOG, '').trim(),
  lakebase: lakebaseMark.replace(XML_PROLOG, '').trim(),
  mlflow: mlflowMark.replace(XML_PROLOG, '').trim(),
  'mosaic-ai': mosaicAiMark.replace(XML_PROLOG, '').trim(),
  'unity-catalog': unityCatalogMark.replace(XML_PROLOG, '').trim(),
};

/** The file each recoloured cut came from, per tone. */
export const BRAND_THEME_FILES: Record<BrandTone, Record<BrandProduct, string>> = {
  light: {
    apps: 'apps-blue-light.svg',
    'databricks-sql': 'databricks-sql-blue-light.svg',
    genie: 'genie-blue-light.svg',
    lakebase: 'lakebase-blue-light.svg',
    // MLflow is the spec's own carve-out: ink and white rather than the blue
    // pair, because it is a wordmark and a two-tone recolour of lettering is a
    // different drawing of it.
    mlflow: 'mlflow-ink.svg',
    'mosaic-ai': 'mosaic-ai-blue-light.svg',
    'unity-catalog': 'unity-catalog-blue-light.svg',
  },
  dark: {
    apps: 'apps-blue.svg',
    'databricks-sql': 'databricks-sql-blue.svg',
    genie: 'genie-blue.svg',
    lakebase: 'lakebase-blue.svg',
    mlflow: 'mlflow-white.svg',
    'mosaic-ai': 'mosaic-ai-blue.svg',
    'unity-catalog': 'unity-catalog-blue.svg',
  },
};

/** The artwork the app draws: official geometry, astrolabe fills. */
export const BRAND_THEME_MARKS: Record<BrandTone, Record<BrandProduct, string>> = {
  light: {
    apps: appsLight.replace(XML_PROLOG, '').trim(),
    'databricks-sql': databricksSqlLight.replace(XML_PROLOG, '').trim(),
    genie: genieLight.replace(XML_PROLOG, '').trim(),
    lakebase: lakebaseLight.replace(XML_PROLOG, '').trim(),
    mlflow: mlflowLight.replace(XML_PROLOG, '').trim(),
    'mosaic-ai': mosaicAiLight.replace(XML_PROLOG, '').trim(),
    'unity-catalog': unityCatalogLight.replace(XML_PROLOG, '').trim(),
  },
  dark: {
    apps: appsDark.replace(XML_PROLOG, '').trim(),
    'databricks-sql': databricksSqlDark.replace(XML_PROLOG, '').trim(),
    genie: genieDark.replace(XML_PROLOG, '').trim(),
    lakebase: lakebaseDark.replace(XML_PROLOG, '').trim(),
    mlflow: mlflowDark.replace(XML_PROLOG, '').trim(),
    'mosaic-ai': mosaicAiDark.replace(XML_PROLOG, '').trim(),
    'unity-catalog': unityCatalogDark.replace(XML_PROLOG, '').trim(),
  },
};

/**
 * The bricks symbol, and the horizontal logo the login gate carries.
 *
 * THESE TWO ARE THE ONLY FULL-COLOUR PIXELS THE DESIGN PERMITS IN THE PRODUCT.
 * `astrolabe-rebuild-spec.md` §2: "No orange in the palette. The full-color
 * bricks symbol inside the Built on Databricks attribution and the login-gate
 * Databricks logo are the only non-palette pixels; #FF3621 is never used as a UI
 * color, text, or accent." Everything else Databricks-shaped in this app is a
 * recoloured product icon out of `assets/logo/theme/`.
 *
 * Kept out of `BRAND_MARKS` deliberately. That record answers "which mark stands
 * for this product", and neither of these stands for a product: they say who
 * built the app. Filing them there would put the corporate mark in reach of
 * every `productFor*` lookup and of `BrandIcon`'s size union, which is exactly
 * the confusion `assets/brand/README.md` warns about -- a reader who recognises
 * Databricks artwork reads a corporate mark used as a product mark as a claim
 * about the product.
 */
export const DATABRICKS_SYMBOL = databricksSymbol.replace(XML_PROLOG, '').trim();
export const DATABRICKS_LOGO = databricksLogo.replace(XML_PROLOG, '').trim();

/** Said beside the symbol in the top bar. §1 fixes the words and the size. */
export const BUILT_ON_DATABRICKS = 'Built on Databricks';

/**
 * The marks that are words rather than squares.
 *
 * MLflow is published as a 954x408 wordmark. It is sized by HEIGHT and its width
 * follows, because a wordmark forced into a square box is either squashed or
 * cropped, and both are redrawings of it. Everything else here is a square icon
 * on a 512 grid.
 */
export const WORDMARKS: ReadonlySet<BrandProduct> = new Set<BrandProduct>(['mlflow']);

/**
 * The sizes the handoff uses, and the only ones a caller may ask for.
 *
 * Table and list rows, and the Connections rows, are 16. Tile labels, chips
 * inside cards and drawer timelines are 14. Architecture nodes are 18. A mark
 * inside a 22px kind chip is 14. Chips around a mono name, and the MLflow link,
 * are 12, which is the floor -- below it these lose legibility and read as dirt.
 *
 * Written as a union rather than a number so "never below 12px" is a compile
 * error rather than a review comment, and so a fifth size is a decision somebody
 * takes deliberately here instead of a `13` typed into one call site.
 */
export type BrandIconSize = 12 | 14 | 16 | 18;

/**
 * Which product ran a tool, keyed on the tool name the agent writes into a
 * stage id.
 *
 * The agent map's kind chips, the Run Explorer's "what ran" strips and the
 * Monitoring drawer's timeline all show the same runs from three angles, so they
 * have to agree about which product a step called. They did not have to before
 * only because two of the three showed no mark at all.
 *
 * Keyed on the tool's own name so one tool cannot be filed under two products.
 * An unmapped tool returns null and its caller keeps a Lucide fallback, which is
 * the honest answer for a tool nobody has classified yet.
 */
const TOOL_PRODUCTS: Record<string, BrandProduct> = {
  search_semantics: 'mosaic-ai',
  search_tagged_assets: 'mosaic-ai',
  describe_table: 'unity-catalog',
  list_data_assets: 'unity-catalog',
  data_genie: 'databricks-sql',
  run_sql: 'databricks-sql',
  query_named_table: 'databricks-sql',
  dictionary_genie: 'genie',
};

/** The product behind a tool call, or null if the tool is not one of ours. */
export function productForTool(tool: string): BrandProduct | null {
  return TOOL_PRODUCTS[tool] ?? null;
}

/** Every tool the map knows, for the tests and for nothing else. */
export function mappedTools(): string[] {
  return Object.keys(TOOL_PRODUCTS);
}

/**
 * Which product a step of a PROPOSED plan will call, keyed on the step's kind.
 *
 * A plan is written before anything runs, so it has no tool call to read a name
 * off: `AnalysisPlan` carries a `kind` per step and nothing finer. Two of the
 * four kinds are still a specific product, and they are read out of the agent
 * rather than guessed at --
 *
 * - `definitions` is the dictionary Genie space. agent.py builds that step with
 *   "Ask the data dictionary for the governed meaning of …", and the call it
 *   becomes is `dictionary_genie`, which `TOOL_PRODUCTS` above files under Genie.
 * - `data` is a governed read on the warehouse. Every step of that kind is a
 *   `Query <table>` or a null-ratio measurement, and all three of the tools they
 *   become -- `data_genie`, `run_sql`, `query_named_table` -- are Databricks SQL.
 *
 * The other two are deliberately null and get no mark. `context` re-reads the
 * conversation and any attachment, which is the app's own memory rather than a
 * Databricks product, and `synthesis` is the model writing the answer -- a model
 * turn, which the handoff keeps as a plain tag everywhere else too.
 */
export function productForPlanKind(kind: string): BrandProduct | null {
  if (kind === 'definitions') return 'genie';
  if (kind === 'data') return 'databricks-sql';
  return null;
}
