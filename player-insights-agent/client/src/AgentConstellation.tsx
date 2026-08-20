/**
 * The run's steps as a night sky, in the two arrangements the design draws.
 *
 * `AgentPathConstellation` is `#18a`: the rail's run, vertical, connecting as it
 * happens. The line into the step in progress draws on a 2.2s loop and that step's
 * star pulses; every other line is at rest. IT STAYS UP AFTER THE RUN, at rest and
 * with the ending named on its status line, because the reader asked to keep
 * looking at the drawing of the run they just watched rather than have it
 * substituted for a list the moment the answer lands. Nothing about it animates
 * then: `activeIndex` is the caller's statement that a step is in progress, and
 * -1 is the same caller saying none is.
 *
 * `AgentMapConstellation` is `#18b`: the finished run, horizontal and scattered,
 * with each step's name and figures set opposite the line flow and the selected
 * star ringed and tinted.
 *
 * Every coordinate comes out of `agent-constellation.ts` and none is written here.
 * That is the same split the rest of this page uses -- vitest runs on `node`, so a
 * number that only exists as an attribute in JSX can be asserted against a
 * rendered tree and never against the arithmetic behind it -- and here it is also
 * what makes the overflow claim checkable: the geometry module derives every
 * position from the box, and its test reads them back and fails if anything lands
 * outside it at any step count.
 *
 * THE FINISHED MAP IS DECORATIVE; THE LIVE PATH IS INSPECTABLE. The map's band is
 * `aria-hidden` because the card grid underneath it owns selection. The path has no
 * duplicate card grid, so each star is a keyboard-operable step selector and the SVG
 * is named as the "Agent steps" group. Its status line is the one
 * `aria-live="polite"` region: "Step 07 · Preparing the findings · 12s", a sentence
 * about the run rather than a description of the animation. Elapsed time is the
 * caller's measured elapsed, never a percentage.
 *
 * `prefers-reduced-motion: reduce` freezes all of it, in astrolabe-animation.css,
 * through the `ast-anim-*` class names this file uses. That guard also restores the
 * resting state each animation would otherwise be frozen mid-way into -- a drawn
 * line rather than an undrawn one -- which is why the classes are used rather than
 * an inline `animation`.
 */
import { AstrolabeMark } from './AstrolabeMark';
import {
  buildMapConstellation,
  buildPathConstellation,
  SELECTED_RING,
  type ConstellationLabel,
  type ConstellationLink,
  type ConstellationStar,
} from './agent-constellation';
import {
  BRAND_PRODUCT_NAMES,
  BRAND_THEME_MARKS,
  productForTool,
  type BrandProduct,
  type BrandTone,
} from './brand-icons';
import { useEffect, useState } from 'react';
import type { TraceStage } from './answer-shape';

/**
 * A recoloured mark as a data URL, for the one seating that cannot inline it.
 *
 * A star on a band is an `<image>` in the middle of a drawing, which is what the
 * design reference does too, and an `<image>` needs a URL rather than markup.
 * A data URL rather than a bundled asset path so the mark travels with the
 * document: one fewer request, and it cannot 404 out of a deploy tree that copied
 * the JavaScript and missed the assets.
 *
 * DERIVED FROM `brand-icons.ts`, NOT FROM A SECOND COPY OF THE ARTWORK. This lane
 * briefly had its own `theme-icons.ts` holding the recoloured pairs, written in
 * parallel with Lane A extending `BrandIcon` over the same files.
 * brand-icons.test.tsx caught it -- "keeps the artwork out of every other source
 * file" -- and it was right to: two maps of one drawing disagree the first time
 * one of them is retuned. So the bytes come from the one map and only the
 * encoding happens here.
 *
 * `encodeURIComponent` rather than base64: it survives a diff, and an artwork
 * file that fails to encode is readable in the markup rather than a wall of
 * base64 nobody can check.
 */
function markUrl(tone: BrandTone, product: BrandProduct): string {
  return `data:image/svg+xml,${encodeURIComponent(BRAND_THEME_MARKS[tone][product])}`;
}

/**
 * The product behind a tool call, where there is a mark worth drawing for it.
 *
 * Null for a tool nobody has classified, and null for MLflow, which is a
 * wordmark rather than a square mark and cannot be a 16px star.
 */
