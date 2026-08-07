import { useCallback, useEffect, useState } from 'react';
import { executionStatus, principalLabel } from './execution-identity';

/**
 * Asks, once per session, under whose authority the answers should be taken.
 */

export type AccessMode = 'service-principal' | 'user-verified' | 'skipped';

interface AccessDecision {
  mode: AccessMode;
  decidedAt: string;
  detail: string;
}

interface ServingPrincipal {
  id: string;
  observedAt: string;
}

interface GateIdentity {
  signedInAs: string;
  /** 'databricks-apps' when somebody is really signed in; 'development-fallback' when not. */
  identitySource?: string;
  executionIdentity: string;
  executionMode: AccessMode;
  accessDecision: AccessDecision | null;
  servingPrincipal: ServingPrincipal | null;
}

interface Remedy {
  kind: 'sql' | 'cli' | 'ui';
  statement: string;
  note: string;
}

interface MissingGrant {
  object: string;
  permission: string;
  objectKind?: string;
}

interface TableVerdict {
  table: string;
  status: 'ok' | 'denied' | 'error';
  detail: string;
  missing?: MissingGrant;
  remedy?: Remedy;
  reason?: 'no-grant' | 'hidden-or-absent';
  apiMessage?: string;
}

/**
 * The ways this stops without being about the reader's own grants.
 *
 * Carried from the server rather than inferred from the wording, because
 * several of these are deployment states and the difference between "the app
 * cannot ask" and "you were refused" is the whole thing somebody at this
 * screen needs to know. Guessing it from a summary string is how they got
 * conflated before.
 */
type BlockedKind =
  | 'no-user-token'
  | 'no-sql-scope'
  | 'token-rejected'
  | 'warehouse-denied'
  | 'no-sql-entitlement'
  | 'warehouse-missing'
  | 'dependency-down'
  | 'not-configured';

interface Blocked {
  summary: string;
  layer: string;
  kind?: BlockedKind;
  missing?: MissingGrant;
  remedy?: Remedy;
  apiMessage?: string;
}

interface NotChecked {
  what: string;
  why: string;
  insteadAs?: string;
}

/** One Genie space, asked about under the reader's own token. */
interface GenieVerdict {
  space: string;
  label: string;
  status: 'ok' | 'denied' | 'error';
  detail: string;
  missing?: MissingGrant;
  remedy?: Remedy;
  apiMessage?: string;
}

interface VerificationResult {
  verified: boolean;
  verdicts?: TableVerdict[];
  ok?: number;
  denied?: number;
  errored?: number;
  blocked?: Blocked;
  impact?: string[];
  notChecked?: NotChecked[];
  /**
   * Absent means the spaces were never asked about, which is not the same as
   * their having passed. The reason is in {@link NotChecked} and an empty list
   * must never render as a set of green rows.
   */
  genie?: GenieVerdict[];
  decision?: AccessDecision;
  servingPrincipal?: ServingPrincipal | null;
}

/**
 * The heading for a run that never got as far as asking about the reader.
 *
 * Written per failure mode rather than shared, because the whole cost of
 * conflating them is paid in this one sentence: somebody told "you lack
 * permission" when a scope was missing goes and asks for grants they already
 * hold, and the person who could actually fix it never hears about it.
 */
function blockedHeading(kind: BlockedKind | undefined): string {
  switch (kind) {
    case 'no-user-token':
      return 'Nothing was checked, and this is not about your permissions.';
    case 'no-sql-scope':
      return 'Nothing was checked: the app could not ask on your behalf.';
    case 'token-rejected':
      return 'Nothing was checked: your token was refused before any permission was read.';
    case 'warehouse-denied':
      return 'The check stopped before it reached a single table.';
    // Deliberately does not mention the warehouse. The same refusal used to be
    // reported as a missing CAN_USE, which sent readers to an ACL that already
    // held them and made the app look like it was lying; the heading has to
    // move the reader off that object, not qualify it.
    case 'no-sql-entitlement':
      return 'Your account cannot run SQL in this workspace at all.';
    case 'warehouse-missing':
      return 'Nothing was checked: the warehouse this asks does not resolve.';
    case 'dependency-down':
      return 'Nothing was checked, because something this depends on did not answer.';
    default:
      return 'Nothing was verified.';
  }
}

