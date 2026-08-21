/**
 * One reading of one connection, for every page that draws connections.
 *
 * `connection-status.ts` owns the four vocabularies -- the badge, the drift
 * marker, the in-use summary, the counts. This module owns the step before
 * them: which preflight check belongs to which resource, which findings belong
 * to it, and whether it has a second reader at all. That step used to live
 * inline in ConnectionsPage.tsx, twice, and the two copies had already begun to
 * differ in what they passed to `driftMarker`.
 *
 * It is lifted here because a second page now draws the same connections as a
 * diagram. A diagram that disagrees with the list on the next page about what
 * this deployment is wired to is worse than no diagram: the list reads as a
 * table somebody has to check, and a diagram reads as the truth. So there is
 * one derivation and both surfaces render its output, rather than two readings
 * of one payload that agree on the day they are written.
 */
import {
  connectionCounts,
  connectionStatus,
  driftCount,
  driftMarker,
  inUseSummary,
  type ConnectionStatus,
  type DriftMarker,
} from './connection-status';
import type { PreflightCheck } from './preflight';
import type { ConnectedResource, ResourceKind } from '../../shared/deployment-config';
import type { AppFacts } from '../../shared/app-facts';

/**
 * Whether the notebook declaration table is offered as a connection editor.
 *
 * OFF for Astrolabe. The registry entry, settings route, declaration reader and
 * notebook-required Apply gate deliberately remain in place: a deployment may
 * still configure the table outside this screen, and this can be restored later
 * without rebuilding that machinery.
 */
export const SHOW_NOTEBOOK_DECLARATION_EDITOR = false;

export type DriftSeverity = 'blocking' | 'warning' | 'pending' | 'unknown' | 'note';

export interface DriftFinding {
  id: string;
  severity: DriftSeverity;
  resourceId: string | null;
  headline: string;
  detail: string;
  remedy: string;
}

/** One row of `/api/settings`, as the server sends it. */
export interface ResourceRow {
  resource: ConnectedResource;
  configured: string;
  configuredFrom: string;
  actual: string;
  actualObserved: boolean;
  intended: string | null;
  intendedAt: string;
  intendedBy: string;
  editable: boolean;
  changedByLabel: string;
  changedByNote: string;
}

export interface SettingsPayload {
  resources: ResourceRow[];
  drift: DriftFinding[];
  status: 'ok' | 'blocked' | 'pending' | 'unknown';
  appBuildSha: string;
  /** App-build lineage stamped while the source checkout was available. */
  appBuildAncestors?: string[];
  modelBuildSha: string;
  orchestratorReported: boolean;
  storeAvailable: boolean;
  checkedAt: string;
  /**
   * What the signed-in user can reach, asked of the workspace by the app.
   *
   * Carried on THIS payload rather than fetched separately, and that is a
   * deliberate constraint rather than a convenience. Both surfaces already read
   * `/api/settings`, so shipping the reachability answers on it means neither
   * can be given the checks without the other: a second route would have to be
   * wired into two pages by hand, and the first person to wire it into one would
   * ship a diagram that disagreed with the list beside it. Optional because a
   * server built before this existed answers without it, and the readers below
   * treat its absence as "nothing was asked" rather than as an empty result.
   */
  checks?: PreflightCheck[];
  /**
   * What the deployment says about itself: its host, description, compute, tags
   * and release. Optional for the same reason `checks` is -- a server built
   * before this existed answers without it -- and its absence means the
   * workspace was never asked, so the Build card draws no rows for it.
   */
  app?: AppFacts;
  /**
   * What a connected notebook published, against what the running model reports.
   *
   * Optional for the same reason as the two above. Its absence means no server on
   * the other end knows about notebooks, which readers present as "no notebook is
   * connected" rather than as a failure.
   */
  notebook?: NotebookPanel;
  /**
   * The assets somebody added to the list the agent may consider.
   *
   * Absent means the same as empty here, which is safe: an empty list draws the
   * card with nothing in it, and the card's own copy is what states that adding one
   * grants nobody anything.
   */
  connections?: ConnectionEntry[];
}

/** How a published setting compares with the one in use. */
export interface DeclarationComparisonRow {
  key: string;
  label: string;
  declared: string;
  live: string;
  flow: 'flows' | 'needs-model-version' | 'refused';
  verdict: 'agrees' | 'pending' | 'refused' | 'unknown';
}

