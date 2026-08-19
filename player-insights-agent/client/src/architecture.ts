/**
 * The shape of this deployment, as a graph whose nodes are real connections.
 *
 * EVERY NODE THAT NAMES A DEPENDENCY NAMES A `ConnectedResource`. Its status,
 * its identifier and its drift come from `connection-model.ts`, which is the
 * derivation the Connections page renders, so the diagram and the list cannot
 * describe different deployments. A node here that had its own idea of whether
 * the warehouse was reachable would eventually be confidently wrong, and a
 * confident diagram is believed in a way a list is not.
 *
 * Two nodes name no resource, and say so rather than borrowing a status that
 * means something else: `browser` and `app` are where the code runs. There is no
 * remote end to probe -- the reader is looking at the browser, and the app
 * answered the request that drew the page.
 *
 * `semantic-index` used to be a third, and the reason it no longer is was a bug
 * rather than a design. The orchestrator reports whether it searches an index; it
 * simply reported it under a key nothing on this side read, so the node had to say
 * the app could not see. It is a registry entry like any other now, and the one
 * case still worth a sentence of its own is a served version older than that
 * report, where absence genuinely means unknown -- see
 * {@link SEMANTIC_INDEX_UNREPORTED}.
 *
 * THE SEMANTIC LANE IS TWO OBJECTS, and drawing it as one hid a real fault. The
 * index is a Unity Catalog object; the endpoint is the compute that serves it,
 * created by the bundle rather than named in the artifact. They fail separately
 * and cost separately -- an endpoint runs and bills by the hour whether or not
 * anything searches the index on it, and an index can be present and refused on
 * an endpoint that is perfectly healthy. With one card on the drawing those two
 * failures looked identical. The app has probed both since the workspace probes
 * were added; only the diagram was short a card, and only because nothing named
 * the endpoint as a connection for it to draw.
 *
 * The edges carry sentences rather than arrowheads. The meaning of an edge is
 * the thing a diagram usually leaves to a reader who can see it, so it is
 * written down here once and used both for the visible caption and for the
 * text equivalent a screen reader gets.
 */
import { CONNECTION_STATUS_LABEL, CONNECTION_STATUS_NOTE } from './connection-status';
import { contentAge, type ContentAge } from './semantic-freshness';
import type { ConnectionReading } from './connection-model';
import type { BrandProduct } from './brand-icons';

/**
 * The one sentence left on the page, as the person who owns the words wrote it.
 *
 * Held here rather than in the page because it makes a claim about something
 * outside itself -- when the checks run, which is a fact about what the page
 * fetches -- and architecture-render.test.tsx asserts the string and the claim
 * together, so a change to when the checks run fails beside the sentence it
 * contradicts.
 *
 * IT USED TO SAY THE OPPOSITE, and it was approved copy: "Checks only run when
 * you click Refresh — 'Not checked' means not checked yet, not broken." Both
 * halves were true of a page that probed nothing on load, and both stopped being
 * true the moment the checks began running themselves. A page that has already
 * run its checks and tells the reader it has not is worse than one that says
 * nothing, because the reader then distrusts the statuses as well.
 *
 * The page's own sub-headline and the line under Live data flow were deleted
 * rather than rewritten. Neither was wrong; both explained the tab to a reader
 * who had just clicked it, and the layout claim ("storage sits on the bottom
 * row") is one the diagram makes better than a sentence about the diagram can.
 */
/** Which half of the page a node belongs to. */
export type ArchitectureLane =
  /** What happens between a question and an answer. */
  | 'request'
  /** The governed data the answer is computed from. */
  | 'data'
  /** What the deployment keeps: the record, and the trace. */
  | 'record'
  /** The optional semantic layer, drawn whether or not it is present. */
  | 'semantic';

/** What kind of thing the node stands for, which decides what its badge can say. */
export type NodePresence =
  /** A `ConnectedResource`, so its status is that entry's status. */
  | 'connection'
  /** Code running here. Nothing to probe. */
  | 'local'
  /** A real component with no registry entry, so nothing reports on it. */
  | 'unregistered';

