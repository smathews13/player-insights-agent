import {
  createBrowserRouter,
  RouterProvider,
  NavLink,
  Navigate,
  Outlet,
  Link,
  useLocation,
  useSearchParams,
} from 'react-router';
import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { AccessGate } from './AccessGate';
import { ConnectionsPage } from './ConnectionsPage';
import { storageBannerNotice, type StorageHealth } from './storage-banner-copy';
import { answerBadge, answerFallback, splitCaveats } from './degraded-answer';
import { dataProvenance } from './data-provenance';
import { submitsOnEnter } from './submit-on-enter';
import { PASSWORD_MANAGER_OPT_OUT } from './password-manager-optout';
import { IDENTITY_RESOLVING, IDENTITY_UNAVAILABLE, userInitials } from './user-initials';
import {
  buildSql,
  buildSources,
  REPRESENTATIVE_ANSWER_CAVEAT,
  REPRESENTATIVE_CAVEATS,
  REPRESENTATIVE_FIGURES,
  REPRESENTATIVE_NARRATIVE,
  REPRESENTATIVE_TAKEAWAY,
} from '../../shared/representative-answer';
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Progress,
  Separator,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from './ui';
import {
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Database,
  FileSearch,
  FileText,
  FlaskConical,
  HelpCircle,
  Info,
  Loader2,
  Menu,
  MessageSquareText,
  Paperclip,
  Play,
  Plus,
  PlugZap,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  UserRound,
  Workflow,
  Wrench,
  X,
} from 'lucide-react';
import { AnswerCharts, type Chart } from './AnswerCharts';
import { AnswerProse, EntityText, SourceEntityName } from './DataEntityLinks';
import { formatCheckedAt } from './preflight';
import { RouteError } from './RouteError';
import {
  benchmarkStatus,
  benchmarkStatusLabel,
  benchmarkSummary,
  formatDuration,
  isTerminal,
  ratingLabel,
} from './benchmark-summary';
import { askElapsedLabel, slowestStageName } from './progress-labels';
import { AskRunFailed, askStreaming } from './ask-stream';
import { LiveProgress } from './LiveProgress';
import { TraceTimeline } from './TraceTimeline';
import { traceHeadline } from './trace-timeline';
import {
  normalizeAnswer,
  normalizeClarification,
  type NormalizedAnswer,
  type StageStatus,
  type TraceStage,
  type TraceSummary,
  type WireAnswer,
} from './answer-shape';

// PIA is a light-only surface. AppKit's stylesheet flips its whole palette to dark tokens
// under `@media (prefers-color-scheme: dark)`, guarded by `:root:not(.light)`, so opting
// in here is what keeps a Dark Mode machine from rendering white text on white cards.
document.documentElement.classList.add('light');

/**
 * What the components are allowed to render: every field present, because it came
 * through `normalizeAnswer`. The loose shape the wire actually carries is
 * `WireAnswer` in answer-shape.ts, and nothing in this file should hold one.
 */
type Answer = Omit<NormalizedAnswer, 'charts'> & { charts?: Chart[] };
interface AnalysisPlan {
  id: string;
  question: string;
  summary: string;
  steps: {
    id: string;
    title: string;
    description: string;
    kind: 'context' | 'definitions' | 'data' | 'synthesis';
  }[];
  requires_approval: boolean;
  uses_conversation_context: boolean;
  uses_attachment_context: boolean;
}
interface PlanResponse {
  type: 'plan';
  mode: 'live';
  plan: AnalysisPlan;
}
/**
 * The agent's question back, when the one asked cannot be answered as put.
 *
 * A third response type rather than an error or an empty answer: nothing failed,
 * and the alternative to asking is a confident answer about the wrong table.
 * `reason` and `options` are optional on the wire and defaulted by the server,
 * because a bare question is still a usable one.
 */
interface Clarification {
  id: string;
  question: string;
  reason?: string;
  options: string[];
  trace: TraceSummary;
}
interface ClarificationResponse {
  type: 'clarification';
  mode: 'live';
  clarification: Clarification;
}
type AgentResponse = Answer | PlanResponse | ClarificationResponse;
interface Identity {
  signedInAs: string;
  executionIdentity: string;
  executionMode: string;
  /**
   * Whether the rail is carrying everyone's conversations. Optional because a
   * client can outlive the server that answered it, and the safe reading of a
   * missing field is the narrow one.
   */
  sharedConversationRail?: boolean;
}
// Rows can come from benchmark runs, where several columns are null.
interface Run {
  id: string;
  /** 'conversation' for an answered Ask PIA turn, 'benchmark' for a suite run. */
  kind?: string;
  conversation_id?: string | null;
  prompt: string | null;
  stakeholder: string | null;
  status: string | null;
  duration_ms: number | null;
  rating: number | null;
  created_at: string;
}
/**
 * What `GET /api/runs/:id/trace` returns for the selected run.
 *
 * `state` is the field that matters: 'trace' means these are the run's own
 * stages, 'no-trace' means the run genuinely has none and `note` says why. The
 * panes must never fill a 'no-trace' run in with a reference shape, showing a
 * plausible trace for the wrong run is the defect this endpoint exists to fix.
 */
interface RunTrace {
  runId: string;
  kind: 'conversation' | 'benchmark';
  state: 'trace' | 'no-trace';
  mode: 'live' | 'representative' | null;
  conversationId: string | null;
  createdAt: string;
  prompt: string | null;
  stakeholder: string | null;
  takeaway: string;
  narrative: string;
  sql: string;
  sources: { name: string; freshness: string }[];
  /** `trace.toolCalls` is the agent's own counter of external calls it made. */
  trace: { id: string; totalMs: number; toolCalls: number; stages: TraceStage[] } | null;
  /**
   * The stages tagged `kind: 'tool'`, a strict subset of the calls the counter
   * above records, so its length understates how many were made.
   */
  toolStages: {
    id: string;
    name: string;
    status: StageStatus;
    durationMs: number;
    calls: number;
    arguments: string;
    result: string;
  }[];
  mlflow: { traceId: string; experimentId: string | null; url: string | null } | null;
  benchmark: {
    suiteId: string | null;
    passed: number | null;
    total: number | null;
    groundedness: number | null;
    relevance: number | null;
    durationMs: number | null;
  } | null;
  note: string;
  undeclaredKeys: string[];
}
interface Conversation {
  id: string;
  title: string;
  updated_at: string;
  /**
   * Who asked. Optional because two kinds of rail entry legitimately have no
   * owner to name: a conversation started in this session and not yet written
   * to the store, and the representative rows served when Lakebase is
   * unreachable. Both render without a watermark rather than borrowing the
   * signed-in user's, which would be showing an owner the row does not have.
   */
  user_email?: string;
}
interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * `unknown` rather than `AgentResponse`, because that is what it is: whatever
   * Lakebase stored or the endpoint returned. Declaring it as the strict shape is
   * what let unchecked payloads reach the renderer. Read it via `responseFromMessage`.
   */
  response_json?: unknown;
}
interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: 'parsing' | 'ready' | 'error';
  error?: string;
  /** Set while parsing so the chip can show elapsed time for slow PDF extraction. */
  started_at?: number;
}

/** Formats the customer confirmed: PDF, Markdown, JSON, TXT, CSV. */
const ATTACHMENT_ACCEPT = '.pdf,.md,.json,.txt,.csv';
/** Mirrors MAX_ATTACHMENT_BYTES on the server so oversized files fail before upload. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

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
 */
function normalizeResponse(raw: unknown): AgentResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const response = raw as Record<string, unknown>;
  if (response.type === 'plan') return response as unknown as PlanResponse;
  if (response.type === 'clarification') {
    return { type: 'clarification', mode: 'live', clarification: normalizeClarification(response.clarification) };
  }
  return normalizeAnswer(response as WireAnswer) as Answer;
}

/** One answer's feedback state. Held per message id, never shared between answers. */
interface FeedbackEntry {
  open: boolean;
  comment: string;
  saved: boolean;
  saving: boolean;
  error: string | null;
}

const emptyFeedback: FeedbackEntry = { open: false, comment: '', saved: false, saving: false, error: null };

function responseFromMessage(message?: ConversationMessage): AgentResponse | null {
  if (!message?.response_json) return null;
  if (typeof message.response_json === 'string') {
    try {
      return normalizeResponse(JSON.parse(message.response_json));
    } catch {
      return null;
    }
  }
  return normalizeResponse(message.response_json);
}

/**
 * The dev Lakebase currently returns many rows per conversation, which floods the rail with
 * near-identical entries. Keep the most recent of each title so the list stays scannable;
 * the underlying rows are untouched and every distinct conversation is still reachable.
 */
function dedupeByTitle(items: Conversation[], keepId: string) {
  const seen = new Map<string, Conversation>();
  for (const item of items) {
    // A NUL between the two parts, so an owner and a title cannot run together
    // into the same key as a different pair would.
    const key = `${(item.user_email ?? '').trim().toLowerCase()}\u0000${item.title.trim().toLowerCase()}`;
    const existing = seen.get(key);
    // The open conversation always wins its slot, so selecting one never makes it disappear.
    if (existing?.id === keepId) continue;
    if (!existing || item.id === keepId || new Date(item.updated_at) > new Date(existing.updated_at)) {
      seen.set(key, item);
    }
  }
  return Array.from(seen.values()).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}

/**
 * The watermark on a rail entry: who asked, short enough to sit beside a date.
 *
 * Delegates to the module the message bubbles read from, because the rail and a
 * bubble can show the same person on the same screen. It used to have its own
 * copy of the rule, which is one drift away from a reader deciding "AN" and "A"
 * are two colleagues.
 */
function ownerInitials(email: string) {
  return userInitials(email).initials;
}

/**
 * The id of a rail entry's title, so the delete control beside it can borrow the
 * title as its description without repeating it in its own name.
 *
 * Derived from the conversation id rather than `useId`, because the two elements
 * that have to agree on it are rendered in the same iteration of the same list
 * and a per-component id would need threading through both.
 */
function railTitleId(conversationId: string) {
  return `rail-title-${conversationId}`;
}

