/**
 * What an unavailable surface says, decided apart from how it is drawn.
 *
 * Every page that can fail used to write its own sentence at the point it gave
 * up, so one Lakebase outage read as four unrelated problems: "Stored benchmark
 * runs could not be read", a red badge saying "Representative runs", a rail that
 * silently showed nothing, and a trace pane offering a reference run. A reader
 * seeing two of those at once cannot tell whether they have one fault or two.
 *
 * The wording lives here rather than in the components for the same reason
 * `storage-banner-copy.ts` exists: which sentence is correct is a decision worth
 * testing, and a decision buried in a render is not testable without a browser.
 *
 * WHAT CHANGED, AND WHY THE PREVIOUS VERSION WAS WORSE THAN NOTHING. This module
 * used to build one paragraph by concatenating three sentences: the taxonomy's
 * generic message, a sentence about what a blank pane does not mean, and advice
 * on whether to wait. On the Ask surface that produced four lines about the
 * app's posture and not one word about the failure -- while the response body it
 * was built from carried the endpoint's status, the provider's error code and
 * the provider's own sentence in `detail`, which this module had nowhere to put
 * and therefore dropped. A reader was told "a service this needed did not
 * respond just now" over a payload that said `403 PERMISSION_DENIED`. Copy that
 * withholds the error while reassuring the reader about our principles is worse
 * than a raw stack trace, because the stack trace can at least be searched.
 *
 * SO THE ORDER IS NOW: what failed, what it said, where it stopped, who it ran
 * as, and one sentence of consequence. Each is a separate field, because a
 * concatenated paragraph is how the error got lost the first time -- there was
 * no field whose absence a test could notice.
 *
 * AND THE ONE THING IT MUST NEVER SAY: that the numbers are elsewhere on screen.
 * A failure sentence offering "showing recent results below" is the fabrication
 * with an apology attached.
 */
import {
  describeDependency,
  describeStage,
  formatProviderError,
  type FailureEvidence,
} from '../../shared/failure-evidence';
import { failureDefinition, NEVER_REROUTE_LAYERS, type FailureCode } from '../../shared/failure-taxonomy';
import type { ExecutionIdentityClaim, UnavailableResult } from '../../shared/terminal-response';

export interface UnavailableNotice {
  /**
   * One line naming what failed, as specifically as the payload allows.
   *
   * With evidence this names the dependency and what it did, because "Agent
   * serving endpoint player-insights-agent refused this request" is something a
   * reader can act on and "This question was not answered" is something they
   * already know -- they were watching. Without evidence it falls back to the
   * server's own sentence, which is then the most specific statement available.
   */
  heading: string;
  /**
   * The actual error, verbatim: status, provider code, provider message.
   *
   * Null only when the failure genuinely had no downstream provider to quote.
   * Rendered monospace and selectable, because its whole job is to be pasted
   * into a ticket or read down a phone.
   */
  error: string | null;
  /** Where in the run it stopped, when the trace got that far. */
  stage: string | null;
  /**
   * Who the work ran as, on the failures where that is the likely cause.
   *
   * Withheld on the others on purpose. A reader debugging an endpoint that did
   * not answer does not need to be told which of their own identities was used,
   * and a line per fact regardless of relevance is how a panel becomes something
   * people skim past.
   */
  identity: string | null;
  /**
   * One sentence on what this means for what is on screen.
   *
   * One, and per surface. "There is nothing here" and "nobody could find out
   * what is here" leave identical blank panes and are acted on completely
   * differently, and the second has to say so out loud, because the first is
   * what a blank pane means by default.
   */
  consequence: string;
  /**
   * Whether waiting helps -- present ONLY when it does.
   *
   * The previous version always said something, so a permission denial carried
   * "waiting will not clear this, so try again only after the cause has been
   * addressed", which is a sentence about retrying attached to a failure that
   * cannot be retried. Silence plus no button is unambiguous, and it is shorter.
   */
  retryAdvice: string | null;
  /**
   * When this surface last had a verified answer, already worded. Null when it
   * never has, which is a different fact and is rendered as its own sentence
   * rather than as a missing date.
   */
  lastVerified: string | null;
  /** "Correlation ID: ...", or null when the caller had none to give. */
  correlation: string | null;
  /** Whether a reader should be offered a retry at all. */
  retryable: boolean;
  /**
   * Which of the two ARIA live behaviours this warrants.
   *
   * `alert` interrupts a screen reader mid-sentence, which is right for a
   * request that failed while somebody waited for it and wrong for a panel that
   * was already empty when the page loaded. Getting this backwards makes the
   * app either shout on every navigation or stay silent on the one event that
   * mattered, and both end with the setting turned off.
   */
  liveRegion: 'alert' | 'status';
}