function starProduct(tool: string): BrandProduct | null {
  const product = productForTool(tool);
  if (product === null || product === 'mlflow') return null;
  return product;
}

/**
 * A four-point sparkle centred on a star, drawn at the reach asked for.
 *
 * The design's glyph for an agent decision, and the reason it is a path rather
 * than a lucide `Sparkles`: this is inside an SVG at 14 units on a navy ground,
 * where a stroked icon at that size reads as a smudge. The current step draws the
 * same shape larger, which is what makes the pulse legible without changing what
 * the glyph means.
 */
function sparkle(x: number, y: number, reach: number): string {
  const arm = reach * 0.73;
  const stub = reach * 0.27;
  return `M${x} ${y - reach}l${stub} ${arm} ${arm} ${stub}-${arm} ${stub}-${stub} ${arm}-${stub}-${arm}-${arm}-${stub} ${arm}-${stub}z`;
}

/**
 * One star: a sparkle for an agent decision, the product's recoloured mark for a
 * tool call.
 *
 * A tool nobody has classified gets the sparkle's neutral sibling, a plain dot,
 * rather than a mark that fits: a reader who knows the Databricks marks reads a
 * lookalike as one and is then wrong about which product ran, which is the defect
 * `brand-icons.ts` was written to end.
 */
function Star({ star, tone }: { star: ConstellationStar; tone: BrandTone }) {
  if (star.decision) {
    return <path className="ast-star-decision" d={sparkle(star.x, star.y, 7)} />;
  }
  const product = star.tool === '' ? null : starProduct(star.tool);
  if (product === null) {
    return <circle className="ast-star-plain" cx={star.x} cy={star.y} r="4" />;
  }
  return <image href={markUrl(tone, product)} x={star.x - 8} y={star.y - 8} width="16" height="16" />;
}

/** A connector, at rest or drawing itself. */
function Link({ link }: { link: ConstellationLink }) {
  if (!link.live) return <path className="ast-link" d={link.d} />;
  // pathLength and the dash array are what make one keyframe work for lines of
  // every length: ast-draw runs stroke-dashoffset from 1 to 0 in normalised units
  // rather than in user units. See astrolabe-animation.css.
  return <path className="ast-link ast-link-live ast-anim-draw" d={link.d} pathLength={1} strokeDasharray="1" />;
}

/**
 * The last stage that did not complete, or -1 when every one of them did.
 *
 * The LAST rather than the first: a run can carry a partial step in the middle
 * and go on past it, and what this is read for is where the record stops.
 */
function lastUnfinished(stages: TraceStage[]): number {
  for (let at = stages.length - 1; at >= 0; at -= 1) {
    if (stages[at].status !== 'complete') return at;
  }
  return -1;
}

/**
 * The stars a run has not reached yet do not exist.
 *
 * There is no placeholder for a step the agent has not announced, which is the
 * live step list's own rule and for its reason: a plausible star beside real ones
 * makes a reader doubt the real ones.
 */