export interface NotebookPanel {
  location: string;
  /** Saved workspace notebook path. Absent on older servers. */
  configuredPath?: string;
  /** Notebook path reported by the latest declaration. Absent on older servers. */
  observedPath?: string;
  read: {
    declaration: {
      source: string;
      revision: string;
      publishedAt: string;
      publishedBy: string;
      settings: Array<{ key: string; value: string }>;
      connections: Array<{ id: string; label: string; kind: ResourceKind; value: string; note: string }>;
      /**
       * The notebook named the readable-scopes key and left it empty.
       *
       * Optional because a build serving an older payload omits it, and absent has
       * to read as "it did not" rather than crash a card.
       */
      emptyScopes?: boolean;
    } | null;
    failure: string | null;
    detail: string;
  };
  comparison: DeclarationComparisonRow[];
}

/** One declared asset, with what withdrawing it would cost. */
export interface ConnectionEntry {
  connection: {
    id: string;
    label: string;
    kind: ResourceKind;
    value: string;
    note: string;
    state: 'declared' | 'withdrawn';
    origin: 'app' | 'notebook';
    createdAt: string;
    createdBy: string;
    changedAt: string;
    changedBy: string;
  };
  impact: {
    headline: string;
    consequences: string[];
    recoverable: boolean;
  };
}

/**
 * Whether there is anything out there for a check to ask about.
 *
 * THE REGISTRY DECIDES FIRST. It says whether the value names a remote object at
 * all, which rules out the settings -- a token cap, two lists of catalog
 * patterns, a boolean. Nothing else can rescue those: there is no object, so
 * there is no verdict to wait for.
 *
 * For everything else, an end exists if anything at all points at one: a check,
 * a configured value, an observed one, or a registry entry that NAMES the check
 * expected to answer. The last is what keeps the Vector Search endpoint honest.
 * Nothing configures it -- only the index payload names it -- so its row is
 * empty on every deployment, and reading that emptiness as "nothing to reach"
 * would report an endpoint that exists and bills by the hour as absent.
 *
 * What is left is the case worth having: a value that could name an object and
 * does not. Unset is the AI Gateway route's correct and default state on every
 * target, and the semantic index's on any release logged without one, and a row
 * reading `Not checked` over an empty value promises a verdict that will never
 * arrive.
 *
 * It replaced a test on `agentKey`, which asked who owned the value rather than
 * whether anything was on the other end of it, and so left three orchestrator
 * settings with no object anywhere sitting permanently under `Not checked`.
 */
export function hasRemoteEnd(row: ResourceRow, check?: PreflightCheck): boolean {
  if (check) return true;
  const { resource } = row;
  if (!resource.namesRemoteObject) return false;
  return Boolean(resource.actualFromCheck || row.configured.trim() || row.actual.trim());
}

/**
 * The check that reports on this resource, from either of the two things that
 * can now produce one.
 *
 * `actualFromCheck` names the check the ORCHESTRATOR ran inside the serving
 * endpoint, whose name is the value it demonstrably used. Those stopped
 * arriving when the endpoint retired its dependency report, and twelve of the
 * nineteen resources never named one in the first place, which is why the page
 * that promises to report reachability answered `Not checked` down almost its
 * whole length.
 *
 * The app now asks the workspace itself, and those checks are keyed by the
 * registry id, so the fallback is a lookup on the row's own id rather than a
 * second mapping table that could drift from the registry. The orchestrator's
 * check still wins where both exist: it is the only one of the two that
 * observed what was USED, as opposed to what was configured and can be reached.
 */
export function checkFor(resource: ConnectedResource,
  checksById: ReadonlyMap<string, PreflightCheck>
): PreflightCheck | undefined {
  const named = resource.actualFromCheck ? checksById.get(resource.actualFromCheck) : undefined;
  return named ?? checksById.get(resource.id);
}

export function indexChecks(checks: readonly PreflightCheck[]): Map<string, PreflightCheck> {
  return new Map(checks.map((check) => [check.id, check]));
}

/**
 * Every check either half of the app has, in one list.
 *
 * The orchestrator's report goes last so that it wins a collision in
 * `indexChecks`, on the same reasoning as `checkFor`: where both answered about
 * one resource, only one of them watched it being used.
 */
export function allChecks(payload: SettingsPayload | null,
  reported: readonly PreflightCheck[]
): PreflightCheck[] {
  return [...(payload?.checks ?? []), ...reported];
}

/**
 * Findings grouped by the resource they are about.
 *
 * Findings with no `resourceId` are deployment-wide and are deliberately not
 * in this map: they belong to the page, not to a row, and a caller that wants
 * them asks for them by name.
 */
export function findingsByResource(drift: readonly DriftFinding[]): Map<string, DriftFinding[]> {
  const grouped = new Map<string, DriftFinding[]>();
  for (const finding of drift) {
    if (!finding.resourceId) continue;
    grouped.set(finding.resourceId, [...(grouped.get(finding.resourceId) ?? []), finding]);
  }
  return grouped;
}