export interface ArchitectureNode {
  id: string;
  label: string;
  /** The registry entry this node is, when it is one. */
  resourceId: string | null;
  presence: NodePresence;
  lane: ArchitectureLane;
  /** One sentence: what this does for an answer the reader reads. */
  role: string;
  /**
   * Whether what this serves is rebuilt on a schedule rather than read live.
   *
   * True on the one node it is true of, and it earns that node a second pill
   * saying how old its content is. Everything else on this drawing reads
   * through to a table at the moment it is asked, so "is it reachable" is the
   * whole question; an index holds a copy, and a copy can be reachable and
   * months out of date at the same time. See `semantic-freshness.ts` for the
   * five days that fact went unreported.
   */
  rebuilt?: boolean;
  /**
   * The Databricks product this node IS, when it is one.
   *
   * The handoff puts each product's official mark left of its node title, and
   * this is where the pairing is declared -- beside the node itself rather than
   * in the component that draws it, so a node added here cannot arrive on screen
   * with the wrong logo or with somebody else's.
   *
   * Absent on the two nodes that are not Databricks products: the reader's
   * browser, and the app's own Node server. The app NODE is `apps`, because that
   * node stands for the Databricks App the server runs inside; the browser
   * stands for Chrome.
   *
   * Which mark a product resolves to is `brand-icons.ts`'s, and only its. This
   * field names a product, never a file.
   */
  product?: BrandProduct;
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  /** What crosses this edge, as a sentence a screen reader can be given. */
  meaning: string;
}

/**
 * The nodes, in reading order.
 *
 * Verified against `agent/agent.py`, `agent/tools.py`,
 * `agent/semantic_retrieval.py`, `server/routes/insights-routes.ts`,
 * `agent/log_model.py` and the bundle's resource files rather than from a
 * description of the system.
 */
export const ARCHITECTURE_NODES: readonly ArchitectureNode[] = [
  {
    id: 'browser',
    label: 'Browser',
    resourceId: null,
    presence: 'local',
    lane: 'request',
    role: 'Sends questions to the app.',
  },
  {
    id: 'app',
    label: 'Databricks App',
    resourceId: null,
    presence: 'local',
    lane: 'request',
    role: 'Stores conversations and invokes the Orchestrator.',
    product: 'apps',
  },
  {
    id: 'agent-endpoint',
    label: 'Orchestrator',
    resourceId: 'agent-endpoint',
    presence: 'connection',
    lane: 'request',
    role: 'Plans each answer and delegates data discovery.',
    product: 'mosaic-ai',
  },
  {
    id: 'data-source-finder',
    label: 'Data Source Finder',
    resourceId: null,
    presence: 'unregistered',
    lane: 'request',
    role: 'Finds and validates governed data for the Orchestrator.',
    product: 'mosaic-ai',
  },
  {
    id: 'llm-endpoint',
    label: 'Foundation model',
    resourceId: 'llm-endpoint',
    presence: 'connection',
    lane: 'request',
    role: 'Reasons over prompts and writes answer prose.',
    product: 'mosaic-ai',
  },
  {
    id: 'genie-data',
    label: 'Data Genie space',
    resourceId: 'genie-data',
    presence: 'connection',
    lane: 'data',
    role: 'Answers metric questions from curated tables.',
    product: 'genie',
  },
  {
    id: 'genie-dictionary',
    label: 'Dictionary Genie space',
    resourceId: 'genie-dictionary',
    presence: 'connection',
    lane: 'data',
    role: 'Defines business terms and fields.',
    product: 'genie',
  },
  {
    id: 'sql-warehouse',
    label: 'SQL warehouse',
    resourceId: 'sql-warehouse',
    presence: 'connection',
    lane: 'data',
    role: 'Runs read-only SQL under the reader\u2019s grants.',
    product: 'databricks-sql',
  },
  {
    id: 'catalog',
    label: 'Unity Catalog',
    resourceId: 'catalog',
    presence: 'connection',
    lane: 'data',
    role: 'Applies governance to every table read.',
    product: 'unity-catalog',
  },
  {
    id: 'semantic-index',
    label: 'Vector Search index',
    resourceId: 'semantic-index',
    presence: 'connection',
    lane: 'semantic',
    role: 'Searches field and metric descriptions for source discovery.',
    rebuilt: true,
    product: 'mosaic-ai',
  },
  {
    id: 'semantic-index-endpoint',
    label: 'Vector Search endpoint',
    resourceId: 'semantic-index-endpoint',
    presence: 'connection',
    lane: 'semantic',
    role: 'Serves Vector Search queries.',
    product: 'mosaic-ai',
  },
  {
    id: 'lakebase',
    label: 'Lakebase (Postgres)',
    resourceId: 'lakebase',
    presence: 'connection',
    lane: 'record',
    role: 'Stores conversations, uploads, feedback, and benchmark runs.',
    product: 'lakebase',
  },
  {
    id: 'experiment-id',
    label: 'MLflow experiment',
    resourceId: 'experiment-id',
    presence: 'connection',
    lane: 'record',
    role: 'Stores run traces, tool calls, SQL, and token usage.',
    product: 'mlflow',
  },
];

