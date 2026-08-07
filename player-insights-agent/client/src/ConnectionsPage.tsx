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
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
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
  CircleCheck,
  CircleHelp,
  Clock,
  Copy,
  Lock,
  Pencil,
  RefreshCw,
  Save,
  Undo2,
  Wrench,
} from 'lucide-react';
import {
  CHANGED_BY,
  type ChangedBy,
  type ConnectedResource,
  type ResourceKind,
} from '../../shared/deployment-config';
import { IdentityPanel } from './IdentityPanel';
import { EntityHighlight, entityRowProps, useRequestedEntity } from './DataEntityLinks';
import {
  PREFLIGHT_STATUS_LABEL,
  formatCheckedAt,
  preflightBadgeVariant,
  preflightHeadline,
  usePreflight,
  type PreflightCheck,
} from './preflight';
import {
  CONNECTION_STATUS_LABEL,
  CONNECTION_STATUS_NOTE,
  DRIFT_MARKER_LABEL,
  connectionCounts,
  connectionStatus,
  connectionStatusVariant,
  driftCount,
  driftMarker,
  inUseSummary,
  type ConnectionStatus,
  type DriftMarker,
} from './connection-status';

type DriftSeverity = 'blocking' | 'warning' | 'pending' | 'unknown' | 'note';

interface DriftFinding {
  id: string;
  severity: DriftSeverity;
  resourceId: string | null;
  headline: string;
  detail: string;
  remedy: string;
}