/** Findings that are not about a single resource. */
export function deploymentWideFindings(drift: readonly DriftFinding[]): DriftFinding[] {
  return drift.filter((finding) => !finding.resourceId);
}

/**
 * Everything a surface needs to draw one connection, derived once.
 *
 * `disagrees` is the fault this whole surface exists to expose: something
 * measured what the deployment is using, and it is not what it was configured
 * with. It is a strict boolean here rather than the truthy expression the page
 * used to compute inline, because a diagram wants to filter on it.
 */
export interface ConnectionReading {
  resource: ConnectedResource;
  row: ResourceRow;
  check: PreflightCheck | undefined;
  /** Every finding for this resource, pending included. */
  findings: DriftFinding[];
  /**
   * The findings a reader has to act on.
   *
   * Pending is excluded because it says what the row's own Intended banner
   * says, and two statements of one fact read as two problems.
   */
  problems: DriftFinding[];
  status: ConnectionStatus;
  marker: DriftMarker;
  /** How many non-pending findings the marker stands for. */
  driftCount: number;
  /** The value to show, and whether anything measured it. */
  summary: { value: string; measured: boolean };
  disagrees: boolean;
  /** Whether anything out there could be asked about this value. */
  remote: boolean;
}

/**
 * The value to show, including the case where only the probe knows it.
 *
 * `inUseSummary` reads the ROW, which carries what the deployment was
 * configured with. That covers every connection whose value arrives as
 * configuration -- which is all of them but one. The Vector Search endpoint is
 * named by the index rather than by anything given to the app, so its row is
 * empty and the only thing holding its name is the check that asked about it.
 *
 * Measured, not configured: the name came back from the workspace, so it is
 * what is being used rather than what somebody asked for. The fallback cannot
 * fire for a configured resource, because a probe is only built from a
 * configured value in the first place, so the two readings would be the same
 * string.
 */
function connectionSummary(row: ResourceRow,
  check: PreflightCheck | undefined
): { value: string; measured: boolean } {
  const summary = inUseSummary(row);
  if (summary.value) return summary;
  const observed = check?.name?.trim() ?? '';
  return observed ? { value: observed, measured: true } : summary;
}

export function readConnection(input: {
  row: ResourceRow;
  check: PreflightCheck | undefined;
  findings: readonly DriftFinding[];
}): ConnectionReading {
  const { row, check } = input;
  const findings = [...input.findings];
  const findingIds = findings.map((finding) => finding.id);
  // Passed through so the marker can tell a finding that asserts a
  // disagreement from one that asserts nothing could be established. Both
  // arrive on this list; only the first is drift. Additive on purpose -- the
  // shape of the reading below is unchanged, so the Architecture diagram reads
  // exactly the fields it read before, with the marker corrected underneath it.
  const severities = Object.fromEntries(findings.map((finding) => [finding.id, finding.severity]));
  const remote = hasRemoteEnd(row, check);
  return {
    resource: row.resource,
    row,
    check,
    findings,
    problems: findings.filter((finding) => !finding.id.startsWith('pending-')),
    status: connectionStatus({ check, hasRemoteEnd: remote }),
    marker: driftMarker({ findingIds, intended: row.intended, severities }),
    driftCount: driftCount(findingIds, severities),
    summary: connectionSummary(row, check),
    disagrees: Boolean(row.actualObserved && row.configured && row.actual !== row.configured),
    remote,
  };
}

/**
 * Every connection in the payload, in the order the registry declares them.
 *
 * The single entry point both pages use, so neither can index a check or group
 * a finding its own way.
 */
export function readConnections(payload: SettingsPayload | null,
  checks: readonly PreflightCheck[]
): ConnectionReading[] {
  if (!payload) return [];
  const checksById = indexChecks(allChecks(payload, checks));
  const findings = findingsByResource(payload.drift);
  return payload.resources
    .filter((row) => SHOW_NOTEBOOK_DECLARATION_EDITOR || row.resource.id !== 'notebook-declaration')
    .map((row) =>
      readConnection({
        row,
        check: checkFor(row.resource, checksById),
        findings: findings.get(row.resource.id) ?? [],
      })
    );
}

/** The counts for the status line, off the same readings the rows render. */
export function countConnections(readings: readonly ConnectionReading[]) {
  return connectionCounts({
    statuses: readings.map((reading) => reading.status),
    markers: readings.map((reading) => reading.marker),
  });
}

/** One reading by resource id, for a surface that draws a chosen few. */
export function readingsById(readings: readonly ConnectionReading[]): Map<string, ConnectionReading> {
  return new Map(readings.map((reading) => [reading.resource.id, reading]));
}

