/**
 * THE list of ways a request is allowed to end badly, and what each one obliges
 * every surface to do about it.
 *
 * One file, imported by the server, the client and (by name) the agent, because
 * the failure a user reads about, the failure the logs record and the failure an
 * alert fires on have to be the same failure. Before this, each surface invented
 * its own wording at the point it gave up, so the same outage read as four
 * unrelated problems depending on which page you were looking at, and none of
 * them could be counted.
 *
 * WHY A TABLE RATHER THAN A UNION OF STRINGS. A bare code tells a caller nothing
 * about what to do with it, so every call site re-decided the HTTP status, the
 * retry posture and the sentence, and they drifted. The one that mattered:
 * `/api/settings` reported "Nothing the orchestrator uses could be read" on a
 * deployment whose endpoint was answering, because "the endpoint did not answer"
 * and "the endpoint answered without a report" were both handled by whichever
 * branch happened to be last. Codes with declared properties make that a lookup
 * instead of a judgement.
 *
 * ADDING A CODE. Add it here first. A surface that needs a failure this list
 * does not have is describing a failure nobody has agreed the meaning of yet,
 * and the taxonomy is the place to agree it. Do not add a second taxonomy file.
 */

/**
 * Where in the request the failure happened, which is the axis a reader triages
 * on. It answers "whose problem is this": the caller's identity, their grants,
 * something downstream, or this release.
 */
export type FailureLayer =
  /** Who is asking, and whether we could establish it at all. */
  | 'identity'
  /** What that established identity is allowed to reach. */
  | 'authorization'
  /**
   * The request itself is inconsistent with one we already hold, or malformed.
   * Nothing downstream was reached and nothing here is broken: the caller's
   * client is the thing that has to change.
   *
   * ADDED FOR `IDEMPOTENCY_CONFLICT`, which fits none of the other nine, and
   * the near misses are each wrong in a way that would cost somebody a
   * morning. `governance` means a data rule refused the work, and filing a
   * duplicate-key refusal there mixes "a client has a retry bug" into the same
   * count as "somebody tried to read a protected column". `contract` is
   * defined as two of OUR OWN parts disagreeing, so it is read as a
   * half-deployed release and lands in FAILED, blaming us for the caller's
   * header. `persistence` would say the store could not record the run, when
   * the store recorded it perfectly and is the reason we know there is a
   * conflict at all.
   *
   * Every other layer answers "whose problem is this" with something inside
   * the system or with the reader's grants. This is the one that answers "the
   * request you sent". It now holds two: IDEMPOTENCY_CONFLICT and
   * IDEMPOTENCY_KEY_MALFORMED, which the ledger used to refuse under one name
   * and two statuses.
   */
  | 'request'
  /** Something the request depends on did not answer. */
  | 'dependency'
  /** Something answered, but not in a form policy lets us use. */
  | 'evidence'
  /** A rule this system enforces on itself refused the work. */
  | 'governance'
  /** The wire between two of our own parts disagreed about shape. */
  | 'contract'
  /** The connection to the browser broke. */
  | 'transport'
  /** Time ran out. */
  | 'deadline'
  /** The app's own store could not record the run. */
  | 'persistence'
  /** This build/model pair is not cleared to serve traffic. */
  | 'release';

/**
 * How loudly an occurrence should be reported, independent of what the user
 * sees. A user-caused denial is a `none` here and still a hard stop for them:
 * paging an operator every time somebody asks for data they cannot read is how
 * an alert channel becomes unwatched.
 */
export type AlertSeverity = 'none' | 'info' | 'warning' | 'page';

/** What the run's trace should carry, so a trace is searchable by outcome. */
export type TraceBehaviour =
  /** Record the failed span and the code, and close the run as failed. */
  | 'record_failure'
  /** As above, and mark the span so security review can find it. */
  | 'record_security_event'
  /** The run may not have a trace at all; do not fabricate a link to one. */
  | 'may_have_no_trace';

