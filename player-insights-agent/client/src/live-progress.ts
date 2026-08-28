/**
 * What to show while a run is still going, said only from what has been
 * observed: that the request was sent, and then each step the endpoint has
 * reported finishing.
 *
 * Nothing else. There is no step to name, so none is named: no "Planning…",
 * no "Analysing…", no percentage. The four hardcoded stage names that used to
 * drive the progress bar were removed for exactly this reason and must not
 * return under a new name; see progress-labels.ts.
 *
 * The stream opening is still a real event with a real time -- the route writes
 * `: open` before it calls the agent -- and it is still what moves the panel out
 * of `sending`. It just no longer prints a sentence of its own: see the
 * `accepted` branch of `buildLiveRun`.
 */
import type { TraceStage } from './answer-shape';
import { stageType, toolNameFromId, type ToolType } from './trace-timeline';
import { describePayload } from './trace-payload';

/**
 * How far a run has got, in terms of what the browser has actually seen.
 *
 * `sending` and `accepted` are distinguishable because the route opens the
 * stream before invoking the agent, so "the server has this" is a fact rather
 * than an assumption about elapsed time.
 */
export type RunPhase = 'sending' | 'accepted' | 'reporting';

/** One reported step, with what it did read off its own record. */
export interface LiveStep {
  id: string;
  name: string;
  type: ToolType;
  status: TraceStage['status'];
  /** Measured duration of the step. */
  durationMs: number;
  /** Offset into the run, or null when the stage carried no measured start. */
  startMs: number | null;
  /**
   * What this step was actually given: the Genie question, the SQL, the table.
   * Empty when the stage recorded nothing, in which case the row shows nothing
   * rather than a placeholder.
   */
  detail: string;
  /** What came back, clamped for the rail. Empty when nothing was recorded. */
  result: string;
  /** Tables structurally declared by this tool call, for shared entity rendering. */
  tables: string[];
  calls: number;
  depth: number;
}

export interface LiveRun {
  phase: RunPhase;
  /**
   * The sentence under the elapsed counter, or '' where there is nothing to say
   * that the panel is not already showing. Never a claim the run did not make.
   */
  detail: string;
  steps: LiveStep[];
}

/** Longest recorded value shown inline on a step row. */
const DETAIL_LIMIT = 180;

/**
 * A recorded string, shortened for a one-line row and marked when shortened.
 *
 * The ellipsis is load-bearing. The expanded trace shows these fields whole and
 * says so; a silently cut Genie question here would have the two views quietly
 * disagreeing about what was asked.
 */
function clamp(value: string, limit = DETAIL_LIMIT): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/** One named argument out of a recorded payload, or '' when it is not there. */
function field(payload: string, key: string): string {
  const described = describePayload(payload);
  const found = described.fields?.find((entry) => entry.key === key);
  return found ? found.value : '';
}

/**
 * Every argument as `key: value`, for a tool this module does not know by name.
 *
 * An object with no keys returns nothing rather than `{}`. The agent records
 * `json.dumps({})` for a tool called without arguments, and printing that on a
 * row reads as a malfunction rather than as "it was called with none".
 */
function allFields(payload: string): string {
  const described = describePayload(payload);
  if (described.empty) return '';
  if (!described.fields) return described.body.trim() === '{}' ? '' : described.body;
  return described.fields.map((entry) => `${entry.key}: ${entry.value}`).join(' \u00b7 ');
}

/**
 * Tables a live stage structurally declared.
 *
 * This is intentionally not an identifier-word scan. Metadata tools name their
 * table in `full_name`; SQL tools name tables only in FROM/JOIN clauses. That
 * keeps model/tool names and underscore-heavy column identifiers out of the
 * table-pill treatment while still recognizing three-part names before the
 * final answer has sources.
 */
