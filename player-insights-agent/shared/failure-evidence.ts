/**
 * What actually failed, said in the provider's own words rather than in ours.
 *
 * WHY THIS EXISTS AS A TYPE RATHER THAN A STRING. `UnavailableResult.detail` was
 * already a string, already populated at every failure site, and already on the
 * wire. It reached the browser and was dropped there, because
 * `unavailableNotice` had nowhere to put it, and nobody noticed for months: the
 * server logs held "PERMISSION DENIED on
 * <your_catalog>.<your_schema>.gold_title_daily_summary" while the
 * reader was shown "a service this needed did not respond just now". A single
 * prose field invites exactly that, because prose has no shape a renderer can
 * be required to honour. Named fields can be asserted on, and
 * `unavailable-copy.test.ts` now asserts each of them survives to the rendered
 * notice.
 *
 * THE FIVE THINGS A READER IS OWED, and this is the order they are read in:
 *   1. WHICH dependency failed, by the name it has in the workspace, because
 *      "a service" is not something anybody can go and look at.
 *   2. WHAT it said: status, provider code, provider sentence, unparaphrased.
 *      A paraphrase of an error is a second error to debug.
 *   3. WHERE in the run it stopped, when the trace got that far.
 *   4. WHO it ran as, because a permission failure is unreadable without it.
 *   5. Whether waiting helps, and only when it does.
 *
 * WHAT THIS IS NOT ALLOWED TO CARRY. Anything a reader is not cleared to see.
 * Unity Catalog names the table, the privilege and its owner in a denial, which
 * is right for the client holding the credential and wrong for this response
 * body: it reaches the person who has just been told they may not read that
 * table, and another label's restricted product is that label's business. So
 * the AUTHORIZATION path sends `AuthorizationRefused.disclosable` rather than
 * the provider's own sentence, and the operator's copy stays in the log beside
 * the correlation id. Everything else -- an endpoint that did not answer, a
 * deadline, a shape the app cannot read -- describes our own infrastructure and
 * travels verbatim. See the `providerMessage` note below before widening that.
 */

/**
 * The dependencies a run can fail on, named so a heading can be specific.
 *
 * A closed list rather than a free string, because the point of this field is
 * that a reader can act on it, and "the service" typed forty different ways at
 * forty call sites is the state this replaces. `unknown` is a real member: a
 * transport that rejects before it has resolved a host knows something failed
 * and genuinely cannot say which of these it was, and guessing would put a name
 * a reader will go and check on a component that was working.
 */
export type DependencyKind =
  | 'agent-endpoint'
  | 'sql-warehouse'
  | 'genie-space'
  | 'unity-catalog'
  | 'lakebase'
  | 'llm-gateway'
  /**
   * This app's own Node server, which is a dependency of the browser and is
   * routinely the thing that failed.
   *
   * Worth its own member because the failure it names is the one a reader is
   * most likely to meet and the one the app was worst at describing: a release
   * replaces the server, and any question in flight dies with it. The browser
   * gets no response at all, so nothing downstream can be blamed and the old
   * copy blamed "a service this needed" -- pointing a reader at the agent
   * endpoint, which was healthy.
   */
  | 'app-server'
  | 'app-store'
  | 'unknown';

/**
 * How each is described in a headline.
 *
 * Written out rather than derived from the kind, because the reader-facing name
 * and the identifier are different registers: `sql-warehouse` is what the code
 * calls it and "SQL warehouse" is what the workspace UI calls it, and a heading
 * that says the first teaches the reader a word they cannot search for.
 */
export const DEPENDENCY_LABELS: Record<DependencyKind, string> = {
  'agent-endpoint': 'Agent serving endpoint',
  'sql-warehouse': 'SQL warehouse',
  'genie-space': 'Genie space',
  'unity-catalog': 'Unity Catalog',
  lakebase: 'Lakebase',
  'llm-gateway': 'LLM gateway',
  'app-server': "This app's own server",
  'app-store': "This app's own store",
  unknown: 'A service this question needed',
};

