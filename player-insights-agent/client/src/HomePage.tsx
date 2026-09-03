/**
 * Ask PIA: the conversation rail, the transcript, the composer and the rail of
 * agent steps beside them.
 *
 * Split out of App.tsx when the pages became modules. The helpers above the page
 * are its own -- the attachment chips, the response parsing and the rail's
 * watermarks -- and stay unexported, because nothing else has ever
 * needed them. The two cards a turn can be drawn as, AnswerCard and PlanCard,
 * are their own modules; ClarificationCard is here because this is the only page
 * that asks for a clarification.
 */
import { Link, useSearchParams } from 'react-router';
import { lazy, memo, Suspense, useCallback, useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { type ListAvailability } from './list-availability';
import { readConversationList, readRunSummaries, startInitialRail } from './initial-rail';
import { UnavailablePanel } from './UnavailablePanel';
import { unavailableNotice, unavailableNoticeFor, type UnavailableNotice } from './unavailable-copy';
import { submitsOnEnter } from './submit-on-enter';
import { PASSWORD_MANAGER_OPT_OUT } from './password-manager-optout';
import { PLACEHOLDER_CONVERSATION_TITLE } from '../../shared/conversation-title';
import {
  claimConversationTitle,
  railEmptyNotice,
  railOwnership,
  signedInOwner,
  unaskedConversation,
} from './conversation-rail';
import {
  clearOwnerSelectionPreference,
  normalizeOwnerSelection,
  readOwnerSelectionPreference,
  rememberOwnerSelectionPreference,
} from './conversation-owner-selection';
import {
  clearPersonaSelectionPreference,
  normalizePersonaSelection,
  railPersonas,
  readPersonaSelectionPreference,
  rememberPersonaSelectionPreference,
} from './conversation-persona-selection';
import {
  personaIdFromSelection,
  personaSelectionKey,
  type ConversationFilterSelection,
} from '../../shared/conversation-filters';
import { subscribeAskHome } from './ask-home-control';
import {
  clearSelectedConversation,
  readSelectedConversation,
  rememberSelectedConversation,
} from './selected-conversation';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardDescription,
  CardContent,
  CardHeader,
  CardTitle,
  Progress,
  Separator,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Textarea,
} from './ui';
import {
  CircleAlert,
  ExternalLink,
  FileText,
  Loader2,
  MessagesSquare,
  Paperclip,
  Plus,
  ShieldCheck,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { EntityText } from './InlineEntityText';
import { attachControlState } from './attach-control';
import { ANSWER_PARAM, CONVERSATION_PARAM, answerRowId } from './conversation-links';
import { formatDuration } from './benchmark-format';
import { conversationRunSummary, railDuration, type RailRunSummary } from './rail-run-summary';
import {
  applyRunLabelOverrideToConversations,
  applyRunLabelOverrideToSummaries,
  subscribeRunLabelOverrides,
} from './run-header-labels';
import { slowestStageName } from './progress-labels';
import { AskCancelled, AskRefused, AskRunFailed, AskUnreachable, askStreaming } from './ask-stream';
import {
  activeAskHasHealthyStream,
  forgetActiveAsk,
  markActiveAskStreamActivity,
  markActiveAskStreamOpen,
  readActiveAsk,
  registerActiveAsk,
  stopActiveAsk,
  subscribeToActiveAskChanges,
} from './ask-cancellation';
import {
  browserActiveRunPollingHost,
  startAdaptiveActiveRunPolling,
  type ActiveRunPollingController,
} from './active-run-polling';
import { LiveProgress } from './LiveProgress';
import { railStagesFor, runningElapsed, runningStepNumber } from './live-progress';
import { isMlflowTraceId } from '../../shared/mlflow-trace-id';
import {
  beginLiveAsk,
  endLiveAsk,
  hydrateLiveAsk,
  identifyLiveAsk,
  openLiveAsk,
  readLiveAsk,
  recordLiveStage,
  stopLiveAsk,
  useLiveAsk,
} from './live-ask';
import { useAgentReadiness } from './agent-readiness';
import { runStatusFor } from './run-status';
import { answerRunVerdict, withDisplayedStageStatus } from '../../shared/run-verdict';
import { RunStatusPill } from './RunStatusPill';
import {
  conversationRunStateKey,
  isWorkingConversationRun,
  readConversationRun,
  replayedStages,
} from './conversation-run';
import {
  conversationIsLive,
  forgetActiveConversationRun,
  readActiveConversationRuns,
  settleActiveConversationRun,
  terminalConversationRunSummary,
  trackActiveConversationRun,
  updateActiveConversationRuns,
  useActiveConversationRuns,
} from './active-conversation-runs';
import { failedAskSettlement, settleAskDisplay, terminalSettlementForResponse } from './ask-terminal-state';
import { AstrolabeMark } from './AstrolabeMark';
import { ConversationRailRunStatus } from './ConversationRailRunStatus';
import { ConceptFlicker } from './ConceptFlicker';
import { WorkingInlineRow } from './WorkingInlineRow';
import { elapsedSeconds, seatForTranscript, WORKING_LABEL } from './working-animation';
import { ToolCallsLabel } from './ToolCallsLabel';
import {
  normalizeAnswer,
  normalizeClarification,
  storedExecutionIdentity,
  type TraceStage,
  type WireAnswer,
} from './answer-shape';
import { EMPTY_FEEDBACK, feedbackFromStored } from './stored-feedback';
import { useIdentity } from './app-state';
import { acceptAppBudgetStatus, approveContinuedUsage, useAppBudgetStatus } from './app-budget-status';
import { ComposerBudgetStatus } from './ComposerBudgetStatus';
import { AIAnalysisCaveat } from './AIAnalysisCaveat';
import { conversationAge } from './conversation-age';
import { PlanCard } from './PlanCard';
import { measureComposerClearance, observeComposerClearance } from './composer-clearance';
import { AgentPathConstellation } from './AgentConstellation';
import { ConstellationField } from './ConstellationField';
import { OPENING_CONSTELLATION } from './constellation';
import { StoredAnswerBoundary } from './StoredAnswerBoundary';
import { useStartupReadiness } from './startup-readiness';
import {
  preloadStoredAnswerRendererForHistory,
  scheduleStoredAnswerRendererPreload,
  startStoredAnswerRendererPreload,
} from './stored-answer-loader';
import {
  capturePrependAnchor,
  mergeNewestConversationMessages,
  prependConversationMessages,
  readConversationMessagePage,
  restorePrependAnchor,
} from './conversation-messages';
import type {
  AgentResponse,
  Answer,
  Attachment,
  Clarification,
  Conversation,
  ConversationMessage,
  FeedbackEntry,
  PlanResponse,
} from './app-types';
import type { FeedbackDirection } from '../../shared/feedback-direction';
import { FeedbackWriteQueue } from './feedback-write-queue';
import { notifyFeedbackChanged } from './feedback-events';

const ConversationFilters = lazy(() =>
  import('./ConversationFilters').then(({ ConversationFilters: filters }) => ({ default: filters }))
);
const UserDrilldownLink = lazy(() =>
  import('./UserDrilldownLink').then(({ UserDrilldownLink: link }) => ({ default: link }))
);
const RunRatingBadge = lazy(() => import('./RunRatingBadge').then(({ RunRatingBadge: badge }) => ({ default: badge })));

/** Formats the customer confirmed: PDF, Markdown, JSON, TXT, CSV. */
const ATTACHMENT_ACCEPT = '.pdf,.md,.json,.txt,.csv';
/** Mirrors MAX_ATTACHMENT_BYTES on the server so oversized files fail before upload. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/**
 * The user turn an approval writes, and the one the transcript is read back for
 * when a plan card asks whether it was approved or revised away. Mirrors
 * `PLAN_APPROVAL_MESSAGE` on the server, which writes the same sentence for a
 * conversation loaded from the store.
 */
const PLAN_APPROVAL_LABEL = 'Approved the proposed analysis plan.';

/**
 * The empty step list, allocated once.
 *
 * A fresh `[]` per render would be a new prop for the constellation and the live
 * panel on every tick of the one-second clock, which is what the memoization
 * around them exists to avoid.
 */
const NO_LIVE_STAGES: TraceStage[] = [];

function isPdfAttachment(filename: string) {
  return /\.pdf$/i.test(filename.trim());
}

/**
 * PDF extraction is CPU-bound and can run for several seconds, so the chip counts up
 * once a parse passes the point where a static label would look hung.
 */
function parsingLabel(attachment: Attachment, now: number) {
  const base = isPdfAttachment(attachment.filename) ? 'Extracting PDF text' : 'Reading report';
  const elapsed = attachment.started_at ? Math.max(0, Math.floor((now - attachment.started_at) / 1000)) : 0;
  return elapsed >= 2 ? `${base}… ${elapsed}s` : `${base}…`;
}

/**
 * Brings a stored or live payload up to the shape the components require.
 *
 * `executionIdentity` is the claim a reopened turn recorded in its own columns,
 * which a live reply instead carries in its body. Applied only on the answer
 * branch: a proposed plan and a question back to the reader executed no
 * analysis, so there is no data-access identity for either to have, and
 * stamping one on them would be a claim about a run that did not happen.
 */
function normalizeResponse(raw: unknown, executionIdentity?: unknown): AgentResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const response = raw as Record<string, unknown>;
  if (response.type === 'plan') return response as unknown as PlanResponse;
  if (response.type === 'clarification') {
    return { type: 'clarification', mode: 'live', clarification: normalizeClarification(response.clarification) };
  }
  const wire = response as WireAnswer;
  return normalizeAnswer(
    executionIdentity === undefined ? wire : { ...wire, execution_identity: executionIdentity }
  ) as Answer;
}

const emptyFeedback = EMPTY_FEEDBACK;

/**
 * A stored turn, as the transcript renders it.
 *
 * The identity comes off the row rather than out of the answer, because that is
 * where the ask route wrote it. Reading it here is what stopped every answer
 * reopened from the rail claiming its identity was unknown while the columns
 * beside it said exactly whose grants had been used: the browser was told the
 * answer and not the record around it, so "unconfirmed" was an honest report of
 * a payload that had been stripped on the way out.
 *
 * A row that recorded nothing still says nothing. `storedExecutionIdentity`
 * returns undefined for it, the answer states no identity, and the footer prints
 * no identity line at all rather than a sentence about the gap. That is correct
 * for every turn taken before the columns existed.
 */
function responseFromMessage(message?: ConversationMessage): AgentResponse | null {
  if (!message?.response_json) return null;
  const identity = storedExecutionIdentity(message);
  if (typeof message.response_json === 'string') {
    try {
      return normalizeResponse(JSON.parse(message.response_json), identity);
    } catch {
      return null;
    }
  }
  return normalizeResponse(message.response_json, identity);
}

/**
 * The id of a rail entry's title, so the delete control beside it can borrow the
 * title as its description without repeating it in its own name.
 *
 * Derived from the conversation id rather than `useId`, because the two elements
 * that have to agree on it are rendered in the same iteration of the same list
 * and a per-component id would need threading through both.
 *
 * Scoped, because below 800px the rail is drawn twice: once in the aside, which
 * is hidden but still in the document, and once inside the sheet. Two elements
 * with one id is a document where `aria-describedby` resolves to whichever came
 * first, so the sheet's delete control would borrow its description from the
 * copy the user cannot see.
 */
/**
 * What a lost write means for the answer on screen.
 *
 * One constant because it is said in two places now: in the inspector, and in the
 * strip that stands in for the inspector below 1180px. It was only in the
 * inspector, which `display: none` took off the screen at exactly the widths where
 * the reader most needs to be told -- so the sentence has to survive the move
 * intact rather than be paraphrased into a strip-sized version of itself.
 */
const RUN_NOT_STORED =
  'This answer was not stored, so there is no run to explore and it will not be here when you ' +
  'come back. The answer above is the agent’s own; only the record of it was lost. Ask again ' +
  'once storage recovers to keep it.';

/**
 * What the inspector column is, as §4 names it.
 *
 * Uppercased by the eyebrow rule rather than typed in capitals, so the string a
 * screen reader is handed is a phrase rather than an acronym read letter by
 * letter. `.ast-eyebrow` is the shipped recipe: 11px 700 letterspaced.
 */
const HARNESS_EYEBROW = 'Live agent harness';

function railTitleId(conversationId: string, scope: RailScope) {
  return `${scope}-title-${conversationId}`;
}

/**
 * Which copy of the conversation rail is being drawn: the aside beside the
 * transcript, or the sheet that replaces it below 800px.
 */
type RailScope = 'rail' | 'rail-sheet';

// The client's own copy of the representative answer, its six reference stages
// and the helper that disclosed them used to live here. They were the last
// invented figures the browser could put on screen without the server being
// involved: the ask path appended the whole card to the transcript whenever a
// question failed. The server's seeded conversations, runs and stored answer
// have since gone the same way, so no surface has a fixture to fall back to and
// every empty list on screen is a fact about the store.

/**
 * What the rail says instead of "No saved conversations yet" when the store
 * could not be read.
 *
 * Taken from the same per-surface copy Run Explorer uses rather than written
 * again here, so the two cannot describe one outage differently. Rendered as a
 * sentence in the rail's own 12px style rather than as an `UnavailablePanel`:
 * the panel carries a heading, a remedy and a correlation id, and a 240px column
 * is not the place a reader acts on any of them.
 */
const railUnreadableNotice = unavailableNotice({
  surface: 'conversations',
  code: 'DEPENDENCY_UNAVAILABLE',
});

