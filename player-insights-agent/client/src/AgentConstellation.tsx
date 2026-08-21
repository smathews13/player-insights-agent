/**
 * The run's steps as a night sky, in the two arrangements the design draws.
 *
 * `AgentPathConstellation` is `#18a`: the rail's run, vertical, connecting as it
 * happens. The line into the step in progress draws on a 2.2s loop, that step's
 * star pulses, and the mark on the foot's status line flickers through the four
 * concepts the app's other loaders flicker through; every other line is at rest.
 * IT STAYS UP AFTER THE RUN, at rest and with the ending named on its status
 * line, because the reader asked to keep looking at the drawing of the run they
 * just watched rather than have it substituted for a list the moment the answer
 * lands. Nothing about it animates then, the foot's mark included: `activeIndex`
 * is the caller's statement that a step is in progress, and -1 is the same caller
 * saying none is.
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
  pathStarY,
  pathVariant,
  PATH_WIDTH,
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
import { BrandIcon } from './BrandIcon';
import { ConceptFlicker } from './ConceptFlicker';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TraceStage } from './answer-shape';
import { formatDuration } from './benchmark-summary';

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
function Star({ star, tone, path = false }: { star: ConstellationStar; tone: BrandTone; path?: boolean }) {
  if (star.decision) {
    return <path className="ast-star-decision" d={sparkle(star.x, star.y, path ? 11 : 7)} />;
  }
  const product = star.tool === '' ? null : starProduct(star.tool);
  if (product === null) {
    return <circle className="ast-star-plain" cx={star.x} cy={star.y} r="4" />;
  }
  if (!path) {
    return <image href={markUrl(tone, product)} x={star.x - 8} y={star.y - 8} width="16" height="16" />;
  }
  return (
    <>
      <circle className="ast-star-tool-halo" cx={star.x} cy={star.y} r="16" />
      <image href={markUrl(tone, product)} x={star.x - 11} y={star.y - 11} width="22" height="22" />
    </>
  );
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
 * The clearance the followed star keeps from either end of its scroller, in px.
 *
 * A star flush against the edge of the column reads as a step half-arrived, and
 * the ring around the current one is drawn outside the glyph. 16 is the
 * inspector's own padding, so the star lands where every other row in that
 * column starts.
 */
const FOLLOW_MARGIN = 16;

/**
 * Under this much correction, the column is left alone.
 *
 * A follow that writes a fraction of a pixel is a follow that writes on every
 * step for no visible gain, and the writes are what a reader sees as a twitch.
 * One pixel is also below what the scale factor below can be trusted to, since
 * it is a ratio of a measured width to a constant.
 */
const FOLLOW_DEAD_ZONE = 1;

/**
 * BEFORE THE PAINT, and on the server not at all.
 *
 * A scroll correction is layout, so it belongs in the commit that changed the
 * layout: in a passive effect the browser paints the taller band at the old
 * offset first and the correction lands a frame later, which is the jump Sam
 * saw as stutter -- one per step, at streaming speed. The same reason a
 * `requestAnimationFrame` is not used here: a frame of coalescing IS the frame
 * of lag, and this runs once per step already.
 *
 * `useLayoutEffect` warns when there is no DOM to lay out, and this band is
 * rendered to static markup all over the suite, so the choice is made once at
 * module scope. A module constant rather than a condition inside the component,
 * because the two hooks have to be the same hook on every render.
 */
const useFollowEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The one box around the band that scrolls, or null when nothing around it does.
 *
 * THE NEAREST ONE AND ONLY THAT ONE. The band's seating is `.trace-inspector`,
 * a column with its own `overflow-y: auto`, and it sits in a page whose middle
 * pane is the reader's transcript. `scrollIntoView` would walk every scrollable
 * ancestor, so a step landing in the rail could move the answer the reader is
 * in the middle of. This walk stops at the first box that can actually take the
 * scroll, and the scroll is applied to that box's `scrollTop` alone.
 *
 * `scrollHeight > clientHeight` rather than the overflow value alone: a column
 * declared scrollable but not yet overflowing is not the thing to move, and on
 * a short run that is exactly what the inspector is.
 */
