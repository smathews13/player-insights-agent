# Databricks product brand marks

Where these came from, what may be done to them, and why this file has to travel
with them.

## Provenance

Nine SVGs, copied verbatim out of the design handoffs at
`docs/design-handoff-pia-dubois-revamp/` and `docs/design-handoff-astrolabe/`,
which took them from the Databricks brand asset library, the same set the
corporate slide template ships. They are not on npm, they are not in Lucide, and
they are NOT the DuBois interface glyphs. See the note at the bottom, because
that mistake has already been made once in this repository.

| File | Product |
| --- | --- |
| `mosaic-ai-icon-full-color.svg` | Mosaic AI |
| `databricks-sql-icon-full-color.svg` | Databricks SQL |
| `genie-icon-full-color.svg` | Genie |
| `unity-catalog-icon-full-color.svg` | Unity Catalog |
| `lakebase-icon-full-color.svg` | Lakebase |
| `mlflow-logo-black-rgb.svg` | MLflow (a wordmark, 954x408, not a square icon) |
| `apps-icon-full-color.svg` | Databricks Apps |
| `databricks-symbol-color.svg` | The bricks symbol, for "Built on Databricks" |
| `databricks-logo-full-color.svg` | The horizontal Databricks logo, for the login gate |

Six are 512x512 full-colour icons in the brand's two-colour pair, `#FF5F46` and
`#FABFBA`. MLflow is a black wordmark and behaves differently everywhere.

The last two are the corporate marks rather than product icons, and they arrived
with the astrolabe handoff for one reason: under that design they are the only
two places in the whole application where a non-palette colour may be drawn. The
symbol is a single `#FF3621` path; the logo is the `#0B2026` wordmark beside the
same orange bricks. Everything else on screen comes out of the token block, and
`#FF3621` is not in it. Neither file is referenced yet. The chrome attribution
and the gate are later work.

## Terms

These are Databricks trademarks, and MLflow is a trademark of the Linux
Foundation. They are reproduced here to identify the Databricks products this
application is built on, which is nominative use: naming the thing you are
talking about. That permits identification and nothing else. It does not make
them ours, and it does not license them to a reader of this repository for their
own material.

So: never restroke, outline, crop, rotate or **redraw**. The geometry is the
mark, and a redrawn mark is no longer the mark it claims nominative use of.

**Recolouring is permitted, and that is decided rather than open.** Example User
ruled on 2026-08-17, on the record here because this paragraph is where the
contradiction was: this is a Databricks-built application, shown to a Databricks
customer, and these marks identify the Databricks products the app actually
connects to. Recolouring official geometry to sit in one palette is a
presentation choice, not a rebrand. The mark still names the product it names.
What is not permitted is redrawing, which is why the line above keeps its
emphasis and why `../logo/theme/` must hold the official artwork recoloured and
never a tracing of it.

An earlier version of this paragraph said "never recolour" and called
`../logo/theme/` an open question. That is the record that was wrong, and it is
corrected here rather than argued with somewhere else. `brand-icons.ts` inlines
these files verbatim for exactly that reason, and `brand-icons.test.ts` reads
them off disk and fails if the artwork in the markup differs from the artwork on
disk by a byte.

## This file is not optional

It is the attribution, and it is the only record of where the artwork came from.
Keep it beside the SVGs, and keep it in anything the SVGs are copied into.

`mirror/publish-exclude.txt` does not exclude `client/src/`, so these files and
this README publish to the public repository together, which is the intended
outcome. A published brand asset with no attribution beside it is the failure
mode to avoid. Anyone adding an exclusion under `client/src/assets/` should
satisfy themselves that it does not drop this file while keeping the artwork.
The publishing script has silently dropped licence files before.

## These are not the DuBois glyphs

`../dubois/` used to hold three 16x16 monochrome icons named `CatalogIcon.svg`,
`SQLIcon.svg` and `GenieCodeIcon.svg`, and they were used as though they were the
Unity Catalog, Databricks SQL and Genie product marks. They are not. They are
DuBois interface glyphs: a document with a bookmark, the letters S/Q/L, a
sparkle, drawn in `#5F7281` and `#6F6F6F` to sit alongside carets and padlocks.
They resemble the products they were filed under in the way a line drawing of a
building resembles a company logo.

The distinction matters because a reader who recognises Databricks marks reads a
lookalike as one and is then wrong about which product ran. If a product you need
has no file in this directory, say so and use a Lucide glyph; do not reach for the
nearest interface icon.