/** Which dependency, and the name it answers to in the workspace. */
export interface FailedDependency {
  kind: DependencyKind;
  /**
   * The workspace's own name for it, or empty when the app does not know one.
   *
   * Empty rather than a placeholder. An endpoint whose name is unset is a
   * misconfigured deployment, and printing "unknown" beside a label reads as a
   * component called unknown; printing nothing reads as a component whose name
   * this build could not resolve, which is what happened.
   */
  name: string;
}

/**
 * How far a run got, when enough of the trace arrived to say.
 *
 * `title` IS THE LAST STAGE THAT FINISHED, not the one the run was inside when
 * it died. The app learns about a stage when the agent reports it complete, so
 * the stage that actually failed is by definition one nobody heard about, and
 * naming the last success as the failure would send a reader to read a query
 * that ran. {@link describeStage} words it as "after" for that reason, and the
 * two must not drift apart: a caller that populates this with a stage it was
 * genuinely inside should say so in a comment at the call site.
 */
export interface FailureStage {
  /** The last stage to complete, as the trace and the live rail both label it. */
  title: string;
  /** How many stages finished in total. Absent when nothing was narrated. */
  completed?: number;
}

export interface FailureEvidence {
  dependency?: FailedDependency;
  /** The HTTP status the provider returned, verbatim. */
  status?: number;
  /**
   * The provider's own error code: `PERMISSION_DENIED`, an SQLSTATE, a Model
   * Serving `error_code`. Kept apart from the message because it is the part
   * worth searching for and the part that does not change between releases.
   */
  providerCode?: string;
  /**
   * The provider's sentence, unedited.
   *
   * NOT A PLACE TO PUT OUR OWN WORDING. If this reads like something a person
   * on this team wrote, it is in the wrong field and belongs in the taxonomy's
   * `uiMessage`. The value of this field is that it is the string an operator
   * will find in the provider's own logs, and rewording it for tone breaks the
   * only join between what the reader saw and what the platform recorded.
   *
   * SUBJECT TO THE DISCLOSURE RULE in this file's header. A caller on the
   * authorization path passes the refusal's `disclosable` here, not Unity
   * Catalog's message.
   */
  providerMessage?: string;
  stage?: FailureStage;
  /**
   * The principal the work was attempted as.
   *
   * Here rather than on `ExecutionIdentityClaim`, which carries `mode` and
   * `verified` and belongs to the signed-in-user execution workstream. That
   * contract is theirs to widen; this field is needed on a failure and nowhere
   * else, so it lives with the rest of the failure.
   */
  principal?: string;
}

/**
 * Whether an untrusted value can be read as evidence.
 *
 * The client parses a failure body out of an SSE frame, which is untyped by the
 * time it has been through `JSON.parse`, and a server one release ahead may send
 * fields this build has no branch for. Unknown keys are ignored rather than
 * refused: a partial reading of a real failure is worth more to a reader than a
 * generic sentence, which is the trade the whole of this module exists to
 * reverse.
 */
export function isFailureEvidence(value: unknown): value is FailureEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.status !== undefined && typeof record.status !== 'number') return false;
  if (record.providerCode !== undefined && typeof record.providerCode !== 'string') return false;
  if (record.providerMessage !== undefined && typeof record.providerMessage !== 'string') return false;
  if (record.principal !== undefined && typeof record.principal !== 'string') return false;
  return true;
}

/**
 * The dependency named the way a reader can go and find it.
 *
 * Null rather than a fallback sentence, so a caller with nothing to say prints
 * nothing rather than a line that looks like a reading and is not one.
 */
export function describeDependency(dependency: FailedDependency | undefined): string | null {
  if (!dependency) return null;
  const label = DEPENDENCY_LABELS[dependency.kind] ?? DEPENDENCY_LABELS.unknown;
  const name = dependency.name.trim();
  return name ? `${label} ${name}` : label;
}

/**
 * How long a provider message may run before it is cut.
 *
 * Generous, because the useful part of a Unity Catalog or Model Serving error is
 * often at the end -- the privilege, the object, the principal -- and a limit
 * tuned to look tidy in a mock truncates precisely the words somebody needs. It
 * exists only to stop a provider that returns a stack trace pushing the retry
 * button off the screen.
 */
