/**
 * Run Explorer: every recorded run, and one run's trace read four ways.
 *
 * Split out of App.tsx when the pages became modules. `TraceUnavailable` comes
 * with it and stays unexported: it is this page's way of saying why a pane is
 * empty, and nothing else has ever rendered it.
 *
 * The Timeline tab used to be a second timing view, `Waterfall`, written here.
 * It is the shared `TraceTimeline` now, the one the answer card draws, and the
 * old one is deleted rather than restyled to resemble it. Two views of one
 * measurement is how this page came to disagree with the answer it was opened
 * from: the waterfall floored a bar at 4% of the track so a label would fit
 * inside it, and scaled the axis to the last stage's end rather than the run's
 * measured envelope, so a step that took 1% of the run drew four times too wide
 * against a total the run never reported. What Run Explorer gains by sharing is
 * everything the answer's panel already had: the roll-up by tool type, and a row
 * that opens onto the arguments and result the agent recorded.
 */
import { useSearchParams } from 'react-router';
import { useState, useEffect, useRef } from 'react';
import './styles/routes/runs.css';
import { listAvailability, listUnreachable, type ListAvailability } from './list-availability';
import { UnavailablePanel } from './UnavailablePanel';
import { unavailableNotice } from './unavailable-copy';
import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './ui';
import { CircleAlert, Search, Workflow } from 'lucide-react';
import { conversationHref } from './conversation-links';
import { readConversationList } from './initial-rail';
import { RunDetails } from './RunDetails';
import { FinalAnswer } from './FinalAnswer';
import { useRunTrace, type RunTraceState } from './app-state';
import { PageHeading } from './page-chrome';
import { RunHeader } from './RunHeader';
import { astPill } from './run-header';
import { runLabel } from './run-label';
import { TraceDag } from './TraceDag';
import { TraceTimeline } from './TraceTimeline';
import type { Conversation, Run } from './app-types';
import { UserDrilldownLink } from './UserDrilldownLink';
import { RunRatingBadge } from './RunRatingBadge';
import { RunOverviewKpis } from './RunOverviewKpis';
import {
  conversationFilterOptions,
  conversationRunNumber,
  matchingRuns,
  resolveRunSelection,
  runDetailMode,
  searchWithRun,
  toolStageDurationMs,
  usernameFilterOptions,
  validRunId,
} from './run-explorer-state';
import { showsAdminSurfaces, useRole } from './role';
import { answerRunVerdict } from '../../shared/run-verdict';
import { UsedThisRun } from './UsedThisRun';
import {
  applyRunLabelOverride,
  applyRunLabelOverrideToList,
  readRunLabelOverride,
  rememberRunLabelOverride,
  type RunLabelOverride,
} from './run-header-labels';
import { AIAnalysisCaveat } from './AIAnalysisCaveat';

/** Stages whose time belongs to data work, including older traces that tagged
 * the finder or SQL wrapper as an agent stage instead of a tool stage. */
/**
 * How much of a run was data work, as a figure that fits inside the run.
 *
 * This read 184.6s on a run whose wall clock was 152.3s, which is not a
 * measurement of anything: it was the same milliseconds counted twice over. The
 * agent records a tree, not a list. `data_source_finder` is one stage spanning
 * the whole discovery phase, and inside it sit the `step-n` model turns and,
 * inside those, every tool call the model asked for. Adding the parent to its
 * own children charges the run for the finder's span plus a second copy of
 * everything that happened during it, and the finder's name matches the pattern
 * above, so it was always in the sum.
 *
 * So parents are dropped and only the innermost data stages are counted, which
 * is also the honest reading of the label: the finder's span includes the model
 * calls that chose the steps, and those are not data work. What is left is
 * unioned rather than added, because a step's tool calls can run in parallel.
 *
 * `wallMs` is the run's own duration, the figure the tile beside this one
 * prints. Where the union is exact the union cannot exceed it, so the bound
 * only ever applies on the fallback path below, where starts were never
 * recorded and there is nothing to union: a sum of parallel leaves is capped at
 * the run it happened inside rather than published as a longer run than
 * happened.
 */