export function stageTableEntities(stage: Pick<TraceStage, 'id' | 'input'>): string[] {
  const tool = toolNameFromId(stage.id);
  if (tool === 'describe_table') {
    const fullName = field(stage.input, 'full_name').trim();
    return fullName ? [fullName] : [];
  }
  if (tool !== 'query_named_table' && tool !== 'run_sql') return [];
  const sql = field(stage.input, 'sql');
  const names: string[] = [];
  for (const match of sql.matchAll(
    /\b(?:from|join)\s+((?:`[^`]+`|[A-Za-z_][\w-]*)(?:\.(?:`[^`]+`|[A-Za-z_][\w-]*)){2})/gi
  )) {
    const name = match[1].replaceAll('`', '');
    if (!names.some((held) => held.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names;
}

/**
 * What a step was given, in a sentence.
 *
 * Every branch reads a recorded field. A tool whose name is not listed falls
 * through to its arguments verbatim, so a tool added to the agent shows up with
 * its real arguments rather than with nothing or with a guess at what it does.
 */
export function describeStage(stage: TraceStage, question = ''): string {
  const tool = toolNameFromId(stage.id);
  switch (tool) {
    case 'data_genie':
      return quoted('Asked the governed data Genie space', field(stage.input, 'question'));
    case 'dictionary_genie':
      return quoted('Asked the data dictionary Genie space', field(stage.input, 'question'));
    case 'run_sql':
      return prefixed('Ran a read-only query', field(stage.input, 'sql'));
    case 'query_named_table':
      return prefixed('Queried the table it was given', allFields(stage.input));
    case 'describe_table': {
      const table = clamp(field(stage.input, 'full_name'));
      return table ? `Read the columns of ${table}` : 'Read a table\u2019s columns';
    }
    case 'list_data_assets': {
      const scope = allFields(stage.input);
      return scope
        ? `Listed the tables it may read under ${clamp(scope)}`
        : 'Listed every table it is permitted to read';
    }
    case 'search_tagged_assets': {
      const asked = allFields(stage.input);
      return asked
        ? `Searched the catalog\u2019s tags for ${clamp(asked)}`
        : 'Searched the catalog\u2019s tags to see which exist';
    }
    default:
      // A tool this module has no wording for still shows what it was given.
      // The alternative is a row that says only its category, which is what
      // this change exists to get away from, and a tool added to the agent
      // must not silently degrade to that.
      if (tool) return clamp(allFields(stage.input));
      break;
  }

  if (stage.id.endsWith('-clarify')) {
    return quoted('Stopped to ask you', field(stage.input, 'question') || stage.output);
  }

  // A model turn records the tool calls it decided on as its output, which is
  // the most useful thing on screen while the run is going: it names what is
  // about to happen, from the run's own record, before that work reports.
  if (/^step-\d+$/.test(stage.id) && stage.output) {
    const chose = stage.output
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    if (chose.length > 0 && chose.every((name) => /^[a-z_][a-z0-9_]*$/.test(name))) {
      return `Chose to call ${chose.join(' and ')}`;
    }
  }

  // Anything else: the recorded input, unless it is the question being asked,
  // which the reader is already looking at further up the page.
  const input = clamp(stage.input);
  if (input && input !== clamp(question)) return input;
  return clamp(stage.output);
}

function quoted(lead: string, value: string): string {
  const text = clamp(value);
  return text ? `${lead}: \u201c${text}\u201d` : lead;
}

function prefixed(lead: string, value: string): string {
  const text = clamp(value);
  return text ? `${lead}: ${text}` : lead;
}

/**
 * What a step returned, for the second line of its row.
 *
 * Only for tool steps. A model turn's output is either the tool names (already
 * used as the detail above), or the prose it is about to answer with, and
 * putting the answer in the progress rail spoils it and doubles it.
 */
function describeResult(stage: TraceStage): string {
  if (stage.kind !== 'tool') return '';
  return clamp(stage.output, 140);
}

/**
 * The live step list with one more stage folded into it.
 *
 * A step arrives twice: announced, then reported. Both carry the same `id`, so
 * the second REPLACES the first in place rather than being appended, which is
 * what keeps one step to one row and keeps the row where the reader has been
 * watching it. Anything with an id nobody has seen is appended, which is every
 * stage from a model version that only reports completions -- against one of
 * those this function is an append and nothing else.
 *
 * IT KEEPS EVERY UNRESOLVED ANNOUNCEMENT. It used to drop the standing one when
 * a later announcement arrived, on the reasoning that only one step of a run is
 * in progress at a time. That stopped being true: the agent calls tools in
 * parallel and announces all of them before any of them starts, so the rail
 * showed one tool of a batch of three and the other two never appeared. An
 * announcement is a step the run said it had started, and this list says what
 * was observed; the run reports each of them, and each completion lands in its
 * own row by id.
 */
export function mergeLiveStage(stages: TraceStage[], incoming: TraceStage): TraceStage[] {
  const at = stages.findIndex((stage) => stage.id === incoming.id);
  if (at !== -1) {
    const merged = [...stages];
    merged[at] = incoming;
    return merged;
  }
  return [...stages, incoming];
}

/**
 * The live step list with a whole replayed run folded into it.
 *
 * WHAT A RETURNING READER IS SHOWN. A browser that reopens a conversation with
 * a run still in flight has no steps of its own -- it was not there for them --
 * and reads them back from the server instead. Folded through
 * {@link mergeLiveStage} one at a time rather than replacing the list, and that
 * matters in both directions: a step this view already watched arrive is not
 * duplicated by the replay of the same step, and a step the replay knows about
 * and this view does not is appended in the order the run reported it.
 *
 * ORDER IS THE REPLAY'S, then whatever this view has seen since. The server
 * stores steps in the order the run announced them, so replaying into an empty
 * list reproduces the path exactly; replaying into a list that has moved on
 * leaves the rows where the reader has been watching them.
 *
 * A replay that carries nothing changes nothing, which is the case for a turn
 * answering with a plan, for a run that has not reached its first step, and for
 * any run older than the narration being stored at all.
 */
export function mergeReplayedStages(stages: TraceStage[], replayed: TraceStage[]): TraceStage[] {
  return replayed.reduce(mergeLiveStage, stages);
}

/**
 * Which run the agent path draws: the one happening, the one that answered, or
 * nothing at all.
 *
 * OUT HERE BECAUSE THE "NOTHING AT ALL" CASE WAS WRONG AND UNTESTABLE. Written
 * inside the page, this fell back to the last answer's trace whenever the live
 * list was empty -- including while a run was in flight, which is precisely the
 * state a reader who navigates back into a working conversation arrives in. So
 * the rail narrated the PREVIOUS question's run under a pill saying this one
 * was working, and in a conversation whose first question was still running it
 * showed nothing while claiming to be live.
 *
 * A run in flight draws its own steps or none. That is what the empty state is
 * for: it says a run is going and has not reported a step yet, which is true,
 * where a finished run's path presented as this one's is not.
 */
export function railStagesFor({
  loading,
  runStopped,
  liveStages,
  answeredStages,
  clarificationStages,
  recorded = false,
}: {
  loading: boolean;
  /** Whether the run in view died mid-flight, which keeps its steps on screen. */
  runStopped: boolean;
  liveStages: TraceStage[];
  /** The newest stored answer's trace, for a conversation that is not running. */
  answeredStages: TraceStage[];
  clarificationStages: TraceStage[];
  /**
   * Whether the finished answer (or clarification) carries a real MLflow id.
   *
   * Local stages without one are the split: a Gantt (from the stored answer
   * or the socket) and no backend connector. Keep them only while the turn is
   * in flight, or when MLflow actually recorded the run.
   */
  recorded?: boolean;
}): TraceStage[] {
  if (loading || runStopped) return liveStages;
  if (!recorded) return [];
  if (answeredStages.length > 0) return answeredStages;
  if (liveStages.length > 0) return liveStages;
  return clarificationStages;
}

/**
 * When the counter should be running from, given everything announced so far.
 *
 * Out here with `runningElapsed` for the same reason: it is the rule that STARTS
 * and STOPS the clock, and a rule that only exists inside a component can be
 * asserted against a rendered tree and never against itself.
 *
 * The instant is held while ANY step is still in progress, rather than being
 * retaken or cleared per event. With tools running in parallel, the first
 * completion of a batch used to clear it, so the clock stopped while two other
 * tools were still going. It is retaken only when the run goes from nothing in
 * progress to something in progress, which is the single-tool case unchanged.
 */
export function nextRunningSince({
  stages,
  since,
  now,
}: {
  stages: TraceStage[];
  since: number | null;
  now: number;
}): number | null {
  if (!stages.some((stage) => stage.status === 'running')) return null;
  return since ?? now;
}

/**
 * How long the step in progress has been going, or null when nothing is.
 *
 * OUT HERE BECAUSE IT IS THE THING THAT STOPS THE COUNTER, and a rule that only
 * exists inside a component can be asserted against a rendered tree and never
 * against itself. Every way a run can end reduces to one of the two nulls: the
 * run ending clears `loading`, and a step completing, a conversation being
 * reopened or another question being asked clears `runningSince`. So a finished
 * run cannot be left counting even if the page's clock keeps ticking for the PDF
 * extraction beside it.
 *
 * `now` is passed in rather than read, because it is the page's one clock: a
 * second reading of `Date.now()` here would tick out of step with every other
 * elapsed figure on screen.
 */
export function runningElapsed({
  loading,
  runningSince,
  now,
}: {
  loading: boolean;
  runningSince: number | null;
  now: number;
}): number | null {
  if (!loading || runningSince === null) return null;
  // Clamped, because a clock that went backwards is not a step that started in
  // the future. `tickingTiming` clamps too; this is the arithmetic, that is the
  // wording, and both are cheaper than one of them being the only guard.
  return Math.max(0, now - runningSince);
}

/**
 * Which step of a live list is in progress, one-based, or 0 when none is.
 *
 * Zero rather than null so the badge can read it as "no step number to give":
 * a run against a model that does not announce its steps has no step in
 * progress at any point, and neither does one that has ended.
 *
 * THE NEWEST UNFINISHED ANNOUNCEMENT, not the first one, and that is the whole
 * defect this line used to carry. A run announces its envelopes before any work
 * happens -- `orchestrator`, then `data_source_finder` -- and neither of them
 * reports until the run is over, so the FIRST `running` row is step 01 from the
 * first event to the last. Everything keyed on this number was therefore stuck
 * on step 01 for the whole run: the ring and the status line on the agent path,
 * and "Live · step 01" on the pill beside it, while the reader watched step 07
 * go by underneath.
 *
 * Announcements arrive in the order the run makes them, so the newest one is the
 * step the reader is actually waiting on -- the deepest tool of a parallel batch
 * rather than the envelope holding it.
 */
export function runningStepNumber(stages: TraceStage[]): number {
  for (let at = stages.length - 1; at >= 0; at -= 1) {
    if (stages[at].status === 'running') return at + 1;
  }
  return 0;
}

export function toLiveStep(stage: TraceStage, question = ''): LiveStep {
  return {
    id: stage.id,
    name: stage.name,
    type: stageType(stage),
    status: stage.status,
    durationMs: stage.duration,
    startMs: stage.startMeasured === false ? null : stage.start,
    detail: describeStage(stage, question),
    result: describeResult(stage),
    tables: stageTableEntities(stage),
    calls: stage.calls,
    depth: Math.min(stage.depth ?? 0, 3),
  };
}

/**
 * Everything the panel draws, from what has been observed and nothing else.
 *
 * NOTHING IS SAID ABOUT A PAUSE BETWEEN STEPS, and nothing should be added that
 * is. A line under the list used to read "Nothing new for 9.47s. The run is
 * ahead of this list — a step arrives only once the next one starts.", built
 * from the wall-clock gap since the newest step reached the browser and from a
 * comparison of that clock against the run's own reported offsets. Both halves
 * were measured, and it still had to go: the counter reset the reader's
 * attention to a number that changes every second while they are waiting on an
 * answer, and the explanation beside it described the transport's delivery
 * timing, which is not something the person who asked a question about their
 * players has any use for. The list of finished steps and the elapsed counter
 * above it already say the run is going. A quiet panel is a run still working,
 * and it does not need narrating.
 *
 * `openedAt` is when the stream's opening bytes arrived: a wall-clock instant
 * recorded by the caller as it happened, not estimated, and when it is absent
 * the corresponding claim is simply not made.
 */
export function buildLiveRun({
  openedAt,
  stages,
  question = '',
}: {
  openedAt: number | null;
  stages: TraceStage[];
  question?: string;
}): LiveRun {
  const steps = stages.map((stage) => toLiveStep(stage, question));

  if (steps.length > 0) {
    const newest = steps[steps.length - 1];
    // Counted apart, because the newest step may be one the endpoint has only
    // announced. "3 steps so far" over two finished steps and one still running
    // is a count of two different things, and the sentence is the one place on
    // this panel that states a number.
    const done = steps.filter((step) => step.status !== 'running').length;
    if (newest.status === 'running') {
      return {
        phase: 'reporting',
        detail: `${done} step${done === 1 ? '' : 's'} done, now “${newest.name}”.`,
        steps,
      };
    }
    return {
      phase: 'reporting',
      detail: `${done} step${done === 1 ? '' : 's'} so far, newest “${newest.name}”.`,
      steps,
    };
  }

  if (openedAt !== null) {
    return {
      phase: 'accepted',
      // Nothing. The panel is on screen, the animation is running and the pill
      // is live, all of which say the run has started; the sentence that used
      // to be here said it again and then explained the endpoint's reporting
      // schedule, which is not something the person waiting on an answer about
      // their players has any use for.
      detail: '',
      steps,
    };
  }

  return {
    phase: 'sending',
    // "Nothing has come back yet" rather than "nothing has run yet". A server
    // that will not stream (a stale build, a proxy that drops
    // `text/event-stream`), answers this request in one lump at the end, and
    // the run is well under way while this line is on screen. What is true in
    // every case is that no response has arrived.
    detail: 'Sending your question to the agent endpoint. Nothing has come back yet.',
    steps,
  };
}

/**
 * The three numbers a follow decision needs, which a plain object can carry.
 *
 * Named separately from the element so the decision below can be exercised
 * without a DOM: the unit suite runs on `node`, and a scroll rule that can only
 * be tested by rendering is a scroll rule that does not get tested.
 */
export interface ScrollExtent {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Within this of the bottom still counts as the bottom. A nudge of the wheel or
 * a fractional row height is not a reader choosing to read something earlier.
 */
export const FOLLOW_SLACK_PX = 48;

export function isAtBottom(view: ScrollExtent, slack = FOLLOW_SLACK_PX): boolean {
  return view.scrollHeight - view.scrollTop - view.clientHeight <= slack;
}

/**
 * Whether the list should still follow the newest step, given a scroll that
 * just happened.
 *
 * Not simply "is it at the bottom?", because the smooth scroll this decision
 * switches on fires the handler on every frame of its own animation, and every
 * frame but the last is short of the bottom. Reading the gap alone therefore
 * reported the reader as away whenever a step landed mid-animation — which is
 * exactly when steps do land, since one animation is started per step — and
 * that step went unfollowed although nobody had touched the list. What a reader
 * does and what the animation does differ in direction rather than in position,
 * so the upward move is the signal: the animation only ever moves down.
 */
export function nextFollowState({
  view,
  previousTop,
  following,
  slack = FOLLOW_SLACK_PX,
}: {
  view: ScrollExtent;
  /** Where the container was at the previous scroll sample. */
  previousTop: number;
  following: boolean;
  slack?: number;
}): boolean {
  if (isAtBottom(view, slack)) return true;
  if (view.scrollTop < previousTop) return false;
  return following;
}