export function AgentPathConstellation({
  stages,
  activeIndex,
  elapsedMs,
}: {
  stages: TraceStage[];
  /** The step in progress, or -1. The caller's decision, not this file's. */
  activeIndex: number;
  /** How long that step has been going, from the caller's one clock. */
  elapsedMs: number | null;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  useEffect(() => {
    // Follow the live frontier. A manual selection remains useful only until the
    // agent reports its next current step.
    setSelectedIndex(null);
  }, [activeIndex]);
  if (stages.length === 0) return null;
  const current = activeIndex >= 0 && activeIndex < stages.length ? stages[activeIndex] : null;
  const shownIndex = selectedIndex ?? (current ? activeIndex : -1);
  const shown = shownIndex >= 0 ? stages[shownIndex] : null;
  /*
   * WHETHER THE RUN IS ACTUALLY INSIDE THAT STEP, which is not the same question as
   * which step is the frontier.
   *
   * `activeIndex` is the newest step the run reported, and against a model that
   * announces nothing it is the last COMPLETED step -- the state a reader sees if
   * the app deploy and the model re-log land separately. The star still gets the
   * ring there, because the frontier is a real thing to mark. The elapsed figure
   * does not, because it would be the browser's own count printed beside a step
   * that finished and reported its own duration, which is a moving number on a
   * settled measurement. `railTiming` refuses the same substitution for the same
   * reason.
   */
  const inFlight = current?.status === 'running';
  // Nothing draws and nothing pulses on a run that has stopped. A line animating
  // into the last step of a finished run is the panel saying the run is still going.
  const path = buildPathConstellation(stages, inFlight ? activeIndex : -1);
  const currentStar = current ? path.stars[activeIndex] : null;
  /*
   * WHERE A SETTLED RUN ENDED, when it did not end cleanly. The band stays up
   * after the run now, so the one line on it has to survive a run that died: over
   * a failed run, "Every step recorded" is a reassurance the record contradicts.
   *
   * Read off the stages rather than handed down with the run's outcome, so this
   * line cannot disagree with the steps drawn above it, and it reports on the
   * RECORD where the pill in the head reports on the RUN -- "Failed at step 05"
   * is that pill's, and is a claim about the run as a whole.
   *
   * The three endings are kept apart because they are three different facts: a
   * stage the agent reported as `failed`, one it reported as `partial`, and one it
   * ANNOUNCED AND NEVER REPORTED, which is what a run killed mid-step leaves in
   * the list and the only one of the three where the word is ours rather than the
   * agent's own. `-1` is the run that ended with every step complete.
   */
  const endedAt = current ? -1 : lastUnfinished(stages);
  const ended = endedAt === -1 ? null : stages[endedAt];
  return (
    <div className="ast-sky ast-sky-path">
      <svg
        role="group"
        aria-label="Agent steps"
        className="ast-sky-canvas"
        viewBox={`0 0 ${path.width} ${path.height}`}
        preserveAspectRatio="xMidYMin meet"
        fill="none"
      >
        <g className="ast-links">
          {path.links.map((link) => (
            <Link key={`${link.from}-${link.to}`} link={link} />
          ))}
        </g>
        {path.stars.map((star, index) => (
          <g
            key={star.id}
            className={`ast-star-select ${shownIndex === index ? 'selected' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`Select step ${path.numbers[index].label}: ${stages[index].name}`}
            onClick={() => setSelectedIndex(index)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setSelectedIndex(index);
            }}
          >
            <Star star={star} tone="dark" />
          </g>
        ))}
        {/* The step in progress, marked twice: the glyph beats and a ring breathes
            around it. Two marks rather than one, because a reader who cannot see
            the opacity dip still sees the ring, and because the ring is what
            survives at the small end of this band's rendered width.
            On a run that has stopped the frontier keeps the ring and loses both the
            beat and the larger glyph -- the newest step is still worth marking, and
            marking it is not the same as claiming it is happening. */}
        {currentStar && (
          <>
            {inFlight && (
              <g className="ast-anim-center-pulse" style={{ transformOrigin: `${currentStar.x}px ${currentStar.y}px` }}>
                <path className="ast-star-current" d={sparkle(currentStar.x, currentStar.y, 9)} />
              </g>
            )}
            <circle
              className={`ast-star-ring ${inFlight ? 'ast-anim-star-pulse' : ''}`.trim()}
              cx={currentStar.x}
              cy={currentStar.y}
              r={SELECTED_RING}
              style={inFlight ? { transformOrigin: `${currentStar.x}px ${currentStar.y}px` } : undefined}
            />
          </>
        )}
        <g className="ast-sky-num">
          {path.numbers.map((number) => (
            <text key={number.step} x={number.x} y={number.y} textAnchor={number.anchor}>
              {number.label}
            </text>
          ))}
        </g>
      </svg>
      {/*
        The one live region on this surface, and the visible label doubles as it.
        A run in flight names the step it is inside; a settled one names how it
        ended, rather than leaving a counter running or a step described as
        happening. The elapsed figure is the caller's measured elapsed in DM Mono,
        because it is a figure in a right-aligned meta slot.
      */}
      <p className="ast-sky-status" aria-live="polite">
        <span className="ast-sky-status-mark" aria-hidden="true">
          <AstrolabeMark size={18} ink="dark" />
        </span>
        <span className="ast-sky-status-text">
          {shown
            ? `Step ${path.numbers[shownIndex].label} · ${shown.name}`
            : ended === null
              ? 'Every step recorded'
              : `Step ${path.numbers[endedAt].label} · ${ended.name} · ${
                  ended.status === 'running' ? 'never reported' : ended.status
                }`}
        </span>
        {inFlight && elapsedMs !== null && (
          <span className="ast-num ast-sky-status-elapsed">{`${Math.max(0, Math.floor(elapsedMs / 1000))}s`}</span>
        )}
      </p>
    </div>
  );
}

/**
 * A star's two lines of text, on the side of it the connectors are not.
 *
 * The name is the near line and the figures sit beyond it. The figures are DM Mono
 * because a step number and a duration in a meta slot are figures, which
 * `.ast-num` exists to state in one place; the name is DM Sans, except where the
 * name IS a tool's identifier, which takes the mono face every identifier in this
 * app takes.
 */
function Label({ label, selected }: { label: ConstellationLabel; selected: boolean }) {
  return (
    <>
      <text
        className={`ast-sky-name ${label.mono ? 'mono' : ''} ${selected ? 'selected' : ''}`.trim()}
        x={label.x}
        y={label.nameY}
        textAnchor="middle"
      >
        {label.name}
      </text>
      <text className="ast-sky-meta" x={label.x} y={label.metaY} textAnchor="middle">
        {label.meta}
      </text>
    </>
  );
}

export function AgentMapConstellation({ stages, selectedId }: { stages: TraceStage[]; selectedId: string | null }) {
  if (stages.length === 0) return null;
  const map = buildMapConstellation(stages);
  const selected = selectedId === null ? null : (map.stars.find((star) => star.id === selectedId) ?? null);
  const legend = legendProducts(map.stars);
  return (
    <div className="ast-sky ast-sky-map">
      <svg
        aria-hidden="true"
        focusable="false"
        className="ast-sky-canvas"
        viewBox={`0 0 ${map.width} ${map.height}`}
        preserveAspectRatio="xMidYMid meet"
        fill="none"
      >
        <g className="ast-links">
          {map.links.map((link) => (
            <path className="ast-link" key={`${link.from}-${link.to}`} d={link.d} />
          ))}
        </g>
        {/* Under the star rather than over it, so the mark keeps its own edges: a
            tinted disc on top of a 16px product icon is a wash over the artwork.
            §5's ring and tint on the selected star, and nothing else changes -- the
            glyph is the same glyph, because what is selected is not a different
            kind of step. */}
        {selected && (
          <circle className="ast-star-selected" cx={selected.x} cy={selected.y} r={SELECTED_RING} />
        )}
        {map.stars.map((star) => (
          <Star key={star.id} star={star} tone="dark" />
        ))}
        {map.labels.map((label, index) => (
          <Label key={label.step} label={label} selected={selected?.id === map.stars[index].id} />
        ))}
        {/* What the two kinds of star are. The products are named here and nowhere
            else on the band, which is why this is worth the room: a recoloured
            16px mark is not something every reader can place, and the alternative
            was a tooltip on a drawing nobody can hover precisely. */}
        <g className="ast-sky-legend" transform={`translate(16 ${map.height - 22})`}>
          <path className="ast-star-decision" d={sparkle(6, 5.5, 6)} />
          <text x="18" y="9">
            agent decision
          </text>
          {legend.map((entry, index) => (
            <g key={entry.product} transform={`translate(${96 + index * 68} 0)`}>
              <image href={markUrl('dark', entry.product)} x="0" y="-2" width="13" height="13" />
              <text x="18" y="9">
                {entry.name}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

/**
 * The products this run actually called, in the order it first called them.
 *
 * A legend naming a product no star on the band is drawn with is a legend
 * describing a different run. Three at most: the band is 820 units wide and the
 * legend has its foot to itself, but a fourth entry runs into the right margin,
 * and a run that called four products has four stars a reader can compare against
 * the three that are named.
 *
 * Each product's spelling comes out of `brand-icons.ts` rather than being restated
 * here, so there is one spelling of each product in the app. The visible name is
 * `Agents`, whatever the artwork's internal slug says.
 */
function legendProducts(stars: ConstellationStar[]): { product: BrandProduct; name: string }[] {
  const seen: BrandProduct[] = [];
  for (const star of stars) {
    if (star.decision || star.tool === '') continue;
    const product = starProduct(star.tool);
    if (product === null || seen.includes(product)) continue;
    seen.push(product);
  }
  return seen.slice(0, 3).map((product) => ({ product, name: BRAND_PRODUCT_NAMES[product] }));
}