interface ResourceRow {
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

interface SettingsPayload {
  resources: ResourceRow[];
  drift: DriftFinding[];
  status: 'ok' | 'blocked' | 'pending' | 'unknown';
  appBuildSha: string;
  modelBuildSha: string;
  orchestratorReported: boolean;
  storeAvailable: boolean;
  checkedAt: string;
}

const GROUPS: Array<{ kinds: ResourceKind[]; title: string; blurb: string }> = [
  {
    kinds: ['agent', 'model'],
    title: 'Agents and models',
    blurb: 'The endpoint that runs the orchestrator, and the models it reasons and scores with.',
  },
  {
    kinds: ['genie-space'],
    title: 'Genie spaces',
    blurb: 'Where governed metric answers and business definitions come from.',
  },
  {
    kinds: ['sql-warehouse', 'unity-catalog'],
    title: 'Data and compute',
    blurb: 'The warehouse that runs generated SQL, and the exact reach the orchestrator was granted.',
  },
  {
    kinds: ['lakebase', 'volume', 'observability', 'app-behaviour'],
    title: 'App storage and behaviour',
    blurb: 'What the app itself stores, links to, and shows.',
  },
];

const SEVERITY_ICON: Record<DriftSeverity, typeof CircleAlert> = {
  blocking: CircleAlert,
  warning: CircleAlert,
  pending: Clock,
  unknown: CircleHelp,
  note: CircleHelp,
};

/**
 * What the retired capability cards knew that the resource registry does not.
 *
 * Six of the seven cards named a dependency that is already a row here, joined
 * through `actualFromCheck`, and five of their descriptions were the resource's
 * own `purpose` in slightly different words. Only the example question was
 * genuinely theirs: it is the one line on either page that says what a
 * dependency is FOR in the reader's own terms, so it survives inside the row
 * rather than being lost with the card around it.
 */
const CAPABILITY_EXAMPLES: Record<string, string[]> = {
  'genie-data': ['How many active players did we have last week?'],
  'genie-dictionary': ['What does \u201chighly engaged\u201d mean?'],
  'sql-warehouse': ['Check null ratios in the latest partition.'],
  'llm-endpoint': ['Why did retention move last month?'],
  'agent-endpoint': ['Compare engagement by title.'],
  // Both of Lakebase's, because the seventh card, "Knowledge files", had no
  // check behind it and a permanent "Not checked" badge. It was not a seventh
  // dependency: the uploads it described are stored in Lakebase, which is a row
  // here with a live check, and the volume that once held published knowledge
  // documents has read nothing at runtime since those were removed. So it folds
  // in here, where its badge becomes a measured one instead of a grey word that
  // could never change.
  lakebase: ['Reopen a conversation from last week.', 'Explain the cross-brand identity rules.'],
};

const CAPABILITY_NOTES: Record<string, string> = {
  'agent-endpoint':
    'While this is unreachable the app answers with representative responses, which keeps the ' +
    'deployment explorable and is disclosed on every answer that uses one.',
  lakebase:
    'Uploaded knowledge files are stored here too. They add approved metric guidance and ' +
    'title-specific context to an answer, and they are the only knowledge source this deployment ' +
    'reads.',
};

/**
 * Where a resolved value came from, said plainly.
 *
 * `artifact` is the only answer that means the model version vouches for the
 * value. Everything else is reported as what it is rather than smoothed over,
 * because "the orchestrator read this from a shell" is the defect the whole
 * provenance chain was added to expose.
 */
const SOURCE_WORDS: Record<string, string> = {
  artifact: 'from the model artifact',
  environment: 'from the process environment',
  profile: 'from a named profile',
  default: 'a compiled default',
  'app-environment': 'from the app container',
  'app-default': 'the app default, because no value was set',
  'app-saved': 'saved here, and in force ahead of the deployed value',
};

const STATUS_HEADLINE: Record<SettingsPayload['status'], string> = {
  ok: 'Everything measured matches what was configured',
  blocked: 'This deployment is not using what it was configured with',
  pending: 'Changes have been recorded but not applied',
  unknown: 'Some of this could not be checked',
};

function tierBadgeVariant(tier: ChangedBy) {
  return tier === 'app-runtime' ? ('default' as const) : ('outline' as const);
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (<div className="flex items-start gap-2">
      <pre className="flex-1 whitespace-pre-wrap rounded-md bg-muted px-2 py-1 text-xs">{command}</pre>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Copy className="size-3.5" /> {copied ? 'Copied' : 'Copy'}
      </Button>
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
  open,
  onToggle,
  summary,
  aside,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  summary: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (<section className="connection-block">
      <button type="button" className="connection-block-summary" aria-expanded={open} onClick={onToggle}>
        <ChevronRight className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="font-semibold">{summary}</span>
        {aside ? <span className="text-xs text-muted-foreground">{aside}</span> : null}
      </button>
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
function PreflightRemedyRow({ check }: { check: PreflightCheck }) {
  return (<div className="space-y-2">
      <div className="health-row">
        <span>{check.label}</span>
        <Badge variant={preflightBadgeVariant(check.status)}>{PREFLIGHT_STATUS_LABEL[check.status]}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{check.detail || check.error}</p>
      {check.remedy ? (<div className="code-panel">
          <div>
            <Wrench /> {check.remedy.kind === 'sql' ? 'Run in a SQL editor' : 'Run with the Databricks CLI'} ·{' '}
            {check.remedy.note}
          </div>
          <pre aria-label={`Fix for ${check.label}`}>{check.remedy.statement}</pre>
        </div>
      ) : (<p className="text-sm text-muted-foreground">
          No statement can fix this one. It needs the dependency to exist, or the agent to be redeployed with it
          declared.
        </p>
      )}
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
 */
function ConnectionRow({
  row,
  check,
  findings,
  onSave,
  onClear,
  saving,
}: {
  row: ResourceRow;
  /** The preflight check this resource names, when the report carried one. */
  check: PreflightCheck | undefined;
  findings: DriftFinding[];
  /** Resolves true when the server took the value, false when it refused it. */
  onSave: (value: string) => Promise<boolean>;
  onClear: () => Promise<void>;
  saving: boolean;
}) {
  const { resource } = row;
  const canWrite = row.editable || resource.stageable;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.intended ?? row.configured);

  // Every finding but the pending one, which says what the Intended banner
  // directly above it already says, two statements of one fact read as two
  // problems. This used to take only the first, under the name `worst`, which
  // it was not: it compared no severities, and there are none to compare.
  // `provenance-*` and `mismatch-*` are the only per-resource findings
  // app-settings.ts raises besides pending, and both are `blocking`. They are
  // separate faults with separate remedies, so showing one hid the other, and a
  // deployer could fix what they were shown and re-check into a second blocking
  // finding they had never been told about.
  const problems = findings.filter((finding) => !finding.id.startsWith('pending-'));

  const disagrees = row.actualObserved && row.configured && row.actual !== row.configured;
  // Nothing else holds this value, so there is no second reading to compare
  // against: the app resolves it and the app applies it. Reporting that as
  // "not measured" invites a search for a discrepancy that cannot exist.
  const appApplied = !resource.agentKey && !resource.actualFromCheck;

  const status = connectionStatus({ check, appApplied });
  const marker = driftMarker({ findingIds: findings.map((finding) => finding.id), intended: row.intended });
  const summary = inUseSummary(row);
  const examples = CAPABILITY_EXAMPLES[resource.id] ?? [];
  const capabilityNote = CAPABILITY_NOTES[resource.id];

  return (<div className="connection-row" data-testid={`connection-${resource.id}`} data-status={status}>
      <button
        type="button"
        className="connection-row-summary"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronRight className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="connection-row-label">{resource.label}</span>
        <Badge variant={connectionStatusVariant(status)}>{CONNECTION_STATUS_LABEL[status]}</Badge>
        {/* Quieter than the badge on purpose. Reachability is the fact somebody
            scanning the page is looking for; whether a value agrees with the
            one it was configured with only means anything once both are on
            screen, which is inside. */}
        {marker !== 'none' ? (<span className="connection-row-drift" data-drift={marker}>
            {DRIFT_MARKER_LABEL[marker]}
            {marker === 'drift' && driftCount(findings.map((finding) => finding.id)) > 1
              ? ` ×${driftCount(findings.map((finding) => finding.id))}`
              : ''}
          </span>
        ) : null}
        <span className={`connection-row-value ${summary.measured ? '' : 'text-muted-foreground'}`}>
          {summary.value || 'not set'}
        </span>
        {/* The mutability tier, reduced to the one bit of it that is worth a
            glance: whether opening this row will offer anything to do. The
            label and the paragraph behind it are inside, next to the control
            they describe, which is where the question "why can I not change
            this?" is actually asked. */}
        {canWrite ? (<Pencil className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (<Lock className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="sr-only">{canWrite ? row.changedByLabel : `${row.changedByLabel}, not changeable here`}</span>
      </button>

      {open ? (<div className="connection-row-detail">
          <p className="text-sm text-muted-foreground">{resource.purpose}</p>
          {capabilityNote ? <p className="text-sm text-muted-foreground">{capabilityNote}</p> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Configured</p>
              <p className="font-mono break-all">{row.configured || 'not set'}</p>
              {row.configuredFrom ? (<p className="text-xs text-muted-foreground">
                  {SOURCE_WORDS[row.configuredFrom] ?? row.configuredFrom}
                </p>
              ) : null}
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">In use</p>
              {row.actualObserved ? (<>
                  <p className={`font-mono break-all ${disagrees ? 'text-destructive' : ''}`}>{row.actual}</p>
                  <p className="text-xs text-muted-foreground">
                    {disagrees ? 'differs from what is configured' : 'reached from inside the endpoint'}
                  </p>
                </>
              ) : (<>
                  <p className="text-muted-foreground">{appApplied ? 'Applied by the app itself' : 'Not measured'}</p>
                  {/* Deliberately not "matches". Nothing checked this value, and
                      a page that reads absence of evidence as agreement is how a
                      misconfigured deployment looks healthy. */}
                  <p className="text-xs text-muted-foreground">{CONNECTION_STATUS_NOTE[status]}</p>
                </>
              )}
            </div>
          </div>

          {/* The failure in the dependency's own words. The statement that fixes
              it is not repeated here: it is in What to fix at the top of the
              page, once, alongside every other blocked check including the
              table ones that have no row to live in. */}
          {check && check.status !== 'ok' ? (<Alert>
              <CircleAlert />
              <AlertDescription>
                {check.error || check.detail}{' '}
                {check.remedy ? 'The statement that fixes this is under “What to fix” above.' : ''}
              </AlertDescription>
            </Alert>
          ) : null}

          {row.intended ? (<Alert>
              <Clock />
              <AlertDescription>
                <strong>Intended: {row.intended}</strong>, recorded
                {row.intendedBy ? ` by ${row.intendedBy}` : ''}
                {row.intendedAt ? ` on ${formatCheckedAt(row.intendedAt)}` : ''}. This has not changed the running
                system.
              </AlertDescription>
            </Alert>
          ) : null}

          {problems.map((finding) => {
            const Icon = SEVERITY_ICON[finding.severity];
            return (<Alert key={finding.id}>
                <Icon />
                <AlertDescription>
                  <strong>{finding.headline}.</strong> {finding.detail}
                </AlertDescription>
              </Alert>
            );
          })}

          {examples.length > 0 ? (<div className="connection-row-examples">
              <span>Try asking</span>
              <ul>
                {examples.map((example) => (<li key={example}>{example}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="connection-row-tier">
            <Badge variant={tierBadgeVariant(resource.changedBy)}>
              {row.editable ? <Pencil className="size-3" /> : <Lock className="size-3" />}
              {row.changedByLabel}
            </Badge>
            <p className="text-xs text-muted-foreground">{row.changedByNote}</p>
          </div>

          {editing ? (<div className="space-y-2">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={resource.label}
                aria-label={`New value for ${resource.label}`}
              />
              {/* The distinction the whole page rests on, restated at the moment
                  of the decision rather than only in the header. */}
              <p className="text-xs text-muted-foreground">
                {row.editable
                  ? 'Saving this applies it immediately. The app reads this value on every request.'
                  : 'Saving this records an intention only. The orchestrator keeps using its current value until ' +
                    'a new model version carries the change.'}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={saving || !draft.trim()}
                  // Closed only when the server took it. Closing either way
                  // discarded the typed value on a refusal and left a row that
                  // looked exactly like one that had saved, with the old value
                  // in it, and the banner explaining why potentially a screen
                  // further up.
                  onClick={async () => {
                    if (await onSave(draft.trim())) setEditing(false);
                  }}
                >
                  <Save className="size-3.5" /> {row.editable ? 'Save and apply' : 'Record intention'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (<div className="flex flex-wrap gap-2">
              {canWrite ? (<Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraft(row.intended ?? row.configured);
                    setEditing(true);
                  }}
                >
                  <Pencil className="size-3.5" /> {row.editable ? 'Change' : 'Record intended value'}
                </Button>
              ) : null}
              {row.intended ? (<Button variant="ghost" size="sm" disabled={saving} onClick={() => void onClear()}>
                  <Undo2 className="size-3.5" /> Discard intention
                </Button>
              ) : null}
            </div>
          )}

          {!row.editable ? <CopyableCommand command={resource.applyWith} /> : null}

          <p className="text-xs text-muted-foreground">
            {resource.arrivesBy}{' '}
            {resource.bundleVariable ? `Bundle variable: ${resource.bundleVariable}.` : 'No bundle variable configures this.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ConnectionsPage() {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [writeError, setWriteError] = useState('');

  // Two GETs, deliberately. `/api/settings` runs the same orchestrator preflight
  // server-side but returns only what it needs for the resource rows; the table
  // matrix and the check inventory need the whole report, and widening the
  // settings route to carry it would put one payload behind two audiences.
  const { report, error: preflightError, loading: preflightLoading, reload: reloadPreflight } = usePreflight();

  const requestedEntity = useRequestedEntity();
  const [tablesOpen, setTablesOpen] = useState(Boolean(requestedEntity));
  const [methodOpen, setMethodOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);

  // Somebody followed an entity link here. The matrix is the entry they were
  // sent to, so it is open before the first paint rather than after a click they
  // were not told to make.
  useEffect(() => {
    if (requestedEntity) setTablesOpen(true);
  }, [requestedEntity]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError('');
    // A refusal from a save that is no longer being made describes a state the
    // page is about to replace. Left up across a successful Re-check, it is a
    // problem the deployer can neither act on nor dismiss.
    setWriteError('');
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error(`the settings endpoint answered ${response.status}`);
      setPayload((await response.json()) as SettingsPayload);
    } catch (caught) {
      setError(`The app could not read its own configuration: ${(caught as Error).message}. ` +
          'Nothing below is current.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const reload = useCallback(() => {
    void loadSettings();
    void reloadPreflight();
  }, [loadSettings, reloadPreflight]);

  /** Saves one value, and says whether the server took it. */
  const write = useCallback(async (row: ResourceRow, value: string): Promise<boolean> => {
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
        await loadSettings();
        return true;
      } catch (caught) {
        setWriteError((caught as Error).message);
        return false;
      } finally {
        setSaving('');
      }
    },
    [loadSettings]
  );

  const clear = useCallback(async (row: ResourceRow) => {
      setSaving(row.resource.id);
      setWriteError('');
      try {
        const response = await fetch(`/api/settings/values/${encodeURIComponent(row.resource.id)}`, {
          method: 'DELETE',
        });
        if (!response.ok) throw new Error(`the settings endpoint answered ${response.status}`);
        await loadSettings();
      } catch (caught) {
        setWriteError((caught as Error).message);
      } finally {
        setSaving('');
      }
    },
    [loadSettings]
  );

  const findingsFor = useMemo(() => {
    const grouped = new Map<string, DriftFinding[]>();
    for (const finding of payload?.drift ?? []) {
      if (!finding.resourceId) continue;
      grouped.set(finding.resourceId, [...(grouped.get(finding.resourceId) ?? []), finding]);
    }
    return grouped;
  }, [payload]);

  // Memoized rather than defaulted inline: a fresh `[]` on every render makes
  // the map below a new object every render, and the row counts that depend on
  // it recompute for eighteen resources each time the page redraws.
  const checks = useMemo(() => report?.checks ?? [], [report]);
  const checkById = useMemo(() => new Map(checks.map((check) => [check.id, check])), [checks]);
  const blocked = checks.filter((check) => check.status !== 'ok');
  const tableChecks = checks.filter((check) => check.kind === 'table');

  const counts = useMemo(() => {
    const rows = payload?.resources ?? [];
    const statuses: ConnectionStatus[] = [];
    const markers: DriftMarker[] = [];
    for (const row of rows) {
      const check = row.resource.actualFromCheck ? checkById.get(row.resource.actualFromCheck) : undefined;
      statuses.push(connectionStatus({
          check,
          appApplied: !row.resource.agentKey && !row.resource.actualFromCheck,
        })
      );
      markers.push(driftMarker({
          findingIds: (findingsFor.get(row.resource.id) ?? []).map((finding) => finding.id),
          intended: row.intended,
        })
      );
    }
    return connectionCounts({ statuses, markers });
  }, [payload, checkById, findingsFor]);

  const wide = (payload?.drift ?? []).filter((finding) => !finding.resourceId);
  // One list, one retry. Two error alerts each offering "Try again" would be two
  // controls for one intention, and the page reads both routes on every load.
  const problems = [preflightError, error].filter(Boolean);
  const principal = report?.principal_resolved ? report.principal : '';

  return (<div className="page-shell connections-page">
      <div className="page-heading">
        <div>
          <p className="section-label">Deployment</p>
          <h2>Connections</h2>
          <p>
            Every agent, model, Genie space, warehouse, catalog and store this deployment is wired to: whether it
            can reach each one, what it was configured with, what it is demonstrably using, and what it would take
            to change it.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reload}>
          <RefreshCw className="size-3.5" /> Re-check
        </Button>
      </div>

      <Alert>
        <Lock />
        <AlertDescription>
          <strong>Most of this cannot be changed from a form, and each row says which.</strong> The orchestrator's
          Genie spaces, catalog and warehouse are baked into the model artifact when the agent is logged, so
          changing one takes a new model version rather than a save. Rows marked{' '}
          <em>{CHANGED_BY['app-runtime'].label}</em> are the only ones this app applies itself.
        </AlertDescription>
      </Alert>

      {preflightLoading && !report ? (<Card>
          <CardHeader>
            <CardTitle>Checking dependencies…</CardTitle>
            <CardDescription>
              Asking the agent to reach the model endpoint, both Genie spaces, the warehouse and every table, and
              reading back what this deployment was configured with.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
      ) : null}

      {problems.length > 0 ? (<Alert>
          <CircleAlert />
          <AlertDescription>
            {problems.map((problem) => (<span key={problem} className="block">
                {problem}
              </span>
            ))}
            <Button variant="outline" size="sm" onClick={reload}>
              <RefreshCw /> Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {writeError ? (<Alert data-testid="settings-write-error">
          <CircleAlert />
          <AlertDescription>{writeError}</AlertDescription>
        </Alert>
      ) : null}

      {/* Only ever visible to someone who followed an entity link here and whose
          entry has since stopped being tracked. Silence in that case would be
          the page answering a question it had not been asked. */}
      <EntityHighlight tracked={tableChecks.map((check) => check.name)} ready={!!report} />

      {report || payload ? (<div className="connections-status" data-testid="drift-summary">
          <p className="connections-status-headline">
            {report?.status === 'ok' && payload?.status === 'ok' ? <CircleCheck className="size-4" /> : null}
            {report ? preflightHeadline(report) : STATUS_HEADLINE[payload!.status]}
          </p>
          <p className="connections-status-counts">
            {report
              ? `${report.counts.ok} reachable · ${report.counts.failed} blocked · ${report.counts.unverified} not checked`
              : 'No dependency check answered'}
            {payload ? ` · ${counts.drifted} drifted · ${counts.pending} pending` : ''}
          </p>
          {payload && payload.status !== 'ok' ? (<p className="connections-status-counts">{STATUS_HEADLINE[payload.status]}</p>
          ) : null}
          <p className="connections-status-meta">
            {report ? `Checked ${formatCheckedAt(report.checked_at)} · tables declared by ${report.table_source}` : ''}
            {payload
              ? `${report ? ' · ' : ''}app build ${payload.appBuildSha || 'unknown'} · orchestrator build ${
                  payload.modelBuildSha || 'unknown'
                }${
                  payload.orchestratorReported
                    ? ' · the served model version reported its own configuration'
                    : ' · the served model version did not report its own configuration'
                }${payload.storeAvailable ? '' : ' · recorded values cannot be read or saved'}`
              : ''}
          </p>
          {wide.map((finding) => {
            const Icon = SEVERITY_ICON[finding.severity];
            return (<Alert key={finding.id}>
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

      {/* Who the deployment is connected AS, once. It was the ShieldCheck alert
          on one page and the IdentityPanel card on the other, saying overlapping
          things about the same two principals. Collapsed it is the one fact
          somebody arriving from the gear wants: the identity every check below
          ran under. */}
      <Disclosure
        open={identityOpen}
        onToggle={() => setIdentityOpen((was) => !was)}
        summary="Connected as"
        aside={principal || 'the Player Insights service principal'}
      >
        <IdentityPanel checkedAs={principal} />
      </Disclosure>

      {/* Kept whole, and kept at the top, against the general rule that
          everything collapses. Every other block on this page describes state;
          this one is the only thing on it a reader can act on, and most of what
          it carries belongs to the table checks, which have no resource row to
          hold them. It renders only when something is blocked, so a healthy
          deployment never sees it. */}
      {blocked.length > 0 ? (<Card>
          <CardHeader>
            <CardTitle>What to fix</CardTitle>
            <CardDescription>
              Each statement is the literal fix, already filled in with the serving principal and the object it needs.
              Run it as a workspace admin.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {blocked.map((check) => (<PreflightRemedyRow key={check.id} check={check} />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {payload
        ? GROUPS.map((group) => {
            const rows = payload.resources.filter((row) => group.kinds.includes(row.resource.kind));
            if (rows.length === 0) return null;
            return (<section key={group.title} className="connection-group">
                <div>
                  <h3 className="text-sm font-semibold">{group.title}</h3>
                  <p className="text-xs text-muted-foreground">{group.blurb}</p>
                </div>
                <div className="connection-rows">
                  {rows.map((row) => (<ConnectionRow
                      key={row.resource.id}
                      row={row}
                      check={row.resource.actualFromCheck ? checkById.get(row.resource.actualFromCheck) : undefined}
                      findings={findingsFor.get(row.resource.id) ?? []}
                      saving={saving === row.resource.id}
                      onSave={(value) => write(row, value)}
                      onClear={() => clear(row)}
                    />
                  ))}
                </div>
              </section>
            );
          })
        : null}

      {tableChecks.length > 0 ? (<Disclosure
          open={tablesOpen}
          onToggle={() => setTablesOpen((was) => !was)}
          summary="Unity Catalog tables"
          aside={`${tableChecks.length} declared · ${tableChecks.filter((check) => check.status !== 'ok').length} blocked`}
        >
          <p className="text-sm text-muted-foreground">
            Every table declared as a model resource, read one row at a time as the serving principal. A table Genie
            curates but the model never declared is the failure that once broke every Data Genie call, so an
            undeclared table shows here as blocked rather than absent.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableChecks.map((check) => (// Addressable and, when an answer linked here, highlighted.
                // The row is the entry an entity link lands on, so it carries
                // the id rather than the block around it.
                <TableRow key={check.id} {...entityRowProps(check.name, requestedEntity)}>
                  <TableCell>{check.name}</TableCell>
                  <TableCell>
                    <Badge variant={preflightBadgeVariant(check.status)}>
                      {PREFLIGHT_STATUS_LABEL[check.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>{check.error || check.detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Disclosure>
      ) : null}

      {report ? (<Disclosure
          open={methodOpen}
          onToggle={() => setMethodOpen((was) => !was)}
          summary="How this was checked"
          aside={`${checks.length} checks · ${report.assumptions.length} stated limits`}
        >
          <p className="text-sm text-muted-foreground">
            {report.source === 'agent'
              ? 'The agent ran these checks inside the serving endpoint, so they reflect the serving principal.'
              : 'The agent never answered, so only the app-side check ran. Nothing behind the endpoint has a verdict.'}
          </p>
          {checks.map((check) => (<div className="health-row" key={check.id}>
              <span>{check.label}</span>
              <Badge variant={preflightBadgeVariant(check.status)}>{PREFLIGHT_STATUS_LABEL[check.status]}</Badge>
            </div>
          ))}
          {report.assumptions.length ? (<Alert>
              <CircleAlert />
              <AlertDescription>
                <strong>What this check does not prove.</strong>
                <ul>
                  {report.assumptions.map((assumption) => (<li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
        </Disclosure>
      ) : null}

      {loading && !payload ? <Skeleton className="h-4 w-1/3" /> : null}
    </div>
  );
}
