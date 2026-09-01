/**
 * Which identity this deployment's questions run under, in one sentence.
 *
 * Separate from `execution-identity.ts`, which is about the ACCESS GATE: what a
 * reader was told when they arrived, and which of the gate's modes they left it
 * in. This is about the boundary itself, and the two disagree by design. A
 * reader can skip the gate and still have every query executed under their own
 * credentials, because the gate is a courtesy and the boundary is enforced.
 * Folding them into one mode was how a page came to say that access had been
 * verified about a run that had not checked anybody's.
 */

/** The server's claim about the next question, as `/api/identity` reports it. */
export interface AnalyticalExecution {
  mode: string;
  verified: boolean;
}

export interface ExecutionSummary {
  /** The line itself. Present in every case, so there is no silent state. */
  label: string;
  /**
   * The qualification, when there is one worth making.
   *
   * Null rather than a reassuring sentence when the mode is the ordinary one.
   * A note on every state is a note nobody reads, and this one has to be read
   * on the two states where it says something has changed.
   */
  note: string | null;
  tone: 'ok' | 'attention';
}

const SIGNED_IN_USER = 'signed_in_user';
const APP_SERVICE_PRINCIPAL = 'app_service_principal';

/**
 * How to describe an execution mode to whoever administers this deployment.
 *
 * Written for someone answering "could this answer have been computed with
 * grants the reader does not have", which is the question an auditor asks and
 * the one the old wording could not be used to answer either way.
 */
export function executionSummary(execution: AnalyticalExecution | null | undefined): ExecutionSummary {
  if (!execution) {
    // An older server, or a payload that did not carry the field. Claiming
    // either mode would be inventing one; the honest line is that this build
    // cannot tell, and it reads as attention because an unknown boundary is
    // exactly the thing somebody should go and establish.
    return {
      label: 'Execution identity not reported',
      note: 'This server did not say which identity runs its questions. Check its version.',
      tone: 'attention',
    };
  }

  if (execution.mode === SIGNED_IN_USER) {
    return execution.verified
      ? {
          label: 'Questions run as the signed-in user',
          note: null,
          tone: 'ok',
        }
      : {
          /*
           * The same sentence, because the same thing happens. Only the note
           * differs, and it is careful about what it does not say: an opaque
           * forwarded token states no subject for this app to check, so the
           * check is deferred to the endpoint rather than skipped. Wording it
           * as a weaker boundary would be false and would send an
           * administrator looking for a misconfiguration there isn't.
           */
          label: 'Questions run as the signed-in user',
          note: 'The forwarded token names no subject this app can check, so the endpoint confirms it instead.',
          tone: 'ok',
        };
  }

  if (execution.mode === APP_SERVICE_PRINCIPAL) {
    return {
      label: 'Questions run as the application',
      // The deployed app cannot reach this mode: it is what a laptop with no
      // Apps proxy in front of it reports. Saying so is the point, because the
      // one reading it on a deployed URL has found a real problem.
      note: 'No signed-in user is being forwarded. Expected only when running locally.',
      tone: 'attention',
    };
  }

  return {
    label: `Questions run as ${execution.mode}`,
    note: 'This build does not recognise that execution mode.',
    tone: 'attention',
  };
}

/**
 * The line in an answer's footer that says whose grants the data was read under.
 *
 * In this file rather than beside the card because it reads the same two fields
 * as `executionSummary` and has to read them the same way. The footer used to
 * hold a constant asserting that a service principal executed the access, which
 * was written before on-behalf-of execution shipped and then survived it: a
 * sentence compiled into the client cannot be right about an arrangement a
 * release can change, and this one told every reader the opposite of what had
 * happened. Deriving it from the claim the server attached to the run is the
 * only form that cannot go stale that way.
 *
 * `verified` DELIBERATELY DOES NOT CHANGE THE SENTENCE, for the reason
 * `executionSummary` gives at more length: it records whether this app could
 * read a subject out of the forwarded token, not which credential the endpoint
 * was called with. An opaque token states no subject to check and is confirmed
 * by the endpoint instead, so hedging the line on it would understate a boundary
 * that was enforced.
 *
 * The absent case is the one to be careful about, and it returns NOTHING. It is
 * a stored answer, or one from a server that did not state this. Naming either
 * identity there would be a claim about a run this build knows nothing about,
 * and naming the reader's would be the flattering half of that -- the runs with
 * no recorded identity are exactly the runs that may not have been theirs.
 *
 * It used to print "The identity this data was read as is unconfirmed." That
 * sentence was accurate and still had to go. It was read on surfaces where the
 * app knows perfectly well who asked, where it invited the reader to suspect
 * their question had been answered as somebody else; and stating a doubt is
 * itself a claim, made on every run whether or not anything was wrong with it.
 * Silence carries the same information without the accusation: the line is
 * there when the run recorded who it read as, and absent when it did not.
 * Softening the wording would have kept the defect, so there is no hedged form
 * of it anywhere -- callers render the line or render nothing.
 */
export function dataAccessDisclosure(execution: AnalyticalExecution | null | undefined): string | null {
  if (!execution) return null;
  if (execution.mode === SIGNED_IN_USER) return 'Data read under your own Unity Catalog grants.';
  if (execution.mode === APP_SERVICE_PRINCIPAL) return 'Data access scope: application Unity Catalog grants.';
  // A mode this build has no sentence for. Printing the raw word to a reader of
  // an answer would be asking them to interpret an internal identifier, and
  // guessing which of the two it resembles is how a footer comes to reassure.
  return null;
}