export interface FailureDefinition {
  code: FailureCode;
  layer: FailureLayer;
  /** What the app answers with. Chosen once here rather than at each throw. */
  httpStatus: number;
  /**
   * Whether repeating the identical request could plausibly succeed.
   *
   * A property of the failure, not advice to a retry loop. `false` means a
   * retry is known to be pointless, so a surface that offers Refresh on one is
   * teaching the user to waste their time.
   */
  retryable: boolean;
  /**
   * Whether an automatic retry may change route or identity to get past this.
   *
   * Always false for identity, authorization and governance failures. This is
   * the property the plan is emphatic about: retrying a denied read as a more
   * privileged principal turns a refusal into a privilege escalation, and it
   * has to be impossible to arrive at by accident, so it is stated per code
   * rather than left to whoever writes the next retry.
   */
  mayRerouteOrReidentify: boolean;
  /**
   * The sentence a user reads. Written for somebody who cannot fix the system
   * and needs to know what to do next, and deliberately not carrying the
   * internal reason: which table, which grant, which principal.
   */
  uiMessage: string;
  trace: TraceBehaviour;
  alert: AlertSeverity;
  /**
   * Whether a request that hit this code may still return an answer.
   *
   * False everywhere today, and the field exists so that stays a decision
   * rather than an omission. An `unavailable` result carries no takeaway,
   * figures, charts, sources or SQL; see shared/terminal-response.ts, which
   * enforces it.
   */
  mayGenerateAnswer: boolean;
}