/** The surfaces that can be unavailable, named so the heading can be specific. */
export type UnavailableSurface =
  | 'ask'
  | 'runs'
  | 'run-trace'
  | 'conversations'
  | 'benchmarks'
  | 'settings'
  | 'attachments';

/**
 * The fallback heading and the one-sentence consequence, per surface.
 *
 * `consequence` is the sentence this whole panel rests on once the error is
 * shown above it. Written per surface rather than generated, because the wrong
 * reading differs: on Run Explorer it is "my history was deleted", on the
 * Benchmark Lab it is "we scored zero".
 */
const SUBJECT: Record<UnavailableSurface, { heading: string; consequence: string }> = {
  ask: {
    heading: 'This question was not answered',
    // Two clauses and no third. This entry used to carry a sentence about the
    // app leaving questions unanswered rather than completing them with figures
    // nobody queried, which is true, is the reason the stored demo response no
    // longer appears here, and is not what somebody staring at a failed question
    // needs to read. It belongs in the commit that removed the fallback and in
    // shared/terminal-response.ts, both of which say it at length.
    consequence: 'Nothing was answered and the conversation is unchanged.',
  },
  runs: {
    heading: 'Runs could not be read',
    consequence: 'The list is blank because nobody could read it, not because there are no runs.',
  },
  'run-trace': {
    heading: 'This trace could not be read',
    consequence: 'The timeline is blank because it could not be read, not because the run did nothing.',
  },
  conversations: {
    heading: 'Conversations could not be read',
    consequence: 'The rail is blank because it could not be read, not because you have no history.',
  },
  benchmarks: {
    heading: 'Benchmark runs could not be read',
    consequence: 'No scores are shown, and the blank space is not a score of zero.',
  },
  settings: {
    heading: 'Configuration could not be read',
    consequence: 'Nothing below is a reading of what this deployment is using.',
  },
  attachments: {
    heading: 'Attached documents could not be read',
    consequence: 'No documents are listed, and that is not a statement that there are none.',
  },
};

/**
 * What the named dependency DID, phrased from the failure's layer.
 *
 * Off the layer rather than the code, so a code added to the taxonomy inherits a
 * correct verb instead of falling through to a generic one. The distinction that
 * matters to a reader is refused-versus-did-not-answer: the first sends them to
 * whoever owns their grants and the second to whoever owns the endpoint, and a
 * heading that says "failed" for both sends them to neither.
 */
function dependencyVerb(code: FailureCode): string {
  switch (failureDefinition(code).layer) {
    case 'identity':
    case 'authorization':
      return 'refused this request';
    case 'governance':
    case 'evidence':
      return 'would not release the data this needed';
    case 'dependency':
      return 'did not respond';
    case 'deadline':
      return 'ran out of time';
    case 'contract':
      return 'answered in a form this app cannot read';
    case 'persistence':
      return 'could not record this run';
    case 'transport':
      return 'lost the connection before the answer arrived';
    case 'release':
      return 'is not cleared to answer questions yet';
    case 'request':
      return 'refused the request as sent';
  }
}

/**
 * Whether naming the executing identity helps explain THIS failure.
 *
 * The taxonomy already maintains the list of layers where identity decides the
 * outcome -- it keeps them for a different reason, to forbid a retry under a
 * different principal -- and reusing it means a new authorization code starts
 * disclosing its identity without anybody remembering to add it here.
 */
function identityIsRelevant(code: FailureCode): boolean {
  return NEVER_REROUTE_LAYERS.includes(failureDefinition(code).layer);
}

/**
 * The only sentence in this module that tells a reader to do something.
 *
 * A constant so the two places that decide whether to show it cannot come to
 * word it differently, which is the drift this whole file exists to stop.
 */
const RETRY_ADVICE = 'This may clear on its own, so it is worth trying again shortly.';

/**
 * The identity line, or null when it would be noise or a guess.
 *
 * `mode` is a free string owned by the signed-in-user execution workstream, so
 * its underscores are replaced rather than mapped through a table here: a table
 * would need editing every time that workstream adds a mode, and until somebody
 * did, an unmapped mode would print as a raw identifier or as nothing.
 */