/**
 * The edges, each with the sentence that is its meaning.
 *
 * The finder’s governed data edges carry the
 * signed-in user's downscoped token where the model version declares
 * `user-authorization`, which is the hop the whole governance story rests on
 * and the one a box-and-arrow diagram normally loses.
 */
export const ARCHITECTURE_EDGES: readonly ArchitectureEdge[] = [
  { from: 'browser', to: 'app', meaning: 'The browser sends the question to this app over HTTPS.' },
  {
    from: 'app',
    to: 'agent-endpoint',
    meaning: 'The app invokes the serving endpoint as its own service principal, forwarding the reader\u2019s token.',
  },
  {
    from: 'agent-endpoint',
    to: 'data-source-finder',
    meaning: 'The orchestrator delegates governed source discovery as one self-contained request.',
  },
  { from: 'agent-endpoint', to: 'llm-endpoint', meaning: 'The orchestrator calls the model to plan and write the final answer.' },
  {
    from: 'data-source-finder',
    to: 'llm-endpoint',
    meaning: 'The finder calls the model to choose discovery and validation steps.',
  },
  {
    from: 'data-source-finder',
    to: 'genie-dictionary',
    meaning: 'Ambiguous terms are resolved against the dictionary space before anything is measured.',
  },
  {
    from: 'data-source-finder',
    to: 'genie-data',
    meaning: 'Metric questions go to the data space, under the reader\u2019s own identity where the version declares it.',
  },
  {
    from: 'data-source-finder',
    to: 'sql-warehouse',
    meaning: 'Resolved tables and validated read-only SQL run under the reader\u2019s grants.',
  },
  { from: 'genie-data', to: 'sql-warehouse', meaning: 'Genie\u2019s generated SQL is executed by the warehouse.' },
  {
    from: 'sql-warehouse',
    to: 'catalog',
    meaning: 'The warehouse reads Unity Catalog, which applies that reader\u2019s row filters and column masks.',
  },
  {
    from: 'data-source-finder',
    to: 'semantic-index',
    meaning: 'Where a deployment has an index, the finder searches descriptions to choose what to ask about.',
  },
  {
    from: 'semantic-index-endpoint',
    to: 'semantic-index',
    meaning: 'The index is a Unity Catalog object; this endpoint is the compute a search of it runs on.',
  },
  { from: 'app', to: 'lakebase', meaning: 'The app writes the conversation, the answer and any feedback to Postgres.' },
  { from: 'agent-endpoint', to: 'experiment-id', meaning: 'The endpoint traces the run into the MLflow experiment.' },
];

/**
 * What a node's badge says, and why.
 *
 * The `connection` case delegates entirely: the label is the one
 * `connection-status.ts` gives that entry, so a node cannot grade a dependency
 * the row on the Connections page grades differently. The other two cases are
 * not statuses at all and say what they are.
 */