export const FAILURE_CODES = [
  'IDENTITY_REQUIRED',
  'IDENTITY_MISMATCH',
  'USER_AUTH_REJECTED',
  'USER_NOT_AUTHORIZED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_KEY_MALFORMED',
  'BUDGET_APPROVAL_REQUIRED',
  'DEPENDENCY_UNAVAILABLE',
  'GENIE_UNATTRIBUTABLE',
  'ASSET_NOT_IN_MANIFEST',
  'COLUMN_POLICY_VIOLATION',
  'RESULT_COLUMN_POLICY_VIOLATION',
  'OUTPUT_SCHEMA_VIOLATION',
  'NO_VALID_EVIDENCE',
  'STREAM_INTERRUPTED',
  'RUN_DEADLINE_EXCEEDED',
  'PERSISTENCE_UNAVAILABLE',
  'RELEASE_NOT_CERTIFIED',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export const FAILURE_TAXONOMY: Record<FailureCode, FailureDefinition> = {
  IDENTITY_REQUIRED: {
    code: 'IDENTITY_REQUIRED',
    layer: 'identity',
    httpStatus: 401,
    retryable: false,
    mayRerouteOrReidentify: false,
    uiMessage: 'Sign in again to continue. This request was not run.',
    trace: 'may_have_no_trace',
    alert: 'info',
    mayGenerateAnswer: false,
  },
  IDENTITY_MISMATCH: {
    code: 'IDENTITY_MISMATCH',
    layer: 'identity',
    httpStatus: 401,
    retryable: false,
    mayRerouteOrReidentify: false,
    // Deliberately vague about which two identities disagreed. The interesting
    // case is an attack, and naming the subject we resolved tells the caller
    // what to forge next.
    uiMessage: 'Your session could not be verified, so nothing was run. Sign out and sign in again.',
    trace: 'record_security_event',
    alert: 'page',
    mayGenerateAnswer: false,
  },
  USER_AUTH_REJECTED: {
    code: 'USER_AUTH_REJECTED',
    layer: 'identity',
    httpStatus: 403,
    retryable: false,
    mayRerouteOrReidentify: false,
    uiMessage: 'The request could not be executed with your permissions.',
    trace: 'record_failure',
    alert: 'warning',
    mayGenerateAnswer: false,
  },
  USER_NOT_AUTHORIZED: {
    code: 'USER_NOT_AUTHORIZED',
    layer: 'authorization',
    httpStatus: 403,
    retryable: false,
    mayRerouteOrReidentify: false,
    uiMessage: 'You do not have access to one or more data products required by this question.',
    trace: 'record_failure',
    alert: 'none',
    mayGenerateAnswer: false,
  },
  /**
   * A request reused an idempotency key that belongs to a different question.
   *
   * WHAT IT MUST NOT DO is the whole reason it is a code rather than a branch:
   * neither run's answer may be served. Replaying the earlier one answers a
   * question the caller is no longer asking, and running the new one under the
   * old key defeats the guard they asked for by sending the key at all.
   * `mayGenerateAnswer: false` states that where a reader will find it.
   *
   * NOT FOR A KEY THAT WAS MALFORMED. That is IDEMPOTENCY_KEY_MALFORMED,
   * directly below, and the two are one edit away from being merged by anybody
   * reading them cold. They are two failures: there, nothing conflicts, because
   * there is no earlier request to conflict with, and the caller's remedy is to
   * send a well-formed header rather than a different one. A code carries
   * exactly one status, so pointing both at this entry would put a 400 on the
   * wire under a code that declares 409, which is the drift this table exists
   * to stop.
   *
   * `info` rather than `warning`. One occurrence is the guard working, and
   * paging on a correctly refused duplicate is how an alert channel stops being
   * read. It is the RATE that means something, and what it means is that some
   * client is reusing keys across questions.
   */
  IDEMPOTENCY_CONFLICT: {
    code: 'IDEMPOTENCY_CONFLICT',
    layer: 'request',
    httpStatus: 409,
    retryable: false,
    // Sending the identical request again reaches the identical conflict. What
    // gets past this is a new key, which is a different request.
    mayRerouteOrReidentify: false,
    uiMessage:
      'This matched an earlier request that asked something different, so nothing was run. Ask again to start a new one.',
    trace: 'record_failure',
    alert: 'info',
    mayGenerateAnswer: false,
  },
  /**
   * An `Idempotency-Key` header the server cannot use, refused rather than
   * ignored.
   *
   * NOT THE CONFLICT ABOVE, though the names sit next to each other and invite
   * the merge. Nothing was compared here: there is no earlier request, no
   * stored key hash, and no second question. The header never became a key at
   * all, so the guard the caller asked for was never armed, and the reason to
   * refuse is that a client which believes it is protected against duplicate
   * execution and is not can only be told so now.
   *
   * The statuses are what make merging them a defect a caller sees. 409 says
   * "this collided with something we hold, send a different key"; 400 says "we
   * could not read what you sent, send a well-formed one". A client acting on
   * the wrong one of those retries forever with a header that will never parse,
   * or abandons a key that was fine.
   *
   * Same layer as the conflict, and correctly: both answer "whose problem is
   * this" with the request, both leave nothing downstream touched, and both end
   * in REFUSED rather than FAILED. The layer is what they share; the status,
   * the remedy and the rate are what they do not.
   *
   * `info` for the same reason as the conflict. One is a client with a bug in
   * how it generates keys, which is worth counting and not worth waking anybody
   * for; a RISING rate says a client shipped that bug to everyone.
   */
  IDEMPOTENCY_KEY_MALFORMED: {
    code: 'IDEMPOTENCY_KEY_MALFORMED',
    layer: 'request',
    httpStatus: 400,
    retryable: false,
    // Resending the identical header reaches the identical rejection. What gets
    // past this is a different header, which is a different request.
    mayRerouteOrReidentify: false,
    // The sentence the ledger already refused with, moved here so the status
    // and the words come from one place. It names the format because that is
    // the only thing the caller can act on, and says what was NOT done with the
    // request, because the caller's mistaken belief that it was protected is
    // the reason this is refused rather than ignored.
    uiMessage:
      'The Idempotency-Key header must be 8 to 200 characters of letters, digits, dot, colon, ' +
      'underscore or hyphen. It was not used, so this request was not protected against being ' +
      'run twice, and it is refused rather than run without the protection you asked for.',
    trace: 'record_failure',
    alert: 'info',
    mayGenerateAnswer: false,
  },
  BUDGET_APPROVAL_REQUIRED: {
    code: 'BUDGET_APPROVAL_REQUIRED',
    layer: 'governance',
    httpStatus: 429,
    retryable: false,
    mayRerouteOrReidentify: false,
    uiMessage:
      'Measured month-to-date spend reached the monthly app budget. An administrator must approve continued usage before a new question can start.',
    trace: 'may_have_no_trace',
    alert: 'info',
    mayGenerateAnswer: false,
  },
  DEPENDENCY_UNAVAILABLE: {
    code: 'DEPENDENCY_UNAVAILABLE',
    layer: 'dependency',
    httpStatus: 503,
    retryable: true,
    mayRerouteOrReidentify: false,
    // Neither "read" nor "below", both of which this used to say. The Ask
    // surface reaches this code when the endpoint did not answer a question,
    // where nothing was being read and there is nothing below the panel to
    // point at, and a sentence naming screen furniture that is not there is a
    // small version of the fabrication this taxonomy exists to stop.
    uiMessage:
      'A service this needed did not respond just now, and nothing has been substituted for what it would have returned.',
    trace: 'record_failure',
    alert: 'warning',
    mayGenerateAnswer: false,
  },
  GENIE_UNATTRIBUTABLE: {
    code: 'GENIE_UNATTRIBUTABLE',
    layer: 'evidence',
    httpStatus: 502,
    retryable: false,
    mayRerouteOrReidentify: false,
    uiMessage: 'The data behind this question could not be attributed to a governed source, so it was not used.',
    trace: 'record_failure',
    alert: 'warning',
    mayGenerateAnswer: false,
  },
  ASSET_NOT_IN_MANIFEST: {
    code: 'ASSET_NOT_IN_MANIFEST',
    layer: 'governance',
    httpStatus: 403,
    retryable: false,
    mayRerouteOrReidentify: false,
    uiMessage: 'This question reached data this release is not declared to read, so it was refused.',
    trace: 'record_security_event',
    alert: 'page',
    mayGenerateAnswer: false,
  },
  COLUMN_POLICY_VIOLATION: {
    code: 'COLUMN_POLICY_VIOLATION',
    layer: 'governance',
    httpStatus: 403,
    retryable: false,
    mayRerouteOrReidentify: false,
    uiMessage: 'Answering this would require a protected field, so it was refused.',
    trace: 'record_security_event',
    alert: 'warning',
    mayGenerateAnswer: false,
  },
  /**
   * The same policy as the entry above, at a later and worse moment.
   *
   * The statement named no protected column, was admitted, and RAN. The result
   * set that came back names one anyway, so the rows were discarded unread. In
   * practice that is `SELECT *` over a table with an identifier in it, or Genie
   * SQL the parser could not expand.
   *
   * THE TWO ARE KEPT APART FOR THREE REASONS, and the second is the one that
   * costs somebody a morning if they are merged:
   *
   *  1. What happened differs. Above, nothing was ever materialised. Here the
   *     values existed in a result set, which is a materially different thing
   *     to have to say to a customer's security reviewer.
   *  2. The rates mean opposite things and cancel out. A rising
   *     COLUMN_POLICY_VIOLATION means questions are asking for protected
   *     fields. A rising rate of THIS means queries are starring, or that Genie
   *     is emitting SQL the parser cannot expand. Reported as one number,
   *     neither trend is visible.
   *  3. This is the only control that catches what the parse cannot, so its
   *     rate IS the coverage measure for the parse-time guard. Folded into that
   *     guard's own count, the measurement is unrecoverable.
   *
   * And not OUTPUT_SCHEMA_VIOLATION, whose name is the closest fit in this file
   * and whose meaning is the furthest away: that is a contract-layer 502 that
   * pages an on-call because the app and the model disagree about a response
   * shape. Reporting a governance refusal there pages somebody for the product
   * working correctly, and tells the reader the agent replied in a form the app
   * cannot read, which it did not.
   *
   * Specified by the evidence-gateway workstream in agent/failures.py, which
   * holds it as a requested-not-declared constant and maps the condition onto
   * COLUMN_POLICY_VIOLATION until this lands.
   */
  RESULT_COLUMN_POLICY_VIOLATION: {
    code: 'RESULT_COLUMN_POLICY_VIOLATION',
    layer: 'governance',
    httpStatus: 403,
    retryable: false,
    mayRerouteOrReidentify: false,
    uiMessage:
      'The result included a protected field, so the rows were discarded and that part of the question was not answered.',
    trace: 'record_security_event',
    alert: 'warning',
    mayGenerateAnswer: false,
  },
  OUTPUT_SCHEMA_VIOLATION: {
    code: 'OUTPUT_SCHEMA_VIOLATION',
    layer: 'contract',
    httpStatus: 502,
    retryable: false,
    mayRerouteOrReidentify: false,
    // The app and the model are released separately, in either order, so this
    // is normally skew rather than corruption. The message says what a user can
    // act on, which is nothing, and who can.
    uiMessage: 'The agent replied in a form this version of the app cannot read, so no answer is shown.',
    trace: 'record_failure',
    alert: 'page',
    mayGenerateAnswer: false,
  },
  NO_VALID_EVIDENCE: {
    code: 'NO_VALID_EVIDENCE',
    layer: 'evidence',
    httpStatus: 200,
    retryable: false,
    mayRerouteOrReidentify: false,
    // 200 because nothing failed. The agent ran, read nothing it was allowed to
    // use, and said so, which is a correct outcome rather than an error.
    uiMessage: 'No governed data could be used to answer this, so there is no answer to show.',
    trace: 'record_failure',
    alert: 'info',
    mayGenerateAnswer: false,
  },
  STREAM_INTERRUPTED: {
    code: 'STREAM_INTERRUPTED',
    layer: 'transport',
    httpStatus: 503,
    retryable: true,
    mayRerouteOrReidentify: false,
    uiMessage: 'The connection dropped before the answer finished. Nothing partial is shown.',
    trace: 'record_failure',
    alert: 'info',
    mayGenerateAnswer: false,
  },
  RUN_DEADLINE_EXCEEDED: {
    code: 'RUN_DEADLINE_EXCEEDED',
    layer: 'deadline',
    httpStatus: 504,
    retryable: true,
    mayRerouteOrReidentify: false,
    uiMessage: 'This took longer than the time allowed, so it was stopped without an answer.',
    trace: 'record_failure',
    alert: 'warning',
    mayGenerateAnswer: false,
  },
  PERSISTENCE_UNAVAILABLE: {
    code: 'PERSISTENCE_UNAVAILABLE',
    layer: 'persistence',
    httpStatus: 503,
    retryable: true,
    mayRerouteOrReidentify: false,
    uiMessage: 'This could not be recorded, so it was not started. Nothing was saved.',
    trace: 'record_failure',
    alert: 'warning',
    mayGenerateAnswer: false,
  },
  RELEASE_NOT_CERTIFIED: {
    code: 'RELEASE_NOT_CERTIFIED',
    layer: 'release',
    httpStatus: 503,
    retryable: false,
    mayRerouteOrReidentify: false,
    uiMessage: 'This deployment has not been certified to answer questions yet.',
    trace: 'may_have_no_trace',
    alert: 'page',
    mayGenerateAnswer: false,
  },
};

export function isFailureCode(value: unknown): value is FailureCode {
  // `hasOwnProperty` through `call` rather than `Object.hasOwn`, which is ES2022
  // and the server compiles to ES2020. Own-property rather than `in`, so
  // `toString` and the rest of the prototype are not codes.
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FAILURE_TAXONOMY, value);
}

/**
 * The definition, or a throw.
 *
 * Deliberately not returning a generic "something went wrong" definition for an
 * unknown code. A surface that reaches here with a code this build does not know
 * has been handed a code from a newer release, and quietly rendering it as a
 * generic failure is how the two halves of a skewed deployment stop disagreeing
 * out loud. Callers holding untrusted input should narrow with
 * {@link isFailureCode} first.
 */
export function failureDefinition(code: FailureCode): FailureDefinition {
  const definition = FAILURE_TAXONOMY[code];
  if (!definition) throw new Error(`Unknown failure code: ${String(code)}`);
  return definition;
}

/**
 * The layers where a retry under a different route or identity is forbidden.
 *
 * Exported so a retry helper can assert against the layer without enumerating
 * codes, and so a new code in one of these layers inherits the prohibition
 * rather than having to remember it.
 */
export const NEVER_REROUTE_LAYERS: readonly FailureLayer[] = ['identity', 'authorization', 'governance'];
