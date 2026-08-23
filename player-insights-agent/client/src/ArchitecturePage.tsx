/**
 * What this deployment is made of, drawn from what it actually reports.
 *
 * THE DIAGRAM IS A SECOND VIEW OF THE CONNECTIONS MODEL, not a picture of it.
 * Every node that names a dependency is a `ConnectedResource`, and its pills, its
 * identifier and its drift come from `connection-model.ts`, the derivation the
 * Connections page renders. The two cannot describe different deployments,
 * because there is only one reading. A diagram is believed in a way a list is
 * not, so a diagram that had its own opinion about what the app is wired to
 * would be the most expensive kind of wrong.
 *
 * THE CHECKS RUN THEMSELVES, ONCE PER SESSION, and this page does not decide
 * when. `/api/architecture` is still the cheap read this page makes for itself:
 * it returns what the app container was given and costs no round trip. The two
 * payloads that carry reachability are expensive, so they run once for the whole
 * session through `session-checks.ts` -- on whichever of this page and
 * Connections is opened first -- and the Refresh control is the only thing that
 * re-runs them after that.
 *
 * It used to be that nothing ran until Refresh was pressed, and the info row at
 * the bottom said so. The cost reasoning was right and the conclusion was wrong:
 * a page that opens on `Not checked` down its whole length is read as broken, not
 * as unasked, and it was read that way by the person it was built for. `Not
 * checked` is still a real status and still never a stand-in for a green one --
 * it is simply no longer the state the page opens in.
 *
 * COLOUR HERE STATES WHAT A CONNECTION IS, NEVER HOW IT IS. The accent on a
 * card's edge, the colour of a line and the colour of the dot travelling along it
 * say question path, agent, Genie space, semantic search, governed data or
 * storage. Status lives in the pills and nowhere else. Two vocabularies in one
 * drawing would make a healthy teal node read as a warning.
 *
 * No figure appears here that was not read from something. There is no latency on
 * this page and no row count, because nothing in this app measures them per
 * dependency; where the reference this was modelled on prints a number, this
 * prints what it is waiting for.
 */
import { Component, Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription } from './ui';
import { CircleAlert, ExternalLink } from 'lucide-react';
import { astPill } from './astrolabe-pill';
import { BrandIcon } from './BrandIcon';
// The word, the icon and the pending state, decided once for the whole app.
import { RefreshControl } from './RefreshControl';
// The chain and the answer's shape, as data rather than as prose in this file.
// See the note at the top of agent-chain.ts for why they moved out of here.
import { AGENT_CHAIN, ANSWER_CONTRACT, CHAIN_BOUND_LABEL, CHAIN_BOUND_NOTE, CHAIN_BOUNDS } from './agent-chain';
import { runtimeSettingsFromResponse } from './runtime-settings-api';
import type { RuntimeSettings } from '../../shared/runtime-settings';
import {
  ARCHITECTURE_NODES,
  dependencyNodes,
  describeArchitecture,
  drawnReadings,
  nodeAccessibleName,
  nodeContentAge,
  nodeReport,
  nodeValue,
  staleContent,
  type ArchitectureNode,
} from './architecture';
import { NODE_FAMILY } from './architecture-view';
import {
  ACCENT_TOKEN,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  canvasFits,
  canvasScale,
  drawnEdges,
  nodeBox,
  type ArchitectureAccent,
  type NodeBox,
} from './architecture-layout';
import { countConnections, readConnections, readingsById, type ConnectionReading } from './connection-model';
import { DRIFT_MARKER_LABEL } from './connection-status';
import { checkedAtOf } from './check-session';
import { useSessionChecks } from './session-checks';
import { fetchWithTimeout } from './fetch-timeout';
import { databricksLink, type DatabricksObject } from '../../shared/databricks-links';
import { entityHref } from './data-entities';