function conversationAge(updatedAt: string) {
  const elapsed = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 172_800_000) return 'Yesterday';
  return new Date(updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const representativeTrace: TraceStage[] = [
  {
    id: 'plan',
    name: 'Interpreted the question',
    kind: 'agent',
    start: 0,
    duration: 620,
    status: 'complete',
    calls: 1,
    input: 'Compare active players by title.',
    output: 'Compare governed 30-day active players by game title.',
  },
  {
    id: 'discover',
    name: 'Found the right data',
    kind: 'agent',
    start: 620,
    duration: 1820,
    status: 'complete',
    calls: 2,
    input: 'Player activity and identity sources',
    output: 'Selected gameplay activity and player profiles.',
  },
  {
    id: 'dictionary',
    name: 'Checked field definitions',
    kind: 'tool',
    start: 1180,
    duration: 740,
    status: 'complete',
    calls: 1,
    input: 'player_id, brand_scope_status',
    output: 'Resolved unique-player semantics and how brand scope is marked.',
  },
  {
    id: 'query',
    name: 'Analyzed players',
    kind: 'tool',
    start: 2440,
    duration: 2310,
    status: 'partial',
    calls: 1,
    input: 'Generated read-only SQL',
    output: 'Five title-level active-player aggregates.',
  },
  {
    id: 'quality',
    name: 'Checked answer quality',
    kind: 'tool',
    start: 4750,
    duration: 930,
    status: 'complete',
    calls: 1,
    input: 'Sources, null ratios, freshness',
    output: 'Groundedness 0.94.',
  },
  {
    id: 'synthesis',
    name: 'Prepared the answer',
    kind: 'agent',
    start: 5680,
    duration: 1160,
    status: 'complete',
    calls: 1,
    input: 'Verified figures',
    output: 'Answer summary with chart.',
  },
];

/** MLflow's own trace ids; a canned answer carries a `trace-` prefixed id instead. */
const MLFLOW_TRACE_ID = /^tr-[0-9a-f]+$/i;

// REPRESENTATIVE_ANSWER_CAVEAT and the answer body below are imported from
// shared/representative-answer.ts. They used to be a copy kept "in step with"
// the server's by hand, which is how our catalogue name survived two cleanups.

/**
 * Discloses an answer no traced agent run produced.
 *
 * Read off the trace id rather than `mode`, because only a live answer can carry
 * an MLflow trace id. The offline answer below is complete and confident enough
 * to be mistaken for a live one, and a canned answer added here later would be
 * just as convincing, so the disclosure is derived rather than remembered.
 */
function discloseAnswerProvenance(answer: Answer): Answer {
  if (MLFLOW_TRACE_ID.test(answer.trace.id)) return answer;
  if (answer.caveats.includes(REPRESENTATIVE_ANSWER_CAVEAT)) return answer;
  return { ...answer, caveats: [REPRESENTATIVE_ANSWER_CAVEAT, ...answer.caveats] };
}

const representativeAnswer: Answer = discloseAnswerProvenance({
  id: 'msg-representative',
  mode: 'representative',
  takeaway: REPRESENTATIVE_TAKEAWAY,
  narrative: REPRESENTATIVE_NARRATIVE,
  figures: REPRESENTATIVE_FIGURES,
  sources: buildSources(),
  caveats: REPRESENTATIVE_CAVEATS,
  sql: buildSql(),
  trace: { id: 'trace-1042', totalMs: 6840, toolCalls: 6, stages: representativeTrace },
});

/**
 * Who the app believes is signed in, per `GET /api/identity`.
 */
function useIdentity() {
  const [identity, setIdentity] = useState<Identity>({
    // Both placeholders are named in user-initials.ts, which has to recognise
    // them: they are sentences, and an avatar built from one reads "RS".
    signedInAs: IDENTITY_RESOLVING,
    executionIdentity: 'Player Insights service principal',
    executionMode: 'service-principal',
  });
  useEffect(() => {
    fetch('/api/identity')
      .then((response) =>
        response.ok ? (response.json() as Promise<Identity>) : Promise.reject(new Error('Identity unavailable'))
      )
      .then(setIdentity)
      .catch(() => setIdentity((current) => ({ ...current, signedInAs: IDENTITY_UNAVAILABLE })));
  }, []);
  return identity;
}

/**
 * Whether the numbers on screen are stored records or seeded ones.
 */
function useStorageHealth(intervalMs = 20_000) {
  const [health, setHealth] = useState<StorageHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      fetch('/api/storage')
        // 503 is the expected answer during an outage and still carries the body.
        .then((response) => response.json() as Promise<StorageHealth>)
        .then((next) => void (cancelled || setHealth(next)))
        .catch(() => undefined);
    void read();
    const timer = setInterval(() => void read(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return health;
}

/**
 * The app-wide statement that stored data is not what is being shown.
 */
function StorageBanner() {
  const health = useStorageHealth();
  // Which of the three things to say, and in which words, is decided in
  // storage-banner-copy.ts so that it can be tested without a browser. The
  // three states put identical-looking seeded figures on screen and have
  // different remedies, and a reader who cannot tell them apart goes looking
  // for the wrong fault. That is not hypothetical, it is how this banner came
  // to be written, and it is why the choice is now something a test pins.
  const notice = storageBannerNotice(health && {
      ...health,
      since: formatCheckedAt(health.since),
      last_ok_at: health.last_ok_at ? formatCheckedAt(health.last_ok_at) : null,
    }
  );
  if (!notice) return null;

  // Neutral ink for the neutral tone, not amber. The stylesheet records amber
  // being removed deliberately: sitting near the gold evaluation card it read
  // as a dimmer gold and blurred the rule that gold means evaluation and
  // nothing else.
  const blocking = notice.tone === 'blocking';
  return (<div
      className={
        blocking
          ? 'border-b border-destructive/40 bg-destructive/10 px-4 md:px-6 py-2.5'
          : 'border-b border-border bg-muted px-4 md:px-6 py-2.5'
      }
    >
      <Alert variant={blocking ? 'destructive' : 'default'} className="border-0 bg-transparent p-0">
        {blocking ? <CircleAlert /> : <Info />}
        <AlertDescription className="flex flex-wrap items-baseline gap-x-2">
          <strong>{notice.heading}</strong>
          <span>{notice.detail}</span>
          {health?.last_error ? (<span className="text-xs opacity-80">
              {health.last_error.route} failed: {health.last_error.message}
            </span>
          ) : null}
          {/* The command itself, on screen, in a shape that can be copied. A
              banner that says "run the grant script" without saying which
              variables it needs sends the reader to the docs to find out, and
              the docs are the thing they already did not read. */}
          {notice.remedy ? (<pre className="w-full whitespace-pre-wrap rounded bg-background/60 px-2 py-1.5 text-xs font-mono">
              {notice.remedy}
            </pre>
          ) : null}
          {notice.remedyNote ? <span className="text-xs opacity-80">{notice.remedyNote}</span> : null}
          <Link to="/connections" className="underline font-medium">
            Connections
          </Link>
        </AlertDescription>
      </Alert>
    </div>
  );
}

type RunTraceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: RunTrace }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/**
 * The selected run's own trace, refetched whenever the selection changes.
 *
 * A superseded request is aborted rather than allowed to land late, because one
 * run's stages appearing under another run's heading is the same defect this
 * whole endpoint exists to remove, just arrived at by a different route.
 */
/**
 * `refreshToken` re-reads the same run. A benchmark suite runs asynchronously for
 * several minutes, so its trace has to be polled to see it finish; changing the
 * token is how a caller asks for that without pretending the run id changed.
 */
function useRunTrace(runId: string | undefined, refreshToken = 0): RunTraceState {
  // Keyed by the run it was fetched for, so a result can only ever be shown
  // under the run it belongs to, including on the render between a new
  // selection and its fetch, which is otherwise a frame of the previous run.
  const [loaded, setLoaded] = useState<{ runId: string; state: RunTraceState } | null>(null);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    const settle = (state: RunTraceState) => {
      if (!controller.signal.aborted) setLoaded({ runId, state });
    };
    fetch(`/api/runs/${encodeURIComponent(runId)}/trace`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) {
          settle({ status: 'missing' });
          return;
        }
        if (!response.ok) throw new Error('This run’s trace could not be read.');
        settle({ status: 'ready', data: (await response.json()) as RunTrace });
      })
      .catch((error: Error) => {
        settle({ status: 'error', message: error.message });
      });
    return () => controller.abort();
  }, [runId, refreshToken]);
  if (!runId) return { status: 'idle' };
  // A poll must not blank the pane it is refreshing, so a result already held for
  // this run stays on screen while the next read is in flight.
  return loaded?.runId === runId ? loaded.state : { status: 'loading' };
}

// Active is the red --primary pill; hovering an inactive route previews that with the
// red wash and red type that --accent carries. Both sides come from tokens, so the
// palette rules in index.css stay the single source of truth for the nav.
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-semibold transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
  }`;

const mobileNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded-md text-sm font-semibold transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
  }`;

type NavLinkClassFn = (props: { isActive: boolean }) => string;

function NavLinks({
  className,
  linkClass,
  onClick,
}: {
  className?: string;
  linkClass: NavLinkClassFn;
  onClick?: () => void;
}) {
  return (<nav className={className}>
      <NavLink to="/" end className={linkClass} onClick={onClick}>
        <MessageSquareText className="size-4" /> Ask PIA
      </NavLink>
      <NavLink to="/runs" className={linkClass} onClick={onClick}>
        <Workflow className="size-4" /> Run Explorer
      </NavLink>
      {/* One entry, not two. Sources & Capabilities asked "can the agent reach
          its dependencies" and Connections asked "are they the right ones, and
          what would change them" off the same evidence, and nobody reading the
          nav could tell which question they were picking. */}
      <NavLink to="/connections" className={linkClass} onClick={onClick}>
        <PlugZap className="size-4" /> Connections
      </NavLink>
      {/* Last on purpose. The other three are read on a normal visit; this one is
          a workbench somebody goes to deliberately. */}
      <NavLink to="/benchmarks" className={linkClass} onClick={onClick}>
        <FlaskConical className="size-4" /> Benchmark Lab
      </NavLink>
    </nav>
  );
}

function IdentityChips({ identity, className }: { identity: Identity; className?: string }) {
  return (<div className={`identity-chips ${className ?? ''}`}>
      {/* Titled with the whole address because the chip shows the local part and
          then truncates that too when the header is tight. */}
      <div className="identity-chip" title={identity.signedInAs}>
        <UserRound className="size-3.5" />
        <span>
          <span className="identity-chip-label text-muted-foreground">Signed in</span>{' '}
          {identity.signedInAs.split('@')[0]}
        </span>
      </div>
    </div>
  );
}

function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const identity = useIdentity();

  return (<div className="min-h-screen bg-muted/30 flex flex-col">
      <header className="app-header border-b bg-background px-4 md:px-6 py-3 flex items-center gap-4 sticky top-0 z-30">
        <div className="brand-lockup">
          {/* The partner mark. Published builds replace this file with a transparent
              image of the same size, so the space is reserved and nothing is shown;
              see mirror/make-neutral-icons.py. Empty alt because the wordmark beside
              it already names the app, and a screen reader announcing a decorative
              logo twice is noise. */}
          <img className="partner-mark" src="/t2-logo.png" alt="" aria-hidden="true" />
          <div className="logo-mark">
            <img src="/pia-logo-new.png" alt="Player Insights Agent" />
          </div>
          <div className="brand-name">
            <h1>Player Insights Agent</h1>
            <span className="brand-full">Player Intelligence</span>
          </div>
        </div>
        {/* Four links now that Sources merged into Connections, but the
            breakpoint stays: below xl the nav and the brand alone
            over-subscribe the header, which squeezed the identity chips to zero
            width and pushed the gear off the right edge; the sheet below carries
            the same links at those widths. */}
        <NavLinks className="hidden xl:flex gap-1 ml-4" linkClass={navLinkClass} />
        <IdentityChips identity={identity} className="ml-auto hidden md:flex items-center gap-3 text-xs" />
        {/* The way into settings.
            
            `/connections` has been the settings surface since it was written,
            it reads and writes `/api/settings`, but it was reachable only as a
            word in a nav bar that hides below `xl`, and nobody looking for
            settings looks for "Connections". So: a gear, in the corner people
            check first, pointing at the page that was already there. It is now
            also where Sources & Capabilities went, which is the complaint this
            gear used to attract: it looked like it "just linked to the sources
            tab", because the two pages were built from the same evidence.

            Neutral by construction. `ghost` and `text-muted-foreground` are
            tokens rather than hues, so it comes through a repaint of the
            palette without a second edit.

            Named "App settings" rather than "Settings" so it is not a substring
            of anything nearby: "the button called Settings" would otherwise be
            an ambiguous locator the moment a settings word appears in the nav,
            which is how the delete control broke four tests this morning. */}
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="ml-auto md:ml-2 text-muted-foreground hover:text-foreground"
        >
          <NavLink to="/connections" aria-label="App settings" title="App settings">
            <Settings className="size-5" />
          </NavLink>
        </Button>
        {/* Mobile nav, visible below the xl breakpoint the desktop nav needs */}
        <div className="xl:hidden">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <Button variant="outline" size="icon" onClick={() => setMobileNavOpen(true)}>
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open navigation</span>
            </Button>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <NavLinks
                className="flex flex-col gap-1 px-4"
                linkClass={mobileNavLinkClass}
                onClick={() => setMobileNavOpen(false)}
              />
              <IdentityChips identity={identity} className="mobile-identity md:hidden" />
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <StorageBanner />

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * A moved page, without losing what the URL was asking for.
 *
 * `<Navigate to="/somewhere">` drops the search string, which for `/sources` is
 * the whole point of the link: `?entity=<table>` is what tells the destination
 * which row to scroll to and highlight.
 */
function RedirectKeepingQuery({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

/**
 * Every route carries its own error element.
 *
 * Without one, React Router falls back to its built-in development page (the one
 * addressed to "Hey developer", printing a stack trace), and it does so for the
 * whole route. The app's own `ErrorBoundary` in main.tsx never got the chance,
 * because the router's per-route boundary catches first.
 */
const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <HomePage />, errorElement: <RouteError /> },
      { path: '/benchmarks', element: <BenchmarkLab />, errorElement: <RouteError /> },
      { path: '/runs', element: <RunExplorer />, errorElement: <RouteError /> },
      { path: '/connections', element: <ConnectionsPage />, errorElement: <RouteError /> },
      // Sources & Capabilities was merged into Connections: it reported the same
      // preflight the settings route already runs, and the two pages were
      // indistinguishable to the people they were for. The redirect carries the
      // query string because every entity link an answer has ever rendered
      // points at `/sources?entity=<table>`, and dropping it would land a reader
      // on the right page with nothing highlighted.
      { path: '/sources', element: <RedirectKeepingQuery to="/connections" /> },
      // First-run setup was removed. A bookmark lands on the page that still
      // shows this deployment's configuration rather than on an error.
      { path: '/setup', element: <Navigate to="/connections" replace /> },
    ],
  },
]);

