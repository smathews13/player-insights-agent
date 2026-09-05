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
 * a page that opens without operational verdicts reads as broken, not as
 * pending, and it was read that way by the person it was built for.
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
import { Component, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import './styles/routes/architecture.css';
import { Link } from 'react-router';
import { Alert, AlertDescription } from './ui';
import { CircleAlert, ExternalLink } from 'lucide-react';
import { astPill } from './pia-pill';
import { BrandIcon } from './BrandIcon';
// The word, the icon and the pending state, decided once for the whole app.
import { RefreshControl } from './RefreshControl';
// The chain and the answer's shape, as data rather than as prose in this file.
// See the note at the top of agent-chain.ts for why they moved out of here.
import { AGENT_CHAIN, ANSWER_CONTRACT, CHAIN_BOUND_LABEL, CHAIN_BOUNDS } from './agent-chain';
import { refreshLiveRuntimeSettings, useLiveRuntimeSettings } from './runtime-settings-live';
import type { RuntimeSettings } from '../../shared/runtime-settings';
import {
  ARCHITECTURE_NODES,
  describeArchitecture,
  drawnReadings,
  experimentConnectionNeedsRefresh,
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
  drawnEdges,
  nodeBox,
  type ArchitectureAccent,
  type NodeBox,
} from './architecture-layout';
import { observeArchitectureScale } from './architecture-responsive';
import {
  ARCHITECTURE_CONTROL_SCOPES,
  displayedBound,
  edgeControlBounds,
  nextActiveBound,
  nodeControlBounds,
} from './architecture-control-scopes';
import type { ChainBound } from './agent-chain';
import { readConnections, readingsById, type ConnectionReading } from './connection-model';
import { DRIFT_MARKER_LABEL } from './connection-status';
import { checkedAtOf } from './check-session';
import { useSessionChecks } from './session-checks';
import { fetchWithTimeout } from './fetch-timeout';
import { databricksLink, type DatabricksObject } from '../../shared/databricks-links';
import { entityHref } from './data-entities';
import { PiaLoadingLabel } from './PiaLoadingLabel';

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

/**
 * The browser must scale the fixed drawing before it paints it.
 *
 * The server and client both render scale 1, so hydration starts from identical
 * markup. In a browser this effect becomes a layout effect: its synchronous
 * clientWidth read is flushed before paint, then ResizeObserver reconciles every
 * later size. On the server it is an ordinary effect and never runs.
 */
const useCanvasLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** Keep a diagram exception from replacing the whole Architecture tab. */
class ArchitectureDiagramBoundary extends Component<
  { byResource: ReadonlyMap<string, ConnectionReading>; checking: boolean; children: ReactNode; now: number },
  { failed: boolean }
> {
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
          {describeArchitecture(this.props.byResource, this.props.now, this.props.checking).map((line) => (
            <li key={line}>{line}</li>
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
/** A node's operational connection verdict, in the shared pill palette. */
function ArchitectureNodeCard({
  activeBound,
  node,
  reading,
  indexReading,
  payload,
  box,
  checking,
  now,
}: {
  activeBound: ChainBound | null;
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
  checking: boolean;
  /** Read once per render by the page, so every card ages content off one clock. */
  now: number;
}) {
  const report = nodeReport(node, reading, indexReading);
  const value = nodeValue(reading);
  const age = nodeContentAge(node, reading, now);
  const object = workspaceObject(node, reading, payload);
  const deepLink = object && payload?.workspaceHost ? databricksLink(payload.workspaceHost, object) : null;
  const controlBounds = nodeControlBounds(node.id);

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
        {checking && node.presence === 'connection' ? (
          <PiaLoadingLabel
            as="span"
            seat="status"
            announce={false}
            className="arch-node-status-loader"
            label={`Checking ${node.label}`}
          />
        ) : report.label ? (
          <span className={astPill(NODE_FAMILY[report.tone], 'arch-node-status')} data-tone={report.tone}>
            {report.label}
          </span>
        ) : null}
        {reading && reading.marker !== 'none' ? (
          <span
            className={astPill(reading.marker === 'drift' ? 'warn' : 'neutral-outline', 'arch-node-drift')}
            data-drift={reading.marker}
          >
            {DRIFT_MARKER_LABEL[reading.marker]}
            {reading.marker === 'drift' && reading.driftCount > 1 ? ` \u00d7${reading.driftCount}` : ''}
          </span>
        ) : null}
        {/* Freshness remains a secondary fact; it never becomes a third connection state. */}
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

  const selected = activeBound !== null && controlBounds.includes(activeBound);
  return (
    <div
      className={selected ? 'arch-node arch-node-selected' : 'arch-node'}
      data-testid={`arch-node-${node.id}`}
      data-node={node.id}
      data-accent={box.accent}
      data-tone={(checking && node.presence === 'connection') || !report.label ? undefined : report.tone}
      data-checking={checking && node.presence === 'connection' ? 'true' : undefined}
      data-drift={reading && reading.marker !== 'none' ? reading.marker : undefined}
      data-control-bounds={controlBounds.join(' ') || undefined}
      data-control-active={selected ? 'true' : undefined}
      data-control-bound={selected ? activeBound : undefined}
      style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` }}
    >
      {node.resourceId ? (
        <Link
          className="arch-node-main"
          to={entityHref(node.resourceId)}
          aria-label={`${nodeAccessibleName(node, reading, indexReading, now, checking)}. Open on Connections.`}
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
          {/* The experiment is the one Databricks destination whose product mark
              is a wordmark. Keep it in the action itself, as Monitoring does, so
              every MLflow hyperlink identifies its destination before its copy. */}
          {node.product === 'mlflow' ? <BrandIcon product="mlflow" size={12} /> : null}
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
 * in one SVG, travelling dots on directional flow edges following the SAME path
 * strings, and the cards on top. Hosting topology stays static so it cannot be
 * mistaken for a request direction. The dots are CSS motion paths rather than SVG
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
  activeBound = null,
  byResource,
  checking = false,
  payload,
  now,
}: {
  /**
   * The setting the drawing is currently explaining.
   *
   * The page passes the displayed bound -- hover preview if the pointer is on a
   * tile, otherwise the click that stuck. This component does not know which.
   */
  activeBound?: ChainBound | null;
  byResource: ReadonlyMap<string, ConnectionReading>;
  /** While live checks are active, connection nodes show only their loader. */
  checking?: boolean;
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
  const description = useMemo(() => describeArchitecture(byResource, now, checking), [byResource, checking, now]);

  /**
   * One fixed geometry and one measured number.
   *
   * Scale 1 is the deterministic server/client initial state. The container query
   * below keeps an unscaled canvas from painting at widths where it would clip;
   * in widths where the canvas belongs, the layout effect measures and applies
   * zoom before the browser paints. ResizeObserver handles only later changes.
   */
  const [scale, setScale] = useState(1);
  const responsive = useRef<HTMLDivElement | null>(null);

  useCanvasLayoutEffect(() => {
    const element = responsive.current;
    if (!element) return;
    return observeArchitectureScale(element, setScale);
  }, []);

  return (
    <div className="arch-responsive" data-testid="architecture-responsive" ref={responsive}>
      <div className="arch-canvas-scroll">
        <div
          className="arch-canvas"
          data-testid="architecture-canvas"
          role="group"
          aria-label="Live data flow. Each card links to that dependency on the Connections page."
          data-active-bound={activeBound ?? undefined}
          data-active-accent={activeBound ? ARCHITECTURE_CONTROL_SCOPES[activeBound].accent : undefined}
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
            {edges.map((edge) => {
              const controlBounds = edgeControlBounds(edge.from, edge.to);
              const controlled = activeBound !== null && controlBounds.includes(activeBound);
              return (
                <g key={edge.id}>
                  <path
                    className="arch-edge"
                    d={edge.d}
                    data-relationship={edge.relationship}
                    data-control-bounds={controlBounds.join(' ') || undefined}
                    data-control-active={controlled ? 'true' : undefined}
                    data-control-bound={controlled ? activeBound : undefined}
                  />
                  <text className="arch-edge-label" x={edge.labelX} y={edge.labelY} textAnchor={edge.labelAnchor}>
                    {edge.label}
                  </text>
                </g>
              );
            })}
          </svg>
          {edges
            .filter((edge) => edge.relationship === 'flow')
            .map((edge) => (
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
                activeBound={activeBound}
                box={box}
                checking={checking}
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
      </div>

      {/*
        The drawing in words. It is the ONE live tree when a panel is too narrow
        for the canvas; at drawable widths CSS removes it from both visual and
        accessibility trees before exposing the interactive canvas. One list, one
        set of sentences, one clock -- so the narrow arrangement is not a second
        version of the page that nobody checks, which is what the old 1024px
        collapse was.
      */}
      <ul className="arch-equivalent" data-testid="architecture-equivalent">
        {description.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {/* The legend maps a colour to a kind of connection, so it has nothing to
          say when the drawing is not on screen. */}
      <ul className="arch-legend">
        {LEGEND.map((entry) => (
          <li key={entry.accent} data-accent={entry.accent}>
            <span aria-hidden="true" />
            {entry.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The loop bounds, as a strip of tiles under the live-data-flow label.
 *
 * THE THREE NUMBERS THAT DECIDE HOW LONG AN ANSWER MAY TAKE, which were readable
 * only by opening the gear -- on a page whose whole job is to say what the
 * deployment does. They sit inside that pane, below its label and above the
 * drawing, because they bound the run the diagram is of rather than sitting in
 * the header as if they were a caption of the section.
 *
 * AN EM-DASH RATHER THAN THE DEFAULTS when the read fails. The shared defaults are
 * 12/12/150 and it would be easy to print them here, but a stored setting is what
 * the agent actually uses and "12" on a page that could not read the store is a
 * claim about a number nobody checked. Same rule as the tiles above: not knowing
 * and knowing zero are different, and the page says which one it is in.
 *
 * Labelled in the Settings pane's own words, so a reader who wants to change one
 * has a string to search the gear for. See CHAIN_BOUND_LABEL.
 */
export function ChainBoundTiles({
  activeBound = null,
  previewBound = null,
  loop,
  onActiveBoundChange,
  onPreviewBoundChange,
}: {
  activeBound?: ChainBound | null;
  /** Hover preview. Same paint as a click; never sticky on its own. */
  previewBound?: ChainBound | null;
  loop: RuntimeSettings['loop'] | null;
  onActiveBoundChange?: (bound: ChainBound | null) => void;
  onPreviewBoundChange?: (bound: ChainBound | null) => void;
}) {
  const unknown = '\u2014';
  const shown = displayedBound(activeBound, previewBound);
  return (
    <ul className="arch-loop-tiles" data-testid="architecture-loop-tiles">
      {CHAIN_BOUNDS.map((bound) => {
        const pressed = activeBound === bound;
        const painted = shown === bound;
        const value = loop ? String(loop[bound]) : 'not available';
        return (
          <li
            data-bound={bound}
            data-accent={ARCHITECTURE_CONTROL_SCOPES[bound].accent}
            data-active={painted ? 'true' : undefined}
            className={painted ? 'arch-bound-selected' : undefined}
            key={bound}
            onMouseEnter={() => onPreviewBoundChange?.(bound)}
            onMouseLeave={() => onPreviewBoundChange?.(null)}
          >
            <button
              type="button"
              className={painted ? 'arch-bound-tile arch-bound-selected' : 'arch-bound-tile'}
              aria-pressed={pressed}
              aria-label={`${CHAIN_BOUND_LABEL[bound]}: ${value}. ${
                pressed
                  ? 'Selected. Click again to clear the architecture highlight.'
                  : 'Show the architecture it controls.'
              }`}
              onClick={() => onActiveBoundChange?.(nextActiveBound(activeBound, bound))}
            >
              <span>{CHAIN_BOUND_LABEL[bound]}</span>
              <strong className="ast-num">{loop ? loop[bound] : unknown}</strong>
            </button>
          </li>
        );
      })}
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
  children?: string;
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
      {children ? <p className="arch-rail-body">{children}</p> : null}
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
  const [activeBound, setActiveBound] = useState<ChainBound | null>(null);
  const [previewBound, setPreviewBound] = useState<ChainBound | null>(null);
  const shownBound = displayedBound(activeBound, previewBound);
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
   * pressed. That was the defect Sam reported: a tab that opens without
   * operational verdicts down its whole length reads as broken.
   */
  const { session, running: checking, firstLoad, refresh } = useSessionChecks();
  const settings = session?.settings ?? null;
  const report = session?.report ?? null;
  const checkError = session?.error ?? '';
  /**
   * The loop bounds, from the same remembered row Save writes.
   *
   * Settings is a modal over this page, so a one-shot fetch on mount kept showing
   * the previous budget after 200 was saved. Refresh only re-ran the workspace
   * checks. The live store is what Appearance already used for colours; the tiles
   * now read it too.
   */
  const runtime = useLiveRuntimeSettings();
  const loop = runtime?.loop ?? null;
  const reconciledExperimentMismatch = useRef('');

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
   * Reconcile a loaded tab after the app behind it was redeployed.
   *
   * Session checks intentionally survive route changes, but the browser can
   * also stay loaded while Databricks replaces the app process. The cheap
   * Architecture payload carries the newly recovered experiment id; when it
   * disagrees with the remembered connection payload, re-run the shared checks
   * once. This is the production failure from the screenshot: Ops had fresh
   * green evidence while Architecture retained an older empty-id verdict.
   */
  useEffect(() => {
    const current = settings?.resources.find((entry) => entry.resource.id === 'experiment-id')?.configured ?? '';
    const authoritative = payload?.experimentId ?? '';
    if (!experimentConnectionNeedsRefresh(authoritative, settings) || checking) return;
    const mismatch = `${current}\u0000${authoritative}`;
    if (reconciledExperimentMismatch.current === mismatch) return;
    reconciledExperimentMismatch.current = mismatch;
    void refresh();
  }, [checking, payload?.experimentId, refresh, settings]);

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
        <RefreshControl
          busy={checking}
          checkedAt={checkedAt}
          now={now}
          onRefresh={() => {
            void refresh();
            void refreshLiveRuntimeSettings();
          }}
        />
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
              <strong>{entry.node.label} is connected and its content is out of date</strong>
              {': '}
              {entry.age.note}
            </span>
          </AlertDescription>
        </Alert>
      ))}

      <section className="arch-flow" aria-labelledby="arch-flow-title">
        <div className="arch-flow-head">
          <h3 className="section-label" id="arch-flow-title">
            Live data flow
          </h3>
        </div>
        <ChainBoundTiles
          activeBound={activeBound}
          previewBound={previewBound}
          loop={loop}
          onActiveBoundChange={setActiveBound}
          onPreviewBoundChange={setPreviewBound}
        />
        <ArchitectureDiagramBoundary
          byResource={byResource}
          checking={checking || firstLoad}
          key={`${checkedAt}:${payload?.readAt ?? ''}`}
          now={now}
        >
          <ArchitectureCanvas
            activeBound={shownBound}
            byResource={byResource}
            checking={checking || firstLoad}
            now={now}
            payload={payload}
          />
        </ArchitectureDiagramBoundary>
      </section>

      {/*
        THREE RAILS IN TWO COLUMNS, AND WHICH RAIL IS WHICH IS SAID HERE RATHER
        THAN COUNTED IN THE STYLESHEET. `data-rail` is what architecture.css
        places against, so the chain can be given the whole left column and the
        other two can stack down the right one. It also carries the blue eyebrow,
        which used to be selected as `.arch-rail:first-child` -- a rule that means
        "whichever section happens to be written first" and would have followed a
        reordering of this markup onto the wrong heading.

        The order below is the order a reader gets when the columns stack at
        1180px: the chain, then what comes back, then where it is kept. Storage is
        last in both arrangements, which is the reason it is written last rather
        than placed last -- a rail moved into the right column by the stylesheet
        alone would stack in the middle of the pipeline stages.
      */}
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
        <section className="arch-rail" data-rail="chain" aria-labelledby="arch-rail-answer">
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
                />
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
        <section className="arch-rail" data-rail="contract" aria-labelledby="arch-rail-contract">
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
              </li>
            ))}
          </ul>
        </section>

        <section className="arch-rail" data-rail="storage" aria-labelledby="arch-rail-storage">
          <h3 className="section-label" id="arch-rail-storage">
            Storage
          </h3>
          <ol className="arch-rail-rows">
            <RailRow accent="kept" badge="Store" title="Databricks App to Lakebase (Postgres)" />
            {/* Two clauses rather than one sentence with an em-dashed aside in
                the middle of it. §7 has no em dash in it, and the list this one
                interrupted itself to give reads better as its own sentence. */}
            <RailRow accent="kept" badge="Trace" title="Orchestrator to MLflow experiment" />
          </ol>
        </section>
      </div>
    </div>
  );
}