export function RunExplorerFilters({
  conversationFilter,
  usernameFilter,
  conversationOptions,
  usernameOptions,
  conversationsUnreadable = false,
  onConversationChange,
  onUsernameChange,
}: {
  conversationFilter: string;
  usernameFilter: string;
  conversationOptions: Array<{ id: string; label: string }>;
  usernameOptions: Array<{ value: string; label: string }>;
  conversationsUnreadable?: boolean;
  onConversationChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
}) {
  const conversationLabel = conversationsUnreadable
    ? 'Conversations could not be read'
    : (conversationOptions.find((option) => option.id === conversationFilter)?.label ?? 'All conversations');
  const usernameLabel = usernameOptions.find((option) => option.value === usernameFilter)?.label ?? 'All users';

  return (
    <div className="run-list-filters">
      <div className="run-filter-field">
        <Select
          value={conversationFilter || 'all'}
          onValueChange={(value) => onConversationChange(value === 'all' ? '' : value)}
        >
          <SelectTrigger
            className="run-conversation-filter"
            aria-label={`Filter runs by conversation: ${conversationLabel}`}
            title={conversationLabel}
          >
            <span className="run-filter-label">{conversationLabel}</span>
          </SelectTrigger>
          <SelectContent
            className="app-select-content run-filter-menu"
            position="popper"
            align="start"
            sideOffset={4}
            collisionPadding={12}
          >
            <SelectItem value="all">All conversations</SelectItem>
            {conversationOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="run-filter-field">
        <Select
          value={usernameFilter || 'all'}
          onValueChange={(value) => onUsernameChange(value === 'all' ? '' : value)}
        >
          <SelectTrigger
            className="run-username-filter"
            aria-label={`Filter runs by username: ${usernameLabel}`}
            title={usernameLabel}
          >
            <span className="run-filter-label">{usernameLabel}</span>
          </SelectTrigger>
          <SelectContent
            className="app-select-content run-filter-menu"
            position="popper"
            align="start"
            sideOffset={4}
            collisionPadding={12}
          >
            <SelectItem value="all">All users</SelectItem>
            {usernameOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function RunExplorer() {
  const role = useRole();
  const canEdit = showsAdminSurfaces(role.state);
  const [searchParams, setSearchParams] = useSearchParams();
  const [runs, setRuns] = useState<Run[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [listReloadToken, setListReloadToken] = useState(0);
  const [traceReloadToken, setTraceReloadToken] = useState(0);
  // Held here rather than inside the Details tab that draws it, and that is a
  // decision about the reader rather than about the code: Radix unmounts a tab's
  // content when you leave it, so state living down there would reset every time
  // somebody looked at the Timeline and came back. Wanting to see raw payloads is
  // a property of the person reading, not of the run they happen to have open, so
  // it also survives selecting a different run -- an inspection is usually
  // several runs compared the same way, and re-flipping the switch for each of
  // them is the kind of small friction nobody reports and everybody feels. It
  // resets on reload, which is the right scope for a preference nothing stores.
  const [advanced, setAdvanced] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const workspaceScrollRef = useRef<HTMLDivElement>(null);
  const [searchText, setSearchText] = useState('');
  // Always "All conversations" on arrival. This used to be seeded from
  // `?conversation=`, so clicking through from Ask PIA hid every other run in
  // the store behind a filter the reader never set and had no reason to look
  // for. Narrowing the list is the reader's decision; the carried-over
  // conversation only decides which run OPENS (see `conversationRun` below).
  const [conversationFilter, setConversationFilter] = useState('');
  const [usernameFilter, setUsernameFilter] = useState('');
  // Whether the rows below are stored runs, seeded ones, or nothing at all
  // because nobody could find out. Classified in list-availability.ts from what
  // the server said, not guessed from the ids or the row count: an empty store
  // and an unreachable one return the same zero rows and are fixed by
  // completely different people.
  const [runsAvailability, setRunsAvailability] = useState<ListAvailability | null>(null);
  const [conversationAvailability, setConversationAvailability] = useState<ListAvailability | null>(null);
  const [labelOverlay, setLabelOverlay] = useState<{
    runId: string;
    value: RunLabelOverride | null;
  } | null>(null);
  const retryRunList = () => {
    setLoading(true);
    setRunsAvailability(null);
    setListReloadToken((token) => token + 1);
  };
  /*
   * Two reads, issued together and awaited separately, and the second one is
   * the fix for the defect Sam reported: Ask listed three conversations while
   * this filter listed six, off the same Lakebase.
   *
   * WHICH CONVERSATIONS EXIST IS ANSWERED BY `/api/conversations`, on both
   * surfaces. This page used to derive the question from `/api/runs` -- a
   * conversation existed for the filter only once a turn inside it had stored a
   * trace -- while Ask read the conversation rows and then collapsed the ones
   * sharing a title. Two surfaces, two different answers, one store. The runs
   * are still what a conversation is CALLED here, because the first prompt of a
   * thread reads better in a filter than a stored title does, and a conversation
   * with no run yet falls back to its title rather than being dropped.
   *
   * Separately awaited because they gate different things. `loading` covers the
   * run rows, so the run list must not sit under skeletons waiting on a read
   * that only fills the filter above it.
   */
  useEffect(() => {
    let live = true;
    const conversationsRead = readConversationList();
    void fetch('/api/runs')
      .then(async (response) => {
        if (!response.ok) throw new Error('Runs could not be read.');
        const rows = (await response.json()) as Run[];
        if (live) setRunsAvailability(listAvailability({ headers: response.headers, rowCount: rows.length }));
        return rows;
      })
      .catch(() => {
        // No stand-in row. This used to insert one complete, plausible run,
        // carrying a real colleague's name, a duration and a five-star rating,
        // none of which had ever happened. It was the last place in the client
        // that answered "I do not know" with a fabrication.
        if (live) setRunsAvailability(listUnreachable());
        return [] as Run[];
      })
      .then((rows) => {
        if (live) setRuns(rows);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    void conversationsRead.then((list) => {
      if (!live) return;
      // Null, not an empty array, when the list could not be read, and the
      // filter says so rather than offering "All conversations" over a store
      // nobody could reach. An empty filter would read as a deployment with one
      // conversation in it.
      setConversations(list.conversations ?? []);
      setConversationAvailability(list.availability);
    });
    return () => {
      live = false;
    };
  }, [listReloadToken]);
  const conversationsUnreadable = conversationAvailability?.origin === 'unavailable';
  const conversationOptions = conversationFilterOptions(conversations, runs);
  const usernameOptions = usernameFilterOptions(runs);
  const visibleRuns = matchingRuns(runs, {
    conversationId: conversationFilter,
    username: usernameFilter,
    search: searchText,
  });
  const requestedId = searchParams.has('run') ? searchParams.get('run') : null;
  const requestedConversation = searchParams.get('conversation');
  const selection = resolveRunSelection(runs, requestedId, requestedConversation);
  const selected = selection.state === 'selected' ? selection.run : null;
  const automaticRunId = selection.automaticRunId;
  const requestedMissing = !loading && runsAvailability?.origin !== 'unavailable' && selection.state === 'invalid';
  // The automatic first selection is navigation cleanup, not a new history
  // entry. Explicit row choices below push instead, so Back/Forward restores the
  // previous run. The cloned params preserve conversation and any future filters.
  useEffect(() => {
    if (loading || runsAvailability?.origin === 'unavailable' || selection.state !== 'selected' || !automaticRunId) {
      return;
    }
    setSearchParams((current) => searchWithRun(current, automaticRunId), { replace: true });
  }, [automaticRunId, loading, runsAvailability?.origin, selection.state, setSearchParams]);
  // Every number and every stage below belongs to the selected run. The panels
  // used to render one hardcoded reference trace no matter what was selected,
  // which put a correct id, wall time, and status beside stages from nothing.
  const traceState = useRunTrace(selected?.id, traceReloadToken);
  const detailMode = runDetailMode({
    listLoading: loading,
    listOrigin: runsAvailability?.origin ?? null,
    selection: selection.state,
    trace: traceState.status,
  });
  const runTrace = traceState.status === 'ready' ? traceState.data : null;
  const stages = runTrace?.trace?.stages ?? [];
  const answerVerdict = runTrace
    ? answerRunVerdict({
        stages,
        caveats: runTrace.caveats,
        narrative: runTrace.narrative,
        content: runTrace.takeaway,
      })
    : undefined;
  const isReference = runTrace?.mode === 'representative';
  // Two different quantities, deliberately not reconciled into one. `trace.toolCalls`
  // is the agent's own counter, incremented once per external call it makes.
  // `toolStages` is the subset of stages it tagged as tool work for the timeline,
  // `discover` and `synthesis` increment the counter while being tagged `agent`, so
  // the counter is routinely larger and the list is often empty on a real run.
  // Bounded by the run's own duration, which is the figure the tile beside it
  // prints. Two tiles read side by side are one claim, and the second cannot
  // report more time than the first without calling the first wrong.
  const toolStageMs = toolStageDurationMs(stages, selected?.duration_ms ?? null);
  const agentToolCalls = runTrace?.trace?.toolCalls ?? selected?.tool_calls ?? null;
  const groundedness = runTrace?.benchmark?.groundedness ?? null;
  const tokens = runTrace?.trace ?? null;
  // Unmeasured, not zero, for the same reason the tool time above is. A run whose
  // gateway reported no usage at all is not a run that spent no tokens.
  const totalTokens = typeof tokens?.total_tokens === 'number' ? tokens.total_tokens : null;
  const promptTokens = typeof tokens?.prompt_tokens === 'number' ? tokens.prompt_tokens : null;
  const completionTokens = typeof tokens?.completion_tokens === 'number' ? tokens.completion_tokens : null;
  const ratePath = selected?.conversation_id ? conversationHref(selected.conversation_id, selected.id) : null;
  const displayed = selected
    ? applyRunLabelOverride(selected, canEdit && labelOverlay?.runId === selected.id ? labelOverlay.value : null)
    : null;

  // The complete right workspace is one bounded scroll owner: header, tabs,
  // active view, map and selected-step detail move together. This is deliberately
  // not a ref per tab; nested tab scrollers made the map look clipped and let
  // selection move a child without moving the workspace the reader was in.
  // The Recent runs rail is a sibling owner and is never written here.
  useEffect(() => {
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [selected?.id]);

  useEffect(() => {
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [activeTab]);

  useEffect(() => {
    if (!canEdit || !selected?.id) return;
    const runId = selected.id;
    let live = true;
    void readRunLabelOverride(runId).then((overlay) => {
      if (!live) return;
      setLabelOverlay({ runId, value: overlay });
      if (overlay) {
        setRuns((rows) => applyRunLabelOverrideToList(rows, runId, overlay));
      }
    });
    return () => {
      live = false;
    };
  }, [canEdit, selected?.id]);
  return (
    <div className="page-shell run-explorer">
      {/* No actions. The Advanced switch was here, and the only thing that read
          it was the Details tab, so on the tab this page opens on it animated and
          changed nothing on screen. It is drawn by RunDetails.tsx now, with the
          panels it governs. */}
      <PageHeading title="Run Explorer" />
      <div className="explorer-layout">
        <Card className="run-list ast-surface-primary">
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
            <RunExplorerFilters
              conversationFilter={conversationFilter}
              usernameFilter={usernameFilter}
              conversationOptions={conversationOptions}
              usernameOptions={usernameOptions}
              conversationsUnreadable={conversationsUnreadable}
              onConversationChange={setConversationFilter}
              onUsernameChange={setUsernameFilter}
            />
            <div className="run-search">
              <Search />
              <Input
                placeholder="Search across runs"
                aria-label="Search runs by conversation, prompt, or person"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="p-2">
            {loading ? (
              <div className="run-list-skeleton" aria-busy="true" role="status" aria-live="polite">
                <span className="sr-only">Loading recent runs</span>
                {[1, 2, 3].map((item) => (
                  <Skeleton key={item} className="h-24" aria-hidden="true" />
                ))}
              </div>
            ) : runsAvailability?.origin ===
              'unavailable' /* Checked before the empty state, and this order is the whole point.
                 Both arrive here with no rows, and "No runs yet" over an outage
                 tells a customer their history is gone. */ ? (
              <UnavailablePanel
                notice={unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE' })}
                onRetry={retryRunList}
              />
            ) : runs.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Workflow />
                  </EmptyMedia>
                  <EmptyTitle>No runs yet</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : visibleRuns.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search />
                  </EmptyMedia>
                  <EmptyTitle>No matching runs</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              visibleRuns.map((run) => (
                <RunListItem
                  key={run.id}
                  run={run.id === displayed?.id && displayed ? displayed : run}
                  active={run.id === selected?.id}
                  onSelect={() => {
                    setLabelOverlay(null);
                    setTraceReloadToken(0);
                    setSearchParams((current) => searchWithRun(current, run.id));
                  }}
                />
              ))
            )}
          </CardContent>
        </Card>
        <div
          className="run-detail ast-surface-primary"
          ref={workspaceScrollRef}
          aria-busy={detailMode === 'loading' || undefined}
        >
          {detailMode === 'loading' ? (
            <RunDetailSkeleton />
          ) : detailMode === 'error' && runsAvailability?.origin === 'unavailable' ? (
            <UnavailablePanel
              notice={unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE' })}
              onRetry={retryRunList}
            />
          ) : detailMode === 'empty' ? (
            <RunDetailState
              title="No runs yet"
              description="Recorded runs will appear here after the first question finishes."
            />
          ) : detailMode === 'invalid' && requestedMissing ? (
            <RunDetailState
              title="Run unavailable"
              description={
                validRunId(requestedId)
                  ? 'This run is not in the store. It may have been deleted or created in a different workspace.'
                  : 'This run link does not contain a valid run id.'
              }
            />
          ) : detailMode === 'missing' ? (
            <RunDetailState
              title="Run unavailable"
              description="This run was removed after the list loaded. Choose another run from Recent runs."
            />
          ) : detailMode === 'error' && traceState.status === 'error' ? (
            <UnavailablePanel
              notice={unavailableNotice({
                surface: 'run-trace',
                code: 'DEPENDENCY_UNAVAILABLE',
                detail: traceState.message,
                interactive: true,
              })}
              onRetry={() => setTraceReloadToken((token) => token + 1)}
            />
          ) : detailMode === 'ready' && displayed && runTrace ? (
            <>
              <RunHeader
                run={displayed}
                conversationId={displayed?.conversation_id ?? undefined}
                conversationRun={conversationRunNumber(runs, displayed)}
                toolCalls={agentToolCalls}
                reference={isReference}
                groundedness={groundedness}
                canEdit={canEdit}
                canOpenUser={canEdit}
                onLabelsSaved={(overlay) => {
                  const id = selected?.id;
                  if (id) setLabelOverlay({ runId: id, value: overlay });
                  if (id) setRuns((rows) => applyRunLabelOverrideToList(rows, id, overlay));
                  if (selected?.conversation_id) rememberRunLabelOverride(selected.conversation_id, overlay);
                }}
              />
              {isReference && (
                <Alert>
                  <CircleAlert />
                  <AlertDescription>
                    {runTrace?.note || 'This is the representative reference trace, not a live agent run.'}
                  </AlertDescription>
                </Alert>
              )}
              <Tabs value={activeTab} onValueChange={setActiveTab} className="run-detail-tabs">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="map">Agent map</TabsTrigger>
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  <TabsTrigger value="details">Details</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="run-detail-tab-panel">
                  <div className="run-detail-content space-y-4 pt-4">
                    {selected && traceState.status === 'ready' ? (
                      <UsedThisRun used={runTrace?.runtimeUsed ?? null} />
                    ) : null}
                    <RunOverviewKpis
                      durationMs={selected?.duration_ms}
                      toolStageMs={runTrace?.trace ? toolStageMs : null}
                      agentToolCalls={agentToolCalls}
                      stages={stages}
                      totalTokens={totalTokens}
                      promptTokens={promptTokens}
                      completionTokens={completionTokens}
                      feedback={displayed?.feedback}
                      legacyUsefulness={displayed?.rating}
                      ratePath={ratePath}
                    />
                    {runTrace.takeaway ? (
                      <FinalAnswer
                        takeaway={runTrace.takeaway}
                        narrative={runTrace.narrative}
                        charts={runTrace.charts}
                        sources={runTrace.sources}
                        caveats={runTrace.caveats}
                        derivation={runTrace.derivation}
                        sql={runTrace.sql}
                        truncated={selected?.truncated}
                        conversationId={selected?.conversation_id}
                        runId={selected?.id}
                      />
                    ) : runTrace?.note ? (
                      <p className="text-muted-foreground text-sm">{runTrace.note}</p>
                    ) : null}
                  </div>
                </TabsContent>
                <TabsContent value="map" className="run-detail-tab-panel">
                  <div className="run-detail-content space-y-4 pt-5">
                    {selected && traceState.status === 'ready' ? (
                      <UsedThisRun used={runTrace?.runtimeUsed ?? null} />
                    ) : null}
                    {stages.length > 0 ? (
                      <>
                        <TraceDag
                          stages={stages}
                          activeIndex={-1}
                          charts={runTrace?.charts}
                          trace={runTrace?.trace}
                          question={runTrace?.prompt ?? ''}
                          verdict={answerVerdict}
                          runStatus={displayed?.status}
                          scrollContainerRef={workspaceScrollRef}
                        />
                        <AIAnalysisCaveat className="ai-note" />
                      </>
                    ) : (
                      <TraceUnavailable state={traceState} />
                    )}
                  </div>
                </TabsContent>
                <TabsContent value="timeline" className="run-detail-tab-panel">
                  <div className="run-detail-content space-y-4 pt-5">
                    {/* The prompt, for the envelope row, which is the run's own
                    question here just as it is on the card. */}
                    {stages.length > 0 && runTrace?.trace ? (
                      <>
                        <TraceTimeline
                          variant="explorer"
                          trace={runTrace.trace}
                          question={runTrace.prompt ?? ''}
                          verdict={answerVerdict}
                          scrollContainerRef={workspaceScrollRef}
                        />
                        <AIAnalysisCaveat className="ai-note" />
                      </>
                    ) : (
                      <TraceUnavailable state={traceState} />
                    )}
                  </div>
                </TabsContent>
                <TabsContent value="details" className="run-detail-tab-panel">
                  <div className="run-detail-content space-y-4 pt-5">
                    {/* The switch that governs these panels is drawn by this component
                    too, which is the point of it being one. See RunDetails.tsx. */}
                    <RunDetails
                      trace={runTrace}
                      advanced={advanced}
                      onAdvancedChange={setAdvanced}
                      unavailable={<TraceUnavailable state={traceState} />}
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </>
          ) : (
            <RunDetailState title="No run selected" description="Choose a run from Recent runs." />
          )}
        </div>
      </div>
    </div>
  );
}

/** Full-size placeholder for the header, tabs, KPIs, and answer region. */
export function RunDetailSkeleton() {
  return (
    <div className="run-detail-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Loading run details</span>
      <div className="run-detail-skeleton-head" aria-hidden="true">
        <div>
          <Skeleton className="run-detail-skeleton-title" />
          <Skeleton className="run-detail-skeleton-ident" />
        </div>
        <Skeleton className="run-detail-skeleton-duration" />
      </div>
      <div className="run-detail-skeleton-tabs" aria-hidden="true">
        {[1, 2, 3, 4].map((tab) => (
          <Skeleton key={tab} />
        ))}
      </div>
      <div className="summary-grid run-kpi-grid run-detail-skeleton-kpis" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((tile) => (
          <Card className="run-kpi-card" key={tile}>
            <CardContent>
              <Skeleton className="run-detail-skeleton-label" />
              <Skeleton className="run-detail-skeleton-value" />
              <Skeleton className="run-detail-skeleton-subtitle" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="run-detail-skeleton-answer" aria-hidden="true">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    </div>
  );
}

function RunDetailState({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="run-detail-state">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Workflow />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * One row of the Recent runs list.
 *
 * Its own component so that what a row says about a run can be rendered from a
 * run, rather than only from a mounted page: the list is filled by a fetch in an
 * effect, and effects do not run under the static renderer these tests use, so
 * every row was previously unreachable from a test.
 */
export function RunListItem({ run, active, onSelect }: { run: Run; active: boolean; onSelect: () => void }) {
  const displayedStatus = run.status;
  return (
    <button type="button" onClick={onSelect} aria-pressed={active} className={`run-item ${active ? 'active' : ''}`}>
      <div className="run-item-head">
        <span className="run-item-pills">
          <Badge variant="outline" className={`run-status-pill ${astPill(displayedStatus)}`}>
            {displayedStatus ?? 'unknown'}
          </Badge>
          {typeof run.tool_calls === 'number' && (
            <Badge variant="outline" className="ast-pill ast-pill--neutral-outline">
              Tools · <span className="ast-num">{run.tool_calls.toLocaleString()}</span>
            </Badge>
          )}
          <RunRatingBadge feedback={run.feedback} legacyUsefulness={run.rating} />
        </span>
        {/* The one figure in the row that stacks into a real column: the head is
            a space-between row, so every date in the list sits on the same right
            edge and a proportional face makes that column ragged. */}
        <span className="run-item-date ast-num">{new Date(run.created_at).toLocaleDateString()}</span>
      </div>
      <span className="run-item-prompt">{runLabel(run)}</span>
      <span className="run-item-meta">
        <span>
          <UserDrilldownLink identity={run.stakeholder} compact />
          {typeof run.duration_ms === 'number' && Number.isFinite(run.duration_ms) ? (
            <>
              {' · '}
              {/* The figure in mono, the name beside it in the body face. A
                  person's name is not a measurement and must not read as one. */}
              <span className="ast-num">{(run.duration_ms / 1000).toFixed(1)}s</span>
            </>
          ) : (
            ''
          )}
        </span>
      </span>
    </button>
  );
}

/**
 * What the trace panes show when there are no stages to draw.
 *
 * One component for every such case, so no pane can quietly fall back to a
 * reference trace to fill the space. A run with nothing to show says so.
 */
function TraceUnavailable({ state }: { state: RunTraceState }) {
  if (state.status === 'loading') {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-16" />
        ))}
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  const [title, description] =
    state.status === 'missing'
      ? ['This run is no longer stored', 'It may have been created in a different workspace or database.']
      : state.status === 'ready'
        ? ['No trace for this run', state.data.note]
        : ['No run selected', ''];
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Workflow />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}