export interface NodeReport {
  /** The word on the badge. */
  label: string;
  /** Which visual treatment it takes. Not a colour; the stylesheet decides that. */
  tone: 'reachable' | 'blocked' | 'not-checked' | 'nothing-to-reach' | 'local' | 'unreadable';
  /** The sentence behind the word, for the detail and for the text equivalent. */
  note: string;
}

/**
 * Every `ConnectionStatus`, mapped to the tone of the same name where there is
 * one.
 *
 * `refused` and `unreachable` are the exceptions and take the `not-checked`
 * treatment. The WORD is still each one's own -- the label comes from
 * `CONNECTION_STATUS_LABEL`, so a refused node reads "Refused" and an unreachable
 * one "Unreachable", exactly as their rows do -- and only the tint is shared,
 * because this lane's tones are the ones the Architecture stylesheet draws and a
 * sixth would be a new tint on a diagram whose whole argument is that it grades
 * nothing the Connections page does not. An untinted node with the right word on
 * it is honest; the same node reading "Not checked" was not. `unreachable` in
 * particular must not borrow `blocked`: red would assert a fault on a diagram off
 * a call that never got an answer.
 */
const CONNECTION_TONE = {
  reachable: 'reachable',
  blocked: 'blocked',
  refused: 'not-checked',
  unreachable: 'not-checked',
  'not-checked': 'not-checked',
  'nothing-to-reach': 'nothing-to-reach',
} as const;

export const LOCAL_NOTE =
  'This is where the code runs rather than something it connects to, so there is nothing to probe.';

/**
 * A deployment that has no semantic layer at all. Not a fault: the index is an
 * hourly charge, and most releases are logged without one.
 */
export const SEMANTIC_INDEX_ABSENT =
  'This release searches no semantic index. The orchestrator reported the setting as unset, so ' +
  'this is what the deployment is rather than something that failed.';

/**
 * A served model version logged before the endpoint reported this setting.
 *
 * The distinction from {@link SEMANTIC_INDEX_ABSENT} is the whole point: "there
 * is no index" and "nobody can tell you" are different facts, and the node used
 * to say the second in every case because the app read the setting from the wrong
 * key. Re-logging the model is what makes it answerable.
 */
export const SEMANTIC_INDEX_UNREPORTED =
  'This served model version does not report whether it searches a semantic index, so whether ' +
  'this deployment has one is unknown rather than settled. Nothing here does not mean there is ' +
  'no index. Re-logging the model reports it.';

/** No index to serve, so the endpoint card is a statement rather than a gap. */
export const SEMANTIC_ENDPOINT_NO_INDEX =
  'This release searches no index, so no endpoint is serving one for it.';

/** The version cannot say whether it searches an index, so nor can this. */
export const SEMANTIC_ENDPOINT_UNREPORTED =
  'This served model version does not report whether it searches an index, so whether an endpoint ' +
  'is serving one is unknown rather than settled.';

/**
 * The index did not answer, and it is the only thing that names its endpoint.
 *
 * Distinct from "nobody has looked yet", which is what an unrun check means.
 * Here a check ran, against the index, and what it established was that this
 * identity cannot read the object that would have named the endpoint.
 */
export const SEMANTIC_ENDPOINT_UNNAMED =
  'Only the index names the endpoint serving it, and the index did not answer, so there was ' +
  'nothing to ask about.';

/**
 * What the semantic lane is doing, as one word per card.
 *
 * Five values rather than the four `ConnectionStatus` has, because this lane
 * carries a distinction the others do not: a deployment may legitimately have
 * no semantic layer at all, and a served version may be too old to say either
 * way. Those two are not statuses -- nothing was probed -- and they must not
 * collapse into each other or into `not-checked`, which is why they are named
 * here rather than expressed as an absence.
 */
export type SemanticState =
  /** The served version does not report the setting. Unknown, not absent. */
  | 'unreported'
  /** Reported, and it is none. A supported deployment rather than a fault. */
  | 'none'
  /** There is one, and no check has run against it yet. */
  | 'not-checked'
  /** Checked, and the workspace answered. */
  | 'online'
  /** Checked, and it was refused or is not there. */
  | 'unreachable';