function describeIdentity(claim: ExecutionIdentityClaim | undefined, principal: string | undefined): string | null {
  const named = principal?.trim();
  const mode = claim?.mode.trim().replace(/_/g, ' ');
  // Stated either way rather than only when false. "Verified" is the claim a
  // reader is actually relying on when they conclude a denial is really about
  // their own grants, and an absent word reads as an unimportant one.
  const verified = claim ? (claim.verified ? 'identity verified' : 'identity not verified') : null;
  if (named && mode) return `Ran as ${named} (${mode}, ${verified}).`;
  if (named) return `Ran as ${named}.`;
  if (mode) return `Ran as ${mode} (${verified}).`;
  return null;
}

export interface UnavailableNoticeInput {
  surface: UnavailableSurface;
  code: FailureCode;
  /** ISO or already-formatted; rendered verbatim. Null when never verified. */
  lastVerifiedAt?: string | null;
  correlationId?: string | null;
  /**
   * Whether somebody is waiting on this right now.
   *
   * Drives the live region, and nothing else. A failed submission interrupts; a
   * pane that was unreadable when the page loaded does not.
   */
  interactive?: boolean;
  /**
   * Replaces the fallback heading when there is no evidence to build one from.
   *
   * The legitimate use is a caller that observed something the taxonomy could
   * not know, such as how far a run got before it stopped. It does not replace
   * the consequence sentence or suppress the error line.
   */
  message?: string;
  /** The failure in named fields. See shared/failure-evidence.ts. */
  evidence?: FailureEvidence;
  /** Free-form operator detail, shown as the error line when there is no evidence. */
  detail?: string;
  executionIdentity?: ExecutionIdentityClaim;
}

export function unavailableNotice(input: UnavailableNoticeInput): UnavailableNotice {
  const definition = failureDefinition(input.code);
  const subject = SUBJECT[input.surface];
  const dependency = describeDependency(input.evidence?.dependency);
  return {
    heading: dependency ? `${dependency} ${dependencyVerb(input.code)}` : (input.message ?? subject.heading),
    // The structured form when there is one, and the free-form string when there
    // is not. Falling back rather than preferring structure and showing nothing
    // otherwise: several call sites still have only a sentence, and a sentence
    // naming a payload shape or an SQLSTATE is the error, however it is typed.
    error: formatProviderError(input.evidence) ?? input.detail?.trim() ?? null,
    stage: describeStage(input.evidence?.stage),
    identity: identityIsRelevant(input.code)
      ? describeIdentity(input.executionIdentity, input.evidence?.principal)
      : null,
    consequence: subject.consequence,
    retryAdvice: definition.retryable ? RETRY_ADVICE : null,
    lastVerified: input.lastVerifiedAt
      ? `Last verified ${input.lastVerifiedAt}.`
      : input.lastVerifiedAt === null
        ? 'This has not been read successfully since the app started.'
        : null,
    correlation: input.correlationId ? `Correlation ID: ${input.correlationId}` : null,
    retryable: definition.retryable,
    liveRegion: input.interactive ? 'alert' : 'status',
  };
}

/**
 * The same notice, from a server payload rather than from separate arguments.
 *
 * The server has already chosen the code, the correlation id and the last
 * verified time; re-deriving them in the browser is how the two came to
 * disagree on the settings page.
 *
 * THIS FUNCTION IS WHERE THE ERROR USED TO DIE. It read five fields off the
 * payload and ignored `detail` and `execution_identity`, so a route that had
 * gone to the trouble of forwarding the provider's status and sentence had them
 * silently discarded one function call from the screen. Everything the payload
 * carries is now passed through, and `unavailable-copy.test.ts` asserts each
 * field arrives rather than asserting the ones somebody remembered.
 */
export function unavailableNoticeFor(
  surface: UnavailableSurface,
  result: UnavailableResult,
  options: { interactive?: boolean } = {}
): UnavailableNotice {
  const notice = unavailableNotice({
    surface,
    code: result.code,
    lastVerifiedAt: result.last_verified_at,
    correlationId: result.request_id,
    interactive: options.interactive,
    message: result.message,
    evidence: result.evidence,
    detail: result.detail,
    executionIdentity: result.execution_identity,
  });
  return {
    ...notice,
    // Read from the payload rather than from the taxonomy, so a server that has
    // downgraded a normally-retryable failure is believed -- including the
    // advice, which would otherwise tell a reader to wait for something the
    // server has just said will not clear. Recomputed rather than passed
    // through, because the taxonomy's posture may be the opposite in either
    // direction and `notice.retryAdvice` was built from the taxonomy's.
    retryable: result.retryable,
    retryAdvice: result.retryable ? RETRY_ADVICE : null,
  };
}