/** The exact statement, in a shape somebody can select and paste. */
function RemedyBlock({ remedy }: { remedy: Remedy }) {
  const label =
    remedy.kind === 'sql'
      ? 'Run this in a SQL editor or notebook:'
      : remedy.kind === 'cli'
        ? 'Run this with the Databricks CLI:'
        : 'Do this in the workspace UI:';
  return (
    <div className="access-gate-remedy">
      <p className="access-gate-remedy-label">{label}</p>
      <pre>{remedy.statement}</pre>
      {remedy.note && <p className="access-gate-detail">{remedy.note}</p>}
    </div>
  );
}

/**
 * The API's own words, collapsed but present.
 *
 * Every sentence above this is a classification, and a classification that
 * cannot be checked against the thing it classified is asking to be believed.
 * Collapsed because it is the second question, never the first.
 */
function ApiMessage({ message }: { message: string }) {
  return (
    <details className="access-gate-raw">
      <summary>What Databricks actually returned</summary>
      <pre>{message}</pre>
    </details>
  );
}

function BlockedReport({ blocked }: { blocked: Blocked }) {
  return (
    <>
      <p>
        <strong>{blockedHeading(blocked.kind)}</strong> {blocked.summary}
      </p>
      {blocked.missing && (
        <p>
          Missing: <code>{blocked.missing.permission}</code> on{' '}
          <code>{blocked.missing.object}</code>
          {blocked.missing.objectKind ? ` (${blocked.missing.objectKind})` : ''}
        </p>
      )}
      <p className="access-gate-layer">Look at: {blocked.layer}</p>
      {blocked.remedy && <RemedyBlock remedy={blocked.remedy} />}
      {blocked.apiMessage && <ApiMessage message={blocked.apiMessage} />}
    </>
  );
}

/**
 * The refusals, one per object, each with the statement that clears it.
 *
 * A count is not a result. Somebody who holds eight of ten needs to know which
 * two, what privilege on what object, and what stops working as a consequence.
 * The last of these is the part nobody can work out for themselves, because
 * "Genie fails as a whole when one curated table is unreadable" is a property
 * of the system rather than of the screen.
 */