/**
 * Which of the five the index is in.
 *
 * Provenance rather than value decides the first two: the orchestrator writes
 * this setting whether or not it names an index, so a source at all is the
 * version having answered, and an empty source is nobody having been asked in a
 * way they could answer.
 */
export function semanticIndexState(reading: ConnectionReading | undefined): SemanticState {
  if (!reading) return 'not-checked';
  if (!reading.summary.value) return reading.row.configuredFrom !== '' ? 'none' : 'unreported';
  if (reading.status === 'reachable') return 'online';
  if (reading.status === 'blocked') return 'unreachable';
  return 'not-checked';
}

/**
 * Which of the five the endpoint is in, which depends on the index as well.
 *
 * The endpoint is only asked about after the index answers and names it, so its
 * own reading cannot be read alone: an endpoint with no check on a deployment
 * that searches nothing is not the same fact as an endpoint with no check on a
 * deployment whose index was refused.
 */
export function semanticEndpointState(index: ConnectionReading | undefined,
  endpoint: ConnectionReading | undefined
): SemanticState {
  const indexState = semanticIndexState(index);
  if (indexState === 'none' || indexState === 'unreported') return indexState;
  if (endpoint?.status === 'reachable') return 'online';
  if (endpoint?.status === 'blocked') return 'unreachable';
  return 'not-checked';
}

/** The two cards a `SemanticState` is drawn as, where it is not a probe's verdict. */
const SEMANTIC_INDEX_REPORT: Partial<Record<SemanticState, NodeReport>> = {
  none: { label: 'None', tone: 'nothing-to-reach', note: SEMANTIC_INDEX_ABSENT },
  unreported: { label: 'Not reported', tone: 'unreadable', note: SEMANTIC_INDEX_UNREPORTED },
};

const SEMANTIC_ENDPOINT_REPORT: Partial<Record<SemanticState, NodeReport>> = {
  none: { label: 'None', tone: 'nothing-to-reach', note: SEMANTIC_ENDPOINT_NO_INDEX },
  unreported: { label: 'Not reported', tone: 'unreadable', note: SEMANTIC_ENDPOINT_UNREPORTED },
};

/** The card for a node whose reading has not arrived, or could not be taken. */
function notChecked(note: string): NodeReport {
  return { label: CONNECTION_STATUS_LABEL['not-checked'], tone: 'not-checked', note };
}

const NOT_CHECKED_NOTE =
  'No check has run against this one yet, so whether it is reachable is unknown rather than confirmed.';

export function nodeReport(node: ArchitectureNode,
  reading: ConnectionReading | undefined,
  /** The index's reading, which the endpoint card cannot be read without. */
  indexReading?: ConnectionReading
): NodeReport {
  if (node.presence === 'local') {
    return { label: 'Runs here', tone: 'local', note: LOCAL_NOTE };
  }
  if (node.presence === 'unregistered') {
    return {
      label: 'Runs in-process',
      tone: 'local',
      note: 'This is a separately invoked agent boundary inside the Orchestrator process, not another endpoint.',
    };
  }
  if (node.id === 'semantic-index') {
    const stated = SEMANTIC_INDEX_REPORT[semanticIndexState(reading)];
    if (stated) return stated;
  }
  if (node.id === 'semantic-index-endpoint') {
    const state = semanticEndpointState(indexReading, reading);
    const stated = SEMANTIC_ENDPOINT_REPORT[state];
    if (stated) return stated;
    // An index that was refused takes its endpoint's name with it. Reported as
    // the reason rather than as the generic "nobody looked", which is untrue:
    // somebody looked at the index and was turned away.
    if (state === 'not-checked' && semanticIndexState(indexReading) === 'unreachable') {
      return notChecked(SEMANTIC_ENDPOINT_UNNAMED);
    }
  }
  // A registry-backed node whose reading has not arrived. Not checked, which is
  // the honest word for it and a real status rather than a stand-in: the cheap
  // page load runs no probes at all.
  if (!reading) {
    return notChecked(NOT_CHECKED_NOTE);
  }
  // The word and the sentence are `connection-status.ts`'s, not this module's.
  // A node cannot grade a dependency differently from the row that grades it on
  // the Connections page, because it does not know how to grade one.
  return {
    label: CONNECTION_STATUS_LABEL[reading.status],
    tone: CONNECTION_TONE[reading.status],
    note: CONNECTION_STATUS_NOTE[reading.status],
  };
}