export const PROVIDER_MESSAGE_LIMIT = 600;

/**
 * The one line that carries the actual error, or null when there is no error to
 * carry.
 *
 * Status, code and message joined with a separator rather than written as a
 * sentence, because this is the line somebody pastes into a ticket or reads down
 * a phone, and prose around it has to be stripped by hand first. The order is
 * the order it is scanned in: the status says which class of problem, the code
 * is what gets searched, the message is what gets read.
 */
export function formatProviderError(evidence: FailureEvidence | undefined): string | null {
  if (!evidence) return null;
  const parts: string[] = [];
  if (typeof evidence.status === 'number') parts.push(`HTTP ${evidence.status}`);
  const code = evidence.providerCode?.trim();
  if (code) parts.push(code);
  const message = evidence.providerMessage?.trim();
  if (message) {
    parts.push(message.length > PROVIDER_MESSAGE_LIMIT ? `${message.slice(0, PROVIDER_MESSAGE_LIMIT)}\u2026` : message);
  }
  return parts.length > 0 ? parts.join(' \u00b7 ') : null;
}

/**
 * How far the run got, or null when nothing observed a stage.
 *
 * The count is the reader's evidence that the earlier steps really happened,
 * which is the difference between "it never started" and "it got most of the way
 * and then stopped", and those send somebody to two different places.
 */
export function describeStage(stage: FailureStage | undefined): string | null {
  if (!stage) return null;
  const title = stage.title.trim();
  if (!title) return null;
  return typeof stage.completed === 'number' && stage.completed > 0
    ? `Stopped after ${stage.completed} completed step${stage.completed === 1 ? '' : 's'}; ` +
        `the last to finish was "${title}".`
    : `Stopped after "${title}".`;
}

/**
 * A status carried by an SDK rejection, from wherever that SDK put it.
 *
 * The transports in this app do not agree on the field: the experimental SDK
 * surfaces `statusCode`, the generated client surfaces `status`, and a fetch
 * wrapper surfaces neither. Reading all of them here means a new transport
 * inherits the behaviour rather than silently reporting no status at all, which
 * is indistinguishable on screen from a provider that did not send one.
 *
 * Deliberately NOT guessing from the message. `rejectionStatus` in the ask route
 * does that, and it must, because it decides whether to convert a rejection into
 * an authorization refusal and a missed 403 would let a denied request through.
 * This function only decides what to PRINT, and printing "HTTP 403" because the
 * word "forbidden" appeared in a sentence asserts a status nobody received.
 */
export function carriedStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { statusCode?: unknown; status?: unknown };
  if (typeof record.statusCode === 'number') return record.statusCode;
  if (typeof record.status === 'number') return record.status;
  return undefined;
}

/**
 * A provider error code carried by an SDK rejection.
 *
 * Databricks returns `error_code` in a REST body and the SDKs put it on the
 * rejection under one of these names depending on which one raised it.
 */
export function carriedProviderCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { error_code?: unknown; errorCode?: unknown; code?: unknown };
  for (const candidate of [record.error_code, record.errorCode, record.code]) {
    // Numeric `code` is a Node system errno (`ECONNREFUSED` is a string, but
    // `code` is also where an HTTP/2 error number lands), and printing a bare
    // integer beside a status reads as a second status.
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Everything an arbitrary rejection can be made to say about itself.
 *
 * One helper rather than three at each call site, so a failure site that
 * forgets one of the three is a change to this function instead of a silently
 * thinner panel. The message falls back to `String(error)` because a thrown
 * non-Error still has a representation and it is better than nothing: the case
 * that produced the sentence this replaces was a rejection nobody had typed.
 */
export function providerFailure(error: unknown): {
  status?: number;
  providerCode?: string;
  providerMessage: string;
} {
  const status = carriedStatus(error);
  const providerCode = carriedProviderCode(error);
  const providerMessage = error instanceof Error ? error.message : String(error);
  return {
    ...(status === undefined ? {} : { status }),
    ...(providerCode === undefined ? {} : { providerCode }),
    providerMessage,
  };
}
