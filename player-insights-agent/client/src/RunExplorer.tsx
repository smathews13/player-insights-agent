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
import { Link, useSearchParams } from 'react-router';
import { useState, useEffect } from 'react';
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
import { CircleAlert, Search, Star, Workflow } from 'lucide-react';
import { conversationHref } from './conversation-links';
import { RunDetails } from './RunDetails';
import { AnswerProse } from './DataEntityLinks';
import { SourcesModule } from './SourcesModule';
import { AstrolabeMark } from './AstrolabeMark';
import { ratingLabel, ratingOutOf } from './benchmark-summary';
import { useRunTrace, type RunTraceState } from './app-state';
import { PageHeading } from './page-chrome';
import { RunHeader } from './RunHeader';
import { astPill } from './run-header';
import { runLabel } from './run-label';
import { TraceDag } from './TraceDag';
import { TraceTimeline } from './TraceTimeline';
import type { Run } from './app-types';
import type { TraceStage } from './answer-shape';
import { UserIdentityChip } from './UserIdentityChip';

/**
 * What a tile says when the run recorded no such measurement.
 *
 * Words, never a zero: a stored answer from before token metering did not make a
 * free call, and "0" beside a non-zero call count reads as though the work was
 * measured and cost nothing.
 *
 * It was an em dash, which §7 of the rebuild spec spells out twice over -- no em
 * dashes anywhere, and unset renders "not set" in mono. A dash also has to be
 * read as absence, which is a convention rather than a sentence; the tile beside
 * it has said "Not rated" in words since it landed, and these now agree.
 *
 * The Benchmark Lab still dashes the same fact, in BenchmarkLab.tsx, which is
 * not this lane's file. See the note in explorer-geometry.test.ts.
 */
const ABSENT = 'not set';

/** Stages whose time belongs to data work, including older traces that tagged
 * the finder or SQL wrapper as an agent stage instead of a tool stage. */
function isDataWork(stage: TraceStage): boolean {
  return stage.kind === 'tool' || /data.source.finder|\bsql\b/i.test(`${stage.id} ${stage.name}`);
}

/**
 * Every stage this one ran inside, nearest first.
 *
 * Walked through `parent_id` rather than read off `depth`, because the chain
 * runs through stages that are not data work themselves: the finder's tool
 * calls hang off a `step-n` model turn, which hangs off the finder. A depth
 * comparison would miss that the finder encloses them. `seen` guards a
 * malformed trace whose parents cycle, which would otherwise spin here.
 */
function enclosingIds(stage: TraceStage, byId: Map<string, TraceStage>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([stage.id]);
  let above = stage.parent_id ? byId.get(stage.parent_id) : undefined;
  while (above && !seen.has(above.id)) {
    chain.push(above.id);
    seen.add(above.id);
    above = above.parent_id ? byId.get(above.parent_id) : undefined;
  }
  return chain;
}

/**
 * Milliseconds the spans cover between them, counting a shared instant once.
 *
 * The agent dispatches a step's tool calls through a thread pool, so two calls
 * can genuinely be in flight at the same moment. Their durations add up to more
 * time than the run had, which is not a contradiction: it is two things
 * happening at once, and a figure a reader compares against wall time has to
 * say so.
 */
function coveredMs(spans: readonly { from: number; to: number }[]): number {
  const ordered = [...spans].filter((span) => span.to > span.from).sort((left, right) => left.from - right.from);
  let covered = 0;
  let open: { from: number; to: number } | null = null;
  for (const span of ordered) {
    // Touching edges continue the same run of activity: one call returning at
    // the instant the next begins is what a serial loop looks like.
    if (!open || span.from > open.to) {
      if (open) covered += open.to - open.from;
      open = { from: span.from, to: span.to };
    } else if (span.to > open.to) {
      open.to = span.to;
    }
  }
  return open ? covered + (open.to - open.from) : covered;
}

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
export function toolStageDurationMs(stages: readonly TraceStage[], wallMs?: number | null): number | null {
  const dataWork = stages.filter(isDataWork);
  if (!dataWork.length) return null;
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const containers = new Set(dataWork.flatMap((stage) => enclosingIds(stage, byId)));
  const innermost = dataWork.filter((stage) => !containers.has(stage.id));
  // Empty only if every data stage encloses another, which takes a cycle in the
  // recorded parents. Then nothing is known about the nesting and the flat sum
  // is the most that can be said.
  const counted = innermost.length ? innermost : dataWork;
  // Strictly measured, not merely present: `start` is coerced to 0 when the wire
  // omitted it, and a union over stages that all begin at 0 returns the longest
  // of them, which would report a fiction as an exact overlap. Where starts were
  // not recorded the durations are added, as they always were.
  const total = counted.every((stage) => stage.startMeasured === true)
    ? coveredMs(counted.map((stage) => ({ from: stage.start, to: stage.start + stage.duration })))
    : counted.reduce((sum, stage) => sum + stage.duration, 0);
  return typeof wallMs === 'number' && wallMs > 0 && total > wallMs ? wallMs : total;
}