/**
 * The identifier a node shows, and whether anything measured it.
 *
 * The same `inUseSummary` the collapsed row on the Connections page shows, so
 * the two surfaces print the same string. `null` where the deployment has not
 * told us one, which the page renders as the reason rather than as a blank.
 */
/**
 * How old the content this node serves is, for the one node that holds any.
 *
 * ONLY WHERE A CHECK RAN AND THE OBJECT ANSWERED, and the exclusions are the
 * point. An index nobody has probed has no age to report and saying "not
 * reported" beside "Not checked" states one absence twice. An index that was
 * refused has no age either, and a second pill under a red one reads as a
 * second problem. In both cases the status pill is already saying the true
 * thing.
 *
 * Where it does draw, the value is the probe's own `content_at` and nothing
 * else. `contentAge` has no fallback and is given none here: no substitute
 * exists that would not read as freshness.
 */
export function nodeContentAge(node: ArchitectureNode,
  reading: ConnectionReading | undefined,
  now: number
): ContentAge | null {
  if (!node.rebuilt) return null;
  if (reading?.status !== 'reachable') return null;
  return contentAge(reading.check?.content_at, now);
}

/**
 * Every node whose content is older than its rebuild schedule can explain.
 *
 * Derived here rather than in the page so it can be tested without rendering
 * one, and so the banner the page raises and the pill on the card are the same
 * judgement rather than two that agree today. Empty is the normal answer.
 *
 * It is raised to the top of the page at all because the failure it reports is
 * one nobody would go looking for: every status on this tab was reachable for
 * the five days the index served content from before the job started failing.
 * A mark that only appears on the card is a mark for somebody who already
 * suspects.
 */
export function staleContent(readings: ReadonlyMap<string, ConnectionReading>,
  now: number
): Array<{ node: ArchitectureNode; age: ContentAge }> {
  const found: Array<{ node: ArchitectureNode; age: ContentAge }> = [];
  for (const node of ARCHITECTURE_NODES) {
    if (!node.rebuilt) continue;
    const age = nodeContentAge(node, node.resourceId ? readings.get(node.resourceId) : undefined, now);
    if (age?.state === 'stale') found.push({ node, age });
  }
  return found;
}

export function nodeValue(reading: ConnectionReading | undefined): { value: string; measured: boolean } | null {
  if (!reading) return null;
  if (!reading.summary.value) return null;
  return reading.summary;
}

export function nodesInLane(lane: ArchitectureLane): ArchitectureNode[] {
  return ARCHITECTURE_NODES.filter((node) => node.lane === lane);
}

/**
 * The nodes that ARE a dependency, which is what the tiles count.
 *
 * The browser and the app server are on the drawing because a reader needs to
 * see where the code runs, but neither is something this deployment depends on
 * reaching, and counting them would make the tile disagree with the number of
 * things that can be checked.
 */
export function dependencyNodes(): ArchitectureNode[] {
  return ARCHITECTURE_NODES.filter((node) => node.presence === 'connection');
}

/**
 * The readings for the dependencies the diagram draws, in drawing order.
 *
 * The tiles are counted off THIS rather than off the whole settings payload,
 * because the tile sits above this diagram and a reader will read it as a count
 * of what is below it. The Connections page has twenty entries; ten of them are
 * drawn here.
 */
export function drawnReadings(readings: ReadonlyMap<string, ConnectionReading>): ConnectionReading[] {
  const found: ConnectionReading[] = [];
  for (const node of dependencyNodes()) {
    const reading = node.resourceId ? readings.get(node.resourceId) : undefined;
    if (reading) found.push(reading);
  }
  return found;
}

