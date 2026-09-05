/**
 * What this deployment is connected to, whether it can reach any of it, and
 * what it would take to change each one.
 *
 * This page used to be two. `/sources` reported live dependency checks as seven
 * capability cards, a table matrix and a health card; `/connections` reported
 * the same checks again as resource cards, because the settings route runs the
 * same orchestrator preflight server-side. Identity was on both. Remediation was
 * on both. The two were indistinguishable to the person they were for, who
 * described the settings gear as "just linking to the sources tab", and both
 * were built out of cards carrying roughly one status line each.
 *
 * The spine is now ONE ROW PER CONNECTION. Collapsed, a row is a line: what it
 * is, whether anything reached it, and what it is demonstrably using. Opened, it
 * becomes what used to be a whole card, and only then does it offer a control.
 *
 * The page keeps one rule from before the merge: never show an edit box for a
 * value this app cannot change. Most of what a deployer wants to point at their
 * own workspace, the Genie spaces, the catalog, the warehouse, is baked into the
 * MLflow model artifact at log time, and a form that accepted a new Genie space
 * id and saved it would report success while the orchestrator carried on using
 * the old one. Which affordance a row gets is decided in
 * `shared/deployment-config.ts` rather than here.
 */
import { Fragment, lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useOutletContext } from 'react-router';
import './styles/routes/connections.css';
import { useRole, type AppOutletContext } from './role';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui';
import {
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Calendar,
  Clock,
  ExternalLink,
  GitCommitHorizontal,
  Pencil,
  Save,
  Search,
  Trash2,
  Wrench,
} from 'lucide-react';
// The official product marks, from the one module that pairs a product with its
// artwork. The Lucide glyphs above keep the actions and the generic concepts --
// the carets, pencils, padlocks and copies -- and never stand in for a product.
import { BrandIcon } from './BrandIcon';
// GitHub's own mark is not Databricks artwork and does not live in the brand
// directory. One copy, shared with the login gate. See GithubMark.tsx.
import { GithubMark } from './GithubMark';
// The word, the icon and the pending state, decided once for the whole app.
import { RefreshButton, RefreshControl } from './RefreshControl';
import { CONNECTED_RESOURCES } from '../../shared/deployment-config';
import { IdentityCard } from './IdentityPanel';
import { useDeploymentIdentity } from './identity-panel-state';
import { PiaLoadingLabel } from './PiaLoadingLabel';
import { PiaBusyButtonContent } from './PiaLoader';
import {
  connectionLoadErrorLabel,
  connectionPlaceholderReadings,
  connectionResourceLoadState,
} from './connection-loading';
// The value that is its own verdict, and the affordance that carries the whole
// of it. Both are the design's, and both are shared with the identity card.
import { CopyButton, NOT_SET, StatusBadge, type StatusTone } from './StatusBadge';
// The egress record. This page keeps its own copy of the grant-statement panel,
// so the call has to be made here too or the channel reports from one site and
// not the other.
// Build stamps are shortened consistently away from the markup, and so is the
// reading that decides whether each half of the deployment is working.
import { buildFacts, type BuildArtifact } from './connection-build';
// The one status recipe. Named as a meaning here, painted in astrolabe-tokens.css.
// What this deployment is, as against what it was built from. The two grids the
// Build card draws are decided there, so a row with nothing to say is dropped
// before the markup sees it.
import { deploymentRows, telemetryRows, type BuildRow } from './build-card';
import { UserDrilldownLink } from './UserDrilldownLink';
import { DateBadge, DateRangeBadges } from './DateBadge';
import { NO_APP_FACTS } from '../../shared/app-facts';
import { EntityHighlight, EntityParts, VisitInDatabricks } from './DataEntityLinks';
import { entityRowProps, isRequestedEntity, useRequestedEntity } from './data-entity-state';
import { entityRowId } from './data-entities';
import { type PreflightCheck } from './preflight';
// Refused, unreachable and not-checked-yet are three different next moves, and
// the words for them are decided in one place so a row and the strip counting
// the rows cannot disagree. See shared/check-verdict.ts.
// One mechanism runs the checks for the whole session, and both tabs read it.
import { DeclaredConnectionsCard } from './DeclaredConnectionsCard';
import { ConnectionRemovalStatus } from './ConnectionRemovalStatus';
import {
  DECLARED_TABLES_SECTION_ID,
  RESOURCE_PRODUCT,
  tableReachabilityCopy,
  declaredTableFilterOptions,
  filterDeclaredTables,
} from './connections-view';
import { useSessionChecks } from './session-checks';
import {
  DRIFT_MARKER_LABEL,
  primaryConnectionState,
  resolvedConnectionStateFromLabel,
  truncateHead,
  visibleCounts,
  type ConnectionCounts,
} from './connection-status';
import { ConnectionStateBadge } from './ConnectionStateBadge';
// One cause said once over every check that shares it, and one remedy said once
// over every cause it clears. See connection-causes.ts for why the cause key is
// a verdict, a sentence and a whole remedy rather than something looser.
import {
  affectedLabel,
  causeGroupHeadline,
  groupByCause,
  groupByRemedy,
  sharedLabelPrefix,
  type BlockCause,
  type RemedyBlock,
} from './connection-causes';
// Which of the blocked checks a reader is actually being asked to do something
// about. A refusal over one of the three optional catalog reads is not one, and
// this panel is the last surface that was still presenting it as one. See
// optional-scope-findings.ts.
import {
  OPTIONAL_SCOPES_CHIP,
  OPTIONAL_SCOPES_LABEL,
  isOptionalScopeShortfall,
  optionalScopeNote,
  splitOptionalScopeFindings,
  type OptionalScopeShortfall,
} from './optional-scope-findings';
// Point and click instead of remembering an identifier. Which list a field
// browses, and what a chosen row actually stores, are decided in
// `asset-picker.ts` rather than in either editor below: the same two editors draw
// ten fields between them, and a mapping written at the call site would be
// written twice.
import { AssetPickerField } from './AssetPicker';
import { pickerForField } from './asset-picker';
import { AppSelect } from './AppSelect';
// The derivation itself -- which check belongs to which resource, which
// findings are about it, and what that makes its badge -- is shared with the
// Architecture page, which draws these same connections as a graph. See
// connection-model.ts for why that is one module rather than two readings.
import {
  allChecks,
  deploymentWideFindings,
  groupConnections,
  readConnections,
  readingsById,
  type ConnectionGroupKey,
  type ConnectionEntry,
  type ConnectionReading,
  type DriftSeverity,
  type ResourceRow,
} from './connection-model';
import { connectionResourceView } from './connection-resource-view';
import { AiGatewayConnection } from './AiGatewayConnection';
import { NO_EXPERIMENTS, showsNotebookAgentSync } from './experimental-features';
import { notebookAgentSyncTarget } from './notebook-agent-sync-deep-link';
import {
  DELETE_CONNECTION_LABEL,
  JUST_ADDED_LABEL,
  addedConnectionLabel,
  forgetConnectionDetail,
  isDeclaredTableConnection,
  isDeclaredUnityCatalogConnection,
} from './declared-connection-view';
import { derivedConnectionKey } from './declared-connection-form';
import { normalizedConnectionValue, useDeclaredConnectionController } from './declared-connection-controller';
import { canMutateConnections } from '../../shared/user-roster-contract';
import {
  UnityCatalogScopeExplorer,
  type UnityCatalogExplorerRowState,
  type UnityCatalogExplorerSelection,
  type UnityCatalogScopeType,
} from './UnityCatalogScopeExplorer';
import { LakebaseMigrationPanel } from './LakebaseMigrationPanel';
import { useLakebaseMigrationStatus, type LakebaseMigrationClientState } from './lakebase-migration-status';
import { LakebaseBindingManager } from './LakebaseBindingManager';

const NotebookAgentSyncPane = lazy(() =>
  import('./NotebookAgentSyncPane').then((loaded) => ({ default: loaded.NotebookAgentSyncPane }))
);

/**
 * The tone a section's rows carry, decided by the section they are in.
 *
 * `not-checked` and `configuration` are deliberately `plain`. Nobody looked, or
 * there was nothing to look at, so there is no verdict for a colour to be a
 * second reading of, and a third tint would make the two that mean something
 * harder to tell apart.
 */
const GROUP_TONE: Record<ConnectionGroupKey, StatusTone> = {
  blocked: 'blocked',
  drifted: 'drifted',
  // Amber, the same rung as drift and the same rung the count line gives it. A
  // refusal is the one unsettled state where something happened, and it must not
  // take red: nothing was established about these objects, so a reader must not
  // read them as dependencies that are down.
  refused: 'drifted',
  // Amber as well, on the same rung: nothing was established, so it must not take
  // red, and it is not a state to leave untinted either -- the headline drops its
  // tick while a dependency is unreachable.
  unreachable: 'drifted',
  reachable: 'reachable',
  'not-checked': 'plain',
  configuration: 'plain',
};

/**
 * Which Databricks product each kind of connection belongs to.
 *
 * The MARK for a product is `brand-icons.ts`'s business and only its business;
 * this is the other half of the join, which is a question only this page can
 * answer -- what kind of thing a row points at. Eighteen rows previously drew
 * the nearest Lucide shape to each product, a bot for the agent and a warehouse
 * for the warehouse, because the official artwork was not in the repository. It
 * is now, so they are the real marks.
 *
 * Keyed on `ResourceKind` and exhaustive by type, which is what makes a new kind
 * a compile error here rather than a row that silently draws nothing. Every kind
 * has a mark; the handoff's mapping covers all ten, so no row falls back.
 */
const SEVERITY_ICON: Record<DriftSeverity, typeof CircleAlert> = {
  blocking: CircleAlert,
  warning: CircleAlert,
  pending: Clock,
  unknown: CircleHelp,
  note: CircleHelp,
};

/**
 * One row of the Build and telemetry card, in whichever of the three shapes it is.
 *
 * The shape is decided in `build-card.ts` and not here: a table name, a sentence
 * and a list of tags are three different kinds of thing, and letting the markup
 * choose between them is how a description ended up in the monospace face.
 *
 * Exported for rendering rather than for reuse, for the same reason the rows
 * below it are: a static render of the page runs no effects, so the card is only
 * ever composed with facts in a test.
 */