/**
 * What each tile on the Overview grid is a measurement of, in one sentence.
 *
 * Every one of these five figures has been read as something it is not. Wall
 * time and tool-stage time were compared as though the second were a share of
 * the first; the call count and the tool time were compared as though one were
 * the other's denominator, when the counter increments on stages the timing
 * never covered. A tile that states its own definition is cheaper than the
 * conversation that follows a reader deciding on one.
 *
 * Rendered as `title`, so the sentence arrives on hover without a second line
 * of text under every figure. That is a real limitation for a reader on a
 * keyboard or a screen reader, and the tiles are still labelled without it.
 */
export const KPI_HINTS = {
  wallTime: 'How long this run took from end to end, from the question arriving to the answer being stored.',
  toolStageTime:
    'How much of that run was spent in data work, counting nested and parallel steps once rather than twice.',
  agentToolCalls: 'How many external tool calls the agent recorded making while it answered this question.',
  llmTokens: 'How many tokens the model gateway metred for this run, split into the prompt and the reply.',
  userRating: 'What a person scored this answer out of five, or Not rated when nobody has scored it yet.',
} as const;

export function conversationRunTitle(runs: readonly Run[], selected: Run | null): string | undefined {
  if (!selected?.conversation_id) return undefined;
  const chronological = [...runs].reverse();
  const conversations = [...new Set(chronological.map((run) => run.conversation_id).filter(Boolean))];
  const conversation = conversations.indexOf(selected.conversation_id) + 1;
  const inConversation = chronological.filter((run) => run.conversation_id === selected.conversation_id);
  const run = inConversation.findIndex((item) => item.id === selected.id) + 1;
  return conversation > 0 && run > 0 ? `Conversation ${conversation}, Run ${run}` : undefined;
}

/** Conversations in the same chronological numbering used by the run header. */
export function conversationFilterOptions(runs: readonly Run[]): Array<{ id: string; label: string }> {
  const ids = [...new Set([...runs].reverse().map((run) => run.conversation_id).filter((id): id is string => Boolean(id)))];
  return ids.map((id, index) => ({ id, label: `Conversation ${index + 1}` }));
}

/**
 * The class a tile's value takes.
 *
 * `.ast-num` because §3 sets every stat value in DM Mono, and this is the one
 * spelling of that rule. It goes on the element rather than into the stylesheet
 * because `.summary-grid` is the Benchmark Lab's grid too: its `strong` rule asks
 * for tabular figures without setting the face, which in DM Sans is a declaration
 * with nothing to apply, and repointing a shared selector would repaint a page
 * this lane does not own.
 *
 * `.tile-absent` drops the words that stand in for a missing figure to secondary
 * ink, the same treatment "Not rated" has always had, so "not set" cannot be read
 * as a measured result.
 */
function tileValue(absent: boolean): string {
  return absent ? 'ast-num tile-absent' : 'ast-num';
}