interface ArchitecturePayload {
  workspaceHost: string;
  canDeepLink: boolean;
  servingEndpoint: { value: string; variable: string };
  appWarehouse: { value: string; variable: string };
  experimentId: string;
  appServicePrincipal: string;
  appBuildSha: string;
  /**
   * WHERE the semantic index is decided, which is not whether there is one.
   *
   * This used to carry a `state` field whose type was the single literal
   * `'unreadable'`, left over from when nothing on this side could tell a
   * deployment with an index from one without. The server stopped sending it
   * when the orchestrator began reporting the setting, and the field could not
   * have said anything else if it had: a type with one inhabitant can only make
   * one claim, and the claim was that the app cannot see. What the deployment
   * actually reports now arrives through `/api/settings` with every other
   * connection, and the semantic lane's real states are `SemanticState` in
   * architecture.ts -- five of them, read off the live readings.
   */
  semanticIndex: { decidedBy: string; reason: string };
  readAt: string;
}

const ARCHITECTURE_DESCRIPTION_TIMEOUT_MS = 5_000;

/** Keep a diagram exception from replacing the whole Architecture tab. */
class ArchitectureDiagramBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('Architecture diagram could not be rendered:', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div data-testid="architecture-diagram-fallback">
        <Alert>
          <CircleAlert />
          <AlertDescription>
            The interactive diagram could not be drawn. The architecture map remains available below.
          </AlertDescription>
        </Alert>
        <ul className="arch-equivalent">
          {ARCHITECTURE_NODES.map((node) => (
            <li key={node.id}>
              <strong>{node.label}</strong>: status unavailable. {node.role}
            </li>
          ))}
        </ul>
      </div>
    );
  }
}

/**
 * Which workspace object a node opens, given what this deployment reported.
 *
 * The identifier is the one the node DISPLAYS, so a link can never point
 * somewhere other than the value beside it. Null wherever the value is unknown,
 * which is most of them until the checks have run.
 */
function workspaceObject(
  node: ArchitectureNode,
  reading: ConnectionReading | undefined,
  payload: ArchitecturePayload | null
): DatabricksObject | null {
  const shown = reading?.summary.value ?? '';
  switch (node.id) {
    case 'agent-endpoint': {
      const name = shown || payload?.servingEndpoint.value || '';
      return name ? { kind: 'serving-endpoint', name } : null;
    }
    case 'llm-endpoint':
      return shown ? { kind: 'serving-endpoint', name: shown } : null;
    case 'genie-data':
    case 'genie-dictionary':
      return shown ? { kind: 'genie-space', spaceId: shown } : null;
    case 'sql-warehouse':
      return shown ? { kind: 'sql-warehouse', warehouseId: shown } : null;
    case 'catalog':
      return shown ? { kind: 'catalog', catalog: shown } : null;
    // A Vector Search index is a Unity Catalog object, browsed at the same path
    // a table is. `databricks-links` refuses a name that is not three levels
    // rather than truncating it to the catalog, which would be a link that
    // worked to the wrong object.
    case 'semantic-index':
      return shown ? { kind: 'vector-index', index: shown } : null;
    // The endpoint is not a Unity Catalog object and this app has no verified
    // workspace path for one, so the card carries its in-app link and no
    // outward one. A guessed URL is a dead affordance that looks live.
    case 'semantic-index-endpoint':
      return null;
    case 'experiment-id': {
      const id = shown || payload?.experimentId || '';
      return id ? { kind: 'experiment', experimentId: id } : null;
    }
    // Lakebase is addressed by a branch and database rather than by a workspace
    // path.
    default:
      return null;
  }
}

/**
 * One node card.
 *
 * TWO CONTROLS RATHER THAN ONE, and the split is deliberate. The design makes the
 * whole card the Databricks link; here the card links to this dependency's own
 * row on Connections and the Databricks link is a second, named control beside
 * it. The in-app link is the one that always works -- it needs no host and no
 * identifier, so it exists on a deployment that has reported neither -- and it is
 * where the configured value, the measured value, the drift and the command that
 * changes it already live. A single card-wide target that sometimes leaves the
 * app and sometimes does nothing is a control a reader cannot learn.
 *
 * The card is inert only where BOTH are unavailable, which is the two nodes that
 * are not dependencies at all: the browser and the app server.
 */
/**
 * A node's verdict, in the palette's own families.
 *
 * `architecture.ts` keeps six tones because six is what this page has to
 * distinguish, and none of them is a colour: `local` is "the code runs here",
 * `nothing-to-reach` is "there is no remote end", `unreadable` is "nobody
 * answered about it". Four of the six collapse to the outlined neutral, which is
 * the correct rendering of all four: nothing was established, and an outline
 * with a word in it says exactly that. Only `reachable` and `blocked` are
 * verdicts, and only they are tinted.
 */