export function HomePage() {
  const { markReady: markStartupReady, registerFocusTarget } = useStartupReadiness();
  const identity = useIdentity();
  const budgetStatus = useAppBudgetStatus();
  /**
   * The address to stamp on a conversation this session creates, or nothing
   * while `/api/identity` has not answered. Undefined is left as undefined all
   * the way to the row: an unattributed conversation is drawn without a
   * watermark and counted under nobody, which is true, where a guess would be
   * a name on screen that no query would ever agree with.
   */
  const signedInAddress = signedInOwner(identity.signedInAs);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [olderMessages, setOlderMessages] = useState<{ hasMore: boolean; cursor: string | null }>({
    hasMore: false,
    cursor: null,
  });
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /**
   * Whether this conversation's documents could not be read, as opposed to there
   * being none. The chip row cannot express the difference, so it is said in
   * words beside it.
   */
  const [attachmentsUnreadable, setAttachmentsUnreadable] = useState(false);
  /**
   * Whether a file the paperclip accepted is still being uploaded and parsed.
   *
   * Deliberately not derived from the chip row's `parsing` statuses, even though
   * the two are true at almost the same times. This is a fact about the control:
   * it is what stops a second press starting a second `uploadAttachments` over
   * the same `<input>`, and it has to be set before the first `await` and cleared
   * after the last one, which the chips cannot promise -- a chip becomes `error`
   * the instant its own file is rejected, so a rejected first file in a batch of
   * three would re-enable the button halfway through the batch.
   */
  const [attaching, setAttaching] = useState(false);
  const [clearingDocs, setClearingDocs] = useState(false);
  const [stopping, setStopping] = useState(false);
  /**
   * A run discovered from Lakebase after this view was reopened.
   *
   * The original fetch belongs to the view that started it and may no longer
   * exist. This is only the durable handle a returning view polls; it never
   * starts or resumes execution.
   */
  const activeConversationRuns = useActiveConversationRuns();
  const [conversationLoading, setConversationLoading] = useState(true);
  /**
   * What the rail's own emptiness means, taken from the response rather than
   * from the row count.
   *
   * The rail used to be backed by seeded conversations whenever the store could
   * not be read, so "blank" could only mean "nothing saved". With no fixture
   * behind it, blank now covers a store that answered and holds nothing and a
   * store nobody could read, and the second must not be rendered as the first:
   * "No saved conversations yet" over an outage tells a reader their history is
   * gone.
   */
  const [railAvailability, setRailAvailability] = useState<ListAvailability | null>(null);
  /**
   * When the request in flight was sent, so the wait can be counted rather than
   * mimed. A real question took 27.5 seconds against a progress bar that filled
   * in 2.6 and then sat frozen and fully ticked for the remaining 23, which
   * reads as a hung application, and is worse than showing no progress at all.
   */
  const [askStartedAt, setAskStartedAt] = useState<number | null>(null);
  /**
   * When a run this view did not start was found already going, per its durable
   * row's `created_at`.
   *
   * The fallback for the one case no stream can cover: a run whose stream was
   * opened by a page load that is gone, or by another browser tab. Its STEPS are
   * recovered -- the app server records each one as the run reports it, and the
   * durable poll replays them into `live-ask.ts` -- but the instant its stream
   * opened is not something this browser ever observed, so the row's own start
   * stands in for it. A run this browser IS still streaming reports its own
   * instant, and that one wins below.
   */
  const [durableRunOpenedAt, setDurableRunOpenedAt] = useState<number | null>(null);
  /** The question in flight, so the live panel can avoid echoing it back. */
  const [askedQuestion, setAskedQuestion] = useState('');
  /**
   * Set when a run died mid-flight, holding how far it got.
   *
   * Keeps `liveStages` on screen after `loading` goes false, so a stopped run
   * settles into the steps it completed rather than either vanishing or leaving
   * a spinner up. Cleared when the next question starts.
   */
  const [runStopped, setRunStopped] = useState<{ steps: number } | null>(null);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  /**
   * The panel shown when a question produced no answer.
   *
   * Held apart from `error`, which is for things that went wrong around a turn
   * that still happened (a re-proposed plan, a failed delete). This one says the
   * turn produced nothing, and it is the state that used to be filled in with
   * the stored demo response.
   */
  const [askUnavailable, setAskUnavailable] = useState<UnavailableNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budgetApprovalBusy, setBudgetApprovalBusy] = useState(false);
  const [budgetApprovalError, setBudgetApprovalError] = useState('');
  /**
   * Feedback state per answer, keyed by the message id it belongs to.
   */
  const [feedback, setFeedback] = useState<Record<string, FeedbackEntry>>({});
  const feedbackRef = useRef<Record<string, FeedbackEntry>>({});
  const feedbackWriteQueueRef = useRef(new FeedbackWriteQueue());
  const feedbackWriteVersionsRef = useRef(new Map<string, number>());
  const confirmedFeedbackRef = useRef(new Map<string, FeedbackEntry>());
  useEffect(() => {
    feedbackRef.current = feedback;
  }, [feedback]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  /**
   * What each conversation's latest answered turn recorded: its status, its wall
   * time and the rating the reader gave it, keyed by conversation id.
   *
   * Empty until `/api/runs` lands, and empty for good if it cannot be read, which
   * is why the row treats every entry as optional rather than waiting for one.
   */
  const [runSummaries, setRunSummaries] = useState<Map<string, RailRunSummary>>(new Map());
  /**
   * The conversation whose delete has been asked for but not yet confirmed.
   */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deletingConversation, setDeletingConversation] = useState<string | null>(null);
  /**
   * Whose conversations the rail is narrowed to. Empty means everyone in it.
   */
  const [ownerFilters, setOwnerFilters] = useState<readonly string[]>([]);
  /** Which recorded run personas the rail is narrowed to. Empty means all. */
  const [personaFilters, setPersonaFilters] = useState<readonly string[]>([]);
  /** Matching ids computed by the server for the filter key beside them. */
  const [serverConversationMatches, setServerConversationMatches] = useState<{
    key: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  /**
   * Whether the rail's sheet is open. Only reachable below 800px, where the aside
   * is hidden and its trigger is the rail.
   */
  const [railSheetOpen, setRailSheetOpen] = useState(false);
  const ownerPreferenceLoadedFor = useRef('');
  const personaPreferenceLoadedFor = useRef('');
  /**
   * The URL wins for deep links and Back/Forward. When Ask is mounted without
   * one after visiting another top-level tab, the browser-session selection
   * wins next. Only a genuinely new session mints a blank draft.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const [conversationId, setConversationId] = useState(
    () => searchParams.get(CONVERSATION_PARAM) ?? readSelectedConversation() ?? `conv-${crypto.randomUUID()}`
  );
  /**
   * The conversation on screen, readable from inside a run that is still going.
   */
  const activeConversationRef = useRef(conversationId);
  /** Every transcript read is cancelled when its conversation stops being current. */
  const conversationLoadControllerRef = useRef<AbortController | null>(null);
  const olderMessagesControllerRef = useRef<AbortController | null>(null);
  /** The durable recovery loop, nudged by rail navigation without remounting it. */
  const activeRunPollerRef = useRef<ActiveRunPollingController | null>(null);
  const previousPolledConversationRef = useRef(conversationId);
  /**
   * The run this conversation has going, read from outside this component.
   *
   * THE FIX FOR THE FROZEN CARD. These four values used to be this component's
   * own state, so leaving Ask -- another tab, another conversation, anything that
   * unmounts this page -- threw away every step the run had reported while the
   * run itself carried on. Coming back mounted a page with an empty list, and the
   * durable poll below could only say that something was still working: the
   * question stayed on screen above a "Working on your question" row and a bar,
   * for the rest of a run that was streaming steps the whole time.
   *
   * They now live in `live-ask.ts`, keyed by conversation, which is where a run
   * that outlives a view belongs. Mounting subscribes and reads; unmounting
   * unsubscribes and does nothing else. A stage arriving while nobody is looking
   * is still recorded, so returning shows the path as it is now and it keeps
   * growing from there.
   *
   * Every value below is still only what the run reported. Nothing is
   * reconstructed, and a run whose stream this browser is not holding -- one
   * started before a reload, or in another tab -- has no stages here and is not
   * given any.
   */
  const liveAsk = useLiveAsk(conversationId);
  const activeConversationRun = activeConversationRuns.get(conversationId)?.status ?? null;
  const liveStages = liveAsk?.stages ?? NO_LIVE_STAGES;
  /**
   * Busy belongs to the conversation on screen, not to this mounted page.
   *
   * The session registry follows streams across conversation and top-level
   * navigation; the durable row covers reloads and other browser tabs.
   */
  const loading = Boolean(liveAsk?.inFlight || isWorkingConversationRun(activeConversationRun));
  useEffect(() => {
    // Covers a run recovered from another tab or a reload. The submit path starts
    // this even earlier, before its POST, while an empty Ask still downloads
    // nothing.
    if (loading) startStoredAnswerRendererPreload();
  }, [loading]);
  const displayedStopNotice = stopNotice ?? liveAsk?.stopNotice ?? null;
  const displayedRunStopped =
    runStopped ??
    (liveAsk?.stopNotice ? { steps: liveStages.filter((stage) => stage.status !== 'running').length } : null);
  /**
   * When the step in progress was announced, on this machine's clock.
   *
   * The reader's counter cannot be derived from the stage's own `start`: that is
   * an offset into the agent's run, measured by `perf_counter` inside a serving
   * container, and it shares no epoch with the browser. What is knowable is when
   * the announcement arrived, which is within the delivery delay of when the step
   * began. Null whenever nothing is in progress, which is what stops the count.
   */
  const runningSince = liveAsk?.runningSince ?? null;
  /**
   * When the route opened the stream, and when the newest step arrived.
   *
   * Both are instants recorded as they happened, because both are things the live
   * panel states as fact. The first is what lets it distinguish "still asking"
   * from "the run has started" in the seconds before any step exists, measured at
   * about half a second against a first step that can be twenty away. See
   * live-progress.ts. The durable instant stands in only for a run this browser
   * is not streaming.
   */
  const streamOpenedAt = liveAsk?.streamOpenedAt ?? durableRunOpenedAt;
  const lastStageAt = liveAsk?.lastStageAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const conversationMainRef = useRef<HTMLElement>(null);
  const wasRunningRef = useRef(false);
  /** Suppresses the ordinary "new answer" scroll for an older-page prepend. */
  const prependingMessagesRef = useRef(false);
  /**
   * The Ask question field. New conversation focuses it from the click itself
   * so the existing composer ring lights and the caret is ready to type. An
   * effect keyed on the new id would also fire after they had already clicked
   * somewhere else.
   */
  const composerRef = useRef<HTMLFormElement>(null);
  /**
   * Parsed once per set of messages, not once per render.
   */
  const parsedResponses = useMemo(() => {
    const byId = new Map<string, AgentResponse>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const parsed = responseFromMessage(message);
      if (parsed) byId.set(message.id, parsed);
    }
    return byId;
  }, [messages]);
  const responses = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => parsedResponses.get(message.id))
    .filter((response): response is AgentResponse => response !== undefined);
  const latestResponse = responses.at(-1);
  // `type` is absent on answers stored before it was added, so an answer is what
  // is left after the two types that name themselves, not what carries 'answer'.
  const answer =
    latestResponse && latestResponse.type !== 'plan' && latestResponse.type !== 'clarification' ? latestResponse : null;
  const asked = latestResponse?.type === 'clarification' ? latestResponse.clarification : null;
  const lastAssistantIndex = messages.map((message) => message.role).lastIndexOf('assistant');
  const parsing = attachments.some((attachment) => attachment.status === 'parsing');
  // What the paperclip says and whether it answers, in one place. See
  // attach-control.ts: the state it is in has to be readable off one object,
  // because the label, the glyph, `aria-busy` and `disabled` are four
  // expressions of it and they were previously going to disagree.
  const attachControl = attachControlState({ attaching, asking: loading, conversationLoading });
  // One condition for the Ask button and for Return, so the key cannot start a
  // run the button is disabled for -- a second submission while one is in
  // flight, or an empty prompt.
  const budgetBlocked = budgetStatus?.level === 'approval-required';
  const canAsk = draft.trim().length > 0 && !loading && !conversationLoading && !parsing && !budgetBlocked;
  // The rail draws the run that happened, or the one happening, or nothing. No
  // reference stages stand in, and a run in flight draws its OWN steps or none:
  // the fallback to the last answer's trace used to apply whenever the live list
  // was empty, which is exactly the state a reader returning to a working
  // conversation arrives in, so the rail narrated the previous question's run
  // under a pill saying this one was live. See `railStagesFor`.
  const railStages = withDisplayedStageStatus(
    railStagesFor({
      loading,
      runStopped: Boolean(displayedRunStopped),
      liveStages,
      answeredStages: answer?.trace.stages ?? [],
      clarificationStages: asked?.trace.stages ?? [],
      recorded: isMlflowTraceId(answer?.trace.id) || isMlflowTraceId(asked?.trace.id),
    }),
    !loading && answer
      ? answerRunVerdict({
          stages: answer.trace.stages,
          caveats: answer.caveats,
          figures: answer.figures,
          narrative: answer.narrative,
          content: answer.content,
        })
      : undefined
  );
  /**
   * Which step is in progress, one-based, or 0 when the run has not said so.
   *
   * Read off the rows rather than tracked separately, so it cannot disagree with
   * what is on screen. Zero against a model version that reports a step only once
   * it has finished, and zero in the gap between one step finishing and the next
   * being announced.
   */
  const runningStep = runningStepNumber(liveStages);
  /**
   * The card the rail rings, and only while a run is actually in flight.
   *
   * THE NEWEST STEP THE RUN HAS ANNOUNCED, which is the step the reader is
   * waiting on in every state that has one and the last step it reported in the
   * gap between two of them. It used to prefer `runningStep`, on the reading that
   * the step in progress is a better answer than the frontier -- and it is, when
   * they differ by being the same row. They stopped being the same row: the run
   * announces `orchestrator` and `data_source_finder` before any step of it
   * starts and reports neither until the end, so "the step in progress" resolved
   * to one of those envelopes and the ring sat on step 01 for the whole run.
   *
   * `runningStep` is still the number the pill's failure label needs -- the step
   * a run DIED inside is a different claim from how far it got -- but it is not
   * the frontier, and it cannot be: it moves backwards to an open envelope every
   * time a step finishes before the next one is announced.
   *
   * Whether the run is INSIDE this step is the band's own reading, off the
   * stage's status, so nothing here has to say it twice.
   *
   * Guarded on `liveStages`, not just on `loading`: with no live steps yet the
   * rail falls back to the PREVIOUS answer's trace, and marking a card there
   * would light up a step of a finished run as though this one were inside it.
   */
  /*
   * A stopped run keeps its frontier marked without animating it. Dropping this
   * to -1 in the same render that placed the error card removed the ring and
   * made the path pop; AgentPathConstellation uses the absent clock to stop every
   * beat while retaining the final observed step.
   */
  const railActiveIndex =
    (loading || Boolean(displayedRunStopped)) && liveStages.length > 0 ? railStages.length - 1 : -1;
  /**
   * How long the step in progress has been going, for the one row that ticks.
   *
   * ONE CLOCK FOR THE WHOLE PAGE, not a timer per row: `now` is already ticked
   * once a second by the effect below, and only while a run or an extraction is
   * going. So the counter stops when the run does, by construction rather than by
   * a component remembering to clear something.
   *
   * Null unless a run is in flight AND a step is in progress, which is what a
   * finished, failed or reopened conversation all reduce to: `loading` goes false
   * and `runningSince` is cleared, and the row prints what it never measured
   * rather than a figure that looks live.
   */
  const railElapsedMs = runningElapsed({ loading, runningSince, now });
  /**
   * Which question of this conversation the agent path is drawing, which is what
   * decides the shape of the chain it draws.
   *
   * The band used to draw the identical seven-point chain for every question
   * anybody ever asked, so it stopped being read as a drawing of THIS run and
   * became part of the furniture. The conversation decides where in the four
   * skies this thread starts and the turn moves it on by one each question, so a
   * follow-up cannot repeat the chain of the question above it.
   *
   * The count of questions asked, because that is the one number that names a
   * run and does not move while the run is going: the user's message is appended
   * before the first step is announced and nothing after that changes it. NOT
   * THE STEP COUNT OR THE ELAPSED TIME, which move under a reader watching the
   * chain arrive, and not the answer's id, which does not exist until the run
   * lands and would therefore change the drawing at the moment the answer did.
   *
   * Both come back unchanged on a reload -- the id is in the URL and the
   * questions are in the stored transcript -- so a run reopened is drawn on the
   * sky it was left on.
   */
  const railTurn = messages.filter((message) => message.role === 'user').length;
  /*
   * Which seating the working animation takes: the full panel while the answer
   * column has nothing in it, the compact strip once there is an answer above to
   * read. Derived from the transcript rather than from a "first run" flag, so
   * clearing a conversation puts the splash back without anything having to
   * remember that it should.
   */
  const workingSeat = seatForTranscript(messages);

  /*
   * The wait, counted rather than mimed, and null until there is something to
   * say. Real seconds and never a percentage (loading-suite.md): the run reports
   * each step on finishing it, so the client knows what has happened and never
   * how much is left.
   */
  const elapsed = elapsedSeconds(askStartedAt, now);

  // One cheap metadata request per page load, shared with the tracked-table list.
  // Warehouse and Genie warmup is App's separate fire-and-forget arrival call;
  // painting this pill never invokes the serving endpoint.
  const readiness = useAgentReadiness();
  useLayoutEffect(() => {
    const focus = () => composerRef.current?.querySelector('textarea')?.focus();
    registerFocusTarget(focus);
    return () => registerFocusTarget(null);
  }, [registerFocusTarget]);
  useLayoutEffect(() => {
    if (!conversationLoading && readiness !== 'checking' && composerRef.current?.querySelector('textarea')) {
      markStartupReady();
    }
  }, [conversationLoading, markStartupReady, readiness]);

  /*
   * What the run is doing, as a word, a tone, and whether the dot may move.
   *
   * Derived in `run-status.ts` rather than here, and the readiness it is given
   * comes from endpoint metadata rather than from this component having mounted.
   * It says "Endpoint reachable" because metadata visibility does not prove
   * CAN_QUERY. The pill said "Ready" from first paint for as long
   * as it has existed, which was a statement about the browser: on a deployment
   * whose endpoint was stopped or whose principal had lost CAN_QUERY it said
   * exactly the same thing, and the reader found out when the question they had
   * just typed failed.
   */
  const runStatus = runStatusFor({
    loading,
    liveSteps: liveStages.length,
    runningStep,
    runStopped: !!displayedRunStopped,
    awaitingApproval: latestResponse?.type === 'plan',
    asked: !!asked,
    answered: !!answer,
    verdict: answer
      ? answerRunVerdict({
          stages: answer.trace.stages,
          caveats: answer.caveats,
          figures: answer.figures,
          narrative: answer.narrative,
          content: answer.content,
        })
      : undefined,
    readiness,
  });

  /*
   * When the run lands, the totals and "Explore full run" mount under the path.
   * The live follow only keeps the newest star on screen, so a long path was
   * left showing its top and those controls sat below the fold. Scroll the
   * pane to its foot in the same commit the answer arrives, and only on that
   * transition -- a settled conversation opened later is the reader's to scroll.
   */
  useLayoutEffect(() => {
    const finishedNow = wasRunningRef.current && !loading && Boolean(answer);
    wasRunningRef.current = loading;
    if (!finishedNow) return;
    const pane = inspectorRef.current;
    if (pane === null) return;
    pane.scrollTop = pane.scrollHeight;
  }, [loading, answer]);

  const selectConversation = useCallback(async (id: string) => {
    // Selection is the earliest reliable signal that stored answers may be
    // needed. Start their chunk while Lakebase and attachment reads are in
    // flight, so the transcript does not reveal a blank Suspense boundary.
    startStoredAnswerRendererPreload();
    conversationLoadControllerRef.current?.abort();
    olderMessagesControllerRef.current?.abort();
    const controller = new AbortController();
    conversationLoadControllerRef.current = controller;
    // Before any await: leaving Ask immediately after clicking a row must still
    // restore that row when the route mounts again.
    rememberSelectedConversation(id);
    setConversationId(id);
    activeConversationRef.current = id;
    setConversationLoading(true);
    setError(null);
    setStopNotice(null);
    setFeedback({});
    setOlderMessages({ hasMore: false, cursor: null });
    setOlderMessagesError(null);
    setOlderMessagesLoading(false);
    // The run that stopped belongs to the conversation it stopped in. Left
    // standing, its badge narrates whichever conversation is opened next, which
    // is a run that never happened there.
    setRunStopped(null);
    // The steps are NOT cleared here any more, and that is the point: they are
    // filed under the conversation they belong to rather than held by this view,
    // so opening a conversation reads that conversation's run and opening another
    // one reads another. Clearing was what made switching away from a running
    // question -- and switching back to it -- lose everything it had reported.
    setDurableRunOpenedAt(null);
    try {
      const [messageResponse, attachmentResponse, durableRun] = await Promise.all([
        readConversationMessagePage(id, { signal: controller.signal }),
        fetch(`/api/conversations/${encodeURIComponent(id)}/attachments`, { signal: controller.signal }),
        readConversationRun(id).catch(() => null),
      ]);
      if (activeConversationRef.current !== id) return;
      const stored = messageResponse.messages;
      preloadStoredAnswerRendererForHistory(stored);
      setMessages(stored);
      setOlderMessages({ hasMore: messageResponse.hasMore, cursor: messageResponse.nextCursor });
      // The ratings these answers already carry, from the rows rather than from
      // this session. `setFeedback({})` above is what a reopened conversation
      // used to be left with: the rating was in the store the whole time and the
      // thumbs came back blank, because nothing had ever read it. See
      // stored-feedback.ts.
      setFeedback(feedbackFromStored(stored));
      // An attachment list that could not be read is not a conversation with no
      // documents, and drawing it as one is worse than saying nothing: the
      // documents are still attached and still reach the agent on the next
      // question, so a user looking at an empty chip row would conclude the
      // opposite of what is true. The route says which of the two happened.
      setAttachmentsUnreadable(!attachmentResponse.ok);
      setAttachments(
        attachmentResponse.ok
          ? ((await attachmentResponse.json()) as Omit<Attachment, 'status'>[]).map((attachment) => ({
              ...attachment,
              status: 'ready',
            }))
          : []
      );
      setDraft('');
      const replayed = replayedStages(durableRun);
      if (isWorkingConversationRun(durableRun)) {
        updateActiveConversationRuns((current) => trackActiveConversationRun(current, id, durableRun));
        const started = Date.parse(durableRun.created_at);
        setAskStartedAt(Number.isFinite(started) ? started : Date.now());
        // Only as the fallback. A run this browser is still streaming reports its
        // own opening instant, and that one is preferred where it exists, so a
        // reopened conversation does not have the durable row's timestamp
        // overwrite the live one.
        setDurableRunOpenedAt(Number.isFinite(started) ? started : Date.now());
        const question = [...stored].reverse().find((message) => message.role === 'user')?.content ?? '';
        setAskedQuestion(question);
        // The steps it has taken, for the case the stream cannot answer: this
        // browser was not the one holding it. Without this, everything above is
        // true and useless -- the question comes back, the composer stays shut
        // because a run is in flight, and the agent path is empty for as long as
        // the run lasts. Folded into the same record the stream writes to, so a
        // browser that has both gets one path rather than two.
        hydrateLiveAsk({
          conversationId: id,
          stages: replayed,
          question,
          startedAt: Number.isFinite(started) ? started : Date.now(),
        });
      } else if (durableRun?.state === 'CANCELLED') {
        const question = [...stored].reverse().find((message) => message.role === 'user')?.content ?? '';
        const started = Date.parse(durableRun.created_at);
        hydrateLiveAsk({
          conversationId: id,
          stages: replayed,
          question,
          startedAt: Number.isFinite(started) ? started : Date.now(),
        });
        endLiveAsk(id);
        setRunStopped({ steps: replayed.filter((stage) => stage.status !== 'running').length });
        setStopNotice(readLiveAsk(id)?.stopNotice ?? 'Stopped');
      } else if (durableRun && replayed.length > 0) {
        // A settled run whose stored answer wiped its trace (the prose-only
        // path) still has the steps in the ledger. Restore them so a hard
        // refresh does not show "no steps" over a run that had many.
        const last = [...stored].reverse().find((message) => message.role === 'assistant');
        const parsed = responseFromMessage(last);
        const storedStages =
          parsed && parsed.type !== 'plan' && parsed.type !== 'clarification' ? parsed.trace.stages : [];
        if (storedStages.length === 0) {
          const question = [...stored].reverse().find((message) => message.role === 'user')?.content ?? '';
          const started = Date.parse(durableRun.created_at);
          hydrateLiveAsk({
            conversationId: id,
            stages: replayed,
            question,
            startedAt: Number.isFinite(started) ? started : Date.now(),
          });
          endLiveAsk(id);
        }
      }
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      if (activeConversationRef.current !== id) return;
      setDraft('');
      setMessages([]);
      setAttachments([]);
      setAttachmentsUnreadable(false);
      setError('This conversation could not be loaded. Start a new conversation or try again.');
    } finally {
      if (conversationLoadControllerRef.current === controller) conversationLoadControllerRef.current = null;
      if (activeConversationRef.current === id) setConversationLoading(false);
    }
  }, []);

  const loadOlderMessages = useCallback(async () => {
    if (!olderMessages.hasMore || !olderMessages.cursor || olderMessagesLoading) return;
    olderMessagesControllerRef.current?.abort();
    const controller = new AbortController();
    olderMessagesControllerRef.current = controller;
    const requestedConversation = conversationId;
    const anchor = capturePrependAnchor(messages[0]);
    setOlderMessagesLoading(true);
    setOlderMessagesError(null);
    try {
      const page = await readConversationMessagePage(requestedConversation, {
        cursor: olderMessages.cursor,
        signal: controller.signal,
      });
      if (activeConversationRef.current !== requestedConversation) return;
      prependingMessagesRef.current = true;
      setMessages((current) => prependConversationMessages(current, page.messages));
      setFeedback((current) => ({ ...feedbackFromStored(page.messages), ...current }));
      setOlderMessages({ hasMore: page.hasMore, cursor: page.nextCursor });
      window.requestAnimationFrame(() => restorePrependAnchor(anchor));
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      if (activeConversationRef.current === requestedConversation) {
        setOlderMessagesError('Older messages could not be loaded. Try again.');
      }
    } finally {
      if (olderMessagesControllerRef.current === controller) olderMessagesControllerRef.current = null;
      if (activeConversationRef.current === requestedConversation) setOlderMessagesLoading(false);
    }
  }, [conversationId, messages, olderMessages.cursor, olderMessages.hasMore, olderMessagesLoading]);

  useEffect(
    () => () => {
      conversationLoadControllerRef.current?.abort();
      olderMessagesControllerRef.current?.abort();
    },
    []
  );

  /**
   * The three things a transcript row can ask this page to do, as callbacks whose
   * identity never changes.
   *
   * THIS EXISTS SO `MessageItem` CAN BE MEMOIZED AT ALL. `ask` and `saveFeedback`
   * are redefined on every render -- they have to be, they read this render's
   * state -- so handing them to a row straight would hand it a different prop
   * every time and `React.memo` would skip nothing. The row would re-render on
   * every tick of the one-second clock, which is the whole thing being fixed.
   *
   * The indirection is a ref rather than a `useCallback` over the two functions,
   * because a `useCallback` whose deps include them changes identity for the same
   * reason they do. WRITTEN IN AN EFFECT, NOT DURING RENDER: a ref written while
   * rendering is not part of the render's input, so a pass React discards takes
   * the write with it. The effect has no dependency array on purpose -- it must
   * run after every render, so what a row calls is always the newest closure and
   * never one holding a stale conversation id.
   */
  const latest = useRef({ ask, saveFeedback });
  useEffect(() => {
    latest.current = { ask, saveFeedback };
  });
  const askRow = useCallback((question: string, approval?: { planId: string; label: string }) => {
    void latest.current.ask(question, approval);
  }, []);
  const rateRow = useCallback(
    (answerId: string, sentiment: FeedbackDirection, options?: { keepCommentOpen?: boolean }) =>
      latest.current.saveFeedback(answerId, sentiment, options),
    []
  );
  const changeFeedback = useCallback((answerId: string, changes: Partial<FeedbackEntry>) => {
    setFeedback((current) => ({
      ...current,
      [answerId]: { ...(current[answerId] ?? emptyFeedback), ...changes },
    }));
  }, []);
  /**
   * Re-reads the run list and collapses it to one summary per conversation.
   *
   * A second request on this page, deliberately, rather than widening the
   * conversation list query: the runs endpoint already derives a turn's status,
   * wall time and rating, and the alternative was a second server-side
   * derivation of the same three things that could disagree with the first.
   *
   * Failure is silent and the pills simply do not appear. The rail's job is to
   * list conversations, and a rail that reported an outage of a decoration would
   * be claiming its titles and dates were in doubt when they are not.
   *
   * Called after a turn completes. The read on arrival is not this -- it is one
   * half of `startInitialRail`, which issues both lists at once.
   */
  const loadRunSummaries = useCallback(async (signal?: AbortSignal) => {
    const summaries = await readRunSummaries(signal);
    // An empty result is also the endpoint's failure shape. Never replace useful
    // rail state with it, and never use it as evidence that a live run failed.
    if (summaries.size > 0) setRunSummaries(summaries);
    return summaries;
  }, []);

  /**
   * Follow every durable run, regardless of which conversation is open.
   *
   * SSE is the primary path. A run this browser is already streaming is omitted
   * until that stream closes or misses three 15-second heartbeats; polling it as
   * well used to make 100 duplicate status reads during a 150-second run.
   *
   * The durable path starts at 1.5 seconds, then backs off from 2 to 10 seconds
   * with bounded jitter while nothing visible changes. A stage/state transition
   * resets it. Hidden tabs have no timer, and visibility, network reconnection,
   * stream attach/detach, or opening another rail conversation wakes it now.
   *
   * There is intentionally no AbortController here: these reads observe work.
   * Only the explicit Stop path has authority to cancel it.
   */
  const activeConversationRunIds = [...activeConversationRuns]
    .filter(([, run]) => isWorkingConversationRun(run.status))
    .map(([id]) => id)
    .sort()
    .join('\u0000');
  useEffect(() => {
    if (!activeConversationRunIds) return;
    let live = true;
    const requests = new AbortController();
    const runIds = activeConversationRunIds.split('\u0000');
    const observed = new Map<string, string>();
    const pollOne = async (runConversationId: string) => {
      try {
        const status = await readConversationRun(runConversationId, fetch, requests.signal);
        // The browser knows this request started before the ledger row is
        // guaranteed to be readable. Null in that admission gap is not a
        // terminal state: settling here exposes the previous turn's Complete
        // or Failed summary until somebody clicks back and forces another read.
        if (!live || !status) return 'unchanged' as const;
        const stateKey = conversationRunStateKey(status);
        const changed = observed.get(runConversationId) !== stateKey;
        observed.set(runConversationId, stateKey);
        if (isWorkingConversationRun(status)) {
          updateActiveConversationRuns((current) => trackActiveConversationRun(current, runConversationId, status));
          // The steps the run has taken since the last poll. This is what makes a
          // reconnected path GROW rather than sit at whatever the first read
          // caught: a browser that is not holding the stream learns about each
          // step from here. Merged by id, so a view that is holding the stream as
          // well is unaffected -- it already has these rows and keeps them.
          hydrateLiveAsk({
            conversationId: runConversationId,
            stages: replayedStages(status),
          });
          return changed ? ('changed' as const) : ('unchanged' as const);
        }
        // A proposed plan is parked on the person, not running. It has no
        // terminal answer summary to wait for and performs no work while the
        // buttons are being reviewed. Settling directly from the authoritative
        // ledger row clears the stale stream overlay, removes the blank working
        // card, enables Approve/Revise, and keeps Stop from targeting nothing.
        if (status.state === 'AWAITING_APPROVAL') {
          updateActiveConversationRuns((current) =>
            settleActiveConversationRun(current, runConversationId, status, null)
          );
          endLiveAsk(runConversationId, status.run_id);
          return 'stop' as const;
        }
        // Keep Live until the terminal summary for THIS run is readable. A
        // missing/error response, or the previous turn's stale summary, is not
        // evidence that the run ended.
        const summaries = await loadRunSummaries(requests.signal);
        if (!live) return 'stop' as const;
        if (!terminalConversationRunSummary(status, summaries.get(runConversationId) ?? null)) {
          return changed ? ('changed' as const) : ('unchanged' as const);
        }
        // The status row and its stages are the only data that can change while
        // work is in flight. The transcript includes every stored response JSON;
        // rereading and replacing that whole list every 1.5 seconds made a long
        // reconnect progressively more expensive. Read it once, after the run
        // reaches a terminal state and an assistant message may actually exist.
        const response =
          activeConversationRef.current === runConversationId
            ? await readConversationMessagePage(runConversationId, { signal: requests.signal }).catch(() => null)
            : null;
        if (!live) return 'stop' as const;
        if (status?.state === 'CANCELLED') {
          if (activeConversationRef.current === runConversationId) {
            setRunStopped({
              steps: replayedStages(status).filter((stage) => stage.status !== 'running').length,
            });
            setStopNotice(readLiveAsk(runConversationId)?.stopNotice ?? 'Stopped');
          }
        }
        updateActiveConversationRuns((current) =>
          settleActiveConversationRun(current, runConversationId, status, summaries.get(runConversationId) ?? null)
        );
        endLiveAsk(runConversationId, status.run_id);
        // The terminal overlay is gone before the persisted answer is exposed.
        // Reversing these two operations produced one committed frame containing
        // the answer plus a brand-new "Live" card beneath it.
        if (response && activeConversationRef.current === runConversationId) {
          const stored = response.messages;
          setMessages((current) => mergeNewestConversationMessages(current, stored));
          setFeedback((current) => ({ ...current, ...feedbackFromStored(stored) }));
          setOlderMessages((current) => ({
            hasMore: current.hasMore || response.hasMore,
            cursor: current.cursor ?? response.nextCursor,
          }));
        }
        return 'stop' as const;
      } catch {
        // A transient status-read failure is not evidence that the server work
        // stopped. Keep the working state; adaptive fallback retries it.
        return 'unchanged' as const;
      }
    };
    const controller = startAdaptiveActiveRunPolling({
      targets: () =>
        runIds.flatMap((id) => {
          const run = readActiveConversationRuns().get(id);
          if (!run || !isWorkingConversationRun(run.status)) return [];
          return [
            {
              conversationId: id,
              shouldPoll: !activeAskHasHealthyStream(id, run.status.run_id),
            },
          ];
        }),
      poll: pollOne,
      host: browserActiveRunPollingHost(),
    });
    activeRunPollerRef.current = controller;
    const unsubscribeStreams = subscribeToActiveAskChanges(() => controller.wake());
    return () => {
      live = false;
      requests.abort();
      unsubscribeStreams();
      controller.stop();
      if (activeRunPollerRef.current === controller) activeRunPollerRef.current = null;
    };
  }, [activeConversationRunIds, loadRunSummaries]);

  useEffect(() => {
    if (previousPolledConversationRef.current === conversationId) return;
    previousPolledConversationRef.current = conversationId;
    activeRunPollerRef.current?.wake();
  }, [conversationId]);

  /**
   * The rail, in one round trip rather than two.
   *
   * ONE EFFECT FOR BOTH LISTS, and the reason is stated in initial-rail.ts: as
   * two effects the requests did overlap, but only because effects happen to run
   * back-to-back, and that is one `await` away from becoming a waterfall. Asking
   * for them together makes the concurrency something the code says rather than
   * something the scheduler happens to do -- and gives the suite something it can
   * count, which two fetches inside effects were not.
   *
   * BOTH ISSUED TOGETHER, EACH AWAITED ON ITS OWN, and the second half is not
   * tidiness. `conversationLoading` below is not a spinner on the rail: while it
   * is true this page hides the welcome screen and disables the composer, so
   * whatever clears it decides when the reader may start typing. Waiting on one
   * combined promise made that the slower of the two reads -- and the run list is
   * the heavier one while feeding nothing but the status pills, so a decoration on
   * the rail was holding the text box shut.
   *
   * The two failures are handled differently and that is not an oversight: a
   * rail without pills is still a rail, and a rail without conversations is an
   * outage the reader is told about. See `InitialRail`.
   */
  useEffect(() => {
    let active = true;
    const reads = startInitialRail();
    void reads.conversations.then((list) => {
      if (!active) return;
      setRailAvailability(list.availability);
      // The rail summaries prove which rows already have an answered turn.
      // Start the one shared import off the critical path instead of waiting for
      // a reader to click a row and briefly meeting Suspense cold.
      preloadStoredAnswerRendererForHistory(list.conversations ?? []);
      // The rail lists saved conversations, but the app opens on a fresh chat
      // so the welcome state is the first thing a new user sees.
      if (list.conversations) {
        setConversations(list.conversations);
        setServerConversationMatches(
          list.matchingConversationIds ? { key: '', ids: new Set(list.matchingConversationIds) } : null
        );
      }
      setConversationLoading(false);
    });
    void reads.runSummaries.then((summaries) => {
      if (!active) return;
      setRunSummaries(summaries);
    });
    return () => {
      active = false;
    };
  }, []);

  /**
   * Follows the URL, which is what makes Back and Forward work.
   *
   * Every conversation change goes through the address bar. A click, Back, and
   * a deep link name the thread there. Returning from another top-level tab has
   * no Ask query string, so it falls back to the browser-session selection,
   * restores that thread, and puts it back in the URL. Guarded on the id already
   * loaded, so it does not re-fetch on unrelated renders.
   */
  const loadedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    const requested = searchParams.get(CONVERSATION_PARAM);
    const target = requested ?? readSelectedConversation();
    if (!target || target === loadedConversationRef.current) return;
    loadedConversationRef.current = target;
    if (!requested) setSearchParams({ [CONVERSATION_PARAM]: target }, { replace: true });
    void selectConversation(target);
  }, [searchParams, selectConversation, setSearchParams]);

  /**
   * The answer a link asked for, when one did.
   *
   * A trace names the answer it came from, and that answer is usually not the
   * last one in the thread, so the end of the transcript is the wrong place to
   * put a reader who followed such a link -- it is the same "landed somewhere
   * plausible, not where you were sent" failure as opening no conversation at
   * all, one screen further in.
   */
  const requestedAnswer = searchParams.get(ANSWER_PARAM);
  const scrolledToAnswerRef = useRef('');
  useEffect(() => {
    if (conversationLoading || messages.length === 0) return;
    const prepended = prependingMessagesRef.current;
    prependingMessagesRef.current = false;
    // Once per requested answer, and then never again for it. The parameter
    // stays in the address bar after the jump -- so the link survives a reload
    // and Back still works -- and without this guard asking a new question in a
    // conversation opened this way would scroll away from the answer that had
    // just arrived, back to the one the reader followed a link to.
    if (requestedAnswer && scrolledToAnswerRef.current !== requestedAnswer) {
      const row = document.getElementById(answerRowId(requestedAnswer));
      // A deep link may name an answer outside the newest page. Walk backward
      // one bounded page at a time until it is present or history is exhausted.
      if (!row && olderMessages.hasMore && !olderMessagesLoading) {
        void loadOlderMessages();
        return;
      }
      // No row means that answer is not in this thread, which is what a stale
      // link looks like. Falling through to the end is the behaviour every
      // other visit gets, and is better than not scrolling at all and leaving
      // the reader at the top with no sign anything was meant to happen.
      if (row) {
        scrolledToAnswerRef.current = requestedAnswer;
        row.scrollIntoView({ block: 'center' });
        return;
      }
    }
    if (prepended) return;
    const newest = messages[messages.length - 1];
    if (!loading && newest?.role === 'assistant' && newest.id) {
      // An answer is read from its beginning. Scrolling to the transcript end
      // landed on the final trace row and made the result appear to open midway.
      document.getElementById(answerRowId(newest.id))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [
    messages,
    loading,
    conversationLoading,
    requestedAnswer,
    olderMessages.hasMore,
    olderMessagesLoading,
    loadOlderMessages,
  ]);

  // Keeps every elapsed counter moving: the parsing chips during a slow PDF
  // extraction, and the agent's own wait, which is the longer of the two.
  useEffect(() => {
    if (!parsing && !loading) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [parsing, loading]);

  async function stopCurrentAsk() {
    const streamed = readActiveAsk(conversationId);
    const current =
      streamed ??
      (activeConversationRun
        ? {
            conversationId,
            correlationId: activeConversationRun.run_id,
            controller: new AbortController(),
            stopRequested: false,
          }
        : null);
    if (!loading || stopping || current?.conversationId !== conversationId || !current.correlationId) return;
    setStopping(true);
    setError(null);
    current.stopRequested = true;
    try {
      await stopActiveAsk(current);
      setAskUnavailable(null);
      setStopNotice('Stopped by you');
      if (!streamed) {
        const completed = liveStages.filter((stage) => stage.status !== 'running').length;
        setRunStopped({ steps: completed });
        settleAskDisplay(current.conversationId, current.correlationId, failedAskSettlement('CANCELLED'));
      }
    } catch (stopError) {
      current.stopRequested = false;
      setError(
        stopError instanceof Error
          ? `The local stream was left open. ${stopError.message}`
          : 'The local stream was left open because the stop request did not complete.'
      );
    } finally {
      setStopping(false);
    }
  }

  async function ask(question = draft, approval?: { planId: string; label: string }) {
    if (!question.trim() || readLiveAsk(conversationId)?.inFlight || readActiveAsk(conversationId)) return;
    if (budgetStatus?.level === 'approval-required') return;
    // Everything below writes into the conversation this run started in. Once
    // the user is somewhere else, none of it is theirs to write: an answer, a
    // step, an error banner or a URL change landing in the conversation they
    // moved to describes a question that was never asked there.
    const runConversationId = conversationId;
    const conversationBefore = conversations.find((conversation) => conversation.id === runConversationId) ?? null;
    // A blank draft becomes a selected conversation the instant it is used.
    // Persist before the request starts, so leaving Ask while the run is active
    // returns to this thread rather than to another starter.
    rememberSelectedConversation(runConversationId);
    const stillInThisConversation = () => activeConversationRef.current === runConversationId;
    const userMessage: ConversationMessage = {
      id: `local-${crypto.randomUUID()}`,
      role: 'user',
      content: approval?.label ?? question,
    };
    setMessages((items) => [...items, userMessage]);
    // The rail is renamed on submission, not on completion. It used to be
    // renamed where the answer is appended, tens of seconds later, so a reader
    // watching their own question run had a rail beside it that still said
    // "New conversation" -- the one place on the screen that could have told
    // them their question had been accepted, saying it had not been. The claim
    // is conditional in the same way the server's upsert is, so this cannot
    // rename a conversation that already has a name, and so calling it again
    // below when the answer lands cannot move a label a reader has read.
    setConversations((items) =>
      claimConversationTitle(items, {
        id: runConversationId,
        prompt: question,
        owner: signedInAddress,
        updatedAt: new Date().toISOString(),
      })
    );
    setDraft('');
    setAskStartedAt(Date.now());
    setDurableRunOpenedAt(null);
    // Filed under the conversation rather than held here, so the run survives
    // this view. A new question replaces whatever this conversation had on
    // record, which is what clearing the step list used to mean.
    beginLiveAsk({ conversationId: runConversationId, question });
    setAskedQuestion(question);
    setRunStopped(null);
    setStopNotice(null);
    setError(null);
    setAskUnavailable(null);
    const controller = new AbortController();
    const currentAsk = {
      conversationId: runConversationId,
      correlationId: '',
      controller,
      stopRequested: false,
      stream: {
        state: 'connecting' as const,
        openedAt: null,
        lastActivityAt: null,
      },
    };
    registerActiveAsk(currentAsk);
    try {
      const { body } = await askStreaming(
        {
          conversationId: runConversationId,
          prompt: question,
          approvedPlanId: approval?.planId,
          executePlan: Boolean(approval),
        },
        // Appended rather than replaced: each event is one finished step, and
        // the list is the run so far. A turn that answers with a plan sends
        // none at all, because the agent proposes before it runs anything.
        {
          // Recorded whatever is on screen, and this is the second half of the
          // frozen-card fix. These callbacks used to return early unless the
          // reader was still looking at the conversation the run started in, so a
          // step that arrived while they were on another conversation, or another
          // tab, was dropped on the floor and never came back. The stage belongs
          // to a conversation, so it is filed under one; which conversation is
          // being drawn is the view's business and it reads its own key.
          //
          // The merge, the announcement bookkeeping and the instant the counter
          // runs from are all in `live-ask.ts` now, over a list it can read
          // synchronously -- the stream hands stages over faster than a render,
          // and deciding whether anything is still in progress off a stale copy
          // is what used to stop the clock while two tools of a batch were going.
          onStage: (stage) => {
            recordLiveStage(runConversationId, stage);
          },
          onStart: (correlationId) => {
            currentAsk.correlationId = correlationId;
            identifyLiveAsk(runConversationId, correlationId);
            const now = new Date().toISOString();
            updateActiveConversationRuns((runs) =>
              trackActiveConversationRun(runs, runConversationId, {
                run_id: correlationId,
                state: 'RUNNING',
                created_at: now,
                updated_at: now,
                terminal_code: null,
              })
            );
          },
          // The run is under way and the request passed every check. Recorded
          // as an instant because the panel says so on screen, and because the
          // interval between this and the first step is the wait this whole
          // change is about.
          onOpen: () => {
            openLiveAsk(runConversationId);
            markActiveAskStreamOpen(currentAsk);
            // The POST and stream-open path has already completed. Warm the
            // answer-only graph during the run without putting an import ahead
            // of the request, its progress, or its first server event.
            scheduleStoredAnswerRendererPreload();
          },
          // Includes the 15-second SSE keep-alive comments, so a connected but
          // quiet model call remains primary and a silent dead stream falls
          // back to durable polling after the bounded stale window.
          onActivity: () => {
            markActiveAskStreamActivity(currentAsk);
          },
        },
        fetch,
        controller.signal
      );
      // Normalized before it is read rather than after it is stored: the envelope
      // below reads `result.narrative` and `result.id`, and those can be absent too.
      const result = normalizeResponse(body);
      if (!result) throw new Error('The live agent returned a response the app could not read.');
      const terminal = terminalSettlementForResponse(result, body);
      settleAskDisplay(runConversationId, currentAsk.correlationId, terminal);
      // The stream result is sent only after the server stores and settles the
      // message. Clear both live sources first, then expose that persisted row;
      // no committed render can contain the answer plus a second Live card.
      if (!stillInThisConversation()) return;
      setMessages((items) => [
        ...items,
        {
          // Each response type is keyed and summarized by its own field. Reading
          // `result.narrative` for all of them is what put an empty bubble on
          // screen for anything that was not an answer.
          id:
            result.type === 'plan'
              ? `msg-${result.plan.id}`
              : result.type === 'clarification'
                ? `msg-${result.clarification.id}`
                : result.id,
          role: 'assistant',
          content:
            result.type === 'plan'
              ? result.plan.summary
              : result.type === 'clarification'
                ? result.clarification.question
                : result.narrative,
          response_json: result,
        },
      ]);
      if (approval && result.type === 'plan') {
        setError(
          'The agent proposed a revised plan instead of running the approved one. Review and approve it to continue.'
        );
      }
      // The row was named and moved to the top when the question was sent; this
      // only carries the store's own "just now" onto it. Same helper, so the
      // label is untouchable from here: an answer arriving must not restate
      // what the rail has been saying for the length of the run, and this used
      // to overwrite the title unconditionally, which renamed a conversation
      // after its second question and then unrenamed it on the next load.
      setConversations((items) =>
        claimConversationTitle(items, {
          id: runConversationId,
          prompt: question,
          owner: signedInAddress,
          updatedAt: new Date().toISOString(),
        })
      );
      // The turn that just finished is a run now, so the rail's row for it has a
      // status, a duration and a place to put a rating. Re-read rather than
      // assembled here from what this page happens to know: the pill has to say
      // what the store recorded, and a turn with a failed stage in it is
      // 'partial' there while looking like a success from up here.
      void loadRunSummaries();
      // Persona is historical run evidence, not a current assignment. Re-read
      // the server row after settlement so this new run is classified from the
      // snapshot it actually stored.
      void refreshConversationEvidence();
      // Now that this conversation has something stored in it, name it in the URL
      // so it can be linked to and so Back and Forward have somewhere to land.
      // Replace rather than push: asking a question is not a navigation.
      loadedConversationRef.current = runConversationId;
      setSearchParams({ c: runConversationId }, { replace: true });
    } catch (askError) {
      const budgetRefusal =
        askError instanceof AskRefused && askError.result.code === 'BUDGET_APPROVAL_REQUIRED'
          ? askError.result.budget_status
          : undefined;
      if (budgetRefusal) {
        // The server won the race before creating a conversation, message, run,
        // lease, or invocation. Restore the exact draft and optimistic rail state
        // instead of drawing a failed answer for work that never started.
        acceptAppBudgetStatus(budgetRefusal);
        setDraft(question);
        setMessages((items) => items.filter((item) => item.id !== userMessage.id));
        setConversations((items) =>
          conversationBefore
            ? items.map((item) => (item.id === runConversationId ? conversationBefore : item))
            : items.filter((item) => item.id !== runConversationId)
        );
        endLiveAsk(runConversationId);
        updateActiveConversationRuns((runs) => forgetActiveConversationRun(runs, runConversationId));
        setAskStartedAt(null);
        setAskedQuestion('');
        setRunStopped(null);
        setAskUnavailable(null);
        return;
      }
      if (askError instanceof AskCancelled) {
        stopLiveAsk(
          runConversationId,
          currentAsk.stopRequested ? 'Stopped by you' : 'Stopped by an administrator',
          currentAsk.correlationId
        );
        settleAskDisplay(runConversationId, currentAsk.correlationId, failedAskSettlement('CANCELLED'));
      } else if (askError instanceof AskRefused) {
        settleAskDisplay(
          runConversationId,
          currentAsk.correlationId,
          failedAskSettlement('REFUSED', askError.result.code)
        );
      } else if (askError instanceof AskRunFailed && askError.terminal) {
        settleAskDisplay(runConversationId, currentAsk.correlationId, failedAskSettlement('FAILED'));
      }
      if (!stillInThisConversation()) return;
      // A run that reached the agent and then stopped is a different event from
      // an endpoint that was never reachable, and the difference is visible on
      // screen: the steps it did finish are still there. Saying "the endpoint is
      // unavailable" over a rail showing four completed steps contradicts what
      // the user just watched happen.
      // A question the server refused is already fully described: it chose the
      // code, the sentence and the correlation id, and re-deriving any of them
      // here would show a reader "the endpoint is unavailable" over a denial
      // that says precisely which of their permissions was the problem.
      if (askError instanceof AskCancelled) {
        setRunStopped({ steps: askError.completed });
        setAskUnavailable(null);
        setStopNotice(currentAsk.stopRequested ? 'Stopped by you' : 'Stopped by an administrator');
        return;
      }
      if (askError instanceof AskRefused) {
        // The stages are kept when the refusal arrived mid-run. It used to clear
        // them unconditionally, which was right while a refusal could only reach
        // here as a plain JSON body -- there were none. A refusal that arrives on
        // an open stream has some behind it, and blanking a timeline the user
        // just watched fill in tells them the run never started.
        setRunStopped(askError.completed > 0 ? { steps: askError.completed } : null);
        setAskUnavailable(unavailableNoticeFor('ask', askError.result, { interactive: true }));
        return;
      }
      /*
       * Named before the generic branch, because it is the failure a reader
       * actually meets and the one they were told least about. The request got no
       * response at all, so the only true statement about which hop failed is
       * that this app's own server did not complete one -- and a release
       * replacing that server mid-question is the ordinary way it happens. The
       * old copy said "a service this needed did not respond", which points at
       * the agent endpoint and is wrong: nothing downstream was reached.
       */
      if (askError instanceof AskUnreachable) {
        setRunStopped(null);
        setAskUnavailable(
          unavailableNotice({
            surface: 'ask',
            code: 'DEPENDENCY_UNAVAILABLE',
            interactive: true,
            // The id the browser minted before the request left. Every other
            // branch here takes one off the server's payload; this branch has no
            // payload, and used to be the one failure a reader could not quote.
            correlationId: askError.correlationId,
            evidence: {
              dependency: { kind: 'app-server', name: '' },
              // The browser's own words. There is no status to quote, because
              // the point of this branch is that no response arrived.
              providerMessage: askError.reason,
            },
          })
        );
        return;
      }
      const stopped = askError instanceof AskRunFailed ? askError : null;
      setRunStopped(stopped ? { steps: stopped.completed } : null);
      // Nothing is appended to the transcript. This used to push a complete,
      // confident, fully-traced answer about five game titles into the
      // conversation and then apologise for it underneath, which is the exact
      // shape of the problem: the apology scrolls away and the figures do not.
      // The stages the run did finish stay on the timeline, because those were
      // observed; an answer was not.
      setAskUnavailable(
        unavailableNotice({
          surface: 'ask',
          code: stopped ? 'STREAM_INTERRUPTED' : 'DEPENDENCY_UNAVAILABLE',
          interactive: true,
          message: stopped
            ? `${stopped.message} The steps it did finish are shown above, as far as they got.`
            : undefined,
        })
      );
    } finally {
      // A terminal SSE result/error settled both display registries above. An
      // unclassified disconnect deliberately leaves them for durable recovery:
      // closing a socket is not evidence that its server-side run stopped.
      if (!currentAsk.correlationId) endLiveAsk(runConversationId);
      forgetActiveAsk(runConversationId, currentAsk);
    }
  }

  async function approveBudgetOverage() {
    if (!budgetStatus || budgetStatus.level !== 'approval-required' || budgetApprovalBusy) return;
    setBudgetApprovalBusy(true);
    setBudgetApprovalError('');
    try {
      await approveContinuedUsage(budgetStatus);
    } catch (approvalError) {
      setBudgetApprovalError((approvalError as Error).message);
    } finally {
      setBudgetApprovalBusy(false);
    }
  }

  function startNewConversation() {
    conversationLoadControllerRef.current?.abort();
    olderMessagesControllerRef.current?.abort();
    // One route back to the starter — the header lockup is the other. Clear
    // before minting the local draft so leaving and returning does not
    // resurrect the old thread.
    clearSelectedConversation();
    const id = `conv-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    setConversationId(id);
    activeConversationRef.current = id;
    setConversations((items) => [
      // Carries the reader's address like every other row of theirs, so the new
      // conversation is watermarked and counted from the moment it appears
      // rather than sitting in the rail as an unattributed row among their own.
      unaskedConversation({ id, owner: signedInAddress, updatedAt: now }),
      ...items.filter((item) => item.title !== PLACEHOLDER_CONVERSATION_TITLE),
    ]);
    setDraft('');
    setMessages([]);
    setOlderMessages({ hasMore: false, cursor: null });
    setOlderMessagesError(null);
    setOlderMessagesLoading(false);
    setAttachments([]);
    setError(null);
    setFeedback({});
    setRunStopped(null);
    setStopNotice(null);
    setDurableRunOpenedAt(null);
    // Nothing to clear: a conversation this new has no run on record, and the one
    // it was started from keeps its own under its own id.
    setConversationLoading(false);
    // An empty conversation has nothing stored to reload, so it is marked as
    // already loaded and the URL is cleared without pushing a history entry,
    // Back should return to the previous conversation, not to a blank one.
    loadedConversationRef.current = id;
    setSearchParams({}, { replace: true });
  }

  function focusQuestionInput() {
    composerRef.current?.querySelector('textarea')?.focus();
  }

  /**
   * The header lockup's home control. A link to `/` from another tab remounts
   * this page with the session record already cleared. The same click on an
   * open thread does not remount, so the starter has to be reached from here.
   */
  useEffect(() => subscribeAskHome(() => startNewConversation()));
  /**
   * A pencil save on Run Explorer. That page updates its own list immediately;
   * this map used to keep the first `/api/runs` Partial until a turn finished.
   */
  useEffect(() =>
    subscribeRunLabelOverrides((conversationId, overlay) => {
      setRunSummaries((current) => applyRunLabelOverrideToSummaries(current, conversationId, overlay));
      setConversations((items) => applyRunLabelOverrideToConversations(items, conversationId, overlay));
    })
  );

  /**
   * Records canonical feedback against one message.
   *
   * Writes for the same answer are serialized so a rapid down-to-up switch
   * cannot land out of order in the append-only audit table. The UI only accepts
   * completion from the newest requested change. A failed replacement restores
   * the last confirmed direction; failed written feedback stays in the focused
   * field so the reader can retry without retyping it.
   */
  async function saveFeedback(
    messageId: string,
    sentiment: FeedbackDirection,
    options: { keepCommentOpen?: boolean } = {}
  ) {
    const entry = feedbackRef.current[messageId] ?? emptyFeedback;
    if (!confirmedFeedbackRef.current.has(messageId) && entry.saved) {
      confirmedFeedbackRef.current.set(messageId, { ...entry });
    }
    const comment = sentiment === 'down' ? entry.comment.trim() : '';
    const version = (feedbackWriteVersionsRef.current.get(messageId) ?? 0) + 1;
    feedbackWriteVersionsRef.current.set(messageId, version);
    const patch = (changes: Partial<FeedbackEntry>) => {
      const next = { ...(feedbackRef.current[messageId] ?? emptyFeedback), ...changes };
      feedbackRef.current = { ...feedbackRef.current, [messageId]: next };
      setFeedback((current) => ({ ...current, [messageId]: { ...(current[messageId] ?? emptyFeedback), ...changes } }));
    };
    patch({
      saving: true,
      saved: false,
      error: null,
      sentiment,
      open: sentiment === 'down' && (options.keepCommentOpen === true || entry.open),
      ...(sentiment === 'up' ? { comment: '' } : {}),
    });

    const write = feedbackWriteQueueRef.current.enqueue(messageId, async () => {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, sentiment, comment: comment || undefined }),
      });
      if (!response.ok) throw new Error(`Feedback was not recorded (HTTP ${response.status}).`);
      notifyFeedbackChanged();
    });

    try {
      await write;
      const confirmed: FeedbackEntry = {
        ...emptyFeedback,
        saved: true,
        sentiment,
        comment,
        open: sentiment === 'down' && options.keepCommentOpen === true,
      };
      confirmedFeedbackRef.current.set(messageId, confirmed);
      if (feedbackWriteVersionsRef.current.get(messageId) !== version) return;
      patch({
        saving: false,
        saved: true,
        open: confirmed.open,
        error: null,
        sentiment,
        ...(sentiment === 'up' ? { comment: '' } : {}),
      });
      setRunSummaries((current) => {
        const next = new Map(current);
        for (const [conversationId, summary] of next) {
          if (summary.runId === messageId) next.set(conversationId, { ...summary, feedback: sentiment });
        }
        return next;
      });
    } catch (error) {
      if (feedbackWriteVersionsRef.current.get(messageId) !== version) return;
      const confirmed = confirmedFeedbackRef.current.get(messageId) ?? emptyFeedback;
      patch({
        saving: false,
        saved: false,
        sentiment: confirmed.sentiment,
        comment: sentiment === 'down' ? entry.comment : confirmed.comment,
        open: sentiment === 'down' || confirmed.sentiment === 'down',
        error: (error as Error).message || 'Feedback was not recorded.',
      });
    }
  }

  async function uploadAttachments(files: FileList | null) {
    if (!files?.length) return;
    // Raised for the whole batch and lowered once, at the end of it, so the
    // control cannot be pressed again while any part of a multi-file selection is
    // still in flight over the shared `<input>`.
    setAttaching(true);
    try {
      for (const file of Array.from(files)) {
        const localId = `upload-${crypto.randomUUID()}`;
        const failed = (message: string) =>
          setAttachments((items) =>
            items.map((attachment) =>
              attachment.id === localId
                ? { ...attachment, status: 'error', error: message, started_at: undefined }
                : attachment
            )
          );
        setAttachments((items) => [
          ...items,
          {
            id: localId,
            filename: file.name,
            mime_type: file.type || 'application/octet-stream',
            size_bytes: file.size,
            status: 'parsing',
            started_at: Date.now(),
          },
        ]);
        // Reject oversized files here rather than spending the upload to be told at the server.
        if (file.size > MAX_ATTACHMENT_BYTES) {
          failed('This report is larger than 8 MB. Try a smaller file.');
          continue;
        }
        try {
          const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/attachments`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-File-Name': encodeURIComponent(file.name),
              'X-File-Type': file.type || 'application/octet-stream',
            },
            body: file,
          });
          // A proxy or body-size rejection can answer with HTML, so never let a JSON
          // parse failure surface to the user as the reason the upload failed.
          const payload = (await response.json().catch(() => null)) as Attachment | null;
          if (!response.ok || !payload) {
            throw new Error(payload?.error ?? 'The report could not be attached. Try uploading it again.');
          }
          setAttachments((items) =>
            items.map((attachment) =>
              attachment.id === localId ? { ...payload, status: 'ready', started_at: undefined } : attachment
            )
          );
        } catch (uploadError) {
          failed((uploadError as Error).message || 'The report could not be attached. Try uploading it again.');
        }
      }
    } finally {
      // `finally`, because a control that is disabled until the page is reloaded
      // is a worse outcome than the missing feedback this pass is here to fix,
      // and the per-file `catch` above cannot promise to have caught everything.
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function removeAttachment(attachment: Attachment) {
    setAttachments((items) => items.filter((item) => item.id !== attachment.id));
    if (attachment.status === 'ready') {
      await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachment.id)}`,
        { method: 'DELETE' }
      ).catch(() => undefined);
    }
  }

  /**
   * Drop every uploaded document without ending the conversation.
   */
  async function clearDocs() {
    setClearingDocs(true);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/attachments`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        // The route explains itself on a 503; preferring its message keeps the
        // reason ("try again shortly") from being flattened into a generic one.
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? 'The documents could not be cleared. They are still attached.');
      }
      setAttachments([]);
      setError(null);
    } catch (clearError) {
      setError((clearError as Error).message);
    } finally {
      setClearingDocs(false);
    }
  }

  /**
   * Remove a conversation, once its confirmation has been answered.
   *
   * The row is dropped from the rail only after the route says it is gone.
   * Removing it optimistically is what made the attachment delete misreport a
   * Lakebase outage as a successful removal (the chip disappeared and the
   * document was still there), and the same trade is worse here, because a rail
   * entry that vanished without being deleted looks exactly like the data loss
   * this store has already suffered once.
   */
  async function deleteConversation(id: string) {
    setDeletingConversation(id);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) {
        // The route explains itself on 404 and 503, and its wording says
        // whether anything was removed. Preferring it keeps "nothing was
        // removed, try again" from being flattened into a generic failure.
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? 'This conversation could not be deleted.');
      }
      setConversations((items) => items.filter((item) => item.id !== id));
      updateActiveConversationRuns((runs) => forgetActiveConversationRun(runs, id));
      setPendingDelete(null);
      setError(null);
      // Deleting the conversation that is open would otherwise leave its
      // answers on screen under an id that no longer resolves.
      if (id === conversationId) startNewConversation();
    } catch (deleteError) {
      setError((deleteError as Error).message);
      setPendingDelete(null);
    } finally {
      setDeletingConversation(null);
    }
  }

  /**
   * Who appears in the rail, how many entries each of them has, and which owner
   * every row on screen is drawn with.
   *
   * Read off the conversations already fetched rather than asked for
   * separately. A second lookup could name someone the rail is not showing, or
   * miss someone it is, and either way the filter would be describing a
   * different set from the one being filtered.
   *
   * Rows and counts come back from ONE pass for the same reason. They were two:
   * the chips counted rows that carried an address and the "All" chip counted
   * every row, so the browser's own optimistic rows -- which carried no address
   * at all -- were on screen without a watermark and missing from the tally.
   * One reader asking five questions saw "All 5 · You 3" and two anonymous rows,
   * which reads as a colleague having quietly used their rail.
   */
  const rail = useMemo(() => railOwnership(conversations, identity.signedInAs), [conversations, identity.signedInAs]);
  const personas = useMemo(() => railPersonas(conversations), [conversations]);
  const adminSharedRail =
    identity.sharedConversationRail === true && (identity.role === 'admin' || identity.role === 'super_admin');

  useEffect(() => {
    if (identity.role === 'consumer') {
      ownerPreferenceLoadedFor.current = '';
      personaPreferenceLoadedFor.current = '';
      setOwnerFilters([]);
      setPersonaFilters([]);
      clearOwnerSelectionPreference();
      clearPersonaSelectionPreference();
      return;
    }
    if (identity.role !== 'admin' && identity.role !== 'super_admin') return;
    if (!adminSharedRail) {
      setOwnerFilters([]);
      return;
    }
    if (conversationLoading) return;

    const available = rail.owners.map((owner) => owner.key);
    if (ownerPreferenceLoadedFor.current !== identity.signedInAs) {
      ownerPreferenceLoadedFor.current = identity.signedInAs;
      setOwnerFilters(readOwnerSelectionPreference(identity.signedInAs, available));
      return;
    }
    setOwnerFilters((current) => {
      const normalized = normalizeOwnerSelection(current, available);
      if (normalized.length !== current.length || normalized.some((value, index) => value !== current[index])) {
        rememberOwnerSelectionPreference(identity.signedInAs, normalized);
        return normalized;
      }
      return current;
    });
  }, [adminSharedRail, conversationLoading, identity.role, identity.signedInAs, rail.owners]);

  useEffect(() => {
    if (identity.role === 'consumer') return;
    if (identity.role !== 'admin' && identity.role !== 'super_admin') return;
    if (!adminSharedRail) {
      setPersonaFilters([]);
      return;
    }
    if (conversationLoading) return;

    const available = personas.map((persona) => persona.key);
    if (personaPreferenceLoadedFor.current !== identity.signedInAs) {
      personaPreferenceLoadedFor.current = identity.signedInAs;
      setPersonaFilters(readPersonaSelectionPreference(identity.signedInAs, available));
      return;
    }
    setPersonaFilters((current) => {
      const normalized = normalizePersonaSelection(current, available);
      if (normalized.length !== current.length || normalized.some((value, index) => value !== current[index])) {
        rememberPersonaSelectionPreference(identity.signedInAs, normalized);
        return normalized;
      }
      return current;
    });
  }, [adminSharedRail, conversationLoading, identity.role, identity.signedInAs, personas]);

  /**
   * The selection, narrowed to people the rail is actually showing.
   *
   * A filter naming somebody who has since left the rail (their last
   * conversation deleted, say), would silently empty it. Worse with several
   * selected than with one: their chip goes with them, so the filter would be
   * both invisible and unclearable. Intersecting here means a name that is not
   * on screen cannot narrow what is, and does it for the toggles and the rows
   * from one place, so the pressed chips and the visible rows cannot disagree.
   *
   * Held as the normalised key rather than as the address, so a selection
   * survives the same person arriving under a different capitalisation.
   */
  const activeOwnerFilters = useMemo(() => {
    const present = new Set(rail.owners.map((owner) => owner.key));
    return ownerFilters.filter((key) => present.has(key));
  }, [ownerFilters, rail]);
  const activePersonaFilters = useMemo(() => {
    const present = new Set(personas.map((persona) => persona.key));
    return personaFilters.filter((key) => present.has(key));
  }, [personaFilters, personas]);
  const conversationFilterKey = useMemo(
    () =>
      JSON.stringify([
        activeOwnerFilters,
        activePersonaFilters
          .map((selection) => personaIdFromSelection(selection))
          .filter((personaId): personaId is string => personaId !== null),
      ]),
    [activeOwnerFilters, activePersonaFilters]
  );
  // Reconstructed from the canonical key so an evidence refresh returning a
  // new array of the same rows does not create a new dependency and refetch in
  // a loop while a filter is active.
  const conversationFilters = useMemo<ConversationFilterSelection>(() => {
    const [owners, personaIds] = JSON.parse(conversationFilterKey) as [string[], string[]];
    return { owners, personaIds };
  }, [conversationFilterKey]);

  const refreshConversationEvidence = useCallback(
    async (signal?: AbortSignal) => {
      const list = await readConversationList(conversationFilters, signal);
      if (!list.conversations) return;
      setConversations(list.conversations);
      if (list.matchingConversationIds) {
        setServerConversationMatches({
          key: conversationFilterKey,
          ids: new Set(list.matchingConversationIds),
        });
      }
    },
    [conversationFilterKey, conversationFilters]
  );

  useEffect(() => {
    if (!adminSharedRail || conversationLoading) return;
    const hasFilter = conversationFilters.owners.length > 0 || conversationFilters.personaIds.length > 0;
    if (!hasFilter) {
      setServerConversationMatches(null);
      return;
    }
    const controller = new AbortController();
    void refreshConversationEvidence(controller.signal);
    return () => controller.abort();
  }, [adminSharedRail, conversationFilters, conversationLoading, refreshConversationEvidence]);

  /**
   * Whose question every bubble in this transcript is, which is the CONVERSATION'S
   * owner and not the reader looking at it.
   *
   * It was `identity.signedInAs`, unconditionally, for every row. On a rail
   * narrowed to one person that is invisibly correct, because the only threads
   * anybody could open were their own. The rail is shared now, so opening a
   * colleague's conversation stamped their questions with YOUR name and address --
   * the app asserting authorship, on a screen whose whole purpose is to say who
   * asked what.
   *
   * `messages` carries no owner and is not going to: the ask route refuses a
   * conversation somebody else owns, so a thread has exactly one asker and the
   * conversation row is where it is recorded. That is the same column
   * `monitoring-routes.ts` reads as `asked_by` and the same one the rail draws its
   * watermark from, so all three now answer "who asked this" identically.
   *
   * The signed-in address is the fallback rather than the default, and only for a
   * conversation the rail has no row for yet -- a blank draft this session just
   * minted, where the reader is about to become the owner.
   */
  const asker = useMemo(() => {
    const owner = conversations.find((item) => item.id === conversationId)?.user_email;
    return typeof owner === 'string' && owner.trim() ? owner : identity.signedInAs;
  }, [conversations, conversationId, identity.signedInAs]);

  /** Owner and persona are ANDed; each multiselect is ORed within itself. */
  const visibleEntries = useMemo(() => {
    if (serverConversationMatches?.key === conversationFilterKey) {
      return rail.entries.filter((entry) => serverConversationMatches.ids.has(entry.conversation.id));
    }
    const selectedOwners = new Set(activeOwnerFilters);
    const selectedPersonas = new Set(activePersonaFilters);
    return rail.entries.filter((entry) => {
      if (selectedOwners.size > 0 && (entry.ownerKey === null || !selectedOwners.has(entry.ownerKey))) {
        return false;
      }
      if (selectedPersonas.size === 0) return true;
      const personaId = entry.conversation.persona_id?.trim() ?? '';
      return personaId ? selectedPersonas.has(personaSelectionKey(personaId)) : false;
    });
  }, [activeOwnerFilters, activePersonaFilters, conversationFilterKey, rail, serverConversationMatches]);

  /*
   * The rail's contents, drawn twice.
   *
   * Below 800px there is no room for a 264px column beside the transcript, and
   * the rail was simply hidden there: creating, switching and deleting a
   * conversation all became unreachable on a phone, which is most of what the
   * page can do besides asking. It now moves into a left sheet, the same pattern
   * the header's nav uses at the same widths.
   *
   * One function rather than a component, because the rail closes over nineteen
   * pieces of this page's state and a component would mean threading every one of
   * them through props. `scope` is what keeps the two copies' element ids apart,
   * and closing the sheet is unconditional: the actions that pick a conversation
   * are the ones that should dismiss it, and calling it on the aside's copy,
   * where it is already closed, does nothing.
   */
  const renderRail = (scope: RailScope) => (
    <>
      <Button
        className="w-full justify-center"
        onClick={() => {
          setRailSheetOpen(false);
          startNewConversation();
          focusQuestionInput();
        }}
      >
        <Plus /> New conversation
      </Button>
      <div>
        <p className="section-label">Conversations</p>
        {adminSharedRail && rail.owners.length > 0 ? (
          <div className="conversation-filter-row">
            <Suspense
              fallback={
                <>
                  <Skeleton className="conversation-owner-select app-select-trigger" />
                  <Skeleton className="conversation-owner-select conversation-persona-select app-select-trigger" />
                </>
              }
            >
              <ConversationFilters
                owners={rail.owners}
                personas={personas}
                total={rail.entries.length}
                selectedOwners={activeOwnerFilters}
                selectedPersonas={activePersonaFilters}
                onOwnersChange={(next) => {
                  setOwnerFilters(next);
                  rememberOwnerSelectionPreference(identity.signedInAs, next);
                }}
                onPersonasChange={(next) => {
                  setPersonaFilters(next);
                  rememberPersonaSelectionPreference(identity.signedInAs, next);
                }}
              />
            </Suspense>
          </div>
        ) : null}
        {conversationLoading && conversations.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : railAvailability?.origin ===
          'unavailable' /* Checked before the empty state, and the order is the whole point.
                 Both arrive here with no rows. `role="status"` because nobody
                 is waiting on this the way they wait on an answer, but a reader
                 who has just been told the rail is empty needs the correction. */ ? (
          <p className="conversation-empty" role="status">
            {railUnreadableNotice.heading}. {railUnreadableNotice.consequence}
          </p>
        ) : conversations.length === 0 ? (
          <p className="conversation-empty">{railEmptyNotice(identity.sharedConversationRail)}</p>
        ) : visibleEntries.length === 0 ? (
          <p className="conversation-empty">No conversations match the selected owner and persona.</p>
        ) : (
          visibleEntries.map(({ conversation, owner, you }) => {
            // What this conversation's latest answered turn recorded, or null
            // when nothing is known about it. Absent is the normal state for a
            // conversation nobody has asked anything yet.
            // The scoped read first, because it is the richer of the two: it
            // carries the reader's own rating, which the rail list cannot know.
            // The rail list answers for every OTHER row, which is every row
            // somebody else owns -- those used to draw no badge at all.
            const fallbackSummary = runSummaries.get(conversation.id) ?? conversationRunSummary(conversation);
            const trackedRun = activeConversationRuns.get(conversation.id) ?? null;
            const streamedRun = readLiveAsk(conversation.id);
            const conversationStages = streamedRun?.stages.length
              ? streamedRun.stages
              : replayedStages(trackedRun?.status ?? null);
            const summary = trackedRun?.summary ?? fallbackSummary;
            const duration = summary ? railDuration(summary.durationMs) : null;
            // A run in flight belongs to the open conversation. Seat the same
            // live pill as the agent-steps pane here, including its breathing
            // dot, instead of leaving the row badged with its previous turn.
            const runningConversation = conversationIsLive(
              activeConversationRuns,
              conversation.id,
              Boolean(streamedRun?.inFlight)
            );
            return (
              // Drawn from the entry rather than from the conversation, so the
              // watermark below is the same answer to "whose is this" that the
              // chips above were counted from. Reading `conversation.user_email`
              // here again is how the two came apart.
              // A row rather than a bare button, because the delete control is
              // a second button and one cannot be nested inside the other.
              // Selecting the conversation is still the whole of the first
              // button, so the click target for the common action is unchanged.
              conversation.id === pendingDelete ? (
                <div
                  key={conversation.id}
                  className="conversation-row confirming ast-surface-primary"
                  role="group"
                  aria-label={`Delete ${conversation.title}?`}
                >
                  <p className="conversation-confirm-question">Delete this conversation?</p>
                  <p className="conversation-confirm-detail">
                    Its questions, answers and traces are removed too. This cannot be undone.
                  </p>
                  <div className="conversation-confirm-actions">
                    <button
                      type="button"
                      className="conversation-confirm-cancel"
                      onClick={() => setPendingDelete(null)}
                      disabled={deletingConversation !== null}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="conversation-confirm-delete"
                      onClick={() => void deleteConversation(conversation.id)}
                      disabled={deletingConversation !== null}
                    >
                      {deletingConversation === conversation.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  key={conversation.id}
                  className={`conversation-row ast-surface-primary ${conversation.id === conversationId ? 'active' : ''}`}
                >
                  <button
                    type="button"
                    className="conversation-item"
                    aria-pressed={conversation.id === conversationId}
                    disabled={conversationLoading}
                    onMouseEnter={() => startStoredAnswerRendererPreload()}
                    onFocus={() => startStoredAnswerRendererPreload()}
                    // Pushes a history entry rather than loading directly, so Back
                    // returns to the conversation the user came from. The effect
                    // watching the URL does the loading.
                    onClick={() => {
                      startStoredAnswerRendererPreload();
                      // Persist in the click itself, before React processes the
                      // URL change, so an immediate tab switch cannot race the
                      // effect that loads the thread.
                      rememberSelectedConversation(conversation.id);
                      setRailSheetOpen(false);
                      setSearchParams({ c: conversation.id });
                    }}
                  >
                    {/* The head line: what the latest turn did, and when the
                        conversation was last touched. The same pair, in the same
                        places, as the recorded-runs card in the Run Explorer, which
                        is the list this rail is the other view of.

                        The pill is drawn only when a run is actually known for this
                        conversation. A conversation nobody has asked anything yet,
                        and one whose turns belong to somebody else and were never
                        sent to this browser, both have no status to report, and the
                        line is then the date alone. */}
                    <span className="conversation-item-head">
                      <ConversationRailRunStatus
                        run={trackedRun}
                        stages={conversationStages}
                        streamed={Boolean(streamedRun?.inFlight)}
                        fallback={fallbackSummary}
                      />
                      <span className="conversation-age ast-num">{conversationAge(conversation.updated_at)}</span>
                    </span>
                    {/* The clamp is two lines, so a long label is cut on screen even
                        though the row now stores it whole. The tooltip is how a reader
                        gets the rest of it back without opening the conversation. */}
                    <span
                      className="conversation-title"
                      id={railTitleId(conversation.id, scope)}
                      title={conversation.title}
                    >
                      {conversation.title}
                    </span>
                    <span className="conversation-meta">
                      {/* Wall time of that latest turn, when the trace recorded one.
                          Absent rather than zero for a turn stored before it did. */}
                      {duration && <span className="conversation-duration ast-num">{duration}</span>}
                      {summary?.feedback ? (
                        <Suspense fallback={null}>
                          <RunRatingBadge feedback={summary.feedback} />
                        </Suspense>
                      ) : null}
                    </span>
                  </button>
                  {adminSharedRail && owner ? (
                    <Suspense fallback={null}>
                      <UserDrilldownLink
                        identity={owner}
                        label="Asked by"
                        compact
                        className="conversation-owner"
                        canOpen
                      />
                    </Suspense>
                  ) : null}
                  {you ? (
                    <button
                      type="button"
                      className="conversation-delete"
                      // Name says what it does, description says what it acts
                      // on, and assistive tech announces them in that order.
                      aria-label="Delete conversation"
                      aria-describedby={railTitleId(conversation.id, scope)}
                      title="Delete this conversation"
                      disabled={runningConversation || conversationLoading}
                      onClick={() => setPendingDelete(conversation.id)}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              )
            );
          })
        )}
      </div>
    </>
  );

  /*
   * Nothing has been asked yet, which is a layout as well as a state.
   *
   * The hero and the composer both read it: on an empty transcript the composer
   * leaves its fixed seat at the bottom of the window and sits in the flow under
   * the headline, where the thing a reader has come to do is the thing in front of
   * them. Once there is a transcript it goes back to the bottom, because then it
   * is a control over a document rather than the document.
   *
   * `loading` is in the test so the composer does not travel the height of the
   * window between submitting the first question and the answer arriving. The
   * first question is appended to `messages` immediately, so this goes false on
   * the same render that draws the reader's own bubble.
   */
  const transcriptEmpty = messages.length === 0 && !loading && !conversationLoading;

  /*
   * The fixed composer is not one height: attachments, extraction failures and
   * the narrow run summary all add rows. Measure the element that is actually on
   * screen and publish the clearance only to this Ask transcript. The observer
   * utility also measures once immediately and falls back to DOM/viewport
   * observation in browsers without ResizeObserver.
   */
  useLayoutEffect(() => {
    const scope = conversationMainRef.current;
    const composer = composerRef.current;
    if (!scope || !composer) return;
    return observeComposerClearance(scope, composer);
  }, []);
  useLayoutEffect(() => {
    const scope = conversationMainRef.current;
    const composer = composerRef.current;
    if (!scope || !composer) return;
    measureComposerClearance(scope, composer, window.innerHeight);
  }, [transcriptEmpty]);

  /*
   * Whether the harness column is drawing a run, or the idle silhouette.
   *
   * The track stays either way: collapsing it at idle hid the Agent path pane
   * and left Ask as conversations beside empty sky. The attribute still names
   * the branch so the idle constellation and a live path cannot disagree about
   * whether there is a run.
   */
  const inspectorIdle = railStages.length === 0 && !loading;

  return (
    <div className="ask-layout" data-inspector={inspectorIdle ? 'idle' : 'run'}>
      <aside className="conversation-rail ast-surface-primary">{renderRail('rail')}</aside>

      {/* The sheet's trigger, drawn only below 800px, where the aside is not.
          responsive.css decides both, so the page cannot end up with two rails or
          none. Above that width this button is display:none and the aside is the
          rail. */}
      <Sheet open={railSheetOpen} onOpenChange={setRailSheetOpen}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rail-sheet-trigger"
          onClick={() => setRailSheetOpen(true)}
        >
          <MessagesSquare aria-hidden="true" /> Conversations
          {/* The count, because the button replaces a rail whose length was
              visible, and "Conversations" alone does not say whether there are
              any. */}
          {rail.entries.length > 0 && <span className="rail-sheet-count">{rail.entries.length}</span>}
        </Button>
        <SheetContent side="left" className="rail-sheet">
          <SheetHeader>
            <SheetTitle>Conversations</SheetTitle>
          </SheetHeader>
          <div className="conversation-rail is-sheet ast-surface-primary">{renderRail('rail-sheet')}</div>
        </SheetContent>
      </Sheet>

      <section ref={conversationMainRef} className={`conversation-main${transcriptEmpty ? ' is-empty' : ''}`}>
        {transcriptEmpty && (
          <div className="ask-hero">
            {/* The chip that introduces the agent, carrying the small cut of the
                mark on Ice. THE MARK IS THE AGENT (§1): the orange robot is
                retired, and the figure a reader meets on an empty transcript is
                now the same drawing as the app's own mark in the header and the
                one the loaders flicker through. It is decorative, because the
                words beside it are the label. */}
            <div className="ask-hero-chip">
              <span className="ask-hero-chip-mark">
                <AstrolabeMark size={18} />
              </span>
              astrolabe player intelligence
            </div>
            <h2>What would you like to understand about your players?</h2>
          </div>
        )}

        {!conversationLoading && (olderMessages.hasMore || olderMessagesLoading || olderMessagesError) ? (
          <div className="message-pagination" aria-live="polite">
            {olderMessages.hasMore ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-message-pagination="older"
                disabled={olderMessagesLoading}
                onClick={() => void loadOlderMessages()}
              >
                {olderMessagesLoading ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" /> Loading older messages…
                  </>
                ) : (
                  'Load older messages'
                )}
              </Button>
            ) : null}
            {olderMessagesError ? (
              <p className="message-pagination-error" role="alert">
                {olderMessagesError}
              </p>
            ) : olderMessagesLoading ? (
              <span className="sr-only" role="status">
                Loading older messages
              </span>
            ) : null}
          </div>
        ) : null}

        {!conversationLoading &&
          messages.map((message, index) => {
            // The memoized parse, so the object handed to the cards below keeps
            // its identity between renders and the charts are not rebuilt.
            const response = parsedResponses.get(message.id);
            // This answer's own feedback, looked up by the ANSWER's id rather
            // than the message's -- they are not always the same value -- so no
            // other answer's rating, comment or saved flag can appear here.
            // Only an answer has one: a plan and a clarification are not turns
            // anybody rates, and the two carry no id to rate them by.
            const rated =
              response && response.type !== 'plan' && response.type !== 'clarification'
                ? feedback[response.id]
                : undefined;
            const entry = rated ?? emptyFeedback;
            return (
              <div
                key={message.id}
                id={`conversation-message-${message.id}`}
                className="conversation-message"
                tabIndex={-1}
              >
                <MessageItem
                  message={message}
                  response={response}
                  asker={asker}
                  canOpenUser={adminSharedRail}
                  loading={loading}
                  // A plan is answered by the user's approval, before the agent has
                  // produced its next assistant message. Comparing only with the
                  // last ASSISTANT row left the approved card interactive for the
                  // entire continuation run: the approval row was below it, but
                  // `lastAssistantIndex` still pointed at the plan itself.
                  resolved={index < messages.length - 1}
                  // How it was settled, which the row above cannot tell from the
                  // row below being there: a plan is settled by approving it and
                  // also by revising it away, and only one of those two ran
                  // anything. The approval writes a known sentence as its user
                  // turn -- here and on the server -- so the turn under the plan
                  // is what says which happened.
                  approved={messages[index + 1]?.content === PLAN_APPROVAL_LABEL}
                  // The turn this answered, for the timeline's envelope row. Read
                  // from the transcript rather than the trace, which does not
                  // carry the prompt.
                  question={index > 0 && messages[index - 1].role === 'user' ? messages[index - 1].content : ''}
                  feedback={entry}
                  // The last answer, as before, and also any answer that already
                  // carries a rating. Only the last one offered the controls, so an
                  // answer rated earlier in a thread came back with its rating
                  // nowhere on screen -- indistinguishable from the rating having
                  // been lost, which is what it was reported as.
                  showFeedback={(index === lastAssistantIndex && !loading) || Boolean(entry.saved)}
                  onAsk={askRow}
                  onFeedbackChange={changeFeedback}
                  onSaveFeedback={rateRow}
                  processStages={
                    index === lastAssistantIndex &&
                    response &&
                    response.type !== 'plan' &&
                    response.type !== 'clarification' &&
                    response.trace.stages.length === 0
                      ? liveStages
                      : undefined
                  }
                />
              </div>
            );
          })}

        {(loading || conversationLoading) && (
          <Card className="answer-card">
            <CardContent className={workingSeat === 'splash' ? 'ast-splash' : 'pt-6 space-y-5'}>
              {/* The working animation is for a run that is actually running.
                  Restoring a saved conversation from Lakebase is not the agent
                  working -- nothing is being asked and nothing is being read --
                  so that case keeps the still mark it always had. Miming a run
                  over a database read is the same invention as a progress bar
                  that fills on a timer. */}
              {conversationLoading ? (
                <div className="flex items-center gap-3">
                  <div className="ask-loading-mark">
                    <AstrolabeMark size={26} />
                  </div>
                  <div>
                    <p className="font-medium">Loading conversation</p>
                    <p className="text-sm text-muted-foreground">Restoring the saved answer and trace from Lakebase.</p>
                  </div>
                </div>
              ) : workingSeat === 'splash' ? (
                <>
                  {/* `#17a`'s splash seating: 72px, centred, alone. It is the
                      splash's whole drawing rather than the narrow window's
                      alternative to `#5ar`'s panel, because the panel is a
                      520x220 sky above a two-line status and the wait it sat
                      over is read in a transcript -- 220px of night between the
                      question and what the agent is doing now pushed both off
                      the fold. The mark cycling through its four concepts says
                      the same thing in a seventh of the height. */}
                  <div className="ast-flick-splash">
                    <ConceptFlicker seat="splash" />
                  </div>
                  {/* The count under the panel, which is where the splash puts
                      it: the panel's own status line says what the agent is
                      doing, and repeating the number inside it would put the
                      same figure on screen twice a few pixels apart. */}
                  <div className="ast-splash-copy">
                    <strong>{WORKING_LABEL}</strong>
                    {elapsed ? (
                      <>
                        <span className="ast-sep" />
                        <strong className="ast-num">{elapsed}</strong>
                      </>
                    ) : null}
                  </div>
                </>
              ) : null}
              {/* Still indeterminate, and still for the original reason: the run
                  reports each step on finishing it, so the client knows what has
                  happened but never how much is left -- the agent takes as many
                  steps as the question needs. A percentage would be the same
                  invention as the four hardcoded stage names this replaced, which
                  ticked to full in 2.6 seconds and froze for the remaining 23. */}
              {!conversationLoading && <Progress value={null} aria-label="Planning out your answer" />}
              {/* The run, said from what has been observed of it: the request
                  going out, then each step with the arguments it was actually
                  given. The skeletons this replaces stood in for content that
                  was fourteen seconds away, under a sentence promising each
                  step "as it finishes" -- which is not what the endpoint does.
                  See live-progress.ts. */}
              {conversationLoading ? (
                <>
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-20 w-full" />
                </>
              ) : (
                <div className={workingSeat === 'splash' ? 'ast-splash-run' : undefined}>
                  <LiveProgress
                    stages={liveStages}
                    openedAt={streamOpenedAt}
                    lastStageAt={lastStageAt}
                    now={now}
                    question={askedQuestion}
                    elapsedMs={railElapsedMs}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {askUnavailable && <UnavailablePanel notice={askUnavailable} />}
        {displayedStopNotice && (
          <Alert>
            <AlertDescription>{displayedStopNotice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert>
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div ref={transcriptEndRef} className="transcript-end" aria-hidden="true" />
        <form
          ref={composerRef}
          className="composer"
          // The submit is what prompts a password manager to offer to save, so
          // the form is opted out as well as the field inside it. These are
          // attributes only; the Return-to-send wiring on the Textarea below is
          // untouched by them.
          {...PASSWORD_MANAGER_OPT_OUT}
          onSubmit={(event) => {
            event.preventDefault();
            if (loading) void stopCurrentAsk();
            else void ask();
          }}
        >
          {/* The inspector's two load-bearing parts, for the widths where there is
              no inspector. composer.css hides this above 1180px, where the column
              itself is on screen.
              Drawn from the first paint now, rather than only once there was a run
              to report. It was gated on one because the pill could say nothing an
              empty transcript did not already say -- "Ready" meant the page had
              rendered. It now reports whether the agent endpoint answered, which
              is a fact about the deployment that an empty transcript says nothing
              about, and withholding it until after the first question would mean
              the one moment it is worth reading is the one moment it is missing. */}
          <div className="trace-summary">
            <RunStatusPill status={runStatus} />
            {answer &&
              (answer.runStored === false ? (
                <span className="trace-summary-note" role="status">
                  {RUN_NOT_STORED}
                </span>
              ) : (
                <Link className="trace-summary-link" to={`/runs?run=${encodeURIComponent(answer.id)}`}>
                  Explore full run <Workflow aria-hidden="true" />
                </Link>
              ))}
          </div>
          <ComposerBudgetStatus
            status={budgetStatus}
            admin={identity.role === 'admin' || identity.role === 'super_admin'}
            busy={budgetApprovalBusy}
            error={budgetApprovalError}
            onApprove={() => void approveBudgetOverage()}
          />
          {attachmentsUnreadable && (
            <p className="composer-notice" role="status">
              Any documents attached to this conversation could not be read just now, so none are listed. Whatever was
              attached is still attached, and still reaches the agent.
            </p>
          )}
          {attachments.length > 0 && (
            <div className="attachment-list" role="region" aria-label="Attached context" tabIndex={0}>
              {attachments.map((attachment) => (
                <div
                  className={`attachment-chip ${attachment.status}`}
                  key={attachment.id}
                  role={attachment.status === 'error' ? 'alert' : undefined}
                >
                  {attachment.status === 'parsing' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : attachment.status === 'error' ? (
                    <CircleAlert className="size-4" />
                  ) : (
                    <FileText className="size-4" />
                  )}
                  <span>
                    <strong title={attachment.filename}>{attachment.filename}</strong>
                    <small>
                      {attachment.status === 'parsing'
                        ? parsingLabel(attachment, now)
                        : attachment.status === 'error'
                          ? attachment.error
                          : `${Math.max(1, Math.round(attachment.size_bytes / 1024))} KB · Ready`}
                    </small>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.filename}`}
                    onClick={() => void removeAttachment(attachment)}
                  >
                    <X />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about player behavior, engagement, addressability, or data quality…"
            rows={2}
            disabled={conversationLoading}
            // A textarea does not submit its form implicitly, so Return has to be
            // wired by hand. Default is prevented for every plain Return, including
            // one this cannot act on, so a keypress meant as "send" never leaves a
            // stray newline in the box. See submit-on-enter.ts for the IME clause.
            onKeyDown={(event) => {
              if (!submitsOnEnter(event)) return;
              event.preventDefault();
              if (!canAsk) return;
              void ask();
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            accept={ATTACHMENT_ACCEPT}
            onChange={(event) => void uploadAttachments(event.target.files)}
          />
          <div className="composer-actions">
            {/* `aria-busy` is both halves of the working state: it is what a screen
                reader is told and, through composer.css, what is painted. Two
                sources -- an attribute and a class -- is how a control ends up
                looking busy to one reader and idle to the other. The hover, press
                and focus states are the stylesheet's as well, because the ghost
                variant's own hover is `bg-accent`, and --accent is the same wash
                this strip is painted in: it has been drawing the strip's colour
                onto the strip for as long as the strip has existed. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="composer-attach"
              aria-busy={attachControl.pending}
              disabled={attachControl.disabled}
              onClick={() => fileInputRef.current?.click()}
            >
              {attachControl.pending ? <Loader2 className="animate-spin" /> : <Paperclip />} {attachControl.label}
            </Button>
            {attachments.length > 0 && ( // Separate from New conversation on purpose: dropping the documents
              // and dropping the thread are different intentions, and coupling them
              // costs the user the conversation to get rid of one stale PDF.
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={clearingDocs || loading || conversationLoading}
                onClick={() => void clearDocs()}
              >
                {clearingDocs ? <Loader2 className="animate-spin" /> : <Trash2 />}
                {clearingDocs ? 'Clearing…' : `Clear docs (${attachments.length})`}
              </Button>
            )}
            {/* The size and the colour are the strip's, in composer.css, rather
                than utilities here: this span is also the flexible spacer that puts
                the submit button hard right, and the two facts belong together.

                The mark leads the caveat rather than sitting elsewhere on the strip
                because the sentence names the agent in its first word, and the
                drawing and the name it belongs to read as one thing only while they
                are adjacent. Same seating as `.ai-note` under an answer, which is
                the same sentence said about a result instead of about the field.
                Decorative: the word "astrolabe" is right beside it, so a mark
                announced again would be the name read twice. */}
            <AIAnalysisCaveat className="composer-ai-note" />
            {/* One control for one current action. While a question is active it
                becomes Stop and remains pressable; Stop first records durable
                cancellation and only then aborts this browser's stream. */}
            <Button type="submit" disabled={loading ? stopping : !canAsk}>
              {loading ? (
                stopping ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Stopping…
                  </>
                ) : (
                  'Stop'
                )
              ) : parsing ? (
                'Reading files…'
              ) : (
                'Ask astrolabe'
              )}
            </Button>
          </div>
        </form>
      </section>

      <aside className="trace-inspector" ref={inspectorRef}>
        {/* Idle silhouette only. It used to unmount the moment the first step
            landed, so the pane flipped to a different night. It stays in the
            markup so that swap cannot return, but rail.css hides it once a run
            is on — the opening drawing uses the same product marks as the live
            path, and leaving it at 0.28 looked like a ghost copy of every
            tool node. Decorative; the heading names the column. */}
        <div className="trace-idle-sky" aria-hidden="true">
          <ConstellationField shape={OPENING_CONSTELLATION} />
        </div>
        {/* §4 names this column before it names what is in it: "LIVE AGENT
            HARNESS", then the run's pill, then the steps. The eyebrow is what
            the column IS and the heading is what the column HOLDS, which is why
            they are two lines rather than one -- the pill reports on the
            harness rather than on the list, so it belongs beside the eyebrow. */}
        <div className="trace-head">
          <p className="ast-eyebrow">{HARNESS_EYEBROW}</p>
          <RunStatusPill status={runStatus} onDark />
        </div>
        <h3 className="trace-title">Agent path</h3>
        {/* A clarification has a trace too, and it is the one that explains why the
            agent is asking. There is deliberately no reference-stage fallback: this
            rail used to show a completed four-stage run, including a red "partial"
            failure, before anyone had asked anything, and then animate a highlight
            through those invented stages while the real agent worked. */}
        {railStages.length > 0 /* The band, or the settled list, and nothing under either of them. The
             line that used to follow -- "Steps appear here as each one
             completes." -- explained the surface to the reader rather than
             reporting on the run, and it sat under a constellation that shows
             the chain arriving. There is deliberately no counter of the pause
             since the newest step either; see live-progress.ts. */ ? (
          <AgentPathConstellation
            stages={railStages}
            activeIndex={railActiveIndex}
            elapsedMs={railElapsedMs}
            totalMs={answer?.trace.totalMs ?? asked?.trace.totalMs ?? null}
            thread={conversationId}
            turn={railTurn}
          />
        ) : /* A run is going and has not reported a step yet. Idle Ask is the
                 sky above, not a second empty-state heading. They used to share
                 one panel and a `loading ?` inside every line of it, so a reader
                 waiting on their first step got an empty-state heading. */
        loading ? (
          /* A run is in flight and no step has landed yet, which is `#17a`'s
               inline seating: 20px mark, "Planning out your answer", the real
               count pinned right. It was a lucide spinner in a washed tile over
               "No steps yet" and a sentence explaining that each step would
               appear as it completed -- a generic glyph standing in for the agent
               (§1 retires those; the mark is the agent) above copy that explained
               the surface to the reader instead of reporting on the run.
               There is no empty-state heading with it. The row says a run is
               going and the pill above says the same; a third line naming the
               absence of steps is the list apologising for being empty. */
          <div className="trace-working">
            <WorkingInlineRow elapsed={elapsed} />
          </div>
        ) : null}
        {answer && (
          <>
            <Separator className="trace-divider" />
            <div className="metric-row">
              {/* A trace the answer did not carry reports nothing, rather than 0.0s
                  and 0 calls, which read as a run that was measured and took no
                  time, instead of a run whose trace never arrived. */}
              <span>
                Total time
                <strong
                  title={
                    answer.trace.stages.length > 0
                      ? `${answer.trace.totalMs.toLocaleString()} milliseconds`
                      : 'Not recorded'
                  }
                >
                  {answer.trace.stages.length > 0 ? formatDuration(answer.trace.totalMs) : 'Not recorded'}
                </strong>
              </span>
              <span>
                <ToolCallsLabel>Tool calls</ToolCallsLabel>
                <strong>{answer.trace.stages.length > 0 ? answer.trace.toolCalls : 'Not recorded'}</strong>
              </span>
              <span>
                Tokens
                <strong
                  title={
                    typeof answer.trace.prompt_tokens === 'number' && typeof answer.trace.completion_tokens === 'number'
                      ? `${answer.trace.prompt_tokens.toLocaleString()} input tokens / ${answer.trace.completion_tokens.toLocaleString()} output tokens`
                      : typeof answer.trace.total_tokens === 'number' && answer.trace.total_tokens > 0
                        ? `${answer.trace.total_tokens.toLocaleString()} total tokens`
                        : 'Not recorded'
                  }
                >
                  {/* The split only when both halves were metred. A gateway that
                      reports only a total prints that total rather than inventing
                      a zero input/output split. */}
                  {typeof answer.trace.prompt_tokens === 'number' && typeof answer.trace.completion_tokens === 'number'
                    ? `${answer.trace.prompt_tokens.toLocaleString()} / ${answer.trace.completion_tokens.toLocaleString()}`
                    : typeof answer.trace.total_tokens === 'number' && answer.trace.total_tokens > 0
                      ? answer.trace.total_tokens.toLocaleString()
                      : 'Not recorded'}
                </strong>
              </span>
              <span>
                Slowest<strong>{slowestStageName(answer.trace.stages) ?? 'Not recorded'}</strong>
              </span>
            </div>
            {/* The answer id is the run id: /api/runs derives conversation runs
                from the assistant message this answer was stored as, so the Run
                Explorer can open on the run the user just watched. Which is only
                true if it was stored. When the write was lost the id names
                nothing, and offering the link sent people to a Run Explorer that
                could not find it, so say what happened instead. */}
            {answer.runStored === false ? (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{RUN_NOT_STORED}</AlertDescription>
              </Alert>
            ) : (
              <Button variant="default" className="trace-explore w-full" asChild>
                <Link to={`/runs?run=${encodeURIComponent(answer.id)}`}>
                  Explore full run <ExternalLink aria-hidden="true" />
                </Link>
              </Button>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

/**
 * One row of the transcript: a question the reader asked, or whatever the agent
 * answered it with.
 *
 * MEMOIZED, AND THE CLOCK IS THE REASON. While a run is in flight the page ticks
 * `now` once a second so the elapsed counters move. Every one of those ticks used
 * to re-render the whole transcript with it -- every answer card, its plan card,
 * its sources, its timeline and its charts -- to change a number that is not in
 * any of them. On a long thread on a mid-range machine that is the most
 * expensive thing this page does while doing nothing.
 *
 * WHAT MAKES THE MEMO ACTUALLY WORK is that none of these props is rebuilt per
 * render. `message` and `response` come from state and a `useMemo`; `asker` is
 * the stable address string; `feedback` is either the entry from state or one
 * shared empty object; and the three callbacks are stable for the life of the page
 * -- see `askRow` and its neighbours, which exist for that reason alone. A single
 * inline arrow function in the list above would defeat every line of this.
 *
 * The JSX below is the transcript's, moved rather than rewritten: it is the same
 * markup, the same order of cases, and the same comments, so what a reader sees
 * is unchanged.
 */
const MessageItem = memo(function MessageItem({
  message,
  response,
  asker,
  canOpenUser,
  loading,
  resolved,
  approved,
  question,
  feedback,
  showFeedback,
  onAsk,
  onFeedbackChange,
  onSaveFeedback,
  processStages,
}: {
  message: ConversationMessage;
  /** Undefined where the stored envelope could not be parsed. */
  response: AgentResponse | undefined;
  asker: string;
  canOpenUser: boolean;
  loading: boolean;
  /** Whether a later turn has superseded this one's question or plan. */
  resolved: boolean;
  /** Whether the turn that superseded a plan was the reader approving it. */
  approved: boolean;
  /** The question this answered, or '' where the row above is not one. */
  question: string;
  feedback: FeedbackEntry;
  showFeedback: boolean;
  onAsk: (question: string, approval?: { planId: string; label: string }) => void;
  onFeedbackChange: (answerId: string, changes: Partial<FeedbackEntry>) => void;
  onSaveFeedback: (
    answerId: string,
    sentiment: FeedbackDirection,
    options?: { keepCommentOpen?: boolean }
  ) => Promise<void>;
  processStages?: TraceStage[];
}) {
  if (message.role === 'user') {
    return (
      <div className="user-message">
        <div className="user-bubble">{message.content}</div>
        <Suspense fallback={null}>
          <UserDrilldownLink identity={asker} label="Asked by" compact className="user-avatar" canOpen={canOpenUser} />
        </Suspense>
      </div>
    );
  }
  if (!response) {
    return (
      <StoredAnswerBoundary
        rawContent={message.content}
        feedback={feedback}
        onFeedbackChange={() => undefined}
        saveFeedback={() => Promise.resolve()}
        showFeedback={false}
      />
    );
  }
  if (response.type === 'clarification') {
    return (
      <ClarificationCard
        clarification={response.clarification}
        loading={loading}
        resolved={resolved}
        onAnswer={(reply) => onAsk(reply)}
      />
    );
  }
  if (response.type === 'plan') {
    return (
      <PlanCard
        plan={response.plan}
        loading={loading}
        resolved={resolved}
        approved={approved}
        onApprove={() =>
          onAsk(response.plan.question, {
            planId: response.plan.id,
            label: PLAN_APPROVAL_LABEL,
          })
        }
        // A revision is a question, so it is asked like one: no approval
        // attached, so nothing runs and the agent comes back with a new plan.
        // It used to drop the plan's original question into the composer and
        // focus it, which left the reader looking at the words they had already
        // typed with nothing to say what had happened. The editor is on the
        // card now; see PlanCard and plan-revision.ts.
        onRevise={(request) => onAsk(request)}
      />
    );
  }
  return (
    <StoredAnswerBoundary
      // The message id reaches the DOM as well as being React's key one level
      // up. React needs the key to tell the rows apart between renders; the
      // document needs an id so a link from a trace can name one answer and
      // this page can find it. A key alone never reaches the DOM.
      id={answerRowId(message.id)}
      preferenceKey={message.id}
      answer={response}
      rawContent={message.content}
      question={question}
      feedback={feedback}
      onFeedbackChange={(changes) => onFeedbackChange(response.id, changes)}
      saveFeedback={(sentiment, options) => onSaveFeedback(response.id, sentiment, options)}
      showFeedback={showFeedback}
      processStages={processStages}
    />
  );
});

/**
 * The agent asking for something it needs, with the options it can offer.
 */
function ClarificationCard({
  clarification,
  loading,
  resolved,
  onAnswer,
}: {
  clarification: Clarification;
  loading: boolean;
  resolved: boolean;
  onAnswer: (reply: string) => void;
}) {
  const options = clarification.options ?? [];
  return (
    <Card className={`plan-card ${resolved ? 'resolved' : ''}`}>
      <CardHeader>
        <div className="flex items-start gap-3">
          {/* The agent's mark, not a question mark: the same reasoning as the plan
              card. The badge beside it says whether the question is still open, and
              a mark that changes per turn stops being an identity.
              The mark is the astrolabe now rather than the robot (§1), so a
              clarification is signed with the same drawing the header carries. */}
          <div className="agent-avatar">
            <AstrolabeMark size={32} />
          </div>
          <div className="space-y-1">
            <Badge variant="outline">{resolved ? 'Question answered' : 'Needs one detail'}</Badge>
            <CardTitle className="answer-takeaway">{clarification.question}</CardTitle>
            {clarification.reason && (
              <CardDescription>
                <EntityText text={clarification.reason} sources={[]} />
              </CardDescription>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {options.length > 0 && (
          <div className="plan-steps">
            {options.map((option, index) => (
              <button
                type="button"
                className="plan-step"
                key={option}
                onClick={() => onAnswer(option)}
                disabled={loading || resolved}
              >
                <span>{index + 1}</span>
                <div>
                  <strong>{option}</strong>
                </div>
              </button>
            ))}
          </div>
        )}
        <Alert>
          <ShieldCheck />
          <AlertDescription>
            {resolved ? 'The analysis below continued from your reply.' : 'Nothing was queried for this turn.'}
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