export function RunExplorer() {
  const [searchParams] = useSearchParams();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  // Seeded from ?run= so "Explore full run" lands on the run it came from. The
  // previous default named a representative row that no live list contains, so
  // arriving from an answer always selected whatever happened to be first.
  const [selectedId, setSelectedId] = useState(searchParams.get('run') ?? '');
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
  const [searchText, setSearchText] = useState('');
  const [conversationFilter, setConversationFilter] = useState(searchParams.get('conversation') ?? '');
  // Whether the rows below are stored runs, seeded ones, or nothing at all
  // because nobody could find out. Classified in list-availability.ts from what
  // the server said, not guessed from the ids or the row count: an empty store
  // and an unreachable one return the same zero rows and are fixed by
  // completely different people.
  const [runsAvailability, setRunsAvailability] = useState<ListAvailability | null>(null);
  useEffect(() => {
    fetch('/api/runs')
      .then(async (response) => {
        const rows = (await response.json()) as Run[];
        setRunsAvailability(listAvailability({ headers: response.headers, rowCount: rows.length }));
        return rows;
      })
      .then(setRuns)
      .catch(() => {
        // No stand-in row. This used to insert one complete, plausible run,
        // carrying a real colleague's name, a duration and a five-star rating,
        // none of which had ever happened. It was the last place in the client
        // that answered "I do not know" with a fabrication.
        setRunsAvailability(listUnreachable());
        setRuns([]);
      })
      .finally(() => setLoading(false));
  }, []);
  const conversationOptions = conversationFilterOptions(runs);
  const visibleRuns = runs.filter((run) => {
    const inConversation = !conversationFilter || run.conversation_id === conversationFilter;
    const matchesSearch = `${runLabel(run)} ${run.stakeholder ?? ''} ${run.conversation_id ?? ''}`
      .toLowerCase()
      .includes(searchText.toLowerCase());
    return inConversation && matchesSearch;
  });
  /**
   * Whether a `?run=` deep link asked for a run that is not here.
   */
  const requestedId = searchParams.get('run');
  const requestedMissing = !loading && Boolean(requestedId) && !runs.some((run) => run.id === requestedId);
  // Looked up across every run, not just the filtered ones: typing in the search
  // box narrows the list, and used to also silently re-point the panels at
  // whatever happened to be first in the narrowed result.
  const chosen = runs.find((run) => run.id === selectedId) ?? null;
  // The conversation carried over from Ask PIA, when the reader clicked through
  // rather than opening a single answer. Runs arrive newest-first, so the first
  // one that belongs to it is that conversation's latest turn, which is the run
  // to open on: without this the Explorer defaulted to the newest run overall,
  // not the conversation the reader had on screen a moment ago. A conversation
  // with no stored run yet finds nothing and falls through to that default.
  const requestedConversation = searchParams.get('conversation');
  const conversationRun = requestedConversation
    ? (runs.find((run) => run.conversation_id === requestedConversation) ?? null)
    : null;
  // A link that named a run this list does not hold selects nothing at all,
  // until the reader picks one themselves. Refusing to guess is not refusing to
  // work: every row in the list is still one click away. A run the reader picks
  // (`chosen`) always wins over the one carried in from the conversation.
  const selected =
    chosen ??
    conversationRun ??
    (requestedMissing && selectedId === requestedId ? null : (visibleRuns[0] ?? runs[0] ?? null));
  // Every number and every stage below belongs to the selected run. The panels
  // used to render one hardcoded reference trace no matter what was selected,
  // which put a correct id, wall time, and status beside stages from nothing.
  const traceState = useRunTrace(selected?.id);
  const runTrace = traceState.status === 'ready' ? traceState.data : null;
  const stages = runTrace?.trace?.stages ?? [];
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
  const agentToolCalls = runTrace?.trace?.toolCalls ?? null;
  // Nothing was tagged, so the time spent in those calls is unmeasured, not zero.
  // Rendering 0.0s next to a non-zero call count reads as "the tools were free".
  // Which is also why no sentence under the grid reconciles them any more. A
  // paragraph there explained that the agent had recorded N external calls and
  // tagged none of them, which is the app explaining its own bookkeeping to a
  // reader who did not ask -- and it restated a figure already standing in the
  // tile beside it. The tile now says "not set", in the register the rest of the
  // page uses for a measurement nobody took.
  const toolStageTime = toolStageMs !== null ? `${(toolStageMs / 1000).toFixed(1)}s` : ABSENT;
  const groundedness = runTrace?.benchmark?.groundedness ?? null;
  const tokens = runTrace?.trace ?? null;
  // Unmeasured, not zero, for the same reason the tool time above is. A run whose
  // gateway reported no usage at all is not a run that spent no tokens.
  const totalTokens = typeof tokens?.total_tokens === 'number' ? tokens.total_tokens : null;
  // The split is printed only when both halves were metred. Half a split filled
  // in with a zero is a claim that the model read nothing, or wrote nothing.
  const tokenSplit =
    typeof tokens?.prompt_tokens === 'number' && typeof tokens?.completion_tokens === 'number'
      ? `${tokens.prompt_tokens.toLocaleString()} in / ${tokens.completion_tokens.toLocaleString()} out`
      : null;
  const rating = ratingLabel(selected?.rating);
  // Rating happens on the answer itself, through the feedback control in the
  // transcript, so the link goes to the conversation this run belongs to, and to
  // the answer inside it: the control being reached for belongs to one turn, and
  // landing at the top of a long thread leaves the reader to find which. A run
  // with no conversation -- a suite run -- has no rating path, and then no link
  // is offered rather than one that lands nowhere.
  //
  // `selected.id` is the answer's own message id, not a separate run key. See
  // conversation-links.ts, and RUNS_QUERY, which derives a conversation run from
  // the message that carries the trace.
  const ratePath = selected?.conversation_id
    ? conversationHref(selected.conversation_id, selected.id)
    : null;
  return (<div className="page-shell run-explorer">
      {/* No actions. The Advanced switch was here, and the only thing that read
          it was the Details tab, so on the tab this page opens on it animated and
          changed nothing on screen. It is drawn by RunDetails.tsx now, with the
          panels it governs. */}
      <PageHeading title="Run Explorer" />
      {requestedMissing && (<Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>
            {/* Why the link missed is the durable half and stays put. What is on
                screen underneath is not: selecting a row leaves `requestedId` in
                the URL, so this banner outlives the state it was describing, and
                "nothing is selected" then sits above four populated panes. A
                reader who is told the screen is empty while looking at a run
                learns to discount everything else this app reports. */}
            The run this link points to ({requestedId}) is not in the store, so it is not shown below
            {selected
              ? '. What you are looking at is a different run, not the one this link named.'
              : ' and nothing is selected.'}{' '}
            It may have been created by a different workspace, or its answer may never have been stored.
            {selected ? '' : ' Pick a run from the list to inspect that one instead.'}
          </AlertDescription>
        </Alert>
      )}
      <div className="explorer-layout">
        <Card className="run-list">
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
            <Select
              value={conversationFilter || 'all'}
              onValueChange={(value) => setConversationFilter(value === 'all' ? '' : value)}
            >
              <SelectTrigger className="run-conversation-filter" aria-label="Filter runs by conversation">
                <span>
                  {conversationOptions.find((option) => option.id === conversationFilter)?.label ??
                    'All conversations'}
                </span>
              </SelectTrigger>
              <SelectContent position="popper" align="start" sideOffset={4}>
                <SelectItem value="all">All conversations</SelectItem>
                {conversationOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="run-search">
              <Search />
              <Input
                placeholder="Search conversations, prompts, or people…"
                aria-label="Search runs by conversation, prompt, or person"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="p-2">
            {loading ? ([1, 2, 3].map((item) => <Skeleton key={item} className="h-24" />)
            ) : runsAvailability?.origin === 'unavailable' ? (/* Checked before the empty state, and this order is the whole point.
                 Both arrive here with no rows, and "No runs yet" over an outage
                 tells a customer their history is gone. */
              <UnavailablePanel notice={unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE' })} />
            ) : runs.length === 0 ? (<Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Workflow />
                  </EmptyMedia>
                  <EmptyTitle>No runs yet</EmptyTitle>
                  <EmptyDescription>Ask a question or run a benchmark to create one.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : visibleRuns.length === 0 ? (<Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search />
                  </EmptyMedia>
                  <EmptyTitle>No matching runs</EmptyTitle>
                  <EmptyDescription>Try a different conversation filter, prompt, or stakeholder search.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (visibleRuns.map((run) => (<RunListItem
                  key={run.id}
                  run={run}
                  active={run.id === selected?.id}
                  onSelect={() => setSelectedId(run.id)}
                />
              ))
            )}
          </CardContent>
        </Card>
        <div className="run-detail">
          <RunHeader
            run={selected}
            title={conversationRunTitle(runs, selected)}
            toolCalls={agentToolCalls}
            reference={isReference}
            groundedness={groundedness}
          />
          {isReference && (<Alert>
              <CircleAlert />
              <AlertDescription>
                {runTrace?.note || 'This is the representative reference trace, not a live agent run.'}
              </AlertDescription>
            </Alert>
          )}
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="map">Agent map</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="details">Details</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="space-y-4 pt-4">
              <div className="summary-grid">
                <Card title={KPI_HINTS.wallTime}>
                  <CardContent>
                    <span>Wall time</span>
                    <strong className={tileValue(!selected?.duration_ms)}>
                      {selected?.duration_ms ? `${(selected.duration_ms / 1000).toFixed(1)}s` : ABSENT}
                    </strong>
                  </CardContent>
                </Card>
                <Card title={KPI_HINTS.toolStageTime}>
                  <CardContent>
                    <span>Tool-stage time</span>
                    {/* Absent covers both "no trace" and "a trace that tagged no
                        stage as tool work". The second used to be explained by a
                        paragraph under the grid; the tile says it. */}
                    <strong className={tileValue(!runTrace?.trace || toolStageTime === ABSENT)}>
                      {runTrace?.trace ? toolStageTime : ABSENT}
                    </strong>
                  </CardContent>
                </Card>
                <Card title={KPI_HINTS.agentToolCalls}>
                  <CardContent>
                    <span>Agent tool calls</span>
                    <strong className={tileValue(agentToolCalls === null)}>{agentToolCalls ?? ABSENT}</strong>
                  </CardContent>
                </Card>
                <Card title={KPI_HINTS.llmTokens}>
                  <CardContent>
                    <span>LLM tokens</span>
                    <strong className={tileValue(totalTokens === null || totalTokens <= 0)}>
                      {totalTokens !== null && totalTokens > 0 ? totalTokens.toLocaleString() : ABSENT}
                    </strong>
                    {totalTokens !== null && totalTokens > 0 && tokenSplit && (<small className="tile-mono ast-num">{tokenSplit}</small>
                    )}
                  </CardContent>
                </Card>
                <Card title={KPI_HINTS.userRating}>
                  <CardContent>
                    <span>User rating</span>
                    {/* In words, and with the way to supply one. A run nobody has
                        rated is a normal state: the agent never rates itself. */}
                    <strong className={tileValue(!rating.rated)}>
                      {rating.rated ? ratingOutOf(rating.value) : 'Not rated'}
                    </strong>
                    {!rating.rated && ratePath && (<Link className="tile-link" to={ratePath}>
                        Rate this run
                      </Link>
                    )}
                  </CardContent>
                </Card>
              </div>
              {traceState.status === 'loading' ? (<div className="space-y-2">
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-16" />
                </div>
              ) : runTrace?.takeaway ? (<Card className="final-answer">
                  <CardContent>
                    <div className="final-answer-head">
                      {/* 18 because `.final-answer-mark svg` paints 18. The
                          size picks the drawing as well as the box -- the
                          graduation ring is dropped below GRADUATION_FLOOR --
                          so a seat that asks for one number and is painted
                          another gets the wrong cut stretched to the right
                          size, which looks like nothing at all. */}
                      <span className="final-answer-mark">
                        <AstrolabeMark size={18} />
                      </span>
                      <p className="final-answer-eyebrow">Final answer</p>
                    </div>
                    <h4 className="final-answer-takeaway">{runTrace.takeaway}</h4>
                    {/* The stored narrative of a past run is the same agent
                        Markdown the live card renders, and it was printing its
                        own `##` and `**` here too. */}
                    <AnswerProse text={runTrace.narrative} sources={runTrace.sources} />
                    {/* Literally the same card as the live answer, links,
                        governance, chips and caveats included: a stored run
                        cites the same tables and carries the same
                        qualifications, and a reader looking at one is at least
                        as likely to want them as a reader looking at the answer
                        it came from. The sources and the caveats were two
                        components here, drawn as two panels, and this tab used
                        to draw the first and not the second -- so an answer
                        disclosed less the second time it was read than the
                        first, on the surface someone opens once they have
                        started to doubt a number.

                        Every table, not the first: this passed `sources[0]` and
                        so did the live card, which is how an answer that read
                        five tables came to cite the one the run happened to read
                        first.

                        Every caveat is passed, degradations included. Ask PIA
                        lifts those into a banner above the figures and so hands
                        the module only the rest; there is no banner here to lift
                        one into, and `caveat-priority.ts` ranks a degradation
                        first, so it leads the list instead of going missing. */}
                    {/* The provenance too, for the same reason the caveats are
                        here: this is the surface someone opens when they have
                        started to doubt a figure, and "over what window, with
                        what filter" is the first thing they need. Absent on a run
                        stored before the agent derived it, which draws nothing
                        rather than an empty row. */}
                    <SourcesModule
                      sources={runTrace.sources}
                      caveats={runTrace.caveats}
                      derivation={runTrace.derivation}
                    />
                    {selected?.conversation_id && (<Link
                        className="final-answer-open"
                        to={conversationHref(selected.conversation_id, selected.id)}
                      >
                        Open full response →
                      </Link>
                    )}
                  </CardContent>
                </Card>
              ) : (<p className="text-muted-foreground text-sm">
                  {traceState.status === 'ready' ? runTrace?.note : 'Pick a run from the list to read its answer.'}
                </p>
              )}
            </TabsContent>
            <TabsContent value="map" className="pt-5">
              {stages.length > 0 ? (<TraceDag
                  stages={stages}
                  activeIndex={-1}
                  charts={runTrace?.charts}
                  trace={runTrace?.trace}
                  question={runTrace?.prompt ?? ''}
                />
              ) : (<TraceUnavailable state={traceState} />
              )}
            </TabsContent>
            <TabsContent value="timeline" className="pt-5">
              {/* The prompt, for the envelope row, which is the run's own
                  question here just as it is on the card. */}
              {stages.length > 0 && runTrace?.trace ? (<TraceTimeline trace={runTrace.trace} question={runTrace.prompt ?? ''} />
              ) : (<TraceUnavailable state={traceState} />
              )}
            </TabsContent>
            <TabsContent value="details" className="space-y-4 pt-5">
              {/* The switch that governs these panels is drawn by this component
                  too, which is the point of it being one. See RunDetails.tsx. */}
              <RunDetails
                trace={runTrace}
                advanced={advanced}
                onAdvancedChange={setAdvanced}
                unavailable={<TraceUnavailable state={traceState} />}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
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
export function RunListItem({ run, active, onSelect }: {
  run: Run;
  active: boolean;
  onSelect: () => void;
}) {
  const runRating = ratingLabel(run.rating);
  return (<button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`run-item ${active ? 'active' : ''}`}
    >
      <div className="run-item-head">
        <span className="run-item-pills">
          <Badge variant="outline" className={`run-status-pill ${astPill(run.status)}`}>
            {run.status ?? 'unknown'}
          </Badge>
          {/* Strictly true, never merely truthy: a server that does not report
              this field at all leaves it undefined, and "not reported" must not
              draw as "ran to the end". Beside the status rather than folded into
              it because the two are independent -- a run can be cut short having
              completed every step it did take, and that row reads `complete`. */}
          {run.truncated === true && (<Badge variant="outline" className={`run-status-pill ${astPill('truncated')}`}>
              Truncated
            </Badge>
          )}
        </span>
        {/* The one figure in the row that stacks into a real column: the head is
            a space-between row, so every date in the list sits on the same right
            edge and a proportional face makes that column ragged. */}
        <span className="run-item-date ast-num">{new Date(run.created_at).toLocaleDateString()}</span>
      </div>
      <span className="run-item-prompt">{runLabel(run)}</span>
      <span className="run-item-meta">
        <span>
          <UserIdentityChip identity={run.stakeholder} compact />
          {run.duration_ms ? (<>
              {' · '}
              {/* The figure in mono, the name beside it in the body face. A
                  person's name is not a measurement and must not read as one. */}
              <span className="ast-num">{(run.duration_ms / 1000).toFixed(1)}s</span>
            </>
          ) : ('')}
        </span>
        {/* Only when somebody rated it. An empty star reads as a rating of zero,
            which is a claim nobody made. */}
        {/* `.ast-num` on the wrapper rather than on the score, which is the one
            place in this row it can go: the star and the figure beside it are one
            sentence that three surfaces have to print identically, and
            rail-run-summary.test.ts reads them as `<Star /> {ratingOutOf(...)}`.
            A span around the figure would satisfy §3 here and break that reading
            in a file this lane does not own. Nothing else inside is a glyph the
            face changes -- a middot and an SVG. */}
        {runRating.rated && (<span className="run-item-rating ast-num">
            {/* With its scale, because a star and a bare number read as a count
                of something rather than as a score. */}
            · <Star /> {ratingOutOf(runRating.value)}
          </span>
        )}
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
    return (<div className="space-y-2">
        {[1, 2, 3].map((row) => (<Skeleton key={row} className="h-16" />
        ))}
      </div>
    );
  }
  if (state.status === 'error') {
    return (<Alert variant="destructive">
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
        : ['No run selected', 'Pick a run from the list to inspect its trace.'];
  return (<Empty>
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