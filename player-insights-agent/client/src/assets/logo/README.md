# The astrolabe marks, and the recoloured product icons

Where these came from, what may be done to them, and the two things about them
that are broken on arrival.

Source: `docs/design-handoff-astrolabe/`, asset manifest in
`astrolabe-rebuild-spec.md` §8. Nothing here is referenced by the app yet. This
directory is the foundation pass putting the artwork in place, and the surfaces
that consume it are later work.

## `astrolabe-*.svg`: our own mark

Ours, drawn for this app, so no third-party terms apply. Eight files: four
concepts in two inks each. All are self-contained, `0 0 64 64`, ink `#11171C`
with blue `#2272B4` on light and white with `#6FAEDD` on dark.

| File | What it is |
| --- | --- |
| `astrolabe-dpad.svg` / `-white` | **The mark.** Ring, graduated reticle ring, d-pad cross, blue centre, four quadrant dots. Anchor `#16d`. |
| `astrolabe-rete.svg` / `-white` | Concept archive. Used only by the flicker loaders and the opening sequence. |
| `astrolabe-reticle.svg` / `-white` | Concept archive, same use. |
| `astrolabe-horizon.svg` / `-white` | Concept archive, same use. |

The d-pad is canonical and the other three are archive. `design-spec-master.md`
§0 says this in its opening sentence and then names rete as canonical four
sentences later; `astrolabe-rebuild-spec.md` §1 and §8 settle it for the d-pad,
and that is what this table records. See `docs/design-handoff-astrolabe/AS-COMMITTED.md`.

Never redraw and never restroke. The small cut for chips at 13-30px is a
different drawing of the same mark, specified in the rebuild spec §1. It drops
the graduation ring and thickens the rim, and it is not one of these files.

## `theme/`: Databricks product icons, recoloured

Fourteen files: the official product geometry with the colours substituted.
`*-blue-light.svg` is `#2272B4` over `#B7D6EE`, for white surfaces.
`*-blue.svg` is `#6FAEDD` over `#B7D6EE`, for navy. Verified as genuine
recolours rather than the full-colour files renamed, which was worth checking
because several pairs have identical byte counts.

**These are recoloured Databricks trademarks, and that is settled: the recolour
is permitted.** Example User ruled on 2026-08-17. This is a Databricks-built
application, shown to a Databricks customer, and these marks identify the
Databricks products the app actually connects to; recolouring official geometry
to sit in one palette is a presentation choice, not a rebrand.

This used to be recorded as an open question, on the grounds that
`../brand/README.md` said "never recolour" while
`docs/design-handoff-astrolabe/brand-icons.md` required the recolour app-wide.
`../brand/README.md` is the record that was wrong and it has been corrected; the
handoff was right. Do not reopen this.

Geometry is untouched in every file, which is the part that was never negotiable
and is the part the ruling did not touch: recolour, never redraw.

## `theme/mlflow-ink.svg` and `theme/mlflow-white.svg` were the same file, and are not now

**Fixed as delivered, not patched here.** Both were sha256
`26dce2cb87bcadf55fe56209337e4ee138542166a8283c84645f674620ca95f9` and **neither
declared a fill on any path**, so both rendered in the SVG default, black. The spec
asks for an ink cut for light surfaces and a white cut for navy, and only the ink cut
existed, twice. That meant the MLflow wordmark on a navy band was black on
`#11171C`: present in the DOM, invisible on screen, and invisible in a way no colour
token could fix, because there was no colour to override.

The design bundle re-cut them. They are now two files, seven paths each, every path
declaring an explicit fill: `#11171C` in `mlflow-ink.svg` and `#FFFFFF` in
`mlflow-white.svg`. Geometry and path count are unchanged, so this is a recolour of
official artwork and not a redrawing. The two hashes in
`mirror/reviewed-binaries.txt` moved with the bytes.

The note is kept rather than deleted for the next person who finds an artwork file
rendering in a default: **do not paper over it with a CSS filter, and do not edit
delivered artwork in place.** Ask for the cut. It took one round.

MLflow is also the one pair in this directory keyed to ink and white rather than to
`--ast-blue` / `--ast-icon-tint` like the other six. That is the spec's own carve-out,
not an inconsistency waiting to be tidied.

## Attribution travels with the artwork

Same rule as `../brand/README.md`, for the same reason: `mirror/publish-exclude.txt`
does not exclude `client/src/`, so these files publish to the public repository.
Keep this file beside them, and keep it in anything they are copied into.
