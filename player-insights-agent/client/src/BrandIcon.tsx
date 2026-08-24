/**
 * A Databricks product's official mark, at one of the handoff's four sizes.
 *
 * The whole API:
 *
 *     <BrandIcon product="unity-catalog" />               // 16px, a table row
 *     <BrandIcon product="genie" size={14} />             // a chip inside a card
 *     <BrandIcon product="mlflow" size={12} />            // a wordmark, 12px TALL
 *     <BrandIcon product="apps" size={18} className="…" /> // an architecture node
 *     <BrandIcon product="mosaic-ai" size={14} labelled /> // no text label beside it
 *
 * `product` is a slug from `brand-icons.ts`, which is the one place a product is
 * paired with its artwork. Add a product there, not here.
 *
 * DECORATIVE BY DEFAULT, and that is the whole of the accessibility story. Every
 * placement the handoff asks for puts the mark immediately left of the product's
 * own name -- "Sources", a table name, a node title, an endpoint. A mark that
 * announced itself there would make a screen reader read the product twice, so
 * the wrapper is `aria-hidden` and the name beside it does the announcing. This
 * is what `AstrolabeMark` already does for the agent's own mark, for the same
 * reason: it is `aria-hidden` unless a seating passes `label`, which is the
 * case where the mark is the only thing identifying what it labels.
 *
 * `labelled` is the exception, for the one seating where there IS no text: the
 * 22px kind chip on an agent-map card, where the card's line below names the
 * tool but not the product. That gets a `title`, which is what the chip carried
 * before this component existed. Do not reach for it anywhere the product's name
 * is already on the line -- a tooltip repeating the word next to it is noise the
 * reader cannot dismiss.
 *
 * The artwork is inlined rather than loaded through `<img>` so the file that
 * publishes is the file that renders and a test can hold the two together.
 *
 * NOTHING IS REDRAWN HERE, AND THE MARKS ARE NOT IN THEIR PUBLISHED INK. The
 * recolour lives in the committed artwork, as a second cut of each mark under
 * `assets/logo/theme/`, so what renders is still geometry somebody reviewed
 * rather than a `filter` this component applied to one. MLflow has one further
 * constraint: its default seating follows the page theme, so its reviewed ink
 * cut resolves the fill through `--foreground`. That is a colour substitution,
 * never a path edit, and it lets one piece of markup turn white on the night sky
 * without asking every link to know which theme the root currently carries.
 * The underlying question was settled on 2026-08-17 -- recolouring official
 * geometry into one palette is permitted, redrawing is not -- and the ruling is
 * recorded in `assets/brand/README.md` and `assets/logo/README.md`.
 */
import {
  BRAND_PRODUCT_NAMES,
  BRAND_THEME_MARKS,
  WORDMARKS,
  type BrandIconSize,
  type BrandProduct,
  type BrandTone,
} from './brand-icons';

// Types only. The values -- `productForTool`, `BRAND_PRODUCT_NAMES` -- are
// imported from `brand-icons` directly, because a module that exports both a
// component and a constant loses fast refresh for every file that imports it.
export type { BrandIconSize, BrandProduct, BrandTone } from './brand-icons';

export function BrandIcon({
  product,
  size = 16,
  tone,
  labelled = false,
  className,
}: {
  product: BrandProduct;
  /** 12, 14, 16 or 18. A height rather than a box for the MLflow wordmark. */
  size?: BrandIconSize;
  /**
   * Which fixed surface this mark is on. Omit it on ordinary page content:
   * MLflow then follows `--foreground`, while the two-colour product marks keep
   * their light-surface cut. A navy band still asks for `dark` explicitly,
   * because its colour is independent of the page theme.
   */
  tone?: BrandTone;
  /** Name the product in a tooltip. Only where no text label sits beside it. */
  labelled?: boolean;
  className?: string;
}) {
  const wordmark = WORDMARKS.has(product);
  const classes = ['brand-icon', wordmark ? 'wordmark' : '', className].filter(Boolean).join(' ');
  /*
   * MLflow is the only one-colour mark in the set, so it is the only mark whose
   * reviewed light cut can follow one semantic ink without losing information.
   * Replacing the seven identical fill values at render time leaves every path,
   * class and coordinate byte-for-byte as reviewed. The other products are
   * two-colour drawings and therefore continue to use their committed cuts.
   */
  const mark =
    product === 'mlflow' && tone === undefined
      ? BRAND_THEME_MARKS.light.mlflow.replaceAll('#11171C', 'var(--foreground)')
      : BRAND_THEME_MARKS[tone ?? 'light'][product];
  return (
    <span
      className={classes}
      // The size travels as a custom property rather than as `width`, so a page
      // partial can still reach the geometry with a class -- and so the wordmark
      // rule can spend the same number on height alone.
      style={{ ['--brand-icon-size' as string]: `${size}px` }}
      aria-hidden={labelled ? undefined : 'true'}
      title={labelled ? BRAND_PRODUCT_NAMES[product] : undefined}
      dangerouslySetInnerHTML={{ __html: mark }}
    />
  );
}