function scrollParent(node: Element): HTMLElement | null {
  for (let box = node.parentElement; box !== null; box = box.parentElement) {
    const overflowY = getComputedStyle(box).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && box.scrollHeight > box.clientHeight) return box;
  }
  return null;
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
  totalMs = null,
  thread = '',
  turn = 0,
}: {
  stages: TraceStage[];
  /** The step in progress, or -1. The caller's decision, not this file's. */
  activeIndex: number;
  /** How long that step has been going, from the caller's one clock. */
  elapsedMs: number | null;
  /** The settled run's wall time, when the trace recorded one. */
  totalMs?: number | null;
  /**
   * The series of runs this one belongs to, and its place in that series.
   *
   * Together they name the run, and `pathVariant` turns them into one of four
   * hand-placed skies. Every run used to draw the identical chain: a reader who
   * had watched two questions had seen the drawing twice, so the band stopped
   * being read as a picture of THIS run and became furniture.
   *
   * NEITHER MAY MOVE WHILE THE RUN IS GOING. The stars are re-placed from
   * scratch every time the agent announces a step and every second the caller's
   * clock ticks, so an input that drifted mid-run -- the step count, the elapsed
   * time, a render counter, the answer's id, which does not exist until the run
   * lands -- would re-shuffle the chain under a reader watching it arrive. That
   * is the shake `pathPitch` was rewritten to end, and it would be back on the x
   * axis.
   *
   * BOTH MUST SURVIVE A RELOAD, or a run a reader comes back to is drawn on a
   * different sky from the one they left it on.
   *
   * The defaults are a caller with no name for the run, and draw the design
   * reference's own sky. That is the honest default rather than an arbitrary
   * one: a surface that cannot identify its run should not imply, by picking a
   * shape, that the shape means something.
   */
  thread?: string;
  turn?: number;
}) {
  /*
   * The step the reader pinned, BY ID and toggled off by a second press, which is
   * the selection the tiles under this band already use (`openId` in TraceDag).
   * Two behaviours in one piece of state, and both were reported as faults:
   *
   * Nothing pinned is the band FOLLOWING THE RUN -- the ring and the status line
   * name the step the agent is on, and they move as it moves.
   *
   * Something pinned STAYS pinned while the run goes on around it. This used to be
   * keyed on the caller's `activeIndex`, so the next step the agent announced
   * dropped the pin and yanked the reader out of the step they had opened, a
   * second or two after they opened it.
   *
   * By id rather than by position for the reason the tiles are: the stage list is
   * replaced under this component when another run is opened, and an index would
   * pin whatever step moved into that slot.
   */
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const pinnedIndex = pinnedId === null ? -1 : stages.findIndex((stage) => stage.id === pinnedId);
  /*
   * A pin whose step is not in this run is DROPPED rather than merely ignored, and
   * dropped while rendering rather than in an effect.
   *
   * Ignoring it is not enough: a new run repeats the ids of the old one, so a pin
   * left in state would go dormant while the new list was short and then reattach
   * itself the moment that run reached a step with the same id -- the reader
   * hauled into a step of a run they never opened.
   *
   * This is React's own "adjusting state when a prop changes": the run on screen
   * changed, so the state derived from it is corrected here and the component
   * re-renders before anything is painted. In an effect it would be a second
   * render after a first one that drew the wrong star.
   */
  if (pinnedId !== null && pinnedIndex === -1) setPinnedId(null);
  const current = activeIndex >= 0 && activeIndex < stages.length ? stages[activeIndex] : null;
  const shownIndex = pinnedIndex !== -1 ? pinnedIndex : current ? activeIndex : stages.length - 1;
  /*
   * THE BAND FOLLOWS THE STEP IT IS MARKING, so the newest star cannot build its
   * way off the bottom of the column.
   *
   * The reported defect: a long run draws taller than the inspector, the column
   * has something to scroll, and nothing scrolls it -- the reader watches a run
   * whose current step is below the fold and has to chase it by hand once a step.
   *
   * `followIndex` is the star to keep in view, and it is -1 when the reader has
   * PINNED a step: a pin is them opening a settled step while the run goes on
   * past it, and hauling the column away from what they just opened is the same
   * defect the pin itself was written to end. Unpinning hands the band back to
   * the run and this follows again with it.
   *
   * KEYED ON THE INDEX rather than on the render. The caller ticks `elapsedMs`
   * once a second for as long as a step is in flight, so an effect that ran on
   * every render would drag the column back once a second while a reader was
   * looking somewhere else in it. Between steps, the column is theirs.
   *
   * Above the empty-stage return because it is a hook: `stages` is empty on the
   * rail before anything is asked and full during a run, and hooks cannot be
   * called on one of those renders and skipped on the other.
   */
  const followIndex = pinnedIndex !== -1 ? -1 : shownIndex;
  const canvasRef = useRef<SVGSVGElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  useFollowEffect(() => {
    const canvas = canvasRef.current;
    if (followIndex < 0 || canvas === null) return;
    const scroller = scrollParent(canvas);
    if (scroller === null) return;
    /*
     * THE STAR'S PLACE IN THE DRAWING, not the box the browser measures around
     * it. The followed star is the one carrying the beat -- a scale animation on
     * a 1.6s loop -- so its own rect is a different size depending on when in
     * that loop it is read, and a follow keyed on it would aim somewhere slightly
     * different every step. `pathStarY` is the number the geometry module placed
     * it at, and the canvas scales its viewBox to its own width, so one rect read
     * converts that number into the column's pixels exactly.
     *
     * Every read happens here, before the one write below: a read after a write
     * is what makes a scroll correction thrash.
     */
    const view = scroller.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    const scale = canvasBox.width / PATH_WIDTH;
    const middle = canvasBox.top + pathStarY(followIndex) * scale;
    const reach = SELECTED_RING * scale;
    /*
     * The status line is RESERVED rather than covered: it is the one sentence
     * naming the step this star is, so parking the star on the column's bottom
     * edge would scroll its own caption out of view.
     */
    const reserve = statusRef.current?.getBoundingClientRect().height ?? 0;
    const floor = view.top + FOLLOW_MARGIN;
    const ceiling = view.bottom - reserve - FOLLOW_MARGIN;
    /*
     * A minimal correction in one direction or the other, so a star already in
     * view is left exactly where it is, and instant rather than smoothed: a
     * smooth scroll restarted by the next step fights the one still running, and
     * what Sam asked for is that the newest step be visible rather than that it
     * glide there.
     */
    const drop =
      middle + reach > ceiling ? middle + reach - ceiling : middle - reach < floor ? middle - reach - floor : 0;
    if (Math.abs(drop) < FOLLOW_DEAD_ZONE) return;
    scroller.scrollTop += drop;
  }, [followIndex]);
  if (stages.length === 0) return null;
  const shown = stages[shownIndex];
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
  const path = buildPathConstellation(stages, inFlight ? activeIndex : -1, pathVariant(thread, turn));
  const currentStar = current ? path.stars[activeIndex] : null;
  const shownProduct = shownIndex >= 0 ? starProduct(path.stars[shownIndex]?.tool ?? '') : null;
  const statusDuration =
    inFlight && elapsedMs !== null
      ? `${Math.max(0, Math.floor(elapsedMs / 1000))}s`
      : activeIndex === -1 && totalMs !== null
        ? formatDuration(totalMs)
        : null;
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
  /*
   * A press pins the step, and a second press on the step already pinned releases
   * it and hands the band back to the run. The same toggle the tiles take, so
   * there is one way to stop inspecting a step on this surface rather than two.
   */
  const pin = (id: string) => setPinnedId((held) => (held === id ? null : id));
  /*
   * Whether the foot's mark is a loader: the run is inside a step AND the line is
   * following it. Derived here beside the rest of the band's state rather than
   * inline in the markup, so the one condition is readable next to `inFlight`,
   * which is the thing it narrows.
   */
  const flickering = inFlight && pinnedIndex === -1;
  return (
    <div className="ast-sky ast-sky-path">
      <svg
        ref={canvasRef}
        role="group"
        aria-label="Agent steps"
        className="ast-sky-canvas"
        viewBox={`0 0 ${path.width} ${path.height}`}
        preserveAspectRatio="xMidYMin meet"
        fill="none"
      >
        <g className="ast-sky-dust" aria-hidden="true">
          {[
            [36, 0.16],
            [274, 0.23],
            [65, 0.34],
            [293, 0.45],
            [29, 0.58],
            [263, 0.66],
            [77, 0.78],
            [286, 0.88],
          ].map(([x, fraction]) => (
            <circle key={`${x}-${fraction}`} cx={x} cy={Math.round(path.height * fraction)} r="1.5" />
          ))}
        </g>
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
            onClick={() => pin(stages[index].id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') pin(stages[index].id);
            }}
          >
            {inFlight && activeIndex === index ? (
              <g className="ast-anim-center-pulse" style={{ transformOrigin: `${star.x}px ${star.y}px` }}>
                <Star star={star} tone="dark" path />
              </g>
            ) : (
              <Star star={star} tone="dark" path />
            )}
          </g>
        ))}
        {/* The step in progress is marked twice: its existing glyph beats and a
            ring breathes around it. Two marks rather than one, because a reader
            who cannot see the scale change still sees the ring, and because the
            ring is what survives at the small end of this band's rendered width.
            On a run that has stopped the frontier keeps the ring and loses both the
            beat and the larger glyph -- the newest step is still worth marking, and
            marking it is not the same as claiming it is happening. */}
        {currentStar && (
          <>
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
      <p ref={statusRef} className="ast-sky-status" aria-live="polite">
        {/*
          THE SLOT FLICKERS WHILE THE STEP IT NAMES IS THE ONE BEING WORKED ON,
          and holds the step's real mark the rest of the time.

          It was static in both states, which made the one glyph on the foot of a
          running band the only thing on the surface not saying the run was going:
          lines drawing, star beating, ring breathing, and a still mark under them.

          `ConceptFlicker` rather than a fifth thing that cycles: it is the app's
          working loader, `ast-anim-flick` and the four concepts, and the reader
          has already met it on the splash and in the strip. A second cycle
          written here would drift from that one the first time either is retuned.

          `flickering` is not `inFlight` alone, because the line does not always
          name the step the run is on. A pinned step is a settled step the reader
          opened, and a loader beside its name would be this band claiming that
          step is happening -- the same substitution the ring refuses two comments
          up. Pinned, or run over: the real mark.
        */}
        <span className="ast-sky-status-mark" aria-hidden="true">
          {flickering ? (
            <ConceptFlicker seat="status" />
          ) : shownProduct ? (
            <BrandIcon product={shownProduct} size={12} tone="dark" />
          ) : (
            <AstrolabeMark size={11} ink="dark" />
          )}
        </span>
        <span className="ast-sky-status-text">
          {pinnedIndex !== -1 || current
            ? `Step ${path.numbers[shownIndex].label} · ${shown.name}`
            : ended === null
              ? `Step ${path.numbers[shownIndex].label} · ${shown.name}`
              : `Step ${path.numbers[endedAt].label} · ${ended.name} · ${
                  ended.status === 'running' ? 'never reported' : ended.status
                }`}
        </span>
        {statusDuration && (
          <span
            className="ast-num ast-sky-status-elapsed"
            title={activeIndex === -1 && totalMs !== null ? `${totalMs.toLocaleString()} milliseconds` : undefined}
          >
            {statusDuration}
          </span>
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
        {selected && <circle className="ast-star-selected" cx={selected.x} cy={selected.y} r={SELECTED_RING} />}
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