/**
 * How long ago the checks were run.
 *
 * `readAgo` in `RefreshControl` is the only caller, and the Refresh control is
 * the only place in the app that states freshness. The Architecture tile strip
 * used to print this as well; one clock with two readings is one too many.
 *
 * Rounded to the coarsest unit that is still true, and "not yet" where nothing
 * has been run. That is now a brief state rather than a resting one -- the checks
 * start themselves when the app is opened -- but it is still reachable, while the
 * first run is in flight and on a deployment where it failed. Never an absolute
 * clock time: the question a reader has is whether the statuses below are from
 * this sitting, and a timestamp makes them work that out.
 */
export function checkedAgo(iso: string, now: number): string {
  if (!iso) return 'not yet';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 'not yet';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * What a screen reader is told a node card is.
 *
 * The status word is IN the name rather than only in the pill beside it, so the
 * card announces the same fact a sighted reader takes from the pill's colour,
 * and the identifier is included because it is the thing that distinguishes two
 * Genie spaces from each other.
 */
export function nodeAccessibleName(node: ArchitectureNode,
  reading: ConnectionReading | undefined,
  indexReading?: ConnectionReading,
  now: number = Date.now()
): string {
  const report = nodeReport(node, reading, indexReading);
  const value = nodeValue(reading);
  const age = nodeContentAge(node, reading, now);
  const parts = [`${node.label}: ${report.label}`];
  // Second, ahead of the identifier, because it is the second thing the card
  // shows and a name announced before a warning buries the warning.
  if (age) parts.push(age.label);
  if (value) parts.push(value.value);
  if (reading?.marker === 'drift') parts.push('drifted from what it was configured with');
  if (reading?.marker === 'pending') parts.push('a saved value has not been applied');
  return parts.join('. ');
}

export function architectureNode(id: string): ArchitectureNode | undefined {
  return ARCHITECTURE_NODES.find((node) => node.id === id);
}

/** Every edge touching one node, for the detail a node carries. */
export function edgesFor(id: string): ArchitectureEdge[] {
  return ARCHITECTURE_EDGES.filter((edge) => edge.from === id || edge.to === id);
}

/**
 * The whole diagram as sentences.
 *
 * This is not a fallback and it is not decoration: it is the diagram, for
 * anybody not reading it with their eyes and a mouse. Every fact the drawing
 * carries -- what a node is, what its status is, what it is using, and what
 * each edge means -- has to appear here, because the alternative is a page
 * whose content is only available to some of its readers.
 */
export function describeArchitecture(readings: ReadonlyMap<string, ConnectionReading>,
  now: number = Date.now()
): string[] {
  const lines: string[] = [];
  const index = readings.get('semantic-index');
  for (const node of ARCHITECTURE_NODES) {
    const reading = node.resourceId ? readings.get(node.resourceId) : undefined;
    const report = nodeReport(node, reading, index);
    const value = nodeValue(reading);
    const age = nodeContentAge(node, reading, now);
    const parts = [`${node.label}: ${report.label}.`, node.role];
    // The whole sentence rather than the pill's words. This list is the drawing
    // for anyone not looking at it, and "Stale, 5 d old" without the sentence
    // that says what stale means here is a pill read aloud, not a description.
    if (age) parts.push(age.note);
    if (value) {
      parts.push(value.measured
          ? `In use: ${value.value}, measured from inside the endpoint.`
          : `Configured as ${value.value}. Nothing has measured what it is actually using.`
      );
    }
    if (reading?.marker === 'drift') {
      parts.push(`This one has drifted: what it is using is not what it was configured with.`);
    }
    if (reading?.marker === 'pending') {
      parts.push('A value has been recorded for this one and has not been applied.');
    }
    lines.push(parts.join(' '));
  }
  for (const edge of ARCHITECTURE_EDGES) {
    const from = architectureNode(edge.from)?.label ?? edge.from;
    const to = architectureNode(edge.to)?.label ?? edge.to;
    lines.push(`${from} to ${to}: ${edge.meaning}`);
  }
  return lines;
}