export function BuildFactRow({ row }: { row: BuildRow }) {
  const wraps =
    row.kind === 'chips' ||
    row.kind === 'date' ||
    (row.kind === 'text' && Boolean(row.dateRange)) ||
    (row.kind === 'badge' && Boolean(row.description));
  return (
    <div className="identity-fact" data-wrap={wraps ? 'true' : undefined}>
      <p className="identity-fact-label">{row.label}</p>
      <div className="identity-fact-value">
        {row.kind === 'badge' ? (
          <>
            <StatusBadge value={row.value} tone={row.tone} title={row.full} testId={`build-${row.key}`} />
            {row.description ? <span className="deployment-inline-description">{row.description}</span> : null}
            {row.copyable ? <CopyButton value={row.full} label={`Copy the ${row.label.toLowerCase()}`} /> : null}
            {/* Opens the thing the row names, which is only ever offered for the
                app's own URL: it is the one value on this card that is a place a
                reader can go. */}
            {row.openable ? (
              <a
                className="deployment-open"
                href={row.full}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${row.full}`}
              >
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : null}
          </>
        ) : null}
        {row.kind === 'text' ? ( // The exact figures where the row shows a shortened one, which today is
          // the telemetry span: two Delta stamps to the millisecond, printed
          // whole, wrapped this row over three lines.
          <p className={`deployment-fact-text${row.dateRange ? ' deployment-fact-dates' : ''}`} title={row.title}>
            <span className="deployment-fact-lead">{row.value}</span>
            {row.dateRange ? <DateRangeBadges value={row.dateRange} /> : null}
            {row.aside ? <span className="deployment-fact-aside">{row.aside}</span> : null}
            {row.identity ? <UserDrilldownLink identity={row.identity} label="by" compact /> : null}
          </p>
        ) : null}
        {row.kind === 'date' ? (
          <div className="deployment-fact-text deployment-date-fact">
            <DateBadge value={row.date} />
            {row.identity ? <UserDrilldownLink identity={row.identity} label="by" compact /> : null}
          </div>
        ) : null}
        {/* A PLACE, NOT A VALUE. These two rows are the only ones on the card
            whose point is to be followed, so they are anchors and they carry
            the mark of whoever owns the destination: the official Databricks
            Apps mark for the workspace the app is running its source from, and
            GitHub's own octocat -- the login gate's, from one module -- for the
            published repository. A reader picks between them by the logo before
            they read the label. */}
        {row.kind === 'link' ? (
          <a
            className="deployment-fact-link"
            href={row.href}
            target="_blank"
            rel="noreferrer noopener"
            title={row.title}
            data-testid={`build-${row.key}`}
          >
            {row.mark === 'apps' ? (
              <BrandIcon product="apps" size={14} className="deployment-fact-mark" />
            ) : (
              <GithubMark className="deployment-fact-mark" />
            )}
            <span className="deployment-fact-link-text">{row.value}</span>
            {/* The same affordance the app endpoint row uses for the one other
                thing on this card a reader can open, so "this leaves the app"
                is said the same way twice rather than two ways. */}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : null}
        {row.kind === 'chips' ? (
          <span className="deployment-tags">
            {row.values.map((value) => (
              <span key={value} className="deployment-tag">
                {value}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One build stamp, kept separate from the dependency status rows below. */
export function BuildStampRow({ artifact }: { artifact: BuildArtifact }) {
  return (
    <div className="identity-fact deployment-source-fact" data-wrap="true">
      <p className="identity-fact-label">{artifact.label}</p>
      <div className="identity-fact-value">
        {/* Eight characters, which is what a reader recognises a commit by, and
            the whole hash on the clipboard: `git show` takes the short one, but a
            paste into a message or a ticket wants the full string. */}
        <StatusBadge
          value={artifact.short || NOT_SET}
          tone={artifact.tone}
          title={artifact.full || NOT_SET}
          testId={`build-${artifact.key}`}
        />
        <span className="deployment-inline-description">{artifact.description}</span>
        {artifact.full ? <CopyButton value={artifact.full} label={`Copy the ${artifact.label} commit`} /> : null}
      </div>
    </div>
  );
}

/**
 * A block that is a heading until somebody wants it.
 *
 * A plain button and a conditional child rather than an animated primitive: the
 * table matrix below is the landing target for `?entity=` deep links, and the
 * highlighted row has to be in the document and scrollable on the first commit
 * after that URL is opened.
 */
function Disclosure({
  id,
  open,
  onToggle,
  summary,
  aside,
  action,
  status,
  controls,
  children,
}: {
  id?: string;
  open: boolean;
  onToggle: () => void;
  summary: string;
  aside?: string;
  action?: React.ReactNode;
  status?: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="connection-block">
      <div className="connection-block-head">
        <div className="connection-block-title-actions">
          <button type="button" className="connection-block-summary" aria-expanded={open} onClick={onToggle}>
            <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
            <span className="connection-block-label">{summary}</span>
            {aside ? <span className="connection-block-aside">{aside}</span> : null}
          </button>
          {action}
          {status}
        </div>
        {controls ? <div className="connection-block-controls">{controls}</div> : null}
      </div>
      {open ? <div className="connection-block-body">{children}</div> : null}
    </section>
  );
}

/**
 * One blocked dependency and the literal statement that unblocks it.
 *
 * The remedy is rendered as selectable text rather than prose about it, because
 * the whole value of this page for a new workspace is that an admin can copy the
 * line out of it.
 */
/**
 * The design's counts line, over ONE population: the rows drawn below it.
 *
 * These five counts used to be taken from two. Reachable, blocked and not-checked
 * came off the CHECK list -- twenty-four of them against this deployment, twelve
 * being individual tables that the list draws as a single "Declared tables" row --
 * while drifted and pending came off the nineteen resource rows. So the line read
 * "24 reachable · 0 blocked · 0 not checked" directly above four rows badged "Not
 * checked" and four badged "Nothing to reach". A summary a reader can disprove by
 * counting the screen is worse than no summary, and this one invited the count by
 * printing the total.
 *
 * "Nothing to reach" is shown only when there is some, and it is shown rather than
 * folded into "not checked" for two reasons: without it the parts do not sum to
 * the number of rows on screen, and "nobody looked" is a different claim from
 * "there is nothing to look at". The row badges keep those apart, so this does.
 *
 * A count of nothing is not RENDERED, which is the stronger form of the rule
 * this line used to keep. It was already true that a zero was not tinted, and
 * that was not enough: the line printed "0 blocked · 0 not checked · 0 drifted ·
 * 0 pending" on a healthy deployment, so four of its six phrases named states
 * the deployment was not in and a reader had to read all four to learn that.
 * Which counts survive is decided in `visibleCounts`, beside the counting, so
 * this component cannot acquire an opinion of its own about it.
 *
 * Each count carries its own word, so the colour is a second reading of
 * something already stated in text rather than the only carrier of it.
 */
export function ConnectionsCounts({ counts }: { counts: ConnectionCounts }) {
  const shown = visibleCounts(counts);
  return (
    <>
      {shown.map((entry, index) => (
        <span key={entry.key}>
          {index > 0 ? ' · ' : ''}
          {/* The figure in mono and the word beside it in DM Sans. The tone is on
              the pair, so a tinted count colours its number and its word
              together and the colour stays a second reading of the word rather
              than of the digits alone. */}
          <span className="connections-count" data-tone={entry.tone}>
            <span className="ast-num">{entry.count}</span> {entry.word}
          </span>
        </span>
      ))}
    </>
  );
}

/**
 * The declared tables, three columns, as the design has them: Table, Status, Detail.
 *
 * The arrival row is SAID as well as tinted. A reader who followed a table name out
 * of an answer lands on twelve near-identical monospace rows with one of them washed
 * blue, and a wash is a decoration until something names it -- the tint and
 * `aria-current` left that fact carried entirely by colour and by a screen reader,
 * so a sighted reader arriving here had to infer why one row looked different. The
 * sentence is PREFIXED to the workspace's own detail rather than replacing it,
 * because what the workspace said about the table is the reason the reader came.
 *
 * Whether a row is the arrival is asked of `isRequestedEntity`, the same predicate
 * `entityRowProps` uses for the tint. Two comparisons would be two chances to
 * disagree about case or trailing space, and disagreeing here means washing one row
 * and captioning another.
 */
interface DeclaredTableFilters {
  query: string;
  catalog: string;
  schema: string;
}

function DeclaredTableControls({
  filters,
  catalogs,
  schemas,
  onChange,
}: {
  filters: DeclaredTableFilters;
  catalogs: readonly string[];
  schemas: readonly string[];
  onChange: (next: DeclaredTableFilters) => void;
}) {
  return (
    <div className="connections-table-query-controls">
      <div className="connections-table-search">
        <Search className="connections-table-search-icon" aria-hidden="true" />
        <Input
          type="search"
          placeholder="Search tables"
          aria-label="Search Unity Catalog tables"
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
        />
      </div>
      {catalogs.length > 0 ? (
        <div className="connections-table-filter">
          <AppSelect
            label="Catalog"
            ariaLabel="Filter tables by catalog"
            value={filters.catalog || 'all'}
            options={[
              { value: 'all', label: 'All catalogs' },
              ...catalogs.map((name) => ({ value: name, label: name })),
            ]}
            onValueChange={(next) => onChange({ ...filters, catalog: next === 'all' ? '' : next, schema: '' })}
            contentClassName="connections-table-filter-menu"
          />
        </div>
      ) : null}
      {schemas.length > 0 ? (
        <div className="connections-table-filter">
          <AppSelect
            label="Schema"
            ariaLabel="Filter tables by schema"
            value={filters.schema || 'all'}
            options={[{ value: 'all', label: 'All schemas' }, ...schemas.map((name) => ({ value: name, label: name }))]}
            onValueChange={(next) => onChange({ ...filters, schema: next === 'all' ? '' : next })}
            contentClassName="connections-table-filter-menu"
          />
        </div>
      ) : null}
    </div>
  );
}

interface DeclaredTableRow {
  check: PreflightCheck;
  connection?: ConnectionEntry;
  pending: boolean;
}

function declaredTableRows(
  tableChecks: readonly PreflightCheck[],
  tableConnections: readonly ConnectionEntry[]
): DeclaredTableRow[] {
  const byName = new Map(
    tableChecks.map((check) => [normalizedConnectionValue(check.name), { check, pending: false }])
  );
  const rows: DeclaredTableRow[] = tableChecks.map((check) => ({ check, pending: false }));
  for (const connection of tableConnections) {
    if (!isDeclaredTableConnection(connection.connection)) continue;
    const key = normalizedConnectionValue(connection.connection.value);
    const matched = byName.get(key);
    if (matched) {
      const row = rows.find((candidate) => candidate.check === matched.check);
      if (row) row.connection = connection;
      continue;
    }
    const check: PreflightCheck = {
      id: `declared:${connection.connection.id}`,
      kind: 'table',
      name: connection.connection.value,
      label: connection.connection.label || connection.connection.value,
      status: 'unverified',
      detail: 'Connection will be checked on refresh.',
      checked_with: '',
      duration_ms: 0,
      error: '',
      remedy: null,
    };
    rows.push({ check, connection, pending: connection.connection.state === 'declared' });
    byName.set(key, { check, pending: true });
  }
  return rows.sort((a, b) => {
    const aUser = a.connection?.connection.origin === 'app';
    const bUser = b.connection?.connection.origin === 'app';
    if (aUser !== bUser) return aUser ? -1 : 1;
    if (aUser && bUser) {
      return (b.connection?.connection.createdAt ?? '').localeCompare(a.connection?.connection.createdAt ?? '');
    }
    return 0;
  });
}

// eslint-disable-next-line react-refresh/only-export-components -- pure summary shared with focused render tests
export function unityCatalogScopeSummary(
  _connections: readonly ConnectionEntry[],
  tableRows: readonly DeclaredTableRow[]
): string {
  const tables = tableRows.length;
  if (tables === 0) return '';
  const connected = tableRows.filter((row) => row.check.status === 'ok' && !row.pending).length;
  const disconnected = tableRows.filter((row) => row.check.status !== 'ok' && !row.pending).length;
  const parts = [`${tables} ${tables === 1 ? 'table declared' : 'tables declared'}`];
  if (connected > 0) parts.push(`${connected} Connected`);
  if (disconnected > 0) parts.push(`${disconnected} Disconnected`);
  return parts.join(' · ');
}

function ConnectionAddedMetadata({ entry }: { entry: ConnectionEntry | undefined }) {
  if (!entry || entry.connection.origin !== 'app') return null;
  const addedBy = entry.connection.createdBy?.trim();
  const addedAt = entry.connection.createdAt?.trim();
  const parsed = addedAt ? new Date(addedAt) : null;
  const validDate = parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
  return (
    <span className="connections-scope-metadata">
      {addedBy ? (
        <UserDrilldownLink
          identity={addedBy}
          label="Added by"
          compact
          className="connections-scope-user"
          showArrow
          canOpen
        />
      ) : null}
      {validDate && addedAt ? (
        <Badge variant="outline" className="connections-scope-date" title={`Added ${validDate.toLocaleString()}`}>
          <Calendar aria-hidden="true" />
          <time dateTime={addedAt}>
            {validDate.toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
        </Badge>
      ) : null}
    </span>
  );
}

export function DeclaredTablesTable({
  tableChecks,
  scopeChecks = [],
  tableConnections = [],
  requestedEntity,
  checkedAt = '',
  controlledFilters,
  onFiltersChange,
  showToolbar = true,
  management,
}: {
  tableChecks: readonly PreflightCheck[];
  scopeChecks?: readonly PreflightCheck[];
  tableConnections?: readonly ConnectionEntry[];
  requestedEntity: string;
  checkedAt?: string;
  controlledFilters?: DeclaredTableFilters;
  onFiltersChange?: (next: DeclaredTableFilters) => void;
  showToolbar?: boolean;
  management?: {
    busy: boolean;
    confirming: string;
    justAdded: string;
    rowError: { id: string; detail: string } | null;
    onConfirm: (id: string) => void;
    onCancel: () => void;
    onRemove: (entry: ConnectionEntry) => void;
  };
}) {
  const [localFilters, setLocalFilters] = useState<DeclaredTableFilters>({ query: '', catalog: '', schema: '' });
  const filters = controlledFilters ?? localFilters;
  const changeFilters = onFiltersChange ?? setLocalFilters;
  const rows = useMemo(() => declaredTableRows(tableChecks, tableConnections), [tableChecks, tableConnections]);
  const checks = useMemo(() => rows.map((row) => row.check), [rows]);
  const { catalogs, schemas } = useMemo(
    () => declaredTableFilterOptions(checks, filters.catalog),
    [checks, filters.catalog]
  );
  const visible = useMemo(() => filterDeclaredTables(checks, filters), [checks, filters]);
  const rowsById = new Map(rows.map((row) => [row.check.id, row]));
  const nonTableConnections = useMemo(() => {
    const seen = new Set<string>();
    return tableConnections
      .filter(
        (entry) =>
          entry.connection.state === 'declared' &&
          (entry.connection.resourceType === 'catalog' ||
            entry.connection.resourceType === 'schema' ||
            (entry.connection.resourceType === 'table' && entry.connection.origin === 'app'))
      )
      .sort((a, b) => {
        const aUser = a.connection.origin === 'app';
        const bUser = b.connection.origin === 'app';
        if (aUser !== bUser) return aUser ? -1 : 1;
        return aUser ? (b.connection.createdAt ?? '').localeCompare(a.connection.createdAt ?? '') : 0;
      })
      .filter((entry) => {
        const key = `${entry.connection.resourceType}:${normalizedConnectionValue(entry.connection.value)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const parts = entry.connection.value.split('.');
        const catalog = parts[0] ?? '';
        const schema = parts[1] ?? '';
        return (
          (!filters.query ||
            entry.connection.value.toLocaleLowerCase().includes(filters.query.trim().toLocaleLowerCase())) &&
          (!filters.catalog || catalog === filters.catalog) &&
          (!filters.schema || schema === filters.schema)
        );
      });
  }, [filters.catalog, filters.query, filters.schema, tableConnections]);

  return (
    <div className="connections-table-wrap">
      {showToolbar ? (
        <div className="connections-table-toolbar">
          <DeclaredTableControls filters={filters} catalogs={catalogs} schemas={schemas} onChange={changeFilters} />
        </div>
      ) : null}
      <Table className="connections-table">
        <TableHeader>
          <TableRow>
            <TableHead>Asset</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Detail</TableHead>
            {management ? <TableHead className="connections-table-actions-head">Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {nonTableConnections.map((entry) => {
            const type =
              entry.connection.resourceType === 'catalog'
                ? 'Catalog'
                : entry.connection.resourceType === 'schema'
                  ? 'Schema'
                  : entry.connection.note === 'asset-type:view'
                    ? 'View'
                    : 'Table';
            const tableRow =
              entry.connection.resourceType === 'table'
                ? rows.find((row) => row.connection?.connection.id === entry.connection.id)
                : undefined;
            const scopeCheck =
              entry.connection.resourceType === 'table'
                ? tableRow?.check
                : scopeChecks.find(
                    (check) =>
                      check.kind === entry.connection.resourceType &&
                      normalizedConnectionValue(check.name) === normalizedConnectionValue(entry.connection.value)
                  );
            const pending =
              Boolean(tableRow?.pending) ||
              Boolean(scopeCheck?.status === 'unverified' && (!scopeCheck.stopped || scopeCheck.stopped === 'unasked'));
            const connected = scopeCheck ? scopeCheck.status === 'ok' : true;
            const connectionState = connected ? 'connected' : 'disconnected';
            const confirmOpen = management?.confirming === entry.connection.id;
            return (
              <Fragment key={entry.connection.id}>
                <TableRow id={`declared-table-row-${entry.connection.id}`} tabIndex={-1}>
                  <TableCell className="connections-table-name">
                    <span className="connections-table-name-stack">
                      <ConnectionEntityName name={entry.connection.value} />
                      <span className="connections-table-scope-state">
                        <Badge variant="outline" className="connections-scope-type">
                          {type}
                        </Badge>
                        {entry.connection.origin === 'app'
                          ? 'In scope · added in Player Insights Agent'
                          : 'In scope · managed by deployment'}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    {pending ? (
                      <PiaLoadingLabel
                        as="span"
                        seat="status"
                        tone="light"
                        announce={false}
                        className="connections-table-status-loader"
                        label={`Checking ${entry.connection.label || entry.connection.value}`}
                      />
                    ) : (
                      <ConnectionStateBadge state={connectionState} subject={entry.connection.value} />
                    )}
                  </TableCell>
                  <TableCell className="connections-table-detail">
                    {tableRow
                      ? pending
                        ? 'Connection check pending'
                        : tableReachabilityCopy(tableRow.check, checkedAt).row
                      : scopeCheck?.detail}
                    <ConnectionAddedMetadata entry={entry} />
                    {management?.justAdded === entry.connection.id ? (
                      <span className="plane-row-new">{JUST_ADDED_LABEL}</span>
                    ) : null}
                  </TableCell>
                  {management ? (
                    <TableCell className="connections-table-actions">
                      {entry.connection.origin === 'app' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={management.busy}
                          aria-label={`${DELETE_CONNECTION_LABEL}: ${entry.connection.value}`}
                          onClick={() => management.onConfirm(entry.connection.id)}
                        >
                          <Trash2 aria-hidden="true" />
                          Delete
                        </Button>
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
                {entry.connection.origin === 'app' && management && confirmOpen ? (
                  <TableRow className="connections-table-confirm-row">
                    <TableCell colSpan={4}>
                      <div
                        className="plane-confirm"
                        role="group"
                        aria-label={`${DELETE_CONNECTION_LABEL}: ${entry.connection.value}`}
                      >
                        <span className="plane-confirm-headline">
                          Delete this Unity Catalog connection permanently?
                        </span>
                        <span className="plane-confirm-detail">{forgetConnectionDetail(entry.connection.origin)}</span>
                        <span className="plane-confirm-actions">
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={management.busy}
                            aria-busy={management.busy || undefined}
                            onClick={() => management.onRemove(entry)}
                          >
                            <PiaBusyButtonContent
                              busy={management.busy}
                              label={DELETE_CONNECTION_LABEL}
                              busyLabel="Deleting"
                              icon={<Trash2 className="size-4" aria-hidden="true" />}
                            />
                          </Button>
                          <Button variant="outline" size="sm" disabled={management.busy} onClick={management.onCancel}>
                            Keep
                          </Button>
                        </span>
                        {management.rowError?.id === entry.connection.id ? (
                          <span className="plane-error" role="alert">
                            {management.rowError.detail}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
          {visible
            .filter((check) => rowsById.get(check.id)?.connection?.connection.origin !== 'app')
            .map((check) => {
              const declared = rowsById.get(check.id);
              const connection = declared?.connection;
              const confirmOpen = connection && management?.confirming === connection.connection.id;
              // One reading, used for the cell and its hover. Two calls were two
              // chances for a decoy count in the probe text to land on one surface
              // and the workspace's count on the other.
              const reachability = tableReachabilityCopy(check, checkedAt);
              return (
                <Fragment key={check.id}>
                  <TableRow
                    {...entityRowProps(check.name, requestedEntity)}
                    id={connection ? `declared-table-row-${connection.connection.id}` : undefined}
                    tabIndex={connection ? -1 : undefined}
                  >
                    {/* THE MARK LEADS THE NAME, per the ask, and it is the icon-only link
                  rather than the phrase: twelve rows would otherwise carry twelve
                  copies of "Open in Databricks" against 40-character table names in
                  a column that has to hold both. It renders nothing at all when the
                  app was given no workspace host, which is a supported deployment
                  and the reason this is not a disabled-looking control. */}
                    <TableCell className="connections-table-name">
                      <VisitInDatabricks name={check.name} />
                      <span className="connections-table-name-stack">
                        <ConnectionEntityName name={check.name} />
                        <span className="connections-table-scope-state">
                          <Badge variant="outline" className="connections-scope-type">
                            {connection?.connection.note === 'asset-type:view' ? 'View' : 'Table'}
                          </Badge>
                          {connection?.connection.origin === 'app'
                            ? 'In scope · added in Player Insights Agent'
                            : 'In scope · managed by deployment'}
                        </span>
                      </span>
                    </TableCell>
                    {/* THE WORD, NOT THE STATUS. Every row here read `Not checked`
                beside a Detail of `HTTP 403`, which contradicts itself on one
                line: a call the workspace refused was made. `checkVerdict`
                separates a refusal from a broken call and from a probe nobody
                ran, and the strip above this table counts through the same
                function so the two cannot disagree. */}
                    <TableCell>
                      {declared?.pending ? (
                        <PiaLoadingLabel
                          as="span"
                          seat="status"
                          tone="light"
                          announce={false}
                          className="connections-table-status-loader"
                          label={`Checking ${check.label || check.name}`}
                        />
                      ) : (
                        <ConnectionStateBadge
                          state={check.status === 'ok' ? 'connected' : 'disconnected'}
                          subject={check.label || check.name}
                        />
                      )}
                    </TableCell>
                    {/* A STATUS, NOT AN ESSAY. This cell used to print the check's whole
                detail, and on this deployment one missing OAuth scope gives all
                twelve of these rows the same three-sentence diagnosis: opening
                the section meant reading it twelve more times. The first
                sentence is the part that is about THIS table, which is what the
                workspace said about it or the code it answered with. The
                reasoning is stated once, on the group in What to fix, and the
                whole sentence is still here in a title. */}
                    <TableCell className="connections-table-detail" title={reachability.title}>
                      {isRequestedEntity(check.name, requestedEntity) ? (
                        <span className="connections-table-arrival">Linked from the answer you followed here. </span>
                      ) : null}
                      {declared?.pending ? 'Connection check pending' : reachability.row}
                      <ConnectionAddedMetadata entry={connection} />
                      {connection && management?.justAdded === connection.connection.id ? (
                        <span className="plane-row-new">{JUST_ADDED_LABEL}</span>
                      ) : null}
                    </TableCell>
                    {management ? (
                      <TableCell className="connections-table-actions">
                        {connection?.connection.origin === 'app' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={management.busy}
                            aria-label={`${DELETE_CONNECTION_LABEL}: ${check.name}`}
                            onClick={() => management.onConfirm(connection.connection.id)}
                          >
                            <Trash2 aria-hidden="true" />
                            Delete
                          </Button>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                  {connection?.connection.origin === 'app' && management && confirmOpen ? (
                    <TableRow className="connections-table-confirm-row">
                      <TableCell colSpan={4}>
                        <div
                          className="plane-confirm"
                          role="group"
                          aria-label={`${DELETE_CONNECTION_LABEL}: ${check.name}`}
                        >
                          <span className="plane-confirm-headline">Delete this table connection permanently?</span>
                          <span className="plane-confirm-detail">
                            {forgetConnectionDetail(connection.connection.origin)}
                          </span>
                          <span className="plane-confirm-actions">
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={management.busy}
                              aria-busy={management.busy || undefined}
                              onClick={() => management.onRemove(connection)}
                            >
                              <PiaBusyButtonContent
                                busy={management.busy}
                                label={DELETE_CONNECTION_LABEL}
                                busyLabel="Deleting"
                                icon={<Trash2 className="size-4" aria-hidden="true" />}
                              />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={management.busy}
                              onClick={management.onCancel}
                            >
                              Keep
                            </Button>
                          </span>
                          {management.rowError?.id === connection.connection.id ? (
                            <span className="plane-error" role="alert">
                              {management.rowError.detail}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
        </TableBody>
      </Table>
      {visible.length === 0 && nonTableConnections.length === 0 ? (
        <p className="connections-table-empty">
          {checks.length === 0
            ? 'No tables or views are declared in the current scope.'
            : 'No tables match these filters.'}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A three-part Unity Catalog name in the same vocabulary as an entity in an
 * answer.
 *
 * THE DOTS STAY OUTSIDE THE TOKENS. The Appearance pane owns a foreground and
 * background for catalog, schema and table separately, and putting the whole
 * name in one token would throw two of those choices away. Keeping each literal
 * segment in the shared `.entity-*` classes also means a saved palette reaches
 * this diagnostics table on the same frame as Ask and Run Explorer.
 *
 * THE LAST SEGMENT IS THE SCANNING ANCHOR. Catalog and schema disambiguate the
 * object, but the table is the part that changes down this list. Its class gives
 * it real weight without a relative `<strong>` that could compound inside a
 * weighted table cell.
 */
export function ConnectionEntityName({ name }: { name: string }) {
  return (
    <span className="connections-entity-name" title={name}>
      <EntityParts text={name} entity={name} />
    </span>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- pure parser shared with focused render tests
export function declaredTableNames(configured: string): string[] {
  return [
    ...new Set(
      configured
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ];
}

/** One complete, stable inventory for both the resource row and detail table. */
// eslint-disable-next-line react-refresh/only-export-components -- pure inventory helper shared with focused render tests
export function canonicalDeclaredTableNames(configured: string, checks: readonly PreflightCheck[]): string[] {
  const names = declaredTableNames(configured);
  for (const check of checks) {
    if (check.kind !== 'table') continue;
    const name = check.name.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function DeclaredTableList({ configured }: { configured: string }) {
  const names = declaredTableNames(configured);
  return (
    <div className="declared-table-list">
      <ul>
        {names.map((name) => (
          <li key={name}>
            <VisitInDatabricks name={name} />
            <ConnectionEntityName name={name} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- pure exact-scope lookup shared with focused tests
export function unityCatalogAssetScopeState(
  connections: readonly ConnectionEntry[],
  managedTableNames: readonly string[],
  resourceType: UnityCatalogScopeType,
  value: string
): UnityCatalogExplorerRowState {
  const normalized = normalizedConnectionValue(value);
  const stored = connections.find(
    (entry) =>
      entry.connection.state === 'declared' &&
      entry.connection.resourceType === resourceType &&
      normalizedConnectionValue(entry.connection.value) === normalized
  );
  if (stored) {
    return {
      label: stored.connection.origin === 'app' ? 'In scope' : 'In scope · managed by deployment',
      selectable: false,
    };
  }
  if (resourceType === 'table' && managedTableNames.some((name) => normalizedConnectionValue(name) === normalized)) {
    return { label: 'In scope · managed by deployment', selectable: false };
  }
  return { label: 'Available', selectable: true };
}

export function DeclaredTablesSection({
  tableChecks,
  scopeChecks = [],
  tableConnections = [],
  requestedEntity,
  checkedAt = '',
  readState = 'ready',
  storeAvailable = true,
  allowMutations = false,
  onChanged = () => {},
}: {
  tableChecks: readonly PreflightCheck[];
  scopeChecks?: readonly PreflightCheck[];
  tableConnections?: ConnectionEntry[];
  requestedEntity: string;
  checkedAt?: string;
  readState?: 'loading' | 'ready' | 'unavailable' | 'not-connected';
  storeAvailable?: boolean;
  allowMutations?: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [filters, setFilters] = useState<DeclaredTableFilters>({ query: '', catalog: '', schema: '' });
  const formId = useId();
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const explorerId = `${formId}-explorer`;
  const controller = useDeclaredConnectionController({ entries: tableConnections, onChanged });
  const managedRows = useMemo(
    () => declaredTableRows(tableChecks, controller.listed),
    [tableChecks, controller.listed]
  );
  const managedTableNames = useMemo(() => managedRows.map((row) => row.check.name), [managedRows]);
  const managedChecks = useMemo(() => managedRows.map((row) => row.check), [managedRows]);
  const { catalogs, schemas } = useMemo(
    () => declaredTableFilterOptions(managedChecks, filters.catalog),
    [managedChecks, filters.catalog]
  );

  useEffect(() => {
    if (!controller.justAdded || adding) return;
    const row = document.getElementById(`declared-table-row-${controller.justAdded}`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [adding, controller.justAdded]);

  async function addUnityCatalogConnections(selections: readonly UnityCatalogExplorerSelection[]) {
    const ids = controller.listed.map((entry) => entry.connection.id);
    const inputs = selections.map((selection) => {
      const id = derivedConnectionKey(selection.resourceType, selection.value, ids);
      ids.push(id);
      return {
        id,
        label: addedConnectionLabel(selection.value, selection.label),
        kind: 'unity-catalog',
        resourceType: selection.resourceType,
        value: selection.value,
        note: selection.assetType ? `asset-type:${selection.assetType}` : '',
      };
    });
    const result = await controller.addBatch(inputs, 'One of those assets is already in the Unity Catalog scope.');
    if (!result.ok) return result;
    setAdding(false);
    return { ok: true, detail: '' };
  }

  function scopeState(resourceType: UnityCatalogScopeType, value: string): UnityCatalogExplorerRowState {
    return unityCatalogAssetScopeState(controller.listed, managedTableNames, resourceType, value);
  }
  const declaredExplorerAssets: UnityCatalogExplorerSelection[] = controller.listed
    .filter(
      (entry) =>
        entry.connection.state === 'declared' &&
        (entry.connection.resourceType === 'catalog' ||
          entry.connection.resourceType === 'schema' ||
          entry.connection.resourceType === 'table')
    )
    .map((entry) => ({
      resourceType: entry.connection.resourceType as UnityCatalogScopeType,
      value: entry.connection.value,
      label: entry.connection.label || entry.connection.value.split('.').at(-1) || entry.connection.value,
      assetType:
        entry.connection.resourceType === 'table'
          ? entry.connection.note === 'asset-type:view'
            ? ('view' as const)
            : entry.connection.note === 'asset-type:table'
              ? ('table' as const)
              : undefined
          : undefined,
    }));
  for (const value of managedTableNames) {
    if (
      !declaredExplorerAssets.some(
        (asset) =>
          asset.resourceType === 'table' && normalizedConnectionValue(asset.value) === normalizedConnectionValue(value)
      )
    ) {
      declaredExplorerAssets.push({ resourceType: 'table', value, label: value.split('.').at(-1) || value });
    }
  }

  const addAction =
    allowMutations && storeAvailable ? (
      <Button
        ref={addButtonRef}
        size="sm"
        className="connections-add-uc"
        aria-expanded={adding}
        aria-controls={explorerId}
        onClick={() => {
          setOpen(true);
          setAdding(true);
        }}
      >
        Add asset
      </Button>
    ) : null;

  return (
    <Disclosure
      id={DECLARED_TABLES_SECTION_ID}
      open={open}
      onToggle={() => setOpen((was) => !was)}
      summary="Unity Catalog scope"
      action={readState === 'ready' ? addAction : null}
      status={readState === 'ready' ? <ConnectionRemovalStatus notice={controller.removalNotice} /> : null}
      controls={
        readState === 'ready' ? (
          <DeclaredTableControls filters={filters} catalogs={catalogs} schemas={schemas} onChange={setFilters} />
        ) : null
      }
    >
      {readState === 'loading' ? (
        <PiaLoadingLabel
          seat="compact"
          label="Loading Unity Catalog scope"
          className="connections-primary-loader-row"
        />
      ) : null}
      {readState === 'unavailable' ? (
        <p className="connections-table-empty" role="alert">
          The Unity Catalog scope could not be loaded. Refresh to try again; no configured assets were removed.
        </p>
      ) : null}
      {readState === 'not-connected' ? (
        <p className="connections-table-empty">
          This app release did not provide its configured Unity Catalog scope. No configured assets were removed.
        </p>
      ) : null}
      {readState === 'ready' && adding ? (
        <UnityCatalogScopeExplorer
          dialogId={explorerId}
          busy={controller.busy}
          declared={declaredExplorerAssets}
          scopeState={scopeState}
          onSave={addUnityCatalogConnections}
          onClose={() => {
            setAdding(false);
          }}
        />
      ) : null}
      {readState === 'ready' && !storeAvailable && allowMutations ? (
        <span className="plane-error">
          The connection store is not answering, so Unity Catalog resources cannot change.
        </span>
      ) : null}
      {readState === 'ready' ? (
        <DeclaredTablesTable
          tableChecks={tableChecks}
          scopeChecks={scopeChecks}
          tableConnections={controller.listed}
          requestedEntity={requestedEntity}
          checkedAt={checkedAt}
          controlledFilters={filters}
          onFiltersChange={setFilters}
          showToolbar={false}
          management={
            allowMutations && storeAvailable
              ? {
                  busy: controller.busy,
                  confirming: controller.confirming,
                  justAdded: controller.justAdded,
                  rowError: controller.rowError,
                  onConfirm: (id) => {
                    controller.setRowError(null);
                    controller.setConfirming(id);
                  },
                  onCancel: () => controller.setConfirming(''),
                  onRemove: (entry) => void controller.remove(entry),
                }
              : undefined
          }
        />
      ) : null}
    </Disclosure>
  );
}

/** Concise table-specific reachability, without repeating the probing identity. */
/**
 * ONE CAUSE inside a block: what it is, and what it alone says.
 *
 * The chip and the sentence are the cause's own, because two causes in one block
 * fail for genuinely different reasons -- four API families, four permissions --
 * and printing one sentence over all of them would assert a permission over
 * objects that were refused over another. What they agree on is not here; it is
 * said once by the block (DECISIONS.md D10).
 */
function FixCause({ cause }: { cause: BlockCause }) {
  const many = cause.checks.length > 1;
  // The catalog and schema every member shares, lifted out of the list so the
  // twelve entries carry the part that differs. Empty for a group of one, and
  // for a group whose labels share nothing.
  const prefix = sharedLabelPrefix(cause.checks.map((affected) => affected.label));
  return (
    <div className="connections-fix-cause" data-affected={cause.checks.length}>
      <div className="connections-fix-problem-head">
        <span className="connections-fix-problem-label">{causeGroupHeadline(cause)}</span>
        {/* ONE CHIP FOR THE CAUSE, which is the design's rule and is also the
            honest reading: every check in a cause shares its verdict, because
            the verdict is part of what collects them. A chip repeated down
            twelve rows was twelve statements of one fact.

            The word is the verdict rather than the status, so a refusal does not
            read "Not checked" over a call the workspace answered. */}
        <ConnectionStateBadge state="disconnected" subject={causeGroupHeadline(cause)} />
        {/* ON THE SAME LINE AS THE OBJECT IT IS ABOUT, which is the whole of
            what a reader wants from a finding: what, and why. It was a
            paragraph of its own under the head, so every cause took two lines
            and a panel of four took eight before it said anything a reader
            could act on. Sam's word for the result was "clunky".

            Only what the block does not already say. Usually one sentence,
            naming the permission this cause turns on; empty when the block
            holds a single cause, because then everything it says is shared and
            is stated once below. */}
        {cause.own ? <span className="connections-fix-problem-cause">{cause.own}</span> : null}
      </div>
      {/* The objects this cause is holding up, compactly, so a reader can see
          "one permission, twelve tables" without scrolling through twelve copies
          of the explanation to count them. */}
      {many ? (
        <div className="connections-fix-affected">
          <p className="connections-fix-affected-label">
            {prefix ? (
              <>
                Affected, in <code>{prefix}</code>
              </>
            ) : (
              <>Affected</>
            )}
          </p>
          <ul>
            {cause.checks.map((affected) => (
              <li key={affected.id} title={affected.label}>
                {affectedLabel(affected.label, prefix)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ONE REMEDY, STATED ONCE, over every cause it clears.
 *
 * WHAT THIS BLOCK USED TO BE. It was one block per failing item, and on this
 * deployment a single stale sign-in refuses four API families at once. So the
 * panel printed the same three-line instruction about private browsing windows
 * four times over, plus the same sentence about signing out of Databricks, and a
 * reader crossed roughly twenty lines of identical advice to learn one thing:
 * that there is one move, and it clears all of it. Which the page never actually
 * said. Before that it was worse -- one block per CHECK, so twelve tables meant
 * twelve copies.
 *
 * Now the remedy is the block and the causes are rows in it. The sentences every
 * cause shares are lifted above them and said once; each cause keeps the one
 * sentence that is about it.
 *
 * The grouping itself is in `connection-causes.ts`, deliberately away from the
 * markup, so which checks belong together is assertable without composing a
 * screen and the page cannot grow a second reading of it. A block of one cause
 * renders what a single check rendered before: the label, the chip, the sentence
 * and the remedy.
 *
 * Exported for rendering, not for reuse: nothing else on the app composes one.
 * A page render under `renderToStaticMarkup` runs no effects, so
 * `ConnectionsPage` itself only ever composes its empty state in a test and this
 * panel is unreachable from there. The alternative was asserting the panel's
 * source text, and this repository has twice shipped a wrong screen past exactly
 * that kind of assertion -- including a source row whose separator was missing
 * while every claim about the file was true.
 */
export function PreflightRemedyBlock({ block }: { block: RemedyBlock }) {
  const headline = causeGroupHeadline(block.causes[0]);
  return (
    <div className="connections-fix-problem" data-causes={block.causes.length}>
      <div className="connections-fix-causes">
        {block.causes.map((cause) => (
          <FixCause key={cause.key} cause={cause} />
        ))}
      </div>
      {/* WHAT THEY ALL SAY, ONCE, under the list of what they are. Below the
          causes rather than above them because a reader arriving at this panel
          wants to know which objects are affected before they read why; four
          shared sentences at the top pushed the object names off the first
          screen. */}
      {/* Small and grey, which is a change of rank rather than of content. What
          these sentences carry is the caveat, not the finding: that a refusal
          stopped before the object, so nothing was established about whether
          the reader can reach it, and that it is therefore not a grant they are
          missing. That has to stay on the page, and it must not outweigh the
          line naming the object or the line saying what to do. */}
      {block.shared ? (
        <p className="connections-fix-problem-detail connections-fix-problem-shared">{block.shared}</p>
      ) : null}
      {block.remedy ? (
        <>
          {/* A `ui` remedy is the reader's own move in their own browser, and
              setting it as code is what made forty lines of shell the answer to
              a stale sign-in. A private window is not something anyone pastes
              into a terminal, and a `<pre>` around it sends somebody looking
              for one. Everything a workspace runs still gets the code block:
              a statement set as prose is a statement somebody retypes, and
              retyping a backtick-quoted principal is where that goes wrong. */}
          {block.remedy.kind === 'ui' ? (
            <p className="connections-fix-problem-do">{block.remedy.statement}</p>
          ) : (
            <pre className="connections-code" aria-label={`Fix for ${headline}`}>
              {block.remedy.statement}
            </pre>
          )}
          {/* THE ONE LINE THE STATEMENT CANNOT CARRY, and only where there is
              one. This is what is left of the "Why this is the fix" fold: the
              fold came off for reading as narrative, the server went on
              generating the paragraph, and it reached no screen, so a blocked row
              carried an instruction and no reasoning at all. Almost every remedy
              now says nothing here, because almost every statement is complete on
              its own.

              Inline and unwrapped on purpose. Not a disclosure, because a reader
              who has to open something to find out the grant they just ran was
              not sufficient will not open it. Not a heading, because one sentence
              under a heading is two lines to carry one. */}
          {block.remedy.guidance ? <p className="connections-fix-problem-guidance">{block.remedy.guidance}</p> : null}
          {/* Where to run it and WHO can, kept whole. A statement somebody
              cannot place is a statement they cannot run, and this line is the
              only thing on the page that says which surface it belongs to.

              Who could run it was the missing half, and it was missing from the
              page entirely once the panel's lead paragraph turned out to be
              wrong about it. A reader holding a GRANT they lack the authority to
              execute has been given a task rather than a fix, and the two
              authorities differ: a Unity Catalog grant needs the metastore admin
              or the object's owner, and a workspace object's permissions need
              somebody who can manage that object. */}
          {/* `run_by` overrides both defaults, and the case it exists for is
              the one where both are wrong: a scope the app never declared is
              fixed in this repository and by a restart, so sending the reader
              to a metastore admin or an object owner is sending them to
              somebody with nothing to do. */}
          {block.remedy.kind === 'ui' ? null : (
            <p className="connections-fix-problem-who">
              {block.remedy.run_by ||
                (block.remedy.kind === 'sql'
                  ? 'Run in a SQL editor as a metastore admin or the object\u2019s owner'
                  : 'Run with the Databricks CLI as a workspace admin, or as someone who can manage this object')}
            </p>
          )}
        </>
      ) : (
        // KEPT, AND SAID ONCE. This is a real remedy -- it names the two things
        // that would clear the fault -- and it used to be repeated under every
        // cause that had no statement. One block collects all of them, so it is
        // stated here and phrased short.
        <p className="connections-fix-problem-note">
          {block.causes.length > 1
            ? 'No statement can fix these. They need the dependency to exist, or the agent redeployed with it declared.'
            : 'No statement can fix this one. It needs the dependency to exist, or the agent redeployed with it declared.'}
        </p>
      )}
    </div>
  );
}

/**
 * One check's block, which is a block of one cause of one check.
 *
 * Kept as the way a single blocked check is drawn, so the case a reader meets on
 * a deployment with one fault is composed by the same code as the case with
 * twelve. A separate single-check renderer is how the two came apart the last
 * time this panel was rebuilt.
 */
export function PreflightRemedyRow({ check }: { check: PreflightCheck }) {
  return <PreflightRemedyBlock block={groupByRemedy(groupByCause([check]))[0]} />;
}

/**
 * The optional catalog permissions, once, neutrally, and OUTSIDE "What to fix".
 *
 * WHAT IT REPLACES. Three of the four blocks in that panel were these: a block
 * for the catalog, one for the schema, and one collecting twelve tables with
 * their twelve names listed under it. Each carried a full diagnosis and each was
 * headed by a chip, inside a red-edged section titled "What to fix", for three
 * permissions this app records as optional and no ask needs. A reader was being
 * asked to go and repair something the app had already decided it can do without.
 *
 * ONE LINE, and the shape of it follows the login gate and the Identity card
 * rather than inventing a fourth: the same label those two use for these same
 * names, the names themselves as values, and the NEUTRAL pill rather than the
 * red one. What is deliberately not borrowed is the gate's word "Not granted",
 * which those surfaces earn by reading the token's own scope list and this one
 * does not; see {@link OPTIONAL_SCOPES_CHIP}.
 *
 * The affected objects are not listed. They are the declared tables, and every
 * one of them has a row of its own in the Unity Catalog tables section below
 * with the workspace's own words on it. Listing twelve names here as well is
 * what the panel was doing, and it is what a reader called clunky.
 */
export function OptionalScopeLine({ shortfall }: { shortfall: OptionalScopeShortfall }) {
  if (shortfall.checks.length === 0) return null;
  return (
    <div className="connections-optional-scopes" data-testid="connections-optional-scopes">
      <p className="connections-optional-scopes-head">
        <span className="connections-optional-scopes-label">{OPTIONAL_SCOPES_LABEL}</span>
        {shortfall.scopes.map((scope) => (
          <code key={scope}>{scope}</code>
        ))}
        <span className="ast-pill ast-pill--neutral">{OPTIONAL_SCOPES_CHIP}</span>
      </p>
      <p className="connections-optional-scopes-note">{optionalScopeNote(shortfall.checks.length)}</p>
    </div>
  );
}

/**
 * One connection: a line until it is opened, a case file after.
 *
 * The collapsed line carries the two facts a reader scans eighteen rows for:
 * whether anything reached this dependency, and what it is demonstrably using.
 * Everything else, the configured value beside the used one, the drift, the
 * remedy, the tier, and the control, waits inside, because a row that offered
 * all of that at rest is the card this replaces.
 *
 * Exported for the same reason as `PreflightRemedyRow`: the padlock-versus-pencil
 * affordance and the configured/in-use pair are only decidable from composed
 * markup, and the page cannot compose either without effects having run.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure async-open decision used by focused UI tests
export function opensForLakebaseMigration(state: LakebaseMigrationClientState | undefined): boolean {
  const status = state?.value?.status;
  return Boolean(status && status !== 'up_to_date');
}

export function ConnectionRow({
  reading,
  tone,
  onSave,
  saving,
  requested,
  refreshing,
  declaredTables: declaredTablesProp,
  tableChecks = [],
  checkedAt = '',
  hostedIndex = '',
  catalogInUse = '',
  allowMutations = false,
  lakebaseMigration,
}: {
  /**
   * The whole reading, derived once by `readConnections` and handed down.
   *
   * The row used to take a payload row, a check and a list of findings and
   * derive the reading itself, which meant the page derived every reading twice
   * -- once for the counts, once per row -- from two different call sites that
   * were one edit away from disagreeing about a row's verdict.
   */
  reading: ConnectionReading;
  /**
   * The colour its section carries.
   *
   * Passed in rather than decided here, because the STATUS IS SAID ONCE, in the
   * section header above, and the tint on this row is a second reading of that
   * header rather than a claim of its own.
   */
  tone: StatusTone;
  /** Resolves true when the server took the value, false when it refused it. */
  onSave: (value: string) => Promise<boolean>;
  onClear: () => Promise<void>;
  saving: boolean;
  /**
   * The entry a link asked this page to show, when it named this one.
   *
   * The Architecture page's nodes link here, and a node that opened the page at
   * a row the reader then has to find themselves has not taken them anywhere.
   */
  requested: boolean;
  /** Whether a refresh is in flight, so this row's badge is being re-decided. */
  refreshing: boolean;
  declaredTables?: readonly string[];
  tableChecks?: readonly PreflightCheck[];
  checkedAt?: string;
  hostedIndex?: string;
  /**
   * The catalog this deployment is configured with, for the schema picker.
   *
   * The App schema row stores a bare schema name, so nothing in the row itself
   * says which catalog to list. The page holds every row and passes it down;
   * empty means the picker opens on the catalog list instead, which is the
   * correct behaviour rather than a degraded one.
   */
  catalogInUse?: string;
  /** Administrators only may stage or save. Consumers still see the row. */
  allowMutations?: boolean;
  lakebaseMigration?: {
    state: LakebaseMigrationClientState;
    apply: () => void;
  };
}) {
  // `problems` is every finding but the pending one, which says what the
  // Intended banner directly above it already says, and two statements of one
  // fact read as two problems. `remote` is whether anything out there could be
  // asked about this value; where nothing could, the row says there is nothing
  // to measure against rather than "not measured", which would invite a search
  // for a discrepancy that cannot exist.
  const { row, check, problems, status, marker, driftCount } = reading;
  const { resource } = row;
  const isDeclaredManifest = resource.id === 'declared-manifest';
  const declaredTables = isDeclaredManifest ? [...(declaredTablesProp ?? declaredTableNames(row.configured))] : [];
  const view = connectionResourceView(reading, {
    checkedAt,
    declaredNames: declaredTables,
    tableChecks,
    hostedIndex,
  });
  const picker = pickerForField(resource.id);
  const lakebaseManaged = resource.id === 'lakebase';
  const canWrite = Boolean(allowMutations && picker && (row.editable || lakebaseManaged));
  const canWriteInline = canWrite && !lakebaseManaged;
  // Open on arrival when a link named this row. The collapsed line carries the
  // value and its verdict; the reason for either is inside, and somebody who
  // followed a link from a diagram came for the reason.
  const [open, setOpen] = useState(requested || opensForLakebaseMigration(lakebaseMigration?.state));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.configured);

  /**
   * Whether THIS row is one a refresh will re-decide.
   *
   * A row the app both resolves and applies has no remote end, so a refresh
   * cannot change its badge. Every remote row keeps the last completed identity
   * visible and carries a quiet busy treatment while it is re-decided; replacing
   * the value with loading copy would throw cached evidence away.
   */
  const restating = refreshing && status !== 'nothing-to-reach';
  // A probe is authoritative evidence that this row has a remote connection
  // state even when the registry says its configured value is not a second
  // identifier to compare (MLflow experiments are the important example).
  const primaryState = primaryConnectionState(status, resource.namesRemoteObject || Boolean(check), restating);
  const connectionDetails = restating
    ? view.details.filter((detail) => !['Access', 'Connection', 'Status'].includes(detail.label))
    : view.details;

  /**
   * Closed only when the server took it.
   *
   * Closing either way discarded the typed value on a refusal and left a row
   * that looked exactly like one that had saved, with the old value in it, and
   * the banner explaining why potentially a screen further up.
   */
  const commit = async () => {
    if (await onSave(draft.trim())) setEditing(false);
  };

  return (
    <div
      className="connection-row"
      data-tone={tone}
      id={entityRowId(resource.id)}
      data-testid={`connection-${resource.id}`}
      data-status={status}
      data-refreshing={restating ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
      data-highlighted={requested ? 'true' : undefined}
      // Announced as well as tinted, the same pairing the table matrix uses: a
      // reader who cannot see the wash still has to be told which of eighteen
      // rows the link they followed was about.
      aria-current={requested ? 'location' : undefined}
    >
      <button
        type="button"
        className="connection-row-summary"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {/* Which product this connection is to, as its own mark rather than a
            word or an approximation of one. Decorative: the product's name is
            in the label immediately beside it, so a mark that announced itself
            would have a screen reader read the product twice. */}
        <BrandIcon product={RESOURCE_PRODUCT[resource.kind]} className="connection-row-product" />
        <span className="connection-row-label">{resource.label}</span>
        {/* THE VALUE IS THE VERDICT. This line used to carry a status chip and,
            beside it, the value in plain text: two columns to read per row, and
            the same word repeated down a page of eighteen. The status is said
            once, in the section header above, and the tint on the value here is
            a second reading of it.

            `aria-live` on the value rather than on the page: a screen reader
            hears this row's verdict change, which is the fact that changed,
            instead of nineteen of them being read out at once. */}
        <span className="connection-row-value" aria-live="polite" aria-busy={restating || undefined}>
          <StatusBadge value={truncateHead(view.displayIdentity)} tone="plain" title={view.displayIdentity} />
          {view.secondaryIdentity ? (
            <code className="connection-row-raw-id" title={view.secondaryIdentity}>
              {view.secondaryIdentity}
            </code>
          ) : null}
        </span>
        {primaryState === 'loading' ? (
          <PiaLoadingLabel
            as="span"
            seat="status"
            tone="light"
            announce={false}
            className="connection-row-status-loader"
            label={`Checking ${resource.label}`}
          />
        ) : primaryState === 'not-applicable' ? null : (
          <ConnectionStateBadge state={primaryState} subject={resource.label} className="connection-row-state" />
        )}
        {/* Announced, not drawn. A row in the Drifted section is under a header
            that says so, and repeating it per row is what the chip did; the
            count is the one thing the header cannot carry, and a reader who
            cannot see which section they are in still needs the verdict. */}
        {marker !== 'none' ? (
          <span className="sr-only">
            {DRIFT_MARKER_LABEL[marker]}
            {marker === 'drift' && driftCount > 1 ? ` ×${driftCount}` : ''}
          </span>
        ) : null}
        {/* The mutability tier, reduced to the one bit of it that is worth a
            glance: whether opening this row will offer anything to do. The
            label and the paragraph behind it are inside, next to the control
            they describe, which is where the question "why can I not change
            this?" is actually asked. */}
        {/* Both carry the attribute, not just the pencil. The two icons are the
            design's promise about what opening the row will offer, and with only
            one of them labelled there was no way to assert that the OTHER case
            draws a padlock rather than nothing at all -- which is how an icon
            silently disappears and the row reads as offering an edit it does
            not. */}
        {canWrite ? <Pencil className="size-3.5 shrink-0 connection-row-affordance" data-affordance="write" /> : null}
      </button>

      {open ? (
        <div className="connection-row-detail">
          {restating ? (
            <PiaLoadingLabel label={`Checking ${resource.label}`} className="connection-detail-status-loader" />
          ) : null}
          {resource.id === 'lakebase' && lakebaseMigration ? (
            <LakebaseMigrationPanel state={lakebaseMigration.state} onApply={lakebaseMigration.apply} />
          ) : null}
          {lakebaseManaged ? (
            <LakebaseBindingManager
              key={lakebaseMigration?.state.value?.status ?? 'migration-unchecked'}
              enabled={canWrite}
            />
          ) : null}
          {view.comparison ? (
            <div className="connection-drift">
              <p className="connection-drift-status">Drift · expected and observed resources differ</p>
              <div className="connection-pair">
                <div className="connection-tile">
                  <p className="connection-tile-label">Expected</p>
                  <p className="connection-tile-value" title={view.comparison.expected}>
                    {view.comparison.expected}
                  </p>
                </div>
                <div className="connection-tile" data-disagrees="true">
                  <p className="connection-tile-label">Observed</p>
                  <p className="connection-tile-value" title={view.comparison.observed}>
                    {view.comparison.observed}
                  </p>
                </div>
              </div>
            </div>
          ) : connectionDetails.length > 0 ? (
            <dl className="connection-details">
              {connectionDetails.map((detail) => {
                const detailState = resolvedConnectionStateFromLabel(detail.value);
                return (
                  <div className="connection-detail" key={`${detail.label}:${detail.value}`}>
                    <dt>{detail.label}</dt>
                    <dd title={detail.value}>
                      {detailState ? (
                        <ConnectionStateBadge state={detailState} subject={`${resource.label} ${detail.label}`} />
                      ) : (
                        detail.value
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : (
            <p className="connection-empty-detail">{view.description}</p>
          )}
          {isDeclaredManifest && view.declaredNames.length > 0 ? (
            <div className="connection-configured-entity-list">
              <DeclaredTableList configured={view.declaredNames.join(',')} />
            </div>
          ) : null}

          {/* The failure in the dependency's own words. The statement that fixes
              it is not repeated here: it is in What to fix at the top of the
              page, once, alongside every other blocked check including the
              table ones that have no row to live in.

              AND ONLY WHERE IT REALLY IS. The catalog and the schema have rows of
              their own, and a refusal over one of the optional catalog reads is
              no longer drawn in that section, so pointing a reader up the page at
              a statement that is not there would send them looking for something
              this app deliberately stopped saying. The row still reports what the
              workspace said, which is the row's job. */}
          {check && check.status !== 'ok' ? (
            <Alert>
              <CircleAlert />
              <AlertDescription>
                {check.error || check.detail}{' '}
                {check.remedy && !isOptionalScopeShortfall(check)
                  ? 'The statement that fixes this is under \u201cWhat to fix\u201d above.'
                  : ''}
              </AlertDescription>
            </Alert>
          ) : null}

          {problems.map((finding) => {
            const Icon = SEVERITY_ICON[finding.severity];
            return (
              <Alert key={finding.id}>
                <Icon />
                <AlertDescription>
                  <strong>{finding.headline}.</strong> {finding.detail}
                </AlertDescription>
              </Alert>
            );
          })}

          {!editing && canWriteInline ? (
            <div className="connection-row-tier-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft(view.identity);
                  setEditing(true);
                }}
              >
                <Pencil className="size-3.5" /> Change
              </Button>
            </div>
          ) : null}

          {resource.id === 'shared-conversation-rail' && canWriteInline ? (
            <p className="connection-row-tier-note connection-row-warning" role="alert">
              <strong>Widens tenancy.</strong> Setting this to true lets every signed-in user see everyone else&apos;s
              conversations on the rail. Writes (ask, delete, upload) stay owner-only, but conversation titles and
              history become shared. Confirm before recording; an app release is still required for it to take effect.
            </p>
          ) : null}

          {editing ? (
            <div className="connection-row-editor">
              <AssetPickerField field={resource.id} current={draft} catalog={catalogInUse} onPick={setDraft} />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={saving || !draft.trim()}
                  aria-busy={saving || undefined}
                  onClick={() => void commit()}
                >
                  <PiaBusyButtonContent
                    busy={saving}
                    label="Save and apply"
                    busyLabel="Saving"
                    icon={<Save className="size-3.5" />}
                  />
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ConnectionLoadRow({ reading, state }: { reading: ConnectionReading; state: 'loading' | 'error' }) {
  const label = state === 'loading' ? `Loading ${reading.resource.label}` : connectionLoadErrorLabel(reading);
  return (
    <div
      className="connection-row connection-row-load-state"
      data-testid={`connection-${reading.resource.id}`}
      data-load-state={state}
    >
      <div className="connection-row-summary">
        <span className="connection-row-loader-chevron" aria-hidden="true" />
        {state === 'loading' ? (
          <PiaLoadingLabel label={label} className="connection-row-loader" />
        ) : (
          <div className="connection-row-load-error" role="alert">
            <CircleAlert className="size-4" aria-hidden="true" />
            <span className="connection-row-label">{reading.resource.label}</span>
            <ConnectionStateBadge state="disconnected" subject={reading.resource.label} />
            <span>{label}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConnectionsPage() {
  const role = useRole();
  const allowMutations = canMutateConnections(role.state);
  const features = useOutletContext<AppOutletContext | null>()?.features ?? NO_EXPERIMENTS;
  const notebookAgentSyncEnabled = showsNotebookAgentSync(features);
  const location = useLocation();
  const blockedNotebookAgentSyncLink =
    !notebookAgentSyncEnabled && notebookAgentSyncTarget({ search: location.search, hash: location.hash }) !== null;
  const [saving, setSaving] = useState('');
  const [writeError, setWriteError] = useState('');
  const lakebaseMigration = useLakebaseMigrationStatus(allowMutations);

  /**
   * The checks, from the one mechanism that runs them for the whole session.
   *
   * THIS PAGE USED TO FETCH BOTH ROUTES ON EVERY MOUNT. That looked like the
   * opposite of the Architecture page's defect and was a defect of its own: every
   * navigation back to this tab re-invoked the serving endpoint and re-probed the
   * workspace, with nobody having asked. Both tabs now read one run, started once
   * per session, with Refresh as the only thing that re-runs it. See
   * session-checks.ts.
   */
  const { session, running: refreshing, firstLoad: firstRun, refresh, reloadSettings } = useSessionChecks();
  const payload = session?.settings ?? null;
  const report = session?.report ?? null;
  const checkError = session?.error ?? '';
  /**
   * Whether the first run is still in flight.
   *
   * Distinct from `refreshing`, which is true for a re-run as well. Only the
   * first run has nothing to draw underneath it, so only the first run gets the
   * primary and row-local Astrolabe loaders. A re-run leaves cached answers on
   * screen under the quiet refresh treatment.
   */
  const linkedEntity = useRequestedEntity();
  const requestedEntity = blockedNotebookAgentSyncLink ? '' : linkedEntity;
  // A resource id rather than a table name means the link came from a
  // connection, so the table matrix is not where it is going.
  const requestedResource = CONNECTED_RESOURCES.some((resource) => resource.id === requestedEntity.toLowerCase())
    ? requestedEntity.toLowerCase()
    : '';
  /**
   * Re-read the configuration after a write, and report a refusal.
   *
   * NOT a re-run of the checks. A save changes what the deployment is configured
   * with, so the rows are redrawn; it changes nothing about whether the workspace
   * answers, so re-probing every dependency would be an expensive way of learning
   * nothing. Returns the sentence to show, or '' when it worked.
   */
  const rereadSettings = useCallback(async () => {
    const failure = await reloadSettings();
    if (failure) setWriteError(failure);
    return failure;
  }, [reloadSettings]);

  /** Saves one value, and says whether the server took it. */
  const write = useCallback(
    async (row: ResourceRow, value: string): Promise<boolean> => {
      setSaving(row.resource.id);
      setWriteError('');
      try {
        const response = await fetch(`/api/settings/values/${encodeURIComponent(row.resource.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value, intent: row.editable ? 'active' : 'intended', note: '' }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { detail?: string };
          // Surfaced verbatim. The server's refusal carries the command that
          // would work, and rewording it here would be a second copy of the
          // rules about what is changeable.
          throw new Error(body.detail ?? `the settings endpoint answered ${response.status}`);
        }
        await rereadSettings();
        return true;
      } catch (caught) {
        setWriteError((caught as Error).message);
        return false;
      } finally {
        setSaving('');
      }
    },
    [rereadSettings]
  );

  const clear = useCallback(
    async (row: ResourceRow) => {
      setSaving(row.resource.id);
      setWriteError('');
      try {
        const response = await fetch(`/api/settings/values/${encodeURIComponent(row.resource.id)}`, {
          method: 'DELETE',
        });
        if (!response.ok) throw new Error(`the settings endpoint answered ${response.status}`);
        await rereadSettings();
      } catch (caught) {
        setWriteError((caught as Error).message);
      } finally {
        setSaving('');
      }
    },
    [rereadSettings]
  );

  // Memoized rather than defaulted inline: a fresh `[]` on every render makes
  // the map below a new object every render, and the row counts that depend on
  // it recompute for eighteen resources each time the page redraws.
  const reported = useMemo(() => report?.checks ?? [], [report]);
  // Both halves, in the order `allChecks` fixes: what the app asked the
  // workspace under the reader's own token, and then anything the orchestrator
  // reported, which outranks it where they answer about the same resource.
  const checks = useMemo(() => allChecks(payload, reported), [payload, reported]);
  const blocked = checks.filter((check) => check.status !== 'ok');
  /**
   * The blocked checks, split by whether anybody is being asked to act.
   *
   * A refusal over one of the three optional catalog reads is not a fix, and
   * this panel was the last surface still drawing one as one. `required` is what
   * "What to fix" is allowed to hold; the rest is stated once, neutrally, in a
   * line of its own. The rule is in `optional-scope-findings.ts`, where it is
   * asserted without composing a screen.
   */
  const findings = splitOptionalScopeFindings(blocked);
  const tableChecks = checks.filter((check) => check.kind === 'table');
  const tableConnections = useMemo(
    () => (payload?.connections ?? []).filter((entry) => isDeclaredUnityCatalogConnection(entry.connection)),
    [payload?.connections]
  );
  /**
   * Do not turn an unsettled or stripped settings response into an empty scope.
   *
   * A source-only Git deploy can replace a target-built app.yaml with public
   * placeholders. That is "not connected", not proof that somebody removed
   * every table. Likewise, a failed settings read is unavailable rather than an
   * empty success. Only a settled payload that carries scope evidence may render
   * the ordinary empty-table branch.
   */
  const unityCatalogReadState = useMemo(() => {
    if (!payload) {
      return firstRun || session?.load?.settings === 'pending' ? ('loading' as const) : ('unavailable' as const);
    }
    const catalog = payload.resources.find((row) => row.resource.id === 'catalog')?.configured.trim() ?? '';
    const schema = payload.resources.find((row) => row.resource.id === 'schema')?.configured.trim() ?? '';
    if (!catalog && !schema && tableChecks.length === 0 && tableConnections.length === 0) {
      return 'not-connected' as const;
    }
    return 'ready' as const;
  }, [firstRun, payload, session?.load?.settings, tableChecks.length, tableConnections.length]);
  /**
   * The blocked checks, collected into one panel block per remedy.
   *
   * Two passes: by cause, so twelve tables refused for one permission are one
   * row, and then by remedy, so four permissions cleared by one restart are one
   * block rather than four repetitions of the same instruction.
   *
   * Not memoized, because `blocked` is a fresh array on every render and a
   * dependency that never compares equal makes a `useMemo` a slower way of doing
   * the same work. The grouping is a single pass over a few dozen checks.
   */
  const remedyBlocks = groupByRemedy(groupByCause(findings.required));

  /**
   * Every connection, read once.
   *
   * The sections and the rows are off this one derivation. They used to be off
   * three: a count strip walked the readings, the sections were a fixed list of
   * resource KINDS, and each row re-derived its own verdict from a check it
   * looked up itself. The strip is gone; the rows still speak for themselves.
   */
  const readings = useMemo(
    () => (payload ? readConnections(payload, reported) : connectionPlaceholderReadings(reported)),
    [payload, reported]
  );
  /**
   * The sections, in the order a reader needs them: what is broken, what moved,
   * what answered, what nobody asked, and then the configuration.
   *
   * The status is the SECTION, which is what lets each row drop its own status
   * chip. Grouping by kind put a blocked warehouse under "Data and compute"
   * three screens down, with its verdict as a chip a reader had to find.
   */
  const groups = useMemo(() => groupConnections(readings), [readings]);
  /**
   * The catalog the schema picker lists inside.
   *
   * Read off the App catalog row, and off its INTENDED value first, because a
   * reader who has just recorded a new catalog is about to pick a schema in that
   * one rather than in the one the current model version was logged with. Empty
   * on a deployment whose catalog was never configured, where the picker opens on
   * the catalog list instead.
   */
  const catalogInUse = useMemo(() => {
    const catalogRow = readingsById(readings).get('catalog')?.row;
    return (catalogRow?.intended ?? catalogRow?.configured ?? '').trim();
  }, [readings]);
  /**
   * The serving endpoint's own reading, for the Orchestrator stamp's badge.
   *
   * The SAME reading the connection row is drawn from, taken by id off the same
   * derivation, rather than a verdict computed here: the endpoint appears twice on
   * this page and two readings of it are two chances to badge one endpoint green
   * in the Build card and red in the list.
   */
  const orchestratorReading = useMemo(() => readingsById(readings).get('agent-endpoint'), [readings]);
  const foundationModel = useMemo(() => {
    const model = readingsById(readings).get('llm-endpoint')?.row;
    return (model?.intended ?? model?.configured ?? '').trim();
  }, [readings]);
  const hostedIndex = useMemo(() => {
    const index = readingsById(readings).get('semantic-index');
    if (!index) return '';
    return ((index.row.actualObserved ? index.row.actual : '') || index.check?.name || index.row.configured).trim();
  }, [readings]);

  /**
   * When these answers were taken.
   *
   * The settings payload's stamp first, because that is the response the
   * workspace probes are computed in and so is the one that moves on every
   * successful refresh. The orchestrator's own `checked_at` is the fallback and
   * is routinely EMPTY: a version that answers with its configuration and runs
   * no checks has no check time to report, which is why the header's old
   * "Checked …" line rendered a blank on a perfectly healthy deployment. The
   * control now says "Not read yet" for that, which is the truth.
   */
  const lastCheckedAt = payload?.checkedAt || report?.checked_at || '';

  /**
   * The declared assets and the control that extends them, built once and drawn
   * in exactly one place: the foot of Connected resources, or the page itself on
   * a deployment that has no such section to hang it from.
   */
  const declaredConnections = (
    <DeclaredConnectionsCard
      entries={payload?.connections}
      storeAvailable={payload?.storeAvailable ?? true}
      allowMutations={allowMutations}
      onChanged={async () => {
        await rereadSettings();
      }}
    />
  );
  const showsDeclaredConnections =
    allowMutations || Boolean(payload?.connections?.length) || payload?.storeAvailable === false;

  const now = Date.now();

  /**
   * The independent app and orchestrator build stamps, and whether each half is
   * working.
   *
   * THE HEALTH IS READ OFF WHAT THIS PAGE ALREADY HOLDS, which is the only way
   * these two rows can be trusted to agree with the rest of the tab. The app's
   * comes from the workspace's own report of the app and its compute -- the same
   * field the App endpoint row is tinted from -- with the fact that this page's
   * read was answered as the fallback. The orchestrator's comes from the check on
   * the serving endpoint row, which is the endpoint a question is actually run
   * against, and falls back to whether the served model version reported its own
   * configuration on this pass.
   *
   * Neither is a second probe. A row that measured its own health would eventually
   * disagree with the row above it about one app.
   */
  const build = buildFacts({
    appBuildSha: payload?.appBuildSha ?? '',
    modelBuildSha: payload?.modelBuildSha ?? '',
    appBuildAncestors: payload?.appBuildAncestors ?? [],
    appServing: payload?.app?.serving,
    appAnswered: Boolean(payload),
    orchestratorStatus: orchestratorReading?.status,
    orchestratorReported: payload?.orchestratorReported,
  });

  /**
   * The app's own record, and the rows it earns.
   *
   * `NO_APP_FACTS` rather than a nullable, so the two derivations below take one
   * shape and the "nothing was reported" case is an empty row list rather than a
   * branch in the markup. A server built before this field existed lands here
   * too, and correctly draws nothing.
   *
   * Both read the same clock, taken once per render, so an uptime and a
   * freshness line cannot round two different instants.
   */
  const appFacts = payload?.app ?? NO_APP_FACTS;
  const deploymentFacts = useMemo(() => deploymentRows(appFacts), [appFacts]);
  const telemetryFacts = useMemo(() => telemetryRows(appFacts, now), [appFacts, now]);

  const wide = deploymentWideFindings(payload?.drift ?? []);
  // The freshness stamp is passed so pressing Refresh re-reads the identity too;
  // see useDeploymentIdentity, which otherwise shares the shell's session read.
  const identityRead = useDeploymentIdentity(true, lastCheckedAt);
  // One list, one control. Two error alerts each offering their own would be two
  // controls for one intention, and one run produces one account of what failed.
  const problems = [checkError].filter(Boolean);
  return (
    <div className="page-shell connections-page">
      <div className="page-heading">
        <div>
          <h2>Connections</h2>
        </div>
        {/* The one control on the page, and it is the shared one: the word, the
            icon, the pending state and the freshness line are decided in
            RefreshControl.tsx, so this header and the Architecture header cannot
            come apart again.
            
            The timestamp is beside the button and appears nowhere else on the
            page. It used to sit in the status block's meta line instead, which
            was the right call while the button had no line of its own; printing
            it in both places would be the thing this page's whole rebuild was
            against, which was saying everything more than once. */}
        <RefreshControl busy={refreshing} checkedAt={lastCheckedAt} onRefresh={() => void refresh()} />
      </div>

      {firstRun ? (
        <Card className="connections-primary-loader" data-testid="connections-primary-loader">
          <PiaLoadingLabel seat="compact" label="Loading connections" className="connections-primary-loader-row" />
        </Card>
      ) : null}

      {problems.length > 0 ? (
        <Alert>
          <CircleAlert />
          <AlertDescription>
            {problems.map((problem) => (
              <span key={problem} className="block">
                {problem}
              </span>
            ))}
            {/* The same action as the header's, so the same button. It said "Try
                again" for as long as it was its own markup. */}
            <RefreshButton busy={refreshing} onRefresh={() => void refresh()} />
          </AlertDescription>
        </Alert>
      ) : null}

      {writeError ? (
        <Alert data-testid="settings-write-error">
          <CircleAlert />
          <AlertDescription>{writeError}</AlertDescription>
        </Alert>
      ) : null}

      {blockedNotebookAgentSyncLink ? (
        <Alert data-testid="notebook-agent-sync-disabled">
          <CircleAlert />
          <AlertDescription>Enable Notebook agent sync in Experimental settings</AlertDescription>
        </Alert>
      ) : null}

      {/* Only ever visible to someone who followed an entity link here and whose
          entry has since stopped being tracked. Silence in that case would be
          the page answering a question it had not been asked. */}
      {/* The connection rows are entries too, since the Architecture page's
          nodes link to them, so a link naming one is not a link to nothing. */}
      <EntityHighlight
        tracked={[...tableChecks.map((check) => check.name), ...CONNECTED_RESOURCES.map((resource) => resource.id)]}
        ready={!!report || !!payload}
      />

      {wide.length > 0 ? (
        <div className="connections-status" data-testid="drift-summary">
          {wide.map((finding) => {
            const Icon = SEVERITY_ICON[finding.severity];
            return (
              <Alert key={finding.id}>
                <Icon />
                <AlertDescription>
                  <strong>{finding.headline}.</strong> {finding.detail}
                  {finding.remedy ? <> {finding.remedy}</> : null}
                </AlertDescription>
              </Alert>
            );
          })}
        </div>
      ) : null}

      {/* Kept whole, against the general rule
          that everything collapses. Every other block on this page describes
          state; this one is the only thing on it a reader can act on, and most of
          what it carries belongs to the table checks, which have no resource row
          to hold them. It renders only when something is blocked, so a healthy
          deployment never sees it -- which is also why it can sit above the two
          cards without pushing them down on the deployments that are fine. */}
      {/* The REQUIRED findings, and only those. It used to render on every
          blocked check, which on this deployment meant a red section headed
          "What to fix" whose first three entries were optional catalog reads
          nothing needs. A section that names things that are not the reader's to
          fix is a section people stop reading. */}
      {findings.required.length > 0 ? (
        <section className="connections-fix" aria-labelledby="connections-fix-title">
          <div className="connections-fix-head">
            <Wrench className="size-3.5" aria-hidden="true" />
            <h3 id="connections-fix-title">What to fix</h3>
          </div>
          {/* No lead paragraph, and its removal is a correction rather than a
              trim. It said each statement was "already filled in with the serving
              principal", which stopped being true when the app took over the
              probing: the grants are filled in with the SIGNED-IN USER, whose
              refusal is what was measured, and telling an admin the line names
              the service principal would have them grant the wrong identity. It
              also said "Run it as a workspace admin", which every block below
              already says more precisely for its own statement. */}
          {/* ONE BLOCK PER REMEDY, not one per failure. Twelve table checks
              stopped by one missing OAuth scope were twelve identical blocks;
              collecting them by cause fixed that and left four -- one per API
              family -- each repeating the same three-line instruction about
              private browsing windows for the one restart that clears all four.
              What shares a cause and what shares a remedy is decided in
              connection-causes.ts, where it can be asserted without composing a
              screen. */}
          <div className="connections-fix-body">
            {remedyBlocks.map((block) => (
              <PreflightRemedyBlock key={block.key} block={block} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Under the panel rather than in it, and drawn whether or not the panel
          is there: the commonest deployment has these three short and nothing
          else wrong at all, and on that one this line is the only thing said
          about them. */}
      <OptionalScopeLine shortfall={findings.optional} />

      {/* The two cards the design puts under the summary: what is running, and
          who it runs as. Both were prose before -- the hashes were a clause in
          the grey meta line above, and the identity was a disclosure called
          "Connected as" whose closed line read `not reported · questions run as
          the signed-in user`, which named nobody. */}
      <div className="deployment-cards">
        <Card className="deployment-card deployment-card-build" data-testid="build-card">
          <div className="deployment-card-head">
            <p className="deployment-card-title">
              <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
              Build and telemetry
            </p>
          </div>
          {/* TWO GRIDS, which is the design's arrangement and is also a
              division of subject: what this deployment IS on the left, what it
              was BUILT FROM on the right. One column of ten label/value pairs
              reads as a list of unrelated facts.

              The left column is dropped entirely, rather than left empty, on a
              deployment whose workspace reported nothing about the app: an empty
              half beside a full one draws the eye to the emptiness. */}
          <div className="deployment-card-body" data-columns={deploymentFacts.length > 0 ? 'two' : 'one'}>
            {deploymentFacts.length > 0 ? (
              <div className="deployment-grid">
                {deploymentFacts.map((row) => (
                  <BuildFactRow key={row.key} row={row} />
                ))}
              </div>
            ) : null}
            <div className="deployment-grid">
              {/* The build identifiers only. Dependency status is already stated
                  in the grouped rows below, so repeating it here would give one
                  reading two badges. */}
              {build.artifacts.map((artifact) => (
                <BuildStampRow key={artifact.key} artifact={artifact} />
              ))}
              {telemetryFacts.map((row) => (
                <BuildFactRow key={row.key} row={row} />
              ))}
            </div>
          </div>
        </Card>

        {/* `remedyStatedElsewhere` is the same condition the What to fix section
            renders on, read from the same array, so the two cannot disagree about
            whether the sign-in remedy is already on this screen. The card carries
            it only on the deployment where the panel is absent: a permission can
            be missing while nothing is blocked, and there the action would
            otherwise be on no surface. */}
        {/* The REQUIRED findings, which is what the panel now renders on. Read
            off the same split for the same reason the old condition read off the
            same array: a deployment whose only shortfall is the three optional
            catalog reads has no panel, so the card must not think the sign-in
            remedy is already on the screen. */}
        <IdentityCard read={identityRead} remedyStatedElsewhere={findings.required.length > 0} />
      </div>

      {notebookAgentSyncEnabled ? (
        <Suspense fallback={null}>
          <NotebookAgentSyncPane
            notebook={payload?.notebook}
            allowMutations={allowMutations}
            onSaved={rereadSettings}
            onRefresh={() => void refresh()}
          />
        </Suspense>
      ) : null}

      {/* ONE SECTION PER VERDICT, and the verdict said once in its header. The
          list was grouped by what a dependency IS -- "Agents and models", "Genie
          spaces", "Data and compute", "App storage and behaviour", each under a
          sentence explaining the category -- with every row carrying its own
          status chip. A blocked warehouse was the eleventh row of the third
          group, and its verdict was a chip a reader had to find. */}
      {groups.map((group) => (
        <section key={group.key} className="connection-group">
          {/* No blurb. Each of the four the categories carried was a sentence
                explaining what the category meant, which a header naming a
                verdict does not need. */}
          <h3 className="connection-group-title" data-tone={GROUP_TONE[group.key]}>
            {group.title}
            {group.aside ? <span className="connection-group-aside">{group.aside}</span> : null}
          </h3>
          <div className="connection-rows">
            {group.readings.map((reading) => {
              const loadState = connectionResourceLoadState(reading, session, firstRun);
              if (loadState !== 'ready') {
                return <ConnectionLoadRow key={reading.resource.id} reading={reading} state={loadState} />;
              }
              return reading.resource.id === 'llm-gateway' ? (
                <AiGatewayConnection
                  key={reading.resource.id}
                  reading={reading}
                  foundationModel={foundationModel}
                  requested={requestedResource === reading.resource.id}
                  refreshing={refreshing}
                  allowMutations={allowMutations}
                  onStaged={rereadSettings}
                />
              ) : (
                <ConnectionRow
                  key={`${reading.resource.id}:${
                    reading.resource.id === 'lakebase'
                      ? lakebaseMigration.state.value
                        ? 'checked'
                        : 'unchecked'
                      : 'settled'
                  }`}
                  reading={reading}
                  tone={GROUP_TONE[group.key]}
                  saving={saving === reading.resource.id}
                  refreshing={refreshing}
                  declaredTables={canonicalDeclaredTableNames(reading.row.configured, tableChecks)}
                  tableChecks={tableChecks}
                  checkedAt={lastCheckedAt}
                  hostedIndex={hostedIndex}
                  requested={requestedResource === reading.resource.id}
                  catalogInUse={catalogInUse}
                  allowMutations={allowMutations}
                  lakebaseMigration={
                    reading.resource.id === 'lakebase'
                      ? { state: lakebaseMigration.state, apply: () => void lakebaseMigration.apply() }
                      : undefined
                  }
                  onSave={(value) => write(reading.row, value)}
                  onClear={() => clear(reading.row)}
                />
              );
            })}
            {/* Built-in configured resources always lead. The shared declared
                  list then adds its own deterministic user-added section, with
                  the closed Add row and form after every saved row. */}
            {group.key === 'reachable' ? declaredConnections : null}
          </div>
        </section>
      ))}

      {/* A deployment where nothing was reachable draws no Connected resources
          section, and the control must not vanish with it. */}
      {groups.some((group) => group.key === 'reachable') || !showsDeclaredConnections ? null : (
        <section className="connection-group">
          <h3 className="connection-group-title">Connected resources</h3>
          <div className="connection-rows">{declaredConnections}</div>
        </section>
      )}

      <DeclaredTablesSection
        tableChecks={tableChecks}
        scopeChecks={checks}
        tableConnections={tableConnections}
        requestedEntity={requestedEntity}
        checkedAt={lastCheckedAt}
        readState={unityCatalogReadState}
        storeAvailable={payload?.storeAvailable ?? true}
        allowMutations={allowMutations}
        onChanged={async () => {
          await refresh();
        }}
      />
    </div>
  );
}