function DenialReport({ result }: { result: VerificationResult }) {
  const refused = (result.verdicts ?? []).filter((verdict) => verdict.status !== 'ok');
  return (
    <>
      <p>
        <strong>Your own access does not cover everything these answers read.</strong> You can
        still continue (the service principal does), but you would be seeing
        figures you could not have queried yourself.
      </p>
      {(result.impact ?? []).map((line) => (
        <p key={line} className="access-gate-impact">
          {line}
        </p>
      ))}
      {/*
        Conditional because a reader can now fail on the Genie spaces alone,
        with every table green. An empty list under a heading reads as "and
        here is the detail", which is worse than no list.
      */}
      {refused.length > 0 && (
        <ul>
          {refused.map((verdict) => (
            <li key={verdict.table}>
              <code>{verdict.table}</code>
              {verdict.missing
                ? `: missing ${verdict.missing.permission}${
                    verdict.missing.object === verdict.table ? '' : ` on ${verdict.missing.object}`
                  }`
                : ': not established'}
              <span className="access-gate-detail">{verdict.detail}</span>
              {verdict.remedy && <RemedyBlock remedy={verdict.remedy} />}
              {verdict.apiMessage && <ApiMessage message={verdict.apiMessage} />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The Genie spaces, when one of them is the problem.
 */
function GenieReport({ verdicts }: { verdicts: readonly GenieVerdict[] }) {
  return (
    <>
      <p>
        <strong>The Genie spaces, asked under your own token.</strong> These are what the agent
        puts governed questions to. Execution is unchanged: the agent reaches them as the service
        principal whatever this says.
      </p>
      <ul>
        {verdicts.map((verdict) => (
          <li key={verdict.space}>
            <code>{verdict.label}</code>
            {verdict.status === 'denied'
              ? `: missing ${verdict.missing?.permission ?? 'CAN_RUN'}`
              : ': not established'}
            <span className="access-gate-detail">{verdict.detail}</span>
            {verdict.remedy && <RemedyBlock remedy={verdict.remedy} />}
            {verdict.apiMessage && <ApiMessage message={verdict.apiMessage} />}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * What the check could not cover, kept beside what it could.
 */
function LimitsReport({ limits }: { limits: readonly NotChecked[] }) {
  return (
    <div className="access-gate-result access-gate-result-neutral">
      <p>
        <strong>What this check does not tell you.</strong>
      </p>
      <ul>
        {limits.map((limit) => (
          <li key={limit.what}>
            {limit.what}
            <span className="access-gate-detail">{limit.why}</span>
            {limit.insteadAs && <span className="access-gate-detail">{limit.insteadAs}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a route that failed sends instead of a result. */
interface Failure {
  error?: string;
  message?: string;
}

/**
 * The verification route not answering, said as that and nothing more.
 *
 * Classified `dependency-down` because it is the same event as a warehouse
 * that did not answer: something this check depends on was unreachable, no
 * statement ran, and nothing about the reader's permissions was established.
 * No missing grant and no remedy are offered, because neither is the problem.
 */
function unreachableVerification(status: number, body: Failure | null): VerificationResult {
  const detail = body?.message ?? body?.error;
  return {
    verified: false,
    verdicts: [],
    blocked: {
      kind: 'dependency-down',
      summary: `The access check itself did not answer (HTTP ${status}). Nothing was run as you and nothing about your permissions was established, either way. Try again shortly.`,
      layer: 'the access verification route',
      apiMessage: detail ?? `The route answered ${status} with nothing this app could read.`,
    },
  };
}

export function AccessGate({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = useState<GateIdentity | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/identity')
      .then((response) => (response.ok ? (response.json() as Promise<GateIdentity>) : Promise.reject()))
      .then(setIdentity)
      // A gate that cannot reach the server must not become a locked door in
      // front of a working app. It stands aside and says nothing it cannot back.
      .catch(() => setUnreachable(true));
  }, []);

  const declare = useCallback(async (mode: 'service-principal' | 'skipped') => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch('/api/access-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!response.ok) throw new Error('The app could not record that choice.');
      const body = (await response.json()) as { decision: AccessDecision; servingPrincipal: ServingPrincipal | null };
      setIdentity((current) =>
        current
          ? { ...current, executionMode: body.decision.mode, accessDecision: body.decision, servingPrincipal: body.servingPrincipal }
          : current
      );
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const verify = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const response = await fetch('/api/access-verification', { method: 'POST' });
      const body = (await response.json().catch(() => null)) as (VerificationResult & Failure) | null;
      // A body carrying neither a verdict nor a block is not a result about
      // anybody's grants. It is the route itself having failed, and a 5xx
      // `{error, message}` is exactly that shape. Rendered as it arrived, it
      // fell through to the denial report and told the reader their own access
      // did not cover these answers, above an empty list, when nothing had been
      // checked. That sentence sends somebody to ask for grants they hold.
      if (!body || (typeof body.verified !== 'boolean' && !body.blocked)) {
        setResult(unreachableVerification(response.status, body));
        return;
      }
      setResult(body);
      if (body.verified && body.decision) {
        setIdentity((current) =>
          current
            ? {
                ...current,
                executionMode: body.decision!.mode,
                accessDecision: body.decision!,
                servingPrincipal: body.servingPrincipal ?? current.servingPrincipal,
              }
            : current
        );
      }
      // Deliberately no fallback. Somebody who asked to be checked and was not
      // checked is left at the gate, because letting them through under the
      // service principal would answer a question they did not ask and let them
      // believe it was the one they did.
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  if (unreachable) return <>{children}</>;
  if (!identity) return null;

  // Nobody is signed in, so there is no second authority to weigh the service
  // principal against and nothing to forward a token for. The question the gate
  // asks has one truthful answer here, and a dialog with one answer is not a
  // choice. It is a thing people learn to click past before reading, which is
  // how a governance prompt stops working in the place it matters.
  if (identity.identitySource === 'development-fallback') return <>{children}</>;

  if (identity.accessDecision) {
    const status = executionStatus(identity.executionMode);
    /*
     * Which principal to name: the one the endpoint reported as itself, falling
     * back to the app's when no preflight has come back yet.
     *
     * Named as the principal this deployment is CONNECTED as, which is all the
     * client can honestly say. Whether a given question runs under it or under
     * the asker's own credentials is decided per release, server-side, and the
     * page that reports that reads it from the server rather than inferring it
     * here.
     */
    const principal = identity.servingPrincipal?.id ?? identity.executionIdentity;
    const short = principalLabel(principal);
    return (
      <>
        <p className="access-badge" role="status">
          {/* Read out as "status:" rather than as a decorative bullet, so the
              state is available to a screen reader and to anyone who does not
              separate green from amber. */}
          <span className={`access-badge-dot access-badge-dot-${status.tone}`} role="img" aria-label="status" />
          <strong>{status.label}</strong>
          {/* The principal, once and abbreviated. The full value is a `title`
              here and printed properly on the Connections page, which is the
              surface that exists to record it. A banner standing over every
              screen of a customer demo is not. */}
          {short && (
            <span className="access-badge-principal" title={principal}>
              {short}
            </span>
          )}
          {/* And that is the whole banner. What was checked, and by extension
              which identity ran it, is reported on the Connections page from
              what the SERVER said, not from a sentence compiled into this
              file, which is how this row came to be asserting the wrong
              execution model within a day of being written. */}
        </p>
        {children}
      </>
    );
  }

  const serving = result?.servingPrincipal ?? identity.servingPrincipal;
  /** A check that ran and did not pass, as distinct from one nobody has run yet. */
  const checkFailed = Boolean(result && !result.verified);
  /** The spaces worth reading about: a green row is not news on a failure screen. */
  const genieProblems = (result?.genie ?? []).filter((verdict) => verdict.status !== 'ok');

  return (
    <div className="access-gate" role="dialog" aria-modal="true" aria-labelledby="access-gate-title">
      <div className="access-gate-panel">
        <h1 id="access-gate-title">Under whose authority?</h1>
        <p>
          Signed in as <strong>{identity.signedInAs}</strong>. By default this checks your own access
          before letting you in, by running a statement on this app&rsquo;s SQL warehouse under your
          own token. What it establishes, and what it leaves open, is listed with the result.
        </p>
        {/*
          Execution and verification are different questions and this paragraph
          is the only thing keeping them apart on screen. Checking first is now
          the default, which makes it very easy for the next sentence to become
          "so the app runs as you". It does not. The orchestrator lives
          inside a Model Serving endpoint that authenticates as the serving
          principal, and no button here changes that. Saying otherwise would be
          the one dishonest thing this app could do about identity.
        */}
        <p>
          What it does not change is who executes. Every Genie call and every SQL statement still runs
          as a service principal whichever option you take below. Checking establishes that you{' '}
          <em>could</em> have read the data behind an answer, not that you did.
        </p>

        {result && !result.verified && (
          <>
            <div className="access-gate-result access-gate-result-bad" role="alert">
              {result.blocked ? <BlockedReport blocked={result.blocked} /> : <DenialReport result={result} />}
              {/*
                Shown beside a warehouse block as well as beside a table
                denial. A Genie space needs neither the warehouse nor the `sql`
                scope, so its answer is real even when the rest of the check
                never got started, and hiding it would waste the one thing that
                run did establish.
              */}
              {genieProblems.length > 0 && <GenieReport verdicts={genieProblems} />}
              {/*
                A default that dead-ends is worse than no default. Verification
                is now the first thing a user meets, so the first thing a user
                without the grant meets is a failure, and the way out has to be
                on the same screen, named, one click away, and honest about the
                fact that taking it establishes nothing.
              */}
              <p className="access-gate-fallback">
                <strong>You can still go in.</strong> Until that is resolved, the way through is the
                service principal, which is how this app has always executed and what{' '}
                <em>Continue as the service principal</em> below does. It grants you nothing and claims
                nothing about your own access; it just stops this screen being a locked door.
              </p>
            </div>
            {result.notChecked?.length ? <LimitsReport limits={result.notChecked} /> : null}
          </>
        )}

        {failure && (
          <p className="access-gate-result access-gate-result-bad" role="alert">
            {failure}
          </p>
        )}

        {/*
          Order is the argument. Checking your own access is first and primary
          because that is now the default; the service principal is second
          because it is the fallback. Once a check has actually failed the
          emphasis swaps. Re-running a check that just failed for a missing
          grant is not the next thing this reader should be pushed towards.
        */}
        <div className="access-gate-actions">
          <button
            type="button"
            className={checkFailed ? undefined : 'access-gate-primary'}
            disabled={busy}
            onClick={verify}
          >
            {busy
              ? 'Checking your access\u2026'
              : checkFailed
                ? 'Check my access again'
                : 'Verify my access first'}
            <span>
              {checkFailed
                ? 'Run the same probe again, worth doing once the grant above has been made, and ' +
                  'pointless before then.'
                : 'Runs a statement on this app’s warehouse under your own token before you go in. ' +
                  'Execution still happens as the service principal either way, and the result ' +
                  'says which checks it could not make.'}
            </span>
          </button>
          <button
            type="button"
            className={checkFailed ? 'access-gate-primary' : undefined}
            disabled={busy}
            onClick={() => declare('service-principal')}
          >
            Proceed as the service principal
            <span>
              The fallback. Questions execute as{' '}
              {principalLabel(serving?.id) || 'the agent serving principal'} without your own access
              having been established, which is how this app worked before this screen existed.
            </span>
          </button>
          <button type="button" className="access-gate-skip" disabled={busy} onClick={() => declare('skipped')}>
            Skip this
            <span>
              Goes straight in without checking anything. Identical to the fallback in what runs;
              recorded differently, so a conversation cannot look verified because nobody looked.
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
