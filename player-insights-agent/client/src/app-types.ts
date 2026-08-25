/**
 * The shapes the pages agree on: what the agent answers with, what the store
 * holds, and who the app believes is signed in.
 *
 * Lifted out of App.tsx when the router file was split into one module per page.
 * Several pages read the same response and the same rows, and the file that
 * defines the router is no longer the file that renders them, so a shared module
 * is the only way to keep one definition of each: a page importing from App.tsx
 * would be a cycle, App.tsx imports the pages.
 */
import type { Chart } from './AnswerCharts';
import type { ExperimentalFeatures } from './experimental-features';
import type { Derivation, NormalizedAnswer, StageStatus, TraceStage, TraceSummary } from './answer-shape';
import type { SessionReport } from '../../shared/session-contract';
import type { RunRuntimeUsed } from '../../shared/run-runtime-used';

/**
 * What the components are allowed to render: every field present, because it came
 * through `normalizeAnswer`. The loose shape the wire actually carries is
 * `WireAnswer` in answer-shape.ts, and nothing in this file should hold one.
 */
export type Answer = Omit<NormalizedAnswer, 'charts'> & { charts?: Chart[] };
export interface AnalysisPlan {
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
export interface PlanResponse {
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
export interface Clarification {
  id: string;
  question: string;
  reason?: string;
  options: string[];
  trace: TraceSummary;
}
export interface ClarificationResponse {
  type: 'clarification';
  mode: 'live';
  clarification: Clarification;
}
export type AgentResponse = Answer | PlanResponse | ClarificationResponse;
export interface Identity {
  signedInAs: string;
  /**
   * Where the signed-in address came from: the Apps proxy, or the development
   * fallback the server uses when a request carried no `x-forwarded-email`.
   *
   * Carried so the header can say whether an OAuth sign-in reached the app at
   * all, which is a different question from what that sign-in is permitted to do.
   * Optional for the same reason the fields below are: a client can outlive the
   * server that answered it, and the safe reading of a missing field is that
   * nothing was established.
   */
  identitySource?: 'databricks-apps' | 'development-fallback';
  executionIdentity: string;
  executionMode: string;
  /**
   * Whether the rail is carrying everyone's conversations. Optional because a
   * client can outlive the server that answered it, and the safe reading of a
   * missing field is the narrow one.
   */
  sharedConversationRail?: boolean;
  /**
   * Which navigation the reader gets, and whether the gear is drawn.
   *
   * Optional for the reason above, and the narrow reading is the same shape:
   * absent means the role could not be established, `role.ts` resolves that to
   * `failed`, and `failed` draws the consumer set. It is NOT a permission --
   * every admin route is refused on the server whatever this says.
   */
  role?: 'super_admin' | 'admin' | 'consumer';
  /**
   * Whether the stored half of the admin list could be read. Carried so the
   * settings editor can say the list is unreadable rather than draw zero rows;
   * it does not change the role beside it.
   */
  addedAdminsReadable?: boolean;
  /**
   * What the sign-in this browser presented was shown to carry.
   *
   * Optional for the same reason as the fields above: a client can outlive the
   * server that answered it, and the safe reading of a missing field is that
   * nothing was established, which is what the OAuth badge does with it.
   */
  session?: SessionReport;
}
// Rows can come from benchmark runs, where several columns are null.
export interface Run {
  id: string;
  /** 'conversation' for an answered Ask PIA turn, 'benchmark' for a suite run. */
  kind?: string;
  conversation_id?: string | null;
  prompt: string | null;
  stakeholder: string | null;
  status: string | null;
  /**
   * The run stopped before it had finished: a suite that never reached the rest
   * of its cases, or a turn that hit one of the agent's own bounds.
   *
   * Its own field rather than a fourth `status`, because it is orthogonal to
   * one: a truncated run can have completed every step it did take. Optional
   * because a client can outlive the server answering it, and absent has to
   * read as "not reported" rather than as "not truncated".
   */
  truncated?: boolean | null;
  /**
   * The Genie spaces this run put its question to, as the run recorded them.
   *
   * Show `title`, not `id`: the id names infrastructure and tells a reader
   * nothing about which space answered them. Fall back to something other than a
   * blank when a deployment baked no title.
   *
   * Null or absent means the run did not report this -- an answer stored before
   * the agent recorded it, or a benchmark run, which has no single trace to read
   * it off. An empty array is the different and stronger claim that the run
   * reached no Genie space at all, so the two must not be treated alike.
   */
  genie_spaces?: { id: string; title: string }[] | null;
  duration_ms: number | null;
  /** The agent's own external-call counter, when this run records one. */
  tool_calls?: number | null;
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
export interface RunTrace {
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
  /** Canonical Plotly specs returned by the answer, when this run produced charts. */
  charts?: Chart[];
  sources: { name: string; freshness: string }[];
  /**
   * What the answer said to keep in mind about its own figures. Empty for a run
   * that produced no answer, and empty for a clarification, which produced a
   * question instead of a number for one to qualify.
   */
  caveats: string[];
  /**
   * What the run measured, over what window, with what filter. Absent rather
   * than empty for a run answered before the agent derived it, so the pane can
   * tell "nothing to show" from "shown as nothing".
   */
  derivation?: Derivation[];
  /** `trace.toolCalls` is the agent's own counter of external calls it made. */
  trace: {
    id: string;
    totalMs: number;
    toolCalls: number;
    stages: TraceStage[];
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
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
    guidelines: number | null;
    extraJudgeRates?: Record<string, { rate: number | null }>;
    durationMs: number | null;
  } | null;
  note: string;
  undeclaredKeys: string[];
  /**
   * The runtime this Ask sent. Null when the run stored none — never today's
   * Settings and never the bundle defaults.
   */
  runtimeUsed?: RunRuntimeUsed | null;
}
export interface Conversation {
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
  /**
   * What this conversation's latest answered turn ended on, derived by the rail
   * query itself rather than read off `/api/runs`.
   *
   * All three are optional and all three are absent together: a conversation
   * nobody has asked anything has no answered turn to describe, and a server
   * from before these columns existed reports none of them.
   *
   * They exist because the rail lists EVERYONE's conversations while
   * `/api/runs` is scoped to the reader, so the badge and the wall time
   * appeared on the reader's own rows and nowhere else. The rating is
   * deliberately not here: it is one reader's opinion and stays on the scoped
   * route that knows whose it is.
   */
  status?: string | null;
  truncated?: boolean | null;
  duration_ms?: number | null;
}
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * `unknown` rather than `AgentResponse`, because that is what it is: whatever
   * Lakebase stored or the endpoint returned. Declaring it as the strict shape is
   * what let unchecked payloads reach the renderer. Read it via `responseFromMessage`.
   */
  response_json?: unknown;
  /**
   * Which credential this turn's questions were executed with, as the row
   * recorded it at the time.
   *
   * Beside `response_json` rather than inside it because that is where the write
   * path puts it: the answer is the agent's, and who it ran as is the app's
   * record about the agent, so folding it in would make every stored answer
   * carry a field the answer contract does not declare.
   *
   * `unknown`, not `string`, for the same reason `response_json` is: these
   * arrive from a database column through JSON, nothing on the way validates
   * them, and the type that says so is the one that forces the read to go
   * through `storedExecutionIdentity`. Null is the ordinary value on any turn
   * recorded before these columns existed, and it has to stay distinguishable
   * from a recorded identity all the way to the footer.
   */
  execution_mode?: unknown;
  /** Whether the forwarded token was proven to be the reader's. See `execution_mode`. */
  execution_identity_verified?: unknown;
  /**
   * The caller's own rating of this answer, 1 to 5, as the store holds it.
   *
   * Beside `response_json` for the same reason the identity columns are: the
   * rating is the reader's record about the answer, not part of the answer, and
   * it is written to a table of its own after the turn is stored. It was not read
   * back at all, which is why a rating a reader had been told was saved was gone
   * when they reopened the conversation. `unknown` like its neighbours: it is
   * whatever the row held.
   */
  usefulness?: unknown;
  /** The comment given with that rating, so the box reopens holding what was said. */
  feedback_comment?: unknown;
}
export interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: 'parsing' | 'ready' | 'error';
  error?: string;
  /** Set while parsing so the chip can show elapsed time for slow PDF extraction. */
  started_at?: number;
}

/** One answer's feedback state. Held per message id, never shared between answers. */
export interface FeedbackEntry {
  open: boolean;
  comment: string;
  saved: boolean;
  saving: boolean;
  error: string | null;
  /**
   * The rating this answer carries, 1 to 5, or null for unrated.
   *
   * Held so the thumb a reader pressed is still pressed when they come back. The
   * state used to record only that something had been saved this session, so a
   * reopened conversation could not have shown the rating even once the route
   * started returning it.
   */
  usefulness: number | null;
}

/**
 * The experiment flags, and the one way to change them.
 *
 * Passed down to the nav and across to the settings page rather than read at
 * each of them, so there is a single answer to "is the Benchmark Lab on" for as
 * long as the app is open. Two readers of the same key are two chances to
 * disagree about it, and the disagreement shows up as a nav bar that offers a
 * page the sheet beside it hides.
 */
export interface ExperimentalFeaturesHandle {
  features: ExperimentalFeatures;
  setFeature: (name: keyof ExperimentalFeatures, enabled: boolean) => void;
}