function ArchitectureNodeCard({
  node,
  reading,
  indexReading,
  payload,
  box,
  now,
}: {
  node: ArchitectureNode;
  reading: ConnectionReading | undefined;
  /**
   * The index's reading, which the endpoint card cannot be read without.
   *
   * The endpoint is only asked about once the index answers and names it, so
   * "no check" on the endpoint means something different depending on what the
   * index said. Passed to every card and used by one, rather than looked up
   * here, so the card still computes nothing for itself.
   */
  indexReading: ConnectionReading | undefined;
  payload: ArchitecturePayload | null;
  box: NodeBox;
  /** Read once per render by the page, so every card ages content off one clock. */
  now: number;
}) {
  const report = nodeReport(node, reading, indexReading);
  const value = nodeValue(reading);
  const age = nodeContentAge(node, reading, now);
  const object = workspaceObject(node, reading, payload);
  const deepLink = object && payload?.workspaceHost ? databricksLink(payload.workspaceHost, object) : null;

  const body = (
    <>
      {/* The product's own mark at the handoff's 18px, left of the title, on
          every node that IS a Databricks product. Which product that is comes
          off the node in architecture.ts, so this draws what the node declares
          and decides nothing. The two nodes with no mark are the two that are
          not products: the reader's browser, and the Node server.

          Decorative -- the label is the next element, and the card's accessible
          name is built from it in nodeAccessibleName. */}
      <span className="arch-node-title">
        {node.product ? <BrandIcon product={node.product} size={18} /> : null}
        <span className="arch-node-label">{node.label}</span>
      </span>
      <span className="arch-node-pills">
        <span className={astPill(NODE_FAMILY[report.tone], 'arch-node-status')} data-tone={report.tone}>
          {report.label}
        </span>
        {reading && reading.marker !== 'none' ? (
          <span
            className={astPill(reading.marker === 'drift' ? 'warn' : 'neutral-outline', 'arch-node-drift')}
            data-drift={reading.marker}
          >
            {DRIFT_MARKER_LABEL[reading.marker]}
            {reading.marker === 'drift' && reading.driftCount > 1 ? ` \u00d7${reading.driftCount}` : ''}
          </span>
        ) : null}
        {/*
          A third pill rather than a different status, for the reason set out in
          semantic-freshness.ts: an index serving old content is reachable, and
          calling it Blocked would say something false about a word that means
          "this identity cannot get to it" everywhere else on the page.
        */}
        {age ? (
          <span
            className={astPill(age.state === 'stale' ? 'warn' : 'neutral-outline', 'arch-node-age')}
            data-age={age.state}
            title={age.note}
          >
            {age.label}
          </span>
        ) : null}
      </span>
      {value ? (
        <span className="arch-node-value" data-measured={value.measured ? 'true' : undefined}>
          {value.value}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className="arch-node"
      data-testid={`arch-node-${node.id}`}
      data-node={node.id}
      data-accent={box.accent}
      data-tone={report.tone}
      data-drift={reading && reading.marker !== 'none' ? reading.marker : undefined}
      style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` }}
    >
      {node.resourceId ? (
        <Link
          className="arch-node-main"
          to={entityHref(node.resourceId)}
          aria-label={`${nodeAccessibleName(node, reading, indexReading, now)}. Open on Connections.`}
        >
          {body}
        </Link>
      ) : (
        <div className="arch-node-main" data-static="true">
          {body}
        </div>
      )}
      <p className="arch-node-role">{node.role}</p>
      {deepLink ? (
        <a className="arch-node-open" href={deepLink} rel="noopener noreferrer" target="_blank">
          Open in Databricks <ExternalLink className="size-3" aria-hidden="true" />
          <span className="sr-only"> ({node.label})</span>
        </a>
      ) : null}
    </div>
  );
}

/** What each accent means, for the row under the drawing. */
const LEGEND: ReadonlyArray<{ accent: ArchitectureAccent; label: string }> = [
  { accent: 'question', label: 'question path' },
  { accent: 'agent', label: 'the agent' },
  { accent: 'genie', label: 'Genie spaces' },
  { accent: 'search', label: 'semantic search' },
  { accent: 'governed', label: 'governed data' },
  { accent: 'kept', label: 'storage' },
];

/**
 * The drawing.
 *
 * Three layers, in this order, and the order is the reason it works: the edges
 * in one SVG, the travelling dots as elements following the SAME path strings,
 * and the cards on top. The dots are CSS motion paths rather than SVG
 * `<animateMotion>` because SMIL's clock does not run in every embedding context
 * and it ignores `prefers-reduced-motion`; the reduced-motion rule in
 * architecture.css switches these off with `!important`, which is what it takes
 * to beat an inline `animation`.
 *
 * Both animated layers are `aria-hidden`, and that is only defensible because
 * the list after them says everything they do -- see `describeArchitecture`,
 * which is the diagram in words rather than a summary of it.
 *
 * Exported so a test can mount it with readings in hand. The page itself has
 * none until somebody presses Refresh, so a render of the page can only ever
 * assert the unchecked state.
 */
export function ArchitectureCanvas({
  byResource,
  payload,
  now,
}: {
  byResource: ReadonlyMap<string, ConnectionReading>;
  payload: ArchitecturePayload | null;
  /**
   * The clock the content ages are computed against.
   *
   * Passed in rather than read here, and required rather than defaulted: one
   * value for the whole drawing and its text equivalent, so the card and the
   * sentence describing it cannot land either side of an hour boundary and
   * report different ages for the same timestamp.
   */
  now: number;
}) {
  const edges = useMemo(() => drawnEdges(), []);
  const description = useMemo(() => describeArchitecture(byResource, now), [byResource, now]);

  /**
   * The width the panel actually offers, which the geometry cannot know.
   *
   * Everything about where a card sits is stated in pixels on a fixed canvas, on
   * purpose, and that stays true: the only thing measured here is how much of
   * full size to draw the whole thing at, so that a window narrower than the
   * canvas shows the whole drawing rather than its left two thirds.
   *
   * `0` until measured, which is the server and the first paint, and draws at
   * full size. ResizeObserver is absent under the test renderer, so every layout
   * check still reasons about the canvas at its stated size.
   */
  const [panelWidth, setPanelWidth] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setPanelWidth((current) => (current === width ? current : width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = canvasScale(panelWidth);
  /*
   * Whether there is room to draw it at all. Below the fit floor the two things a
   * fixed drawing can do are shrink past legibility and be read through a
   * letterbox, and this page has shipped both; the list below is the third
   * answer. See `canvasFits`.
   *
   * The scroller stays mounted either way, because it is the element being
   * measured: unmounting it would take the ResizeObserver with it, the width would
   * go back to 0, `canvasFits` would say yes, and the drawing would come back and
   * remove itself again on the next frame.
   */
  const fits = canvasFits(panelWidth);

  return (
    <>
      <div className="arch-canvas-scroll" ref={scroller} data-fits={fits ? undefined : 'false'}>
        {fits ? (
          <div
            className="arch-canvas"
            data-testid="architecture-canvas"
            role="group"
            aria-label="Live data flow. Each card links to that dependency on the Connections page."
            style={{
              width: `${CANVAS_WIDTH}px`,
              height: `${CANVAS_HEIGHT}px`,
              // Omitted entirely at full size, so the common case carries no
              // property at all and the rendered markup is the one the geometry
              // checks were written against.
              ...(scale < 1 ? { zoom: scale } : {}),
            }}
          >
            <svg
              className="arch-edges"
              viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
              aria-hidden="true"
              focusable="false"
            >
              {edges.map((edge) => (
                <g key={edge.id}>
                  <path className="arch-edge" d={edge.d} />
                  <text className="arch-edge-label" x={edge.labelX} y={edge.labelY} textAnchor={edge.labelAnchor}>
                    {edge.label}
                  </text>
                </g>
              ))}
            </svg>
            {edges.map((edge) => (
              <span
                className="arch-dot"
                key={edge.id}
                data-testid={`arch-dot-${edge.id}`}
                aria-hidden="true"
                style={{
                  offsetPath: `path('${edge.d}')`,
                  background: `var(${ACCENT_TOKEN[edge.accent]})`,
                  animationDuration: `${edge.duration}s`,
                  animationDelay: `${edge.delay}s`,
                }}
              />
            ))}
            {ARCHITECTURE_NODES.map((node) => {
              const box = nodeBox(node.id);
              if (!box) return null;
              return (
                <ArchitectureNodeCard
                  box={box}
                  indexReading={byResource.get('semantic-index')}
                  key={node.id}
                  node={node}
                  now={now}
                  payload={payload}
                  reading={node.resourceId ? byResource.get(node.resourceId) : undefined}
                />
              );
            })}
          </div>
        ) : null}
      </div>

      {/*
        The drawing, for anybody not reading it with their eyes and a mouse. Not a
        fallback: every fact the picture carries is here, which is the only thing
        that makes hiding the picture from a screen reader defensible.

        And it is the same list that becomes VISIBLE in a panel too narrow to draw
        in. One list, one set of sentences, one clock, whichever way it is being
        read -- so the narrow arrangement is not a second version of the page that
        nobody checks, which is what the old 1024px collapse was.
      */}
      <ul className="arch-equivalent" data-testid="architecture-equivalent">
        {description.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {/* The legend maps a colour to a kind of connection, so it has nothing to
          say when the drawing is not on screen. */}
      {fits ? (
        <ul className="arch-legend">
          {LEGEND.map((entry) => (
            <li key={entry.accent} data-accent={entry.accent}>
              <span aria-hidden="true" />
              {entry.label}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * The four tiles.
 *
 * EVERY VALUE IS COUNTED FROM THE DEPENDENCIES DRAWN BELOW, and the two that
 * cannot be counted until something has been checked render an em-dash rather
 * than a zero. "0 reachable" and "nobody has looked" are different claims, and
 * printing the first on a page that has probed nothing is the single most
 * misleading thing this tile strip could do.
 *
 * The design seats a fifth tile here, LAST CHECK. It is deliberately not built:
 * the Refresh control in the heading states the same freshness beside the button
 * that changes it, and a second reading of the same clock is a second thing to
 * disagree. Freshness belongs to `RefreshControl` and is read nowhere else on
 * this page — do not take `checkedAt` as a prop to put it back. Recorded in
 * `docs/design-handoff-pia-dubois-revamp/AS-COMMITTED.md`.
 */
export function ArchitectureTiles({
  readings,
  dependencies,
}: {
  /** The readings for the drawn dependencies. Empty until the checks have run. */
  readings: readonly ConnectionReading[];
  dependencies: number;
}) {
  const ran = readings.length > 0;
  const counts = countConnections(readings);
  const unknown = '\u2014';
  return (
    <ul className="arch-tiles" data-testid="architecture-tiles">
      {/* `.ast-num` on all four, because four tiles in a row are read across and
          a reader compares them. The rule they carried asked for tabular figures
          with `font-variant-numeric` on DM Sans, which declares no `tnum`
          feature, so nothing was tabular and the strip shuffled sideways every
          time a count changed under a refresh. */}
      <li>
        <span>Dependencies</span>
        <strong className="ast-num">{dependencies}</strong>
      </li>
      <li>
        <span>Reachable</span>
        <strong className="ast-num" data-tone={ran && counts.reachable > 0 ? 'reachable' : undefined}>
          {ran ? counts.reachable : unknown}
        </strong>
      </li>
      <li>
        <span>Not checked</span>
        {/* Before anything has run, every dependency is unchecked, which is what
            the cards below say too. This is the one tile whose value is known
            without a probe. */}
        <strong className="ast-num">{ran ? counts.notChecked : dependencies}</strong>
      </li>
      <li data-tile="drift">
        <span>Drift</span>
        <strong className="ast-num" data-tone={ran && counts.drifted > 0 ? 'drifted' : undefined}>
          {ran ? counts.drifted : unknown}
        </strong>
      </li>
    </ul>
  );
}

/**
 * The loop bounds, as a strip of tiles above the drawing.
 *
 * THE THREE NUMBERS THAT DECIDE HOW LONG AN ANSWER MAY TAKE, which were readable
 * only by opening the gear -- on a page whose whole job is to say what the
 * deployment does. They sit beside the dependency counts because they are the same
 * kind of fact: a property of this deployment that a reader may need before they
 * can explain a run that stopped early.
 *
 * AN EM-DASH RATHER THAN THE DEFAULTS when the read fails. The shared defaults are
 * 12/12/90 and it would be easy to print them here, but a stored setting is what
 * the agent actually uses and "12" on a page that could not read the store is a
 * claim about a number nobody checked. Same rule as the tiles above: not knowing
 * and knowing zero are different, and the page says which one it is in.
 *
 * Labelled in the Settings pane's own words, so a reader who wants to change one
 * has a string to search the gear for. See CHAIN_BOUND_LABEL.
 */
export function ChainBoundTiles({ loop }: { loop: RuntimeSettings['loop'] | null }) {
  const unknown = '\u2014';
  return (
    <ul className="arch-tiles arch-tiles-loop" data-testid="architecture-loop-tiles">
      {CHAIN_BOUNDS.map((bound) => (
        <li key={bound} title={CHAIN_BOUND_NOTE[bound]}>
          <span>{CHAIN_BOUND_LABEL[bound]}</span>
          <strong className="ast-num">{loop ? loop[bound] : unknown}</strong>
        </li>
      ))}
    </ul>
  );
}

/**
 * One step in a rail, which is a stage of a run rather than a dependency.
 *
 * `stage` is the MLflow stage id, drawn as a mono chip. It is here so a reader can
 * hold this rail against a run in the Run Explorer and match them line for line;
 * before the chain was written down, the two used different names for the same
 * stage and there was no way to tell that `data_source_finder` in a trace was the
 * row this rail called "Orchestrator on Model Serving".
 */
function RailRow({
  accent,
  badge,
  boundNote,
  children,
  optional,
  stage,
  title,
}: {
  accent: ArchitectureAccent;
  badge?: string;
  /** The bound that stops this stage, already formatted, or undefined. */
  boundNote?: string;
  children: string;
  /** Whether the stage is skipped on a run that does not need it. */
  optional?: boolean;
  stage?: string;
  title: string;
}) {
  return (
    <li className="arch-rail-row" data-accent={accent} data-stage={stage}>
      <p className="arch-rail-title">
        {title}
        {badge ? <span className="arch-rail-badge">{badge}</span> : null}
        {/* Said on the row rather than left to the prose. Three of these stages do
            not run on every question, and a rail drawing six rows for a run that
            had three is a rail that gets read as a fault. */}
        {optional ? (
          <span className="arch-rail-badge" data-optional="true">
            If needed
          </span>
        ) : null}
        {stage ? <code className="arch-rail-stage">{stage}</code> : null}
      </p>
      <p className="arch-rail-body">{children}</p>
      {boundNote ? <p className="arch-rail-bound">{boundNote}</p> : null}
    </li>
  );
}

/** The mono line between two rows, which names what passes between them. */
function RailStep({ label }: { label: string }) {
  return (
    <li className="arch-rail-step" aria-hidden="true">
      {'\u2193'} {label}
    </li>
  );
}

export function ArchitecturePage() {
  const [payload, setPayload] = useState<ArchitecturePayload | null>(null);
  const [payloadError, setPayloadError] = useState('');
  /**
   * The checks, from the one mechanism that runs them.
   *
   * NOT THIS PAGE'S OWN FETCH, and not this page's own decision about when to
   * fetch. `useSessionChecks` runs them once for the session -- on whichever of
   * this page and Connections is opened first -- and hands both pages the same
   * store afterwards. See session-checks.ts for why the automatic run is latched
   * rather than keyed on the store being empty.
   *
   * The page used to hold all of this itself, and probe nothing until Refresh was
   * pressed. That was the defect Sam reported: a tab that opens on `Not checked`
   * down its whole length reads as broken, however carefully the sentence at the
   * bottom explains that it is not.
   */
  const { session, running: checking, refresh } = useSessionChecks();
  const settings = session?.settings ?? null;
  const report = session?.report ?? null;
  const checkError = session?.error ?? '';

  // The cheap read, and the only one on mount. It costs the app container's own
  // configuration and no round trip to the workspace, which is what lets the
  // info row promise that nothing is checked until somebody asks.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetchWithTimeout('/api/architecture', {}, ARCHITECTURE_DESCRIPTION_TIMEOUT_MS);
        if (!response.ok) throw new Error(`the architecture endpoint answered ${response.status}`);
        const body = (await response.json()) as ArchitecturePayload;
        if (live) setPayload(body);
      } catch (caught) {
        if (live) {
          setPayloadError(
            `The app could not describe its own deployment: ${(caught as Error).message}. ` +
              'The identifiers below are missing.'
          );
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /**
   * The loop bounds, for the strip above the drawing.
   *
   * A THIRD READ ON MOUNT AND THE CHEAPEST OF THE THREE: it is the app's own
   * stored row, not a probe of the workspace, so it costs nothing that the info
   * row's promise about checks depends on. Held as null until it lands, and null
   * is what the strip draws an em-dash for -- a failed read must not be reported
   * as the shared defaults, because the number the agent uses is whatever is
   * stored and nobody checked it.
   *
   * The public read rather than the admin one. `/api/runtime-settings` answers
   * every signed-in reader, and this page is on the consumer navigation; the
   * admin route is the write.
   */
  const [loop, setLoop] = useState<RuntimeSettings['loop'] | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetchWithTimeout('/api/runtime-settings', {}, ARCHITECTURE_DESCRIPTION_TIMEOUT_MS);
        const settings = await runtimeSettingsFromResponse(response, 'loaded');
        if (live) setLoop(settings.loop);
      } catch {
        // Deliberately silent. The strip says it does not know, which is the whole
        // of what a reader can do about it, and this page already has three alerts
        // that matter more than a fourth about a tooltip's numbers.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const checks = useMemo(() => report?.checks ?? [], [report]);
  const readings = useMemo(() => readConnections(settings, checks), [settings, checks]);
  const byResource = useMemo(() => readingsById(readings), [readings]);
  const drawn = useMemo(() => drawnReadings(byResource), [byResource]);
  const drifted = drawn.filter((reading) => reading.marker === 'drift');
  // One clock for the tiles, the cards and the sentences under them.
  const now = Date.now();
  const stale = staleContent(byResource, now);
  /**
   * WHEN THE CHECKS RAN, WHICH IS THE SERVER'S ANSWER AND NOT THIS PAGE'S CLOCK.
   *
   * This used to be `new Date().toISOString()`, set when the two fetches
   * returned. It was already slightly wrong -- it recorded when the answers
   * arrived here rather than when the workspace was asked -- and it was the
   * reason a restored view could not be built without lying: a remembered client
   * timestamp would have been re-stamped on every reopen, so the page would have
   * claimed a check ran at the moment somebody clicked the tab. Both payloads
   * carry the server's own record, so there is nothing to re-stamp. Read in the
   * same order ConnectionsPage reads it, so one run cannot be given two times.
   */
  const checkedAt = checkedAtOf(session);

  return (
    <div className="page-shell architecture-page">
      <div className="page-heading">
        <div>
          <h2>Architecture</h2>
        </div>
        {/* The shared control, on the same clock as the tiles below it, so the
            two cannot report the same instant differently. */}
        <RefreshControl busy={checking} checkedAt={checkedAt} now={now} onRefresh={() => void refresh()} />
      </div>

      {payloadError ? (
        <Alert>
          <CircleAlert />
          <AlertDescription>{payloadError}</AlertDescription>
        </Alert>
      ) : null}

      {checkError ? (
        <Alert data-testid="architecture-check-error">
          <CircleAlert />
          <AlertDescription>{checkError}</AlertDescription>
        </Alert>
      ) : null}

      {drifted.length > 0 ? (
        <Alert data-testid="architecture-drift">
          <CircleAlert />
          <AlertDescription>
            <span>
              <strong>
                {drifted.length === 1
                  ? '1 dependency is not using what it was configured with'
                  : `${drifted.length} dependencies are not using what they were configured with`}
              </strong>
              : {drifted.map((reading) => reading.resource.label).join(', ')}.
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {stale.map((entry) => (
        <Alert data-testid={`architecture-stale-${entry.node.id}`} key={entry.node.id}>
          <CircleAlert />
          <AlertDescription>
            <span>
              <strong>{entry.node.label} is reachable and its content is out of date</strong>
              {': '}
              {entry.age.note}
            </span>
          </AlertDescription>
        </Alert>
      ))}

      <ArchitectureTiles dependencies={dependencyNodes().length} readings={drawn} />
      <ChainBoundTiles loop={loop} />

      <section className="arch-flow" aria-labelledby="arch-flow-title">
        <div className="arch-flow-head">
          <h3 className="section-label" id="arch-flow-title">
            Live data flow
          </h3>
        </div>
        <ArchitectureDiagramBoundary key={`${checkedAt}:${payload?.readAt ?? ''}`}>
          <ArchitectureCanvas byResource={byResource} now={now} payload={payload} />
        </ArchitectureDiagramBoundary>
      </section>

      <div className="arch-rails">
        {/*
          THE CHAIN, FROM agent-chain.ts RATHER THAN WRITTEN HERE. This rail used to
          be four hand-written rows describing the run as it was before the chain was
          reworked -- browser, orchestrator, warehouse, browser. It had no approval
          plan, so the plan card a reader meets on their first real question appeared
          to come from nowhere on this page; no step loop and none of the three bounds
          that stop it; and synthesis and charts folded into one row, which hid that
          charts are dropped first when a run is out of budget.

          Generated from the stage list so the names on screen are the agent's own
          span ids. See the note at the top of that module.
        */}
        <section className="arch-rail" aria-labelledby="arch-rail-answer">
          <h3 className="section-label" id="arch-rail-answer">
            Chain &middot; per question
          </h3>
          <ol className="arch-rail-rows">
            {AGENT_CHAIN.map((stage, index) => (
              <Fragment key={stage.stage}>
                <RailRow
                  accent={stage.accent}
                  badge={stage.badge}
                  boundNote={
                    stage.bound && loop ? `${CHAIN_BOUND_LABEL[stage.bound]} \u00b7 ${loop[stage.bound]}` : undefined
                  }
                  optional={stage.optional}
                  stage={stage.stage}
                  title={stage.title}
                >
                  {stage.body}
                </RailRow>
                {/* No arrow after the last row: it would point at the section's own
                    bottom edge and name something that is not below it. */}
                {stage.passes && index < AGENT_CHAIN.length - 1 ? <RailStep label={stage.passes} /> : null}
              </Fragment>
            ))}
          </ol>
        </section>

        {/*
          What comes back, which is the other half of what the chain spec fixes. The
          fields are `AnswerContract`'s own wire names, because the app renders them
          and the agent fills them and the two have disagreed before -- `derivation`
          in particular is called provenance by everybody who discusses it and
          `derivation` on the wire, so a reader opening a raw trace looks for the
          wrong key.
        */}
        <section className="arch-rail" aria-labelledby="arch-rail-contract">
          <h3 className="section-label" id="arch-rail-contract">
            Answer contract
          </h3>
          <ul className="arch-contract-rows">
            {ANSWER_CONTRACT.map((section) => (
              <li className="arch-contract-row" key={section.field}>
                <p className="arch-contract-head">
                  <code className="arch-rail-stage">{section.field}</code>
                  <span>{section.label}</span>
                  {/* The sections the gear can switch off. Derivation and sources
                      carry no badge because there is no switch for them: a figure
                      without its source is the one thing the contract does not
                      allow. */}
                  {section.optional ? (
                    <Link
                      className="arch-rail-badge arch-contract-settings-link"
                      data-optional="true"
                      to="/settings#answer-contract-settings"
                      state={{ settingsFrom: '/architecture' }}
                      aria-label={`Optional ${section.label}; open its answer content setting`}
                    >
                      Optional
                    </Link>
                  ) : null}
                </p>
                <p className="arch-rail-body">{section.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="arch-rail" aria-labelledby="arch-rail-storage">
          <h3 className="section-label" id="arch-rail-storage">
            Storage
          </h3>
          <ol className="arch-rail-rows">
            <RailRow accent="kept" badge="Store" title="Databricks App to Lakebase (Postgres)">
              Conversations and messages, written by the app as it serves. Never read to answer.
            </RailRow>
            {/* Two clauses rather than one sentence with an em-dashed aside in
                the middle of it. §7 has no em dash in it, and the list this one
                interrupted itself to give reads better as its own sentence. */}
            <RailRow accent="kept" badge="Trace" title="Orchestrator to MLflow experiment">
              The trace of each run lands here: tools called, SQL, timings. It is what the Run Explorer reads.
            </RailRow>
          </ol>
        </section>
      </div>
    </div>
  );
}