/**
 * Which section of the list a connection belongs in.
 *
 * `configuration` is the `nothing-to-reach` rows under the name the page gives
 * them. They are not a fifth verdict: they are the values the app both resolves
 * and applies, which have no remote end to report on, and a list that badged
 * them alongside dependencies was printing "Nothing to reach" five times as
 * though it were a check result.
 */
export type ConnectionGroupKey =
  | 'blocked'
  | 'drifted'
  | 'refused'
  | 'unreachable'
  | 'reachable'
  | 'not-checked'
  | 'configuration';

export interface ConnectionGroup {
  key: ConnectionGroupKey;
  /** Said once, here, instead of as a chip repeated down every row. */
  title: string;
  /**
   * How many rows the section holds, where the number is the useful part.
   *
   * Only `not-checked` carries one. The other headers name a verdict a reader
   * acts on and the rows under them are countable in a glance, where "not
   * checked" is the section somebody wants the SIZE of -- it is the extent of
   * what this page does not know. Empty for every other section, because a count
   * beside "Blocked" would read as a second severity.
   */
  aside: string;
  readings: ConnectionReading[];
}

/**
 * The order the sections are drawn in, which is the order a reader needs them.
 *
 * Anything actionable first. Blocked is the only state on this page with a
 * statement attached to it, drift is the only other one that says something is
 * wrong, and everything below them is a report.
 */
const GROUP_ORDER: Array<{ key: ConnectionGroupKey; title: string }> = [
  { key: 'blocked', title: 'Blocked' },
  { key: 'drifted', title: 'Drifted' },
  // Above `reachable` because it is actionable, below the two that assert
  // something is WRONG because a refusal does not: the call stopped at the
  // permission layer, so nothing was established about the object. Its own section
  // rather than a heading shared with `not-checked` -- a permission and a run are
  // different next moves, and one heading over both is the conflation the count
  // line was making.
  { key: 'refused', title: 'Refused' },
  // Beside refused rather than folded in with it, and in the same place the count
  // line puts it, so the section order and the line read the same left to right.
  // A refusal is answered by a permission and an unreachable call by a retry or an
  // escalation, which is two next moves and so two headings.
  { key: 'unreachable', title: 'Unreachable' },
  // Named for what the rows ARE rather than for what the probe did to them.
  // "Checked and reachable" described the last preflight; a reader opening this
  // tab wants the list of live services the app is wired to, which is the same
  // list under a name that says so.
  { key: 'reachable', title: 'Connected resources' },
  { key: 'not-checked', title: 'Not checked' },
  { key: 'configuration', title: 'Configuration' },
];

/**
 * Which section one reading belongs in.
 *
 * Drift outranks reachability, and that is the whole reason this is a function
 * rather than a read of `status`. A warehouse the endpoint reached, running under
 * an id this deployment was not configured with, is `reachable` on the badge and
 * is the most interesting row on the page: filed under "Connected resources"
 * it would be the twelfth green row in a list nobody reads to the end.
 */
export function connectionGroupKey(reading: ConnectionReading): ConnectionGroupKey {
  if (reading.status === 'blocked') return 'blocked';
  if (reading.marker === 'drift') return 'drifted';
  if (reading.status === 'nothing-to-reach') return 'configuration';
  return reading.status;
}

/**
 * The readings, collected into the sections the page draws, empty ones dropped.
 *
 * ONE STATUS PER SECTION HEADER, WHICH IS THE POINT. The list used to be grouped
 * by what a dependency IS -- "Agents and models", "Genie spaces", "Data and
 * compute", "App storage and behaviour", each under a sentence explaining the
 * category -- and every row inside carried its own status chip. So a deployment
 * with one fault drew four headings, four blurbs and nineteen chips, and the
 * blocked row was somewhere in the middle of the third group. Grouping by verdict
 * puts it first and states the verdict once.
 *
 * A section with no rows is not rendered at all, on the same rule as a count of
 * zero: an empty "Blocked" heading is a heading that has to be read to learn
 * nothing is blocked.
 */
export function groupConnections(readings: readonly ConnectionReading[]): ConnectionGroup[] {
  const byKey = new Map<ConnectionGroupKey, ConnectionReading[]>();
  for (const reading of readings) {
    const key = connectionGroupKey(reading);
    byKey.set(key, [...(byKey.get(key) ?? []), reading]);
  }
  return GROUP_ORDER.filter((group) => (byKey.get(group.key) ?? []).length > 0).map((group) => {
    const readings = byKey.get(group.key) ?? [];
    const count = readings.length;
    return {
      key: group.key,
      title: group.title,
      aside:
        group.key === 'not-checked' ? `${count} ${count === 1 ? 'dependency' : 'dependencies'}` : '',
      readings,
    };
  });
}