export default function App() {
  // Outside the router on purpose: the choice is about the session rather than
  // about a page, and asking again on every navigation would train people to
  // dismiss it without reading, which is the opposite of what it is for.
  return (<AccessGate>
      <RouterProvider router={router} />
    </AccessGate>
  );
}

function HomePage() {
  const identity = useIdentity();
  // Who to sign this transcript's questions with. Recomputed per render rather
  // than memoized: it is a string split, and the identity changes once.
  const asker = userInitials(identity.signedInAs);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /**
   * Whether this conversation's documents could not be read, as opposed to there
   * being none. The chip row cannot express the difference, so it is said in
   * words beside it.
   */
  const [attachmentsUnreadable, setAttachmentsUnreadable] = useState(false);
  const [clearingDocs, setClearingDocs] = useState(false);
  const [loading, setLoading] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(true);
  /**
   * When the request in flight was sent, so the wait can be counted rather than
   * mimed. A real question took 27.5 seconds against a progress bar that filled
   * in 2.6 and then sat frozen and fully ticked for the remaining 23, which
   * reads as a hung application, and is worse than showing no progress at all.
   */
  const [askStartedAt, setAskStartedAt] = useState<number | null>(null);
  /**
   * Steps the run in flight has finished, in the order the agent finished them.
   *
   * Every entry is a measured `TraceStage` the agent emitted on completing it,
   * the same rows, with the same names and durations, that the finished "How it
   * worked" panel draws. Nothing is added here that the run did not report, so
   * this list only ever grows by one real step at a time and is empty until the
   * first one lands.
   */
  const [liveStages, setLiveStages] = useState<TraceStage[]>([]);
  /**
   * When the route opened the stream, and when the newest step arrived.
   *
   * Both are instants recorded as they happened, because both are things the
   * live panel states as fact. The first is what lets it distinguish "still
   * asking" from "the run has started" in the seconds before any step exists,
   * measured at about half a second, against a first step that can be twenty
   * away. See live-progress.ts.
   */
  const [streamOpenedAt, setStreamOpenedAt] = useState<number | null>(null);
  const [lastStageAt, setLastStageAt] = useState<number | null>(null);
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
  const [error, setError] = useState<string | null>(null);
  /**
   * Feedback state per answer, keyed by the message id it belongs to.
   */
  const [feedback, setFeedback] = useState<Record<string, FeedbackEntry>>({});
  const [conversations, setConversations] = useState<Conversation[]>([]);
  /**
   * The conversation whose delete has been asked for but not yet confirmed.
   */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deletingConversation, setDeletingConversation] = useState<string | null>(null);
  /**
   * Whose conversations the rail is narrowed to. Empty means everyone in it.
   */
  const [ownerFilters, setOwnerFilters] = useState<readonly string[]>([]);
  const toggleOwnerFilter = useCallback((email: string) => {
    setOwnerFilters((current) =>
      current.includes(email) ? current.filter((entry) => entry !== email) : [...current, email]
    );
  }, []);
  /**
   * The open conversation is in the URL, so the browser's Back button moves
   * between conversations instead of leaving the application.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const [conversationId, setConversationId] = useState(() => searchParams.get('c') ?? `conv-${crypto.randomUUID()}`);
  /**
   * The conversation on screen, readable from inside a run that is still going.
   */
  const activeConversationRef = useRef(conversationId);
  const [now, setNow] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
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
    latestResponse && latestResponse.type !== 'plan' && latestResponse.type !== 'clarification'
      ? latestResponse
      : null;
  const asked = latestResponse?.type === 'clarification' ? latestResponse.clarification : null;
  const lastAssistantIndex = messages.map((message) => message.role).lastIndexOf('assistant');
  const parsing = attachments.some((attachment) => attachment.status === 'parsing');
  // One condition for the Ask button and for Return, so the key cannot start a
  // run the button is disabled for -- a second submission while one is in
  // flight, or an empty prompt.
  const canAsk = draft.trim().length > 0 && !loading && !conversationLoading && !parsing;
  // The rail draws the run that happened, or the one happening, or nothing. No
  // reference stages stand in. While a question is in flight the live steps are
  // preferred over the previous answer's, so the panel is never narrating the
  // last run while this one is going; once the answer lands, `liveStages` is
  // cleared and the same rail is drawn from the authoritative trace.
  const railStages = (loading || runStopped) && liveStages.length > 0
    ? liveStages
    : answer?.trace.stages.length
      ? answer.trace.stages
      : (asked?.trace.stages ?? []);

  const selectConversation = useCallback(async (id: string) => {
    setConversationId(id);
    activeConversationRef.current = id;
    setConversationLoading(true);
    setLoading(false);
    setError(null);
    setFeedback({});
    // The run that stopped belongs to the conversation it stopped in. Left
    // standing, its badge and its steps narrate whichever conversation is
    // opened next, which is a run that never happened there.
    setRunStopped(null);
    setLiveStages([]);
    try {
      const [messageResponse, attachmentResponse] = await Promise.all([
        fetch(`/api/conversations/${encodeURIComponent(id)}/messages`),
        fetch(`/api/conversations/${encodeURIComponent(id)}/attachments`),
      ]);
      if (!messageResponse.ok) throw new Error('Conversation unavailable');
      setMessages((await messageResponse.json()) as ConversationMessage[]);
      // An attachment list that could not be read is not a conversation with no
      // documents, and drawing it as one is worse than saying nothing: the
      // documents are still attached and still reach the agent on the next
      // question, so a user looking at an empty chip row would conclude the
      // opposite of what is true. The route says which of the two happened.
      setAttachmentsUnreadable(!attachmentResponse.ok);
      setAttachments(attachmentResponse.ok
          ? ((await attachmentResponse.json()) as Omit<Attachment, 'status'>[]).map((attachment) => ({
              ...attachment,
              status: 'ready',
            }))
          : []
      );
      setDraft('');
    } catch {
      setDraft('');
      setMessages([]);
      setAttachments([]);
      setAttachmentsUnreadable(false);
      setError('This conversation could not be loaded. Start a new conversation or try again.');
    } finally {
      setConversationLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/conversations')
      .then((response) => {
        if (!response.ok) throw new Error('Conversations unavailable');
        return response.json() as Promise<Conversation[]>;
      })
      .then((items) => {
        if (!active) return;
        // The rail lists saved/example conversations, but the app opens on a fresh
        // chat so the welcome state is the first thing a new user sees.
        setConversations(items);
        setConversationLoading(false);
      })
      .catch(() => {
        if (active) setConversationLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  /**
   * Follows the URL, which is what makes Back and Forward work.
   *
   * Every conversation change goes through the address bar: a click pushes a
   * history entry, and this loads whatever the entry names, whether the user got
   * there by clicking, by going back, or by opening a link. Guarded on the id
   * already loaded, so it does not re-fetch on unrelated renders.
   */
  const loadedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    const target = searchParams.get('c');
    if (!target || target === loadedConversationRef.current) return;
    loadedConversationRef.current = target;
    void selectConversation(target);
  }, [searchParams, selectConversation]);

  useEffect(() => {
    if (conversationLoading || messages.length === 0) return;
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, loading, conversationLoading]);

  // Keeps every elapsed counter moving: the parsing chips during a slow PDF
  // extraction, and the agent's own wait, which is the longer of the two.
  useEffect(() => {
    if (!parsing && !loading) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [parsing, loading]);

  async function ask(question = draft,
    approval?: { planId: string; label: string }
  ) {
    if (!question.trim() || loading) return;
    // Everything below writes into the conversation this run started in. Once
    // the user is somewhere else, none of it is theirs to write: an answer, a
    // step, an error banner or a URL change landing in the conversation they
    // moved to describes a question that was never asked there.
    const runConversationId = conversationId;
    const stillInThisConversation = () => activeConversationRef.current === runConversationId;
    const userMessage: ConversationMessage = {
      id: `local-${crypto.randomUUID()}`,
      role: 'user',
      content: approval?.label ?? question,
    };
    setMessages((items) => [...items, userMessage]);
    setDraft('');
    setLoading(true);
    setAskStartedAt(Date.now());
    setLiveStages([]);
    setStreamOpenedAt(null);
    setLastStageAt(null);
    setAskedQuestion(question);
    setRunStopped(null);
    setError(null);
    try {
      const { body } = await askStreaming({
          conversationId: runConversationId,
          prompt: question,
          approvedPlanId: approval?.planId,
          executePlan: Boolean(approval),
        },
        // Appended rather than replaced: each event is one finished step, and
        // the list is the run so far. A turn that answers with a plan sends
        // none at all, because the agent proposes before it runs anything.
        {
          onStage: (stage) => {
            if (!stillInThisConversation()) return;
            setLiveStages((stages) => [...stages, stage]);
            setLastStageAt(Date.now());
          },
          // The run is under way and the request passed every check. Recorded
          // as an instant because the panel says so on screen, and because the
          // interval between this and the first step is the wait this whole
          // change is about.
          onOpen: () => {
            if (!stillInThisConversation()) return;
            setStreamOpenedAt(Date.now());
          },
        }
      );
      if (!stillInThisConversation()) return;
      // Normalized before it is read rather than after it is stored: the envelope
      // below reads `result.narrative` and `result.id`, and those can be absent too.
      const result = normalizeResponse(body);
      if (!result) throw new Error('The live agent returned a response the app could not read.');
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
        setError('The agent proposed a revised plan instead of running the approved one. Review and approve it to continue.');
      }
      const now = new Date().toISOString();
      setConversations((items) => [
        { id: runConversationId, title: question.slice(0, 80), updated_at: now },
        ...items.filter((item) => item.id !== runConversationId),
      ]);
      // Now that this conversation has something stored in it, name it in the URL
      // so it can be linked to and so Back and Forward have somewhere to land.
      // Replace rather than push: asking a question is not a navigation.
      loadedConversationRef.current = runConversationId;
      setSearchParams({ c: runConversationId }, { replace: true });
    } catch (askError) {
      if (!stillInThisConversation()) return;
      // A run that reached the agent and then stopped is a different event from
      // an endpoint that was never reachable, and the difference is visible on
      // screen: the steps it did finish are still there. Saying "the endpoint is
      // unavailable" over a rail showing four completed steps contradicts what
      // the user just watched happen.
      const stopped = askError instanceof AskRunFailed ? askError : null;
      setRunStopped(stopped ? { steps: stopped.completed } : null);
      setMessages((items) => [
        ...items,
        {
          id: representativeAnswer.id,
          role: 'assistant',
          content: representativeAnswer.narrative,
          response_json: representativeAnswer,
        },
      ]);
      setError(`${
          stopped
            ? `${stopped.message} The steps it did finish are shown as far as they got.`
            : 'The serving endpoint is unavailable.'
        } Showing a representative POC response so you can continue the evaluation.`
      );
    } finally {
      // Not unconditionally: leaving this conversation already cleared the flag,
      // and a question asked in the new one would have its "Working…" state
      // switched off by the abandoned run finishing behind it.
      if (stillInThisConversation()) setLoading(false);
    }
  }

  function startNewConversation() {
    const id = `conv-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    setConversationId(id);
    activeConversationRef.current = id;
    setConversations((items) => [
      { id, title: 'New conversation', updated_at: now },
      ...items.filter((item) => item.title !== 'New conversation'),
    ]);
    setDraft('');
    setMessages([]);
    setAttachments([]);
    setError(null);
    setFeedback({});
    setRunStopped(null);
    setLiveStages([]);
    setConversationLoading(false);
    // An empty conversation has nothing stored to reload, so it is marked as
    // already loaded and the URL is cleared without pushing a history entry,
    // Back should return to the previous conversation, not to a blank one.
    loadedConversationRef.current = id;
    setSearchParams({}, { replace: true });
  }

  /**
   * Records one rating against one message.
   *
   * The comment is read from this message's own entry, not from a shared box, so
   * the text posted is the text typed about this answer. Failure is reported
   * rather than swallowed: this used to `.catch(() => undefined)` and then say
   * "Feedback saved" regardless, so a rating that never reached the table looked
   * recorded, and the usefulness figure is computed from that table.
   */
  async function saveFeedback(messageId: string, usefulness: number) {
    const entry = feedback[messageId] ?? emptyFeedback;
    const patch = (changes: Partial<FeedbackEntry>) =>
      setFeedback((current) => ({ ...current, [messageId]: { ...(current[messageId] ?? emptyFeedback), ...changes } }));
    patch({ saving: true, error: null });
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, usefulness, comment: entry.comment }),
      });
      if (!response.ok) throw new Error(`The rating was not recorded (HTTP ${response.status}).`);
      patch({ saving: false, saved: true, open: false, error: null });
    } catch (error) {
      patch({ saving: false, saved: false, error: (error as Error).message || 'The rating was not recorded.' });
    }
  }

  async function uploadAttachments(files: FileList | null) {
    if (!files?.length) return;
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
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-File-Name': encodeURIComponent(file.name),
              'X-File-Type': file.type || 'application/octet-stream',
            },
            body: file,
          }
        );
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
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function removeAttachment(attachment: Attachment) {
    setAttachments((items) => items.filter((item) => item.id !== attachment.id));
    if (attachment.status === 'ready') {
      await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachment.id)}`,
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
   * The rail as it is actually drawn, collapsed once.
   */
  const railConversations = useMemo(() => dedupeByTitle(conversations, conversationId),
    [conversations, conversationId]
  );

  /**
   * Who appears in the rail, and how many entries each of them has.
   *
   * Read off the conversations already fetched rather than asked for
   * separately. A second lookup could name someone the rail is not showing, or
   * miss someone it is, and either way the filter would be describing a
   * different set from the one being filtered. Ordered by volume so the
   * heaviest user is first, which is the one a reviewer usually wants.
   */
  const railOwners = useMemo(() => {
    const counts = new Map<string, number>();
    for (const conversation of railConversations) {
      if (!conversation.user_email) continue;
      counts.set(conversation.user_email, (counts.get(conversation.user_email) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email));
  }, [railConversations]);

  /**
   * The selection, narrowed to people the rail is actually showing.
   *
   * A filter naming somebody who has since left the rail (their last
   * conversation deleted, say), would silently empty it. Worse with several
   * selected than with one: their chip goes with them, so the filter would be
   * both invisible and unclearable. Intersecting here means a name that is not
   * on screen cannot narrow what is, and does it for the toggles and the rows
   * from one place, so the pressed chips and the visible rows cannot disagree.
   */
  const activeOwnerFilters = useMemo(() => {
    const present = new Set(railOwners.map((owner) => owner.email));
    return ownerFilters.filter((email) => present.has(email));
  }, [ownerFilters, railOwners]);

  /** The rail, narrowed to the selected owners. Empty selection is everyone. */
  const visibleConversations = useMemo(() => {
    if (activeOwnerFilters.length === 0) return railConversations;
    const selected = new Set(activeOwnerFilters);
    const matching = railConversations.filter((conversation) => conversation.user_email && selected.has(conversation.user_email)
    );
    // Belt and braces. `activeOwnerFilters` only holds people counted off these
    // same conversations, so each of them has at least one and this cannot fire
    // today, but an empty rail caused by a filter is the failure worth two
    // lines of insurance, because it reads as data loss rather than as a filter.
    return matching.length > 0 ? matching : railConversations;
  }, [railConversations, activeOwnerFilters]);

  return (<div className="ask-layout">
      <aside className="conversation-rail">
        <Button className="w-full justify-start" onClick={startNewConversation} disabled={loading}>
          <Plus /> New conversation
        </Button>
        <div>
          <p className="section-label">
            Recent
            {identity.sharedConversationRail && (// A rail carrying other people's conversations says so on the
              // page. The scope is a deployment setting, so without this the
              // only way to know which one is running is to read the app's
              // startup log, and a widened scope nobody can see is the kind
              // that surprises somebody later.
              <span className="section-label-scope" title="This deployment shows everyone's conversations">
                {' '}
                · all users
              </span>
            )}
          </p>
          {railOwners.length > 1 && (// Only when the rail actually holds more than one person. Derived
            // from the rows on screen rather than from the flag or a lookup, so
            // the control cannot claim a capability the rail is not showing:
            // with sharing off there is one owner and no filter, and with it on
            // but only one person having asked anything, still no filter. The
            // list also cannot drift from the rail, because it is the rail.
            // Toggles rather than a dropdown, because the question a shared
            // rail gets asked is "these two people", and a single select can
            // only ask it one person at a time. Chips rather than a column of
            // checkboxes for the same reason the row shows initials rather than
            // an address: this is a 240px rail, and a list of nine names would
            // push the conversations it is meant to be filtering off the screen.
            <div
              className="conversation-filter"
              role="group"
              // Names the group so the toggles inside it are read as a filter
              // rather than as nine unexplained buttons.
              aria-label="Show conversations from"
            >
              <UserRound className="size-3.5" aria-hidden="true" />
              {/* "Everyone" IS the empty selection rather than a fourth state
                  layered over it, so there is one thing to reason about and no
                  way to reach a rail that is filtered to nobody. It is still a
                  button, because "unselect the ones you selected" is a worse
                  way to ask for everyone than pressing everyone. */}
              <button
                type="button"
                className="conversation-filter-chip is-all"
                aria-pressed={activeOwnerFilters.length === 0}
                onClick={() => setOwnerFilters([])}
              >
                All <span className="conversation-filter-count">{railConversations.length}</span>
              </button>
              {railOwners.map(({ email, count }) => {
                const you = email === identity.signedInAs;
                return (<button
                    key={email}
                    type="button"
                    className="conversation-filter-chip"
                    aria-pressed={activeOwnerFilters.includes(email)}
                    // The address, not the initials: two letters read aloud are
                    // not an answer to "whose". Distinct from every conversation
                    // title too, so it cannot shadow one the way the delete
                    // control once did.
                    aria-label={`${you ? 'You' : email} (${count})`}
                    title={`${email} \u00b7 ${count} conversation${count === 1 ? '' : 's'}`}
                    onClick={() => toggleOwnerFilter(email)}
                  >
                    <span className="conversation-filter-initials" aria-hidden="true">
                      {you ? 'You' : ownerInitials(email)}
                    </span>
                    <span className="conversation-filter-count" aria-hidden="true">
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {conversationLoading && conversations.length === 0 ? (<div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : conversations.length === 0 ? (<p className="conversation-empty">No saved conversations yet.</p>
          ) : (visibleConversations.map((conversation) =>
              // A row rather than a bare button, because the delete control is
              // a second button and one cannot be nested inside the other.
              // Selecting the conversation is still the whole of the first
              // button, so the click target for the common action is unchanged.
              conversation.id === pendingDelete ? (<div
                  key={conversation.id}
                  className="conversation-row confirming"
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
              ) : (<div
                  key={conversation.id}
                  className={`conversation-row ${conversation.id === conversationId ? 'active' : ''}`}
                >
                  <button
                    type="button"
                    className="conversation-item"
                    aria-pressed={conversation.id === conversationId}
                    disabled={loading || conversationLoading}
                    // Pushes a history entry rather than loading directly, so Back
                    // returns to the conversation the user came from. The effect
                    // watching the URL does the loading.
                    onClick={() => setSearchParams({ c: conversation.id })}
                  >
                    <span className="conversation-title" id={railTitleId(conversation.id)}>
                      {conversation.title}
                    </span>
                    <span className="conversation-meta">
                      <span className="conversation-age">{conversationAge(conversation.updated_at)}</span>
                      {conversation.user_email && (// Marked `aria-hidden` and paired with a text label,
                        // because two initials read aloud are not an answer to
                        // "whose is this". The label carries the address.
                        <span className="conversation-owner" title={`Asked by ${conversation.user_email}`}>
                          <span aria-hidden="true">{ownerInitials(conversation.user_email)}</span>
                          <span className="sr-only">Asked by {conversation.user_email}</span>
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="conversation-delete"
                    // Named for the action alone, and pointed at the title for
                    // the object. `aria-label={`Delete ${title}`}` reads well
                    // in isolation but makes this button's name a superstring
                    // of its neighbour's, so "the button called <title>" now
                    // describes two controls: one that opens the conversation
                    // and one that destroys it. A screen-reader user hears the
                    // title twice with no reliable way to tell which is which,
                    // and every by-name query in the e2e suite matched both.
                    // Name says what it does, description says what it acts
                    // on, and assistive tech announces them in that order.
                    aria-label="Delete conversation"
                    aria-describedby={railTitleId(conversation.id)}
                    title="Delete this conversation"
                    disabled={loading || conversationLoading}
                    onClick={() => setPendingDelete(conversation.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              )
            )
          )}
        </div>
        <Link to="/benchmarks" className="benchmark-shortcut">
          <FlaskConical className="size-4" /> Open Benchmark Lab
        </Link>
      </aside>

      <section className="conversation-main">
        {messages.length === 0 && !loading && !conversationLoading && (<div className="ask-hero">
            <Badge variant="secondary">
              <Sparkles className="size-3" /> PIA player intelligence
            </Badge>
            <h2>What would you like to understand about your players?</h2>
            <p>Ask in plain language. The agent finds governed data, checks definitions, and explains the answer.</p>
            <div className="prompt-grid">
              {[
                'Compare active players by title over the last 30 days.',
                'Show the Hoops 26 season launch engagement spike.',
                'Check null ratios in the latest player activity data.',
                'Compare recurrent consumer spending with full-game net bookings by title.',
              ].map((suggestion) => (<button key={suggestion} onClick={() => void ask(suggestion)}>
                  {suggestion}
                  <span>Ask →</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!conversationLoading &&
          messages.map((message, index) => {
            if (message.role === 'user') {
              // Signed with an avatar the way the agent's answers are, so the
              // two are told apart by a mark and not only by the colour of the
              // bubble. The initials are the whole of what the circle can hold;
              // the identity itself is on the title and read out to a screen
              // reader, see user-initials.ts.
              return (<div className="user-message" key={message.id}>
                  <div className="user-bubble">{message.content}</div>
                  <div className="user-avatar" title={asker.label}>
                    <span aria-hidden="true">{asker.initials}</span>
                    <span className="sr-only">Asked by {asker.label}</span>
                  </div>
                </div>
              );
            }
            // The memoized parse, so the object handed to the cards below keeps
            // its identity between renders and the charts are not rebuilt.
            const response = parsedResponses.get(message.id);
            if (!response) {
              // Still the agent's Markdown even when the envelope around it did
              // not parse, so it is rendered as Markdown. No sources to link
              // against: the list that would have declared them is the part of
              // the response the app could not read.
              return (<Card className="answer-card" key={message.id}>
                  <CardContent className="pt-6">
                    <AnswerProse text={message.content} sources={[]} />
                  </CardContent>
                </Card>
              );
            }
            if (response.type === 'clarification') {
              return (<ClarificationCard
                  key={message.id}
                  clarification={response.clarification}
                  loading={loading}
                  resolved={index !== lastAssistantIndex}
                  onAnswer={(reply) => void ask(reply)}
                />
              );
            }
            if (response.type === 'plan') {
              return (<PlanCard
                  key={message.id}
                  plan={response.plan}
                  loading={loading}
                  resolved={index !== lastAssistantIndex}
                  onApprove={() =>
                    void ask(response.plan.question, {
                      planId: response.plan.id,
                      label: 'Approved the proposed analysis plan.',
                    })
                  }
                  onRevise={() => {
                    setDraft(response.plan.question);
                    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
                  }}
                />
              );
            }
            return (<AnswerCard
                key={message.id}
                answer={response}
                // The turn this answered, for the timeline's envelope row. Read
                // from the transcript rather than the trace, which does not
                // carry the prompt.
                question={index > 0 && messages[index - 1].role === 'user' ? messages[index - 1].content : ''}
                // Whether a plan was approved on the way to this answer, which
                // the timeline has to disclose because that turn records no
                // trace and its time is outside `totalMs`. Detected from the
                // preceding assistant turn's shape rather than by matching the
                // approval text, which is a server-side string this file would
                // otherwise be holding a second copy of.
                afterPlanApproval={precedingPlan(messages, parsedResponses, index)}
                // This answer's own feedback, looked up by its message id, so no
                // other answer's rating, comment or saved flag can appear here.
                feedback={feedback[response.id] ?? emptyFeedback}
                onFeedbackChange={(changes) =>
                  setFeedback((current) => ({
                    ...current,
                    [response.id]: { ...(current[response.id] ?? emptyFeedback), ...changes },
                  }))
                }
                saveFeedback={(rating) => saveFeedback(response.id, rating)}
                showFeedback={index === lastAssistantIndex && !loading}
              />
            );
          })}

        {(loading || conversationLoading) && (<Card className="answer-card">
            <CardContent className="pt-6 space-y-5">
              <div className="flex items-center gap-3">
                <div className="agent-avatar">
                  {conversationLoading ? <Sparkles /> : <Loader2 className="animate-spin" />}
                </div>
                <div>
                  <p className="font-medium">
                    {conversationLoading ? 'Loading conversation' : askElapsedLabel(askStartedAt, now)}
                  </p>
                  {conversationLoading && (<p className="text-sm text-muted-foreground">
                      Restoring the saved answer and trace from Lakebase.
                    </p>
                  )}
                </div>
              </div>
              {/* Still indeterminate, and still for the original reason: the run
                  reports each step on finishing it, so the client knows what has
                  happened but never how much is left -- the agent takes as many
                  steps as the question needs. A percentage would be the same
                  invention as the four hardcoded stage names this replaced, which
                  ticked to full in 2.6 seconds and froze for the remaining 23. */}
              {!conversationLoading && <Progress value={null} aria-label="Working on your question" />}
              {/* The run, said from what has been observed of it: the request
                  going out, the endpoint accepting it, then each step with the
                  arguments it was actually given. The skeletons this replaces
                  stood in for content that was fourteen seconds away, under a
                  sentence promising each step "as it finishes" -- which is not
                  what the endpoint does. See live-progress.ts. */}
              {conversationLoading ? (<>
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-20 w-full" />
                </>
              ) : (<LiveProgress
                  stages={liveStages}
                  openedAt={streamOpenedAt}
                  lastStageAt={lastStageAt}
                  now={now}
                  question={askedQuestion}
                />
              )}
            </CardContent>
          </Card>
        )}

        {error && (<Alert>
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div ref={transcriptEndRef} aria-hidden="true" />
        <form
          className="composer"
          // The submit is what prompts a password manager to offer to save, so
          // the form is opted out as well as the field inside it. These are
          // attributes only; the Return-to-send wiring on the Textarea below is
          // untouched by them.
          {...PASSWORD_MANAGER_OPT_OUT}
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          {attachmentsUnreadable && (<p className="text-xs text-muted-foreground" role="status">
              Any documents attached to this conversation could not be read just now, so none are
              listed. Whatever was attached is still attached, and still reaches the agent.
            </p>
          )}
          {attachments.length > 0 && (<div className="attachment-list" aria-label="Attached context">
              {attachments.map((attachment) => (<div
                  className={`attachment-chip ${attachment.status}`}
                  key={attachment.id}
                  role={attachment.status === 'error' ? 'alert' : undefined}
                >
                  {attachment.status === 'parsing' ? (<Loader2 className="size-4 animate-spin" />
                  ) : attachment.status === 'error' ? (<CircleAlert className="size-4" />
                  ) : (<FileText className="size-4" />
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || conversationLoading}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip /> Attach context
            </Button>
            {attachments.length > 0 && (// Separate from New conversation on purpose: dropping the documents
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
            <span className="text-xs text-muted-foreground">
              AI can make mistakes. Sources and caveats are included.
            </span>
            <Button type="submit" disabled={!canAsk}>
              {loading ? 'Working…' : parsing ? 'Reading files…' : 'Ask PIA'} <Sparkles />
            </Button>
          </div>
        </form>
      </section>

      <aside className="trace-inspector">
        <div className="flex items-center justify-between">
          <div>
            <p className="section-label">Live agent harness</p>
            <h3 className="font-semibold">How it worked</h3>
          </div>
          <Badge variant={runStopped ? 'destructive' : loading ? 'default' : 'secondary'}>
            {loading
              ? // Now a description of the rail below rather than of the request:
                // it fills in as the run goes, so "Live" is what it is doing.
                liveStages.length > 0
                ? `Live · step ${liveStages.length}`
                : 'Live'
              : runStopped
                ? 'Stopped'
                : latestResponse?.type === 'plan'
                  ? 'Approval needed'
                  : asked
                    ? 'Question asked'
                    : answer
                      ? 'Complete'
                      : 'Ready'}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">A friendly view of the agents and tools behind each answer.</p>
        {/* A clarification has a trace too, and it is the one that explains why the
            agent is asking. There is deliberately no reference-stage fallback: this
            rail used to show a completed four-stage run, including a red "partial"
            failure, before anyone had asked anything, and then animate a highlight
            through those invented stages while the real agent worked. */}
        {railStages.length > 0 ? (<TraceDag stages={railStages} activeIndex={-1} compact />
        ) : (<Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {loading ? <Loader2 className="animate-spin" /> : <Workflow />}
              </EmptyMedia>
              <EmptyTitle>{loading ? 'Working on it' : 'No run yet'}</EmptyTitle>
              <EmptyDescription>
                {loading
                  ? // Reached only before the first step lands, or on a turn that
                    // answers with a plan and so never runs one. Both are states
                    // where there is genuinely nothing to draw yet; the elapsed
                    // count lives on the card and is not repeated here.
                    'The agent has not finished a step yet. Each one appears here as it completes.'
                  : 'Ask a question and the steps the agent took will appear here.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {answer && (<>
            <Separator />
            <div className="metric-row">
              {/* A trace the answer did not carry reports nothing, rather than 0.0s
                  and 0 calls, which read as a run that was measured and took no
                  time, instead of a run whose trace never arrived. */}
              <span>
                Total time
                <strong>{answer.trace.stages.length > 0 ? formatDuration(answer.trace.totalMs) : 'Not recorded'}</strong>
              </span>
              <span>
                Tool calls<strong>{answer.trace.stages.length > 0 ? answer.trace.toolCalls : ', '}</strong>
              </span>
              <span>
                Slowest<strong>{slowestStageName(answer.trace.stages) ?? ', '}</strong>
              </span>
            </div>
            {/* The answer id is the run id: /api/runs derives conversation runs
                from the assistant message this answer was stored as, so the Run
                Explorer can open on the run the user just watched. Which is only
                true if it was stored. When the write was lost the id names
                nothing, and offering the link sent people to a Run Explorer that
                could not find it, so say what happened instead. */}
            {answer.runStored === false ? (<Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>
                  This answer was not stored, so there is no run to explore and it will not be here
                  when you come back. The answer above is the agent’s own; only the record of it was
                  lost. Ask again once storage recovers to keep it.
                </AlertDescription>
              </Alert>
            ) : (<Button variant="outline" className="w-full" asChild>
                <Link to={`/runs?run=${encodeURIComponent(answer.id)}`}>
                  Explore full run <Workflow />
                </Link>
              </Button>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function PlanCard({
  plan,
  loading,
  resolved,
  onApprove,
  onRevise,
}: {
  plan: AnalysisPlan;
  loading: boolean;
  resolved: boolean;
  onApprove: () => void;
  onRevise: () => void;
}) {
  return (<Card className={`plan-card ${resolved ? 'resolved' : ''}`}>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="agent-avatar">
            <Workflow />
          </div>
          <div className="space-y-1">
            <Badge variant="outline">{resolved ? 'Approved plan' : 'Review before analysis'}</Badge>
            <CardTitle className="answer-takeaway">Proposed analysis plan</CardTitle>
            {/* Inline Markdown, not blocks. The plan is already structured --
                the steps below are its sections -- so what is left for Markdown
                here is a backticked column name in a sentence, and a heading
                would be a second sectioning of something already sectioned.
                No sources either: nothing has been queried at plan time, so
                there is nothing this plan may claim to have read. */}
            <CardDescription>
              <EntityText text={plan.summary} sources={[]} />
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="plan-steps">
          {plan.steps.map((step, index) => (<div className="plan-step" key={step.id}>
              <span>{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>
                  <EntityText text={step.description} sources={[]} />
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="plan-context">
          {plan.uses_conversation_context && <Badge variant="secondary">Uses conversation context</Badge>}
          {plan.uses_attachment_context && <Badge variant="secondary">Uses attached reports</Badge>}
        </div>
        <Alert>
          <ShieldCheck />
          <AlertDescription>
            {resolved
              ? 'You approved this plan. The analysis below was produced by running these steps.'
              : 'No analytical query runs until you approve this plan. You can revise the request first.'}
          </AlertDescription>
        </Alert>
        {!resolved && (<div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onRevise} disabled={loading}>
              Revise request
            </Button>
            <Button type="button" onClick={onApprove} disabled={loading}>
              <Play /> Approve and run
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

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
  return (<Card className={`plan-card ${resolved ? 'resolved' : ''}`}>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="agent-avatar">
            <HelpCircle />
          </div>
          <div className="space-y-1">
            <Badge variant="outline">{resolved ? 'Question answered' : 'Needs one detail'}</Badge>
            <CardTitle className="answer-takeaway">{clarification.question}</CardTitle>
            {clarification.reason && (<CardDescription>
                <EntityText text={clarification.reason} sources={[]} />
              </CardDescription>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {options.length > 0 && (<div className="plan-steps">
            {options.map((option, index) => (<button
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
            {resolved
              ? 'The analysis below continued from your reply.'
              : 'Nothing was queried for this turn. Answering above is cheaper than an answer about the wrong table.'}
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

/**
 * Whether the answer at `index` was reached through a plan the user approved.
 */
function precedingPlan(messages: ConversationMessage[],
  parsed: Map<string, AgentResponse>,
  index: number
): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message.role !== 'assistant') continue;
    // The nearest assistant turn before this one decides it. A plan means this
    // answer continued from an approval; anything else means it did not, and
    // scanning further back would attribute an earlier turn's plan to this one.
    return parsed.get(message.id)?.type === 'plan';
  }
  return false;
}

function AnswerCard({
  answer,
  question = '',
  afterPlanApproval = false,
  feedback,
  onFeedbackChange,
  saveFeedback,
  showFeedback,
}: {
  answer: Answer;
  /** The prompt this answer replied to, shown on the timeline's envelope row. */
  question?: string;
  /** Whether a plan was approved before this run, which the trace cannot show. */
  afterPlanApproval?: boolean;
  feedback: FeedbackEntry;
  onFeedbackChange: (changes: Partial<FeedbackEntry>) => void;
  saveFeedback: (rating: number) => Promise<void>;
  showFeedback: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const source = answer.sources[0];
  /**
   * The collapsed line, which is now the same reconciliation the panel opens
   * onto rather than a separate summary that could disagree with it.
   *
   * It read "91.7s · 18 tool calls · 18 steps", and those last two are not the
   * same quantity said twice: `toolCalls` is the agent's own counter of external
   * calls, incremented by work that never becomes a stage, while the step count
   * is rows. Printing them adjacent and equal invited exactly the conflation
   * that TraceSummary's own docstring and the `toolStages` split exist to
   * prevent. The counter has moved inside the panel where it is labelled, and
   * this line now says what was measured and what is unexplained.
   */
  const traceSummary = traceHeadline(answer.trace);
  // A degradation is not a caveat about the answer, it is a statement about
  // whether the answer is the answer. Separated so it can be shown above the
  // figures instead of below them in a list of five, see degraded-answer.ts.
  const { degraded: degradedCaveats, ordinary: ordinaryCaveats } = splitCaveats(answer.caveats);
  // Whether this card may be read as an answer to the question at all, and if
  // not, which of the two ways it failed. See degraded-answer.ts for why this
  // reads `mode` rather than looking for the representative caveat.
  const fallback = answerFallback(answer);
  // Only ever asserted when the answer itself says so. The app is deployed
  // against whatever catalog the operator configured and cannot tell otherwise,
  // see data-provenance.ts.
  const provenance = dataProvenance(answer);
  return (<Card className="answer-card">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="agent-avatar">
            <Sparkles />
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Destructive, not secondary. A grey chip reading "Representative
                  response" sat beside a complete, confident, correct-looking
                  answer and read as a label for a demo mode rather than as a
                  warning that none of the numbers under it were queried. */}
              <Badge variant={answerBadge(answer).variant}>{answerBadge(answer).label}</Badge>
              {/* Beside the "Live agent response" badge, because that badge is
                  the thing being qualified. A run whose Genie space refused it
                  is still a live run and still earns the badge, and the badge
                  alone reads as an assurance the answer has not earned. */}
              {degradedCaveats.length > 0 && <Badge variant="destructive">Degraded, fallback data</Badge>}
            </div>
            <CardTitle className="answer-takeaway">{answer.takeaway}</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* First in the card, above the narrative and the figures, because it
            governs how every number below it should be read. Below them it was
            a footnote to a conclusion the reader had already drawn. */}
        {fallback && (<Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>
              <strong>
                {fallback === 'representative'
                  ? 'These are not your figures. The agent did not answer this question, so the app filled the card below with its own stored demo response.'
                  : 'This answer was built on fallback data.'}
              </strong>{' '}
              {/* The server states the reason here on the fallback paths, see
                  representativeFallback in server/routes/insights-routes.ts.
                  Empty for a stored demo conversation, where the headline above
                  is the whole of what is known. */}
              {degradedCaveats.length > 0 && (<EntityText text={degradedCaveats.join(' ')} sources={answer.sources} />
              )}
            </AlertDescription>
          </Alert>
        )}
        {/* The tables this answer declared as sources are links to where the app
            tracks them, rather than inert text a reader has to go and look up.
            Only those, and only when the Connections page has a row for them, see
            data-entities.ts for why that pair of rules is the whole feature. */}
        <AnswerProse className="leading-7" text={answer.narrative} sources={answer.sources} />
        {/* Above the figure breakdown: the chart is the shape of the result, the figures
            beneath it are the numbers that shape is made of. Renders nothing when the
            answer carries no charts, which is every representative answer. */}
        <AnswerCharts charts={answer.charts} />
        {answer.figures.length > 0 && (<Card className="chart-card">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Result breakdown</CardTitle>
                  <CardDescription>Figures the agent returned for this question</CardDescription>
                </div>
                <Badge variant="outline">
                  <BarChart3 /> Interactive result
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="bar-chart">
              {answer.figures.map((figure) => (<div className="bar-row" key={figure.label}>
                  <span>{figure.label}</span>
                  <div>
                    <i style={{ width: `${Math.min(Math.max(figure.value, 0), 100)}%` }} />
                  </div>
                  <b>{figure.display ?? figure.value}</b>
                  {/* Guarded: the response is cast, not validated, and a figure missing its
                      comparison would otherwise throw and blank the whole transcript. */}
                  <em className={figure.comparison?.startsWith('-') ? 'negative' : ''}>{figure.comparison}</em>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        {source && (<div className="source-strip">
            <Database className="size-4" />
            <div>
              <strong>
                <SourceEntityName name={source.name} />
              </strong>
              <span>{source.freshness} · Governed Unity Catalog source</span>
            </div>
            {provenance === 'synthetic' && <Badge variant="outline">Synthetic demo data</Badge>}
          </div>
        )}
        {ordinaryCaveats.length > 0 && (<Alert>
            <CircleAlert />
            <AlertDescription>
              {/* Caveats name tables as often as the narrative does. This is
                  where "refunds are already netted into …" ends up. */}
              <strong>What to keep in mind:</strong>{' '}
              <EntityText text={ordinaryCaveats.join(' ')} sources={answer.sources} />
            </AlertDescription>
          </Alert>
        )}
        {/* Two layers over the same run, deliberately not the same view twice.
            The right-hand rail is "what happened, in order"; this is "where the
            time went, and does it reconcile". It used to hold a horizontal strip
            of step cards, which was the rail's content again in a second shape,
            so a reader who opened it learnt nothing they had not already been
            shown. */}
        <Collapsible>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <p className="font-medium text-sm">How it worked</p>
              <p className="trace-headline text-xs text-muted-foreground">{traceSummary}</p>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                View process <ChevronDown />
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="pt-3">
            <TraceTimeline trace={answer.trace} question={question} afterPlanApproval={afterPlanApproval} />
          </CollapsibleContent>
        </Collapsible>
        <div className="advanced-row">
          <div>
            <p className="font-medium text-sm">Advanced trace details</p>
            <p className="text-xs text-muted-foreground">Show sanitized raw inputs, outputs, and generated SQL</p>
          </div>
          <Switch checked={advanced} onCheckedChange={setAdvanced} aria-label="Show advanced trace details" />
        </div>
        {advanced && (<Tabs defaultValue="sql">
            <TabsList>
              <TabsTrigger value="sql">Generated SQL</TabsTrigger>
              <TabsTrigger value="raw">Raw I/O</TabsTrigger>
              <TabsTrigger value="sources">All sources</TabsTrigger>
            </TabsList>
            <TabsContent value="sql">
              <div className="code-panel">
                <div>
                  <Badge variant="outline">Read only</Badge>
                  <span>Generated by AI, inspect before reuse</span>
                </div>
                <pre>{answer.sql}</pre>
              </div>
            </TabsContent>
            <TabsContent value="raw">
              <div className="code-panel">
                <pre>
                  {JSON.stringify(answer.trace.stages.map(({ id, input, output }) => ({ id, input, output })),
                    null,
                    2
                  )}
                </pre>
              </div>
            </TabsContent>
            <TabsContent value="sources" className="space-y-2">
              {answer.sources.map((source) => (<div className="source-line" key={source.name}>
                  <Database />
                  <span>
                    <strong>{source.name}</strong>
                    <small>{source.freshness}</small>
                  </span>
                </div>
              ))}
            </TabsContent>
          </Tabs>
        )}
        {showFeedback && (<>
            <Separator />
            <div className="feedback">
              <span>Was this useful?</span>
              <Button
                variant="outline"
                size="icon"
                aria-label="Thumbs up"
                disabled={feedback.saving}
                onClick={() => void saveFeedback(5)}
              >
                <ThumbsUp />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Thumbs down"
                disabled={feedback.saving}
                onClick={() => onFeedbackChange({ open: true })}
              >
                <ThumbsDown />
              </Button>
              {feedback.open && (<div className="feedback-comment">
                  <Input
                    value={feedback.comment}
                    onChange={(event) => onFeedbackChange({ comment: event.target.value })}
                    placeholder="What could be better?"
                    aria-label="What could be better?"
                  />
                  <Button size="sm" disabled={feedback.saving} onClick={() => void saveFeedback(2)}>
                    {feedback.saving ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              )}
              {feedback.saved && (<span className="saved">
                  <Check /> Feedback saved
                </span>
              )}
              {/* A rating that did not reach the table must not look recorded, since
                  the usefulness figure is computed from that table. */}
              {feedback.error && <span className="text-destructive text-xs">{feedback.error}</span>}
            </div>
          </>
        )}
        <p className="ai-note">
          <Sparkles /> AI-generated analysis. Verify material decisions against cited sources. Data access executed by
          the Player Insights service principal.
        </p>
      </CardContent>
    </Card>
  );
}

function TraceDag({
  stages,
  activeIndex,
  compact = false,
}: {
  stages: TraceStage[];
  activeIndex: number;
  compact?: boolean;
}) {
  // The compact rail shows at most four evenly spread stages so it stays readable
  // regardless of how many stages a live trace reports.
  const visible =
    compact && stages.length > 4
      ? [0, 1, 2, 3].map((slot) => stages[Math.round((slot * (stages.length - 1)) / 3)])
      : stages;
  return (<div className={`trace-dag ${compact ? 'compact' : ''}`}>
      {visible.map((item, index) => {
        // Capped, because the indent is a reading aid and a deep run should not
        // push its last stages off the side of the rail.
        const depth = Math.min(item.depth ?? 0, 3);
        const next = visible[index + 1];
        return (<div
            key={item.id}
            className="dag-step"
            style={depth ? { paddingLeft: `${depth * 16}px` } : undefined}
          >
            <div className={`dag-node ${item.status} ${activeIndex === index ? 'active' : ''}`}>
              {item.kind === 'agent' ? <Bot /> : item.kind === 'tool' ? <Wrench /> : <FileSearch />}
              <div>
                <strong>{item.name}</strong>
                <span>
                  {(item.duration / 1000).toFixed(1)}s · {item.calls} call{item.calls === 1 ? '' : 's'}
                </span>
              </div>
              <Badge variant="outline">{item.status}</Badge>
            </div>
            {next && (// The edge names the actual relationship now that the run has one.
              // It read "delegated" between every pair, which described the fixed
              // sequence the agent used to run and describes nothing in a loop.
              <div className="dag-edge">
                <span>{(next.depth ?? 0) > depth ? 'calls' : 'then'}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (<div className="page-heading">
      <div>
        <p className="section-label">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions}
    </div>
  );
}

/**
 * Formats a stored benchmark metric, or says it is absent.
 *
 * Never substitutes a plausible number for a missing one. A dash is a fact about
 * the run; a made-up percentage is a claim about the agent's quality.
 */
function metricOrDash(value: number | null | undefined, render: (value: number) => string) {
  return typeof value === 'number' && Number.isFinite(value) ? render(value) : ', ';
}

/** How often a still-running suite is re-read. Runs take four to five minutes. */
const BENCHMARK_POLL_MS = 5_000;

/**
 * The Benchmark Lab, showing only what the store actually holds.
 *
 * Every figure comes from the store. This is the screen that most looks like
 * evidence, so a hardcoded headline here is read as a measurement.
 *
 * Reads `/api/runs` for stored benchmark runs and `/api/runs/:id/trace` for one
 * run's metrics: both existing endpoints, so the runner needs no new contract.
 */
function BenchmarkLab() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [origin, setOrigin] = useState<'lakebase' | 'empty' | 'unavailable' | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    fetch('/api/runs')
      .then((response) => {
        if (!response.ok) throw new Error('Stored benchmark runs could not be read.');
        const substituted = response.headers.get('X-PIA-Data-Origin') === 'representative';
        const reason = response.headers.get('X-PIA-Degraded-Reason');
        if (active) setOrigin(!substituted ? 'lakebase' : reason === 'storage_empty' ? 'empty' : 'unavailable');
        return response.json() as Promise<Run[]>;
      })
      .then((rows) => {
        if (active) setRuns(rows.filter((run) => run.kind === 'benchmark'));
      })
      .catch((error: Error) => {
        if (!active) return;
        // No fixture stand-in. An unreadable list is reported as unreadable; the
        // previous page could not express this state at all.
        setRuns([]);
        setOrigin('unavailable');
        setLoadError(error.message);
      });
    return () => {
      active = false;
    };
  }, [reloadToken]);

  const selected = runs?.find((run) => run.id === selectedId) ?? runs?.[0] ?? null;
  const traceState = useRunTrace(selected?.id, reloadToken);
  const metrics = traceState.status === 'ready' ? traceState.data.benchmark : null;
  // Every figure below is derived here, once, from this run. Nothing on the page
  // holds a count of its own, which is what makes the old three-way disagreement
  // between a six-row table, a "8 / 10" tile and an "8 of 10" alert impossible.
  const summary = benchmarkSummary(selected?.status, metrics);

  // A suite takes four to five minutes, so a run is not finished when the POST
  // returns. Poll the run's own trace until it reports a terminal outcome.
  useEffect(() => {
    if (!selected || !summary.inProgress) return;
    const timer = window.setInterval(() => setReloadToken((token) => token + 1), BENCHMARK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [selected, summary.inProgress]);

  async function runSuite() {
    setRunning(true);
    setRunError(null);
    try {
      const response = await fetch('/api/benchmarks/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suiteId: 'poc-benchmark' }),
      });
      if (!response.ok) throw new Error(`The suite could not be started (HTTP ${response.status}).`);
      // The response is read rather than discarded, and the run is then polled, so
      // the page reports the run that exists rather than announcing a completion
      // on a timer. The old version faked one 1.1 seconds after the POST.
      const created = (await response.json()) as { id?: unknown };
      const id = typeof created.id === 'string' ? created.id : null;
      setLastRunId(id);
      if (id) setSelectedId(id);
      setReloadToken((token) => token + 1);
    } catch (error) {
      setRunError((error as Error).message || 'The suite could not be started.');
    } finally {
      // Only the request is finished here. Whether the suite is finished is the
      // run's business, and it is read from the run.
      setRunning(false);
    }
  }

  return (<div className="page-shell">
      <PageHeading
        eyebrow="Repeatable evaluation"
        title="Benchmark Lab"
        description="Run the suite, then compare what each run actually recorded."
        actions={
          <Button onClick={() => void runSuite()} disabled={running}>
            {running ? <Loader2 className="animate-spin" /> : <Play />}
            {running ? 'Starting…' : 'Run suite'}
          </Button>
        }
      />

      {/* What scored the run, next to the scores rather than only in the stored
          metrics nobody reads. A stakeholder is entitled to know these come from
          MLflow's published prompts run against a Claude endpoint and not from
          the Databricks managed judge service, and to know which prompt version,
          because scores from two versions are not comparable. */}
      {summary.judgeDisclosure && (<Alert>
          <Info />
          <AlertDescription>
            <strong>{summary.judgeBadge ?? 'Judged by an LLM'}.</strong> {summary.judgeDisclosure}
            {summary.groundednessBasis ? ` ${summary.groundednessBasis}` : ''}
          </AlertDescription>
        </Alert>
      )}

      {runError && (<Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{runError}</AlertDescription>
        </Alert>
      )}

      {loadError && (<Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>
            {loadError} The list below is empty because it could not be read, not because no runs exist.
          </AlertDescription>
        </Alert>
      )}

      {lastRunId && !runError && (<Alert>
          {summary.inProgress ? <Loader2 className="animate-spin" /> : <Check />}
          <AlertDescription>
            {summary.inProgress
              ? 'Run started. A suite takes several minutes; this page is polling it and will report what it records.'
              : 'Run finished. Its recorded metrics are shown below.'}{' '}
            <Link to={`/runs?run=${encodeURIComponent(lastRunId)}`} className="underline font-medium">
              Open it in the Run Explorer
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}

      {summary.contradiction && (<Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>
            {summary.contradiction} Nothing has been adjusted to hide it. The figures below are shown as stored.
          </AlertDescription>
        </Alert>
      )}

      {/* Whether the suite ran, which the pass count cannot tell you. Five passed
          and one failed, and five passed and one errored, give the same fraction
          and are different facts. */}
      {summary.executionNote && (<Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>
            {summary.executionNote} The rates below are counted over the cases that were scored, not over the whole
            suite.
          </AlertDescription>
        </Alert>
      )}

      {/* One execution against one model version, not a grade. The agent varies
          between runs while the judge is pinned at temperature zero, so a reader
          who takes a single number as a settled figure will be surprised later. */}
      {summary.runCaveat && (<Alert>
          <Info />
          <AlertDescription>{summary.runCaveat}</AlertDescription>
        </Alert>
      )}

      <div className="summary-grid">
        <Card>
          <CardContent>
            <span>Cases passed</span>
            {/* A fraction, never a bare rate: a suite where three of ten cases error
                must read "5 of 10" so it can never be reported as a score out of the
                seven that happened to produce an answer. */}
            <strong>{summary.passedLabel}</strong>
            {/* The pass count alone is a verdict. "2 of 6" reads as a broken agent
                when relevance was 5 of 5 and both cases the demo turns on passed,
                true, and misleading. The breakdown gives the shape instead, and
                keeps an errored case from reading as a failed one. */}
            <small>
              {!selected
                ? 'No run selected'
                : summary.inProgress
                  ? 'Run still in progress'
                  : (summary.outcomeLabel ?? 'Out of every case attempted')}
            </small>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <span>Suite duration</span>
            <strong>{summary.durationLabel}</strong>
            <small>Whole suite, not per case</small>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <span>Groundedness</span>
            {/* Counted over the cases this judge reached a verdict on, which is not
                the case total. A rubric that did not apply to a case was never
                measured on it, and a rate that borrows the case count says
                otherwise. */}
            <strong>{summary.groundednessLabel}</strong>
            <small>{summary.groundednessCoverage ?? 'Defensible from the run’s own trace'}</small>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <span>Relevance</span>
            <strong>{summary.relevanceLabel}</strong>
            <small>{summary.relevanceCoverage ?? 'Answered the question asked'}</small>
          </CardContent>
        </Card>
        <Card className="benchmark-score">
          <CardContent>
            <span>Guidelines</span>
            {/* Present because the governance refusal is scored by this rubric
                alone: a scheme where a correct refusal fails by construction is
                worse than no scoring. Cases with no guideline do not apply here,
                and not-applicable is not a failure. */}
            <strong>{summary.guidelinesLabel}</strong>
            <small>{summary.guidelinesCoverage ?? 'Only cases that state a guideline'}</small>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recorded runs</CardTitle>
          <CardDescription>
            {runs === null
              ? 'Reading stored benchmark runs…'
              : runs.length === 0
                ? 'No benchmark run has been recorded yet.'
                : `${runs.length} stored ${runs.length === 1 ? 'run' : 'runs'}. Select one to see its metrics above.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runs === null ? (<div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : runs.length === 0 ? (/* The state a customer's first visit is in. It used to be unreachable,
               because the page never asked the store anything. */
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FlaskConical />
                </EmptyMedia>
                <EmptyTitle>Nothing has been benchmarked yet</EmptyTitle>
                <EmptyDescription>
                  {origin === 'unavailable'
                    ? 'Lakebase is unreachable, so stored runs cannot be listed. A broken connection, not an empty suite.'
                    : 'Start a run and it will appear here with the metrics it recorded.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (<div className="table-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Rating</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => {
                    const status = benchmarkStatus(run.status);
                    const rating = ratingLabel(run.rating);
                    return (<TableRow
                        key={run.id}
                        className={selected?.id === run.id ? 'bg-muted/50' : ''}
                        onClick={() => setSelectedId(run.id)}
                      >
                        <TableCell className="font-medium">{runLabel(run)}</TableCell>
                        <TableCell>{conversationAge(run.created_at)}</TableCell>
                        <TableCell>
                          <Badge variant={status === 'failed' ? 'destructive' : 'outline'}>
                            {benchmarkStatusLabel(status)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {isTerminal(status) ? metricOrDash(run.duration_ms, formatDuration) : 'In progress'}
                        </TableCell>
                        <TableCell>
                          {/* A run nobody has rated is a normal state: the runner never
                              invents a rating, a person supplies one afterwards through
                              the feedback path. Said in words, because an empty star
                              reads as a rating of zero. */}
                          {rating.rated ? (<span className="stars">
                              <Star /> {rating.value}
                            </span>
                          ) : (<span className="text-muted-foreground">Not rated yet</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-case results</CardTitle>
          <CardDescription>What each case in the suite did</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Deliberately holds no case list of its own.
        
              The suite rows in the database carry case ids and no question text, so
              until tonight the questions existed only as a hardcoded array in this
              file, which is precisely why the timings printed beside them were
              invented. That array is gone, the catalog is moving server-side, and
              this panel will render whatever a run reports rather than pairing
              server results with client-held questions. Two lists to keep in step
              is how the six-row table came to disagree with the "8 of 10" tile
              above it. */}
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileSearch />
              </EmptyMedia>
              <EmptyTitle>Not reported per case yet</EmptyTitle>
              <EmptyDescription>
                A run currently records suite-level totals only. The question, outcome and latency for each case will
                appear here as the run reports them, including cases that error rather than pass or fail.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    </div>
  );
}

// Benchmark-suite rows come back without a prompt, so fall back to a readable label.
function runLabel(run: Run) {
  return run.prompt?.trim() || 'Benchmark suite run';
}

function RunExplorer() {
  const [searchParams] = useSearchParams();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  // Seeded from ?run= so "Explore full run" lands on the run it came from. The
  // previous default named a representative row that no live list contains, so
  // arriving from an answer always selected whatever happened to be first.
  const [selectedId, setSelectedId] = useState(searchParams.get('run') ?? '');
  const [advanced, setAdvanced] = useState(false);
  const [searchText, setSearchText] = useState('');
  // Whether the rows below are stored runs or fixtures standing in for them,
  // and if they are fixtures, why. Taken from the response rather than guessed
  // from the ids, so the list says what the server actually did instead of
  // inferring it from row shapes. The reason matters as much as the fact: an
  // empty store and an unreachable one look identical here and are fixed by
  // completely different things.
  const [runsOrigin, setRunsOrigin] = useState<'lakebase' | 'empty' | 'unavailable' | null>(null);
  useEffect(() => {
    fetch('/api/runs')
      .then((response) => {
        const substituted = response.headers.get('X-PIA-Data-Origin') === 'representative';
        const reason = response.headers.get('X-PIA-Degraded-Reason');
        setRunsOrigin(!substituted ? 'lakebase' : reason === 'storage_empty' ? 'empty' : 'unavailable');
        return response.json() as Promise<Run[]>;
      })
      .then(setRuns)
      .catch(() => {
        setRunsOrigin('unavailable');
        setRuns([
          {
            id: 'run-1042',
            prompt: 'Compare active players by title over the last 30 days.',
            stakeholder: 'Example User',
            status: 'complete',
            duration_ms: 6840,
            rating: 5,
            created_at: new Date().toISOString(),
          },
        ]);
      })
      .finally(() => setLoading(false));
  }, []);
  const visibleRuns = runs.filter((run) =>
    `${runLabel(run)} ${run.stakeholder ?? ''}`.toLowerCase().includes(searchText.toLowerCase())
  );
  /**
   * Whether a `?run=` deep link asked for a run that is not here.
   */
  const requestedId = searchParams.get('run');
  const requestedMissing = !loading && Boolean(requestedId) && !runs.some((run) => run.id === requestedId);
  // Looked up across every run, not just the filtered ones: typing in the search
  // box narrows the list, and used to also silently re-point the panels at
  // whatever happened to be first in the narrowed result.
  const chosen = runs.find((run) => run.id === selectedId) ?? null;
  // A link that named a run this list does not hold selects nothing at all,
  // until the reader picks one themselves. Refusing to guess is not refusing to
  // work: every row in the list is still one click away.
  const selected = chosen ?? (requestedMissing && selectedId === requestedId ? null : (visibleRuns[0] ?? runs[0] ?? null));
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
  const toolStages = runTrace?.toolStages ?? [];
  const toolStageMs = toolStages.reduce((total, stage) => total + stage.durationMs, 0);
  const agentToolCalls = runTrace?.trace?.toolCalls ?? null;
  // Nothing was tagged, so the time spent in those calls is unmeasured, not zero.
  // Rendering 0.0s next to a non-zero call count reads as "the tools were free".
  const toolStageTime = toolStages.length > 0 ? `${(toolStageMs / 1000).toFixed(1)}s` : ', ';
  const countsDisagree = (agentToolCalls ?? 0) > 0 && toolStages.length === 0;
  const groundedness = runTrace?.benchmark?.groundedness ?? null;
  return (<div className="page-shell">
      <PageHeading
        eyebrow="Progressive trace disclosure"
        title="Run Explorer"
        description="Start with the answer, then inspect agents, timing, and sanitized raw details."
        actions={
          <div className="advanced-toggle">
            <span>Advanced</span>
            <Switch checked={advanced} onCheckedChange={setAdvanced} />
          </div>
        }
      />
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
            <CardTitle className="text-base">Recent runs</CardTitle>
            {/* Named on the list itself, not only in the app-wide banner: this
                pane is where someone counts runs and reads durations, and those
                numbers are fixtures whenever the store had none to give. */}
            {runsOrigin === 'unavailable' ? (<Badge variant="destructive" className="w-fit">
                Representative runs: Lakebase unreachable
              </Badge>
            ) : null}
            {runsOrigin === 'empty' ? (<Badge variant="secondary" className="w-fit">
                Representative runs. No runs stored yet
              </Badge>
            ) : null}
            <Input
              placeholder="Search prompts or people…"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </CardHeader>
          <CardContent className="p-2">
            {loading ? ([1, 2, 3].map((item) => <Skeleton key={item} className="h-24 mb-2" />)
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
                  <EmptyDescription>Try a different prompt or stakeholder search.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (visibleRuns.map((run) => (<button
                  key={run.id}
                  onClick={() => setSelectedId(run.id)}
                  className={`run-item ${run.id === selected?.id ? 'active' : ''}`}
                >
                  <div>
                    <Badge variant="outline">{run.status ?? 'unknown'}</Badge>
                    <span>{new Date(run.created_at).toLocaleDateString()}</span>
                  </div>
                  <strong>{runLabel(run)}</strong>
                  <small>
                    {(run.stakeholder ?? 'Unknown').split('@')[0]}
                    {run.duration_ms ? ` · ${(run.duration_ms / 1000).toFixed(1)}s` : ''}
                    {run.rating ? ` · ★ ${run.rating}` : ''}
                  </small>
                </button>
              ))
            )}
          </CardContent>
        </Card>
        <Card className="run-detail">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle>{selected ? runLabel(selected) : 'Select a run'}</CardTitle>
                <CardDescription className="run-detail-meta">
                  {selected
                    ? `${selected.id} · ${(selected.stakeholder ?? 'Unknown').split('@')[0]} · ${selected.status ?? 'complete'}`
                    : 'Pick a run from the list to inspect its trace.'}
                </CardDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isReference && <Badge variant="outline">Reference trace</Badge>}
                {/* Only benchmark runs measure groundedness. A fixed 94% used to sit here
                    on every run, including ones nobody had scored. */}
                {groundedness !== null && (<Badge variant="secondary">Groundedness {Math.round(groundedness * 100)}%</Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isReference && (<Alert className="mb-4">
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
              <TabsContent value="overview" className="space-y-5 pt-4">
                <div className="summary-grid compact">
                  <Card>
                    <CardContent>
                      <span>Wall time</span>
                      <strong>{selected?.duration_ms ? `${(selected.duration_ms / 1000).toFixed(1)}s` : ', '}</strong>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent>
                      <span>Tool-stage time</span>
                      <strong>{runTrace?.trace ? toolStageTime : ', '}</strong>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent>
                      <span>Agent tool calls</span>
                      <strong>{agentToolCalls ?? ', '}</strong>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent>
                      <span>User rating</span>
                      <strong>{selected?.rating ? `${selected.rating} / 5` : 'Not rated'}</strong>
                    </CardContent>
                  </Card>
                </div>
                {/* Without this, the two tiles above look like one number contradicting
                    itself. They are different quantities, so say which is which rather
                    than quietly picking one. */}
                {countsDisagree && (<p className="text-xs text-muted-foreground">
                    The agent recorded {agentToolCalls} external{' '}
                    {agentToolCalls === 1 ? 'call' : 'calls'} for this run but tagged none of its
                    stages as tool work, so there is no per-call timing to total. Tool-stage time
                    covers only tagged stages; the Timeline tab shows every stage either way.
                  </p>
                )}
                {traceState.status === 'loading' ? (<div className="space-y-2">
                    <Skeleton className="h-6 w-3/4" />
                    <Skeleton className="h-16" />
                  </div>
                ) : runTrace?.takeaway ? (<>
                    <h3 className="text-xl font-semibold">{runTrace.takeaway}</h3>
                    {/* The stored narrative of a past run is the same agent
                        Markdown the live card renders, and it was printing its
                        own `##` and `**` here too. */}
                    <AnswerProse text={runTrace.narrative} sources={runTrace.sources} />
                  </>
                ) : (<p className="text-muted-foreground text-sm">
                    {traceState.status === 'ready' ? runTrace?.note : 'Pick a run from the list to read its answer.'}
                  </p>
                )}
                {runTrace?.sources[0] && (<div className="source-strip">
                    <Database />
                    <div>
                      <strong>{runTrace.sources[0].name}</strong>
                      <span>{runTrace.sources[0].freshness}</span>
                    </div>
                  </div>
                )}
              </TabsContent>
              <TabsContent value="map" className="pt-5">
                {stages.length > 0 ? (<TraceDag stages={stages} activeIndex={-1} />
                ) : (<TraceUnavailable state={traceState} />
                )}
              </TabsContent>
              <TabsContent value="timeline" className="pt-5">
                {stages.length > 0 ? <Waterfall stages={stages} /> : <TraceUnavailable state={traceState} />}
              </TabsContent>
              <TabsContent value="details" className="space-y-4 pt-5">
                <Alert>
                  <ShieldCheck />
                  <AlertDescription>
                    Inputs and outputs are sanitized before display. Secrets and tokens are never shown.
                  </AlertDescription>
                </Alert>
                {/* The trace id is an identifier, not payload, so it is not behind the
                    Advanced gate: it is the only handle anyone has for finding this
                    answer's trace in MLflow. */}
                {runTrace?.mlflow && (<div className="rounded-md border p-3 text-sm">
                    <div className="text-muted-foreground text-xs font-medium">MLflow trace</div>
                    <code className="break-all">{runTrace.mlflow.traceId}</code>
                    {runTrace.mlflow.url ? (<a
                        className="text-primary mt-1 block underline underline-offset-2"
                        href={runTrace.mlflow.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in the MLflow experiment
                      </a>
                    ) : (<p className="text-muted-foreground mt-1 text-xs">
                        Save an MLflow experiment on the Connections page to link straight to this trace.
                      </p>
                    )}
                  </div>
                )}
                {advanced ? (runTrace?.trace ? (<>
                      {runTrace.sql && (<div className="code-panel">
                          <pre>{runTrace.sql}</pre>
                        </div>
                      )}
                      {runTrace.undeclaredKeys.length > 0 && (<Alert>
                          <CircleAlert />
                          <AlertDescription>
                            This run carries fields the app does not render yet: {runTrace.undeclaredKeys.join(', ')}.
                          </AlertDescription>
                        </Alert>
                      )}
                      <div className="code-panel">
                        <pre>{JSON.stringify(runTrace.trace, null, 2)}</pre>
                      </div>
                    </>
                  ) : (<TraceUnavailable state={traceState} />
                  )
                ) : (<Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ShieldCheck />
                      </EmptyMedia>
                      <EmptyTitle>Advanced details are hidden</EmptyTitle>
                      <EmptyDescription>
                        Turn on Advanced above to inspect sanitized inputs, outputs, generated SQL, retries, and errors.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
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

function Waterfall({ stages }: { stages: TraceStage[] }) {
  // Guarded, because a real trace can report a single zero-duration stage and a
  // zero total would make every bar's width NaN.
  const total = Math.max(...stages.map((stage) => stage.start + stage.duration), 1);
  return (<div className="waterfall">
      <div className="waterfall-content">
        <div className="waterfall-axis">
          {/* Ticks follow the run's own wall time. They used to read 0/2/4/6.8s, which
              was the reference run's duration printed over whatever was selected. */}
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (<span key={fraction}>{((total * fraction) / 1000).toFixed(1)}s</span>
          ))}
        </div>
        {stages.map((stage) => (<div className="waterfall-row" key={stage.id}>
            <span style={stage.depth ? { paddingLeft: `${Math.min(stage.depth, 4) * 12}px` } : undefined}>
              {stage.name}
              <small>{stage.kind}</small>
            </span>
            <div>
              <i
                className={stage.duration > 1800 ? 'slow' : ''}
                style={{
                  marginLeft: `${(stage.start / total) * 100}%`,
                  width: `${Math.max((stage.duration / total) * 100, 4)}%`,
                }}
              >
                {(stage.duration / 1000).toFixed(1)}s
              </i>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

