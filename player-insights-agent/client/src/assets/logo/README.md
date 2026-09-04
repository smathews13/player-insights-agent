# Player Insights Agent marks and compatibility artwork

Where these came from, what may be done to them, and the two things about them
that are broken on arrival.

Source: the September 2026 PIA brand handoff. These assets are the live product
identity used by the app header, opening surfaces, loaders, empty states, and
generated app icons.

## `pia-*.svg`: current product identity

The six PIA files are canonical 64-unit drawings from the September 2026
brand handoff:

| File                                        | What it is                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pia-dpad.svg` / `pia-dpad-white.svg`       | Engraved primary D-pad for light/dark surfaces at 24px and above.                       |
| `pia-dpad-sm.svg` / `pia-dpad-white-sm.svg` | Simplified D-pad, with no engravings, for every seat below 24px.                        |
| `pia-cluster.svg` / `pia-cluster-white.svg` | Static secondary face-button cluster for loaders and empty states; never a header mark. |

`pia-mark.ts` holds the matching typed geometry. `PiaMark` chooses the
simplified cut from the rendered size, so callers cannot accidentally engrave
a mark below the legibility floor. Print uses the light-surface cuts.

## Retired artwork

The former ring/rete/reticle/horizon artwork was removed after the PIA surface
sweep moved every runtime consumer to the six `pia-*` assets above. Do not
restore those files or use their name as product branding.

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
