/* eslint-disable react-refresh/only-export-components -- gate parsing and its modal share one authorization contract */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshButton } from './RefreshControl';
import { principalLabel } from './execution-identity';
import { ACCESS_GATE_ENABLED } from '../../shared/access-gate';
import { UserIdentityChip } from './UserIdentityChip';
import { tableCountLine } from './access-gate-state';
import { identityRequest } from './app-state';
import { Dialog } from './Dialog';

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

export interface GateIdentity {
  signedInAs: string;
  /** 'databricks-apps' when somebody is really signed in; 'development-fallback' when not. */
  identitySource?: string;
  executionMode: AccessMode;
  accessDecision: AccessDecision | null;
  servingPrincipal: ServingPrincipal | null;
}

export function gateIdentityFromResponse(value: unknown): GateIdentity {
  if (!value || typeof value !== 'object') throw new Error('Identity unavailable');
  const identity = value as Partial<GateIdentity>;
  if (
    typeof identity.signedInAs !== 'string' ||
    typeof identity.executionMode !== 'string'
  ) {
    throw new Error('Identity unavailable');
  }
  return {
    ...identity,
    accessDecision: identity.accessDecision ?? null,
    servingPrincipal: identity.servingPrincipal ?? null,
  } as GateIdentity;
}

export function requiresAccessDecision(identity: GateIdentity | null, enabled = ACCESS_GATE_ENABLED): boolean {
  return Boolean(enabled && identity && identity.identitySource !== 'development-fallback' && !identity.accessDecision);
}

interface Remedy {
  kind: 'sql' | 'cli' | 'ui';
  statement: string;
  /** One line needed to run the statement correctly, or `''`. Mostly `''`. */
  guidance: string;
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

/**
 * The exact statement, in a shape somebody can select and paste.
 *
 * The statement and where to run it, and nothing arguing for either. The "why
 * this is the fix" paragraph that used to sit under it is gone from every surface
 * rather than folded away on some of them.
 *
 * WHAT COMES BACK IS ONE LINE, AND ONLY WHERE THE STATEMENT NEEDS IT. Cutting the
 * paragraph left this field generated and rendered nowhere, so a reader was given
 * an instruction with no reasoning even in the two cases where the instruction on
 * its own is misleading: a SCIM patch whose id looks like it should be an email,
 * and a warehouse lookup whose two outcomes mean opposite things. `guidance` is
 * `''` on everything else, which is most of them.
 */
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
      {remedy.guidance ? <p className="access-gate-remedy-guidance">{remedy.guidance}</p> : null}
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
      {/* The classification on its own line, in red, because it is the one
          sentence on this screen that decides who the reader has to go and talk
          to. The server's own account of the refusal follows it rather than
          sharing the line with it. */}
      <p className="access-gate-verdict">{blockedHeading(blocked.kind)}</p>
      <p>{blocked.summary}</p>
      {blocked.missing && (
        <p>
          Missing: <code>{blocked.missing.permission}</code> on <code>{blocked.missing.object}</code>
          {blocked.missing.objectKind ? ` (${blocked.missing.objectKind})` : ''}
        </p>
      )}
      <p className="access-gate-layer">Look at: {blocked.layer}</p>
      {blocked.remedy && <RemedyBlock remedy={blocked.remedy} />}
      {blocked.apiMessage && <ApiMessage message={blocked.apiMessage} />}
    </>
  );
}

/** The tail of a three-part name, which is the part that distinguishes it. */
function shortName(table: string): string {
  const parts = table.split('.');
  return parts[parts.length - 1] || table;
}

/**
 * The result as a count, which is what somebody checking their permissions came
 * for.
 *
 * THREE STATES, NOT TWO, and the separator carries them rather than a paragraph
 * each: readable, refused, and not checked. A zero never renders, per the count
 * line everywhere else in the app. "Not checked" is the one word that has to
 * survive every rewrite of this file -- it means the check did not run, never
 * that it ran and failed (DECISIONS D8) -- so it is never folded in with the
 * refusals to make the line shorter.
 */
/**
 * The refusals, one per object, each with the statement that clears it.
 *
 * LEADS WITH THE COUNT. This opened on a paragraph saying the reader's own
 * access did not cover everything these answers read, and a second one saying
 * they could continue anyway, above a count sentence, above the list: four
 * paragraphs before the first fact somebody at a permissions screen is looking
 * for. The count line is that fact, the consequence is the one thing a count
 * cannot carry, and the way out is one line further down.
 *
 * A count is still not the whole result. Somebody who holds eleven of twelve
 * needs to know which one, what privilege on what object, and the statement
 * that clears it, so the refusals keep their rows. What could not be CHECKED
 * gets named and nothing more: there is no grant to offer for it, because
 * nothing was established either way.
 */
export function DenialReport({ result }: { result: VerificationResult }) {
  const verdicts = result.verdicts ?? [];
  const refused = verdicts.filter((verdict) => verdict.status === 'denied');
  const unchecked = verdicts.filter((verdict) => verdict.status === 'error');
  const countLine = tableCountLine(result);
  return (
    <>
      {countLine && (
        <p className="access-gate-impact">
          <strong>{countLine}</strong>
        </p>
      )}
      {(result.impact ?? []).map((line) => (
        <p key={line}>{line}</p>
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
              {verdict.remedy && <RemedyBlock remedy={verdict.remedy} />}
              {verdict.apiMessage && <ApiMessage message={verdict.apiMessage} />}
            </li>
          ))}
        </ul>
      )}
      {unchecked.length > 0 && (
        <>
          <p className="access-gate-unchecked">
            Not checked, so unknown rather than refused:{' '}
            {unchecked.map((verdict, at) => (
              <span key={verdict.table}>
                {at > 0 ? ', ' : ''}
                <code title={verdict.table}>{shortName(verdict.table)}</code>
              </span>
            ))}
          </p>
          {/* One disclosure for the set rather than one per row. These have no
              grant to offer and no object to name beyond themselves, so the only
              thing left worth reading is what the service said, and a reader who
              wants that wants all of it at once. */}
          {unchecked.some((verdict) => verdict.apiMessage) && (
            <ApiMessage
              message={unchecked
                .filter((verdict) => verdict.apiMessage)
                .map((verdict) => `${verdict.table}\n${verdict.apiMessage}`)
                .join('\n\n')}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * The Genie spaces, when one of them is the problem.
 *
 * The heading was three sentences: what these are, what the agent uses them for,
 * and that execution is unchanged whatever this says. The second is not news to
 * anybody reading a Genie row, and the third is the intro's job, said once at
 * the top for the whole screen rather than again per section.
 */
function GenieReport({ verdicts }: { verdicts: readonly GenieVerdict[] }) {
  return (
    <>
      <p>
        <strong>Genie spaces, asked under your own token.</strong>
      </p>
      <ul>
        {verdicts.map((verdict) => (
          <li key={verdict.space}>
            <code>{verdict.label}</code>
            {verdict.status === 'denied'
              ? `: missing ${verdict.missing?.permission ?? 'CAN_RUN'}`
              : ': not established'}
            {verdict.remedy && <RemedyBlock remedy={verdict.remedy} />}
            {verdict.apiMessage && <ApiMessage message={verdict.apiMessage} />}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * What the check could not cover, behind a summary line.
 *
 * COLLAPSED, AND THAT IS THE POINT. Every word of it is worth having and none of
 * it is what somebody at a door needs first: it was an amber panel carrying two
 * or three bullets, each with a three-line grey explanation under it, sitting
 * between the reader and the way in. Nothing has been deleted. It is one line
 * until somebody asks.
 *
 * The epistemology of the check lives in here too, rather than in the opening
 * paragraph where it used to be. "You could have read this, not that you did" is
 * the sentence that stops a reader over-claiming afterwards, and it is a
 * qualifier on the result rather than an instruction for getting through the
 * door.
 */
export function LimitsReport({ limits }: { limits: readonly NotChecked[] }) {
  return (
    <details className="access-gate-result access-gate-result-neutral access-gate-limits">
      <summary>What this check does not tell you</summary>
      <p className="access-gate-detail">
        A pass establishes that you <em>could</em> have read the data behind an answer, not that you did.
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
    </details>
  );
}

/**
 * The whole of what a reader needs before choosing one of three doors.
 *
 * ONE SENTENCE OF SUBSTANCE, and it was five. The paragraph explained the
 * epistemology of the check ("establishes that you could have read the data
 * behind an answer, not that you did"), promised that what it establishes is
 * listed with the result, and said twice over that execution is a property of
 * the deployment. All of that is true and none of it is what somebody checking
 * their permissions is reading for. What survives is the two facts that change
 * what they do next: WHAT is checked, and that it decides nothing about who runs
 * the questions afterwards. The qualifier moved to the limits disclosure, beside
 * the result it qualifies.
 *
 * Verification and execution are different questions. This screen only answers
 * the first: can YOU reach the warehouse, the tables, and the Genie spaces under
 * your own token. Who runs later asks is analyticalExecution on Connections, not
 * a switch on these buttons. Claiming "still runs as a service principal" here
 * was false under user authorization and taught the wrong lesson about the gate.
 */
export function GateIntro({ signedInAs, id }: { signedInAs: string; id?: string }) {
  return (
    <p id={id}>
      <UserIdentityChip identity={signedInAs} label="Signed in as" compact />. This checks your access under your own
      token: the SQL warehouse, the tables behind answers, and the Genie spaces. It does not decide who runs the
      questions that follow; that is reported on Connections.
    </p>
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

/**
 * Everything inside the panel a keyboard can reach, in document order.
 *
 * Written as a selector rather than a walk because the panel's contents are
 * ordinary markup: three buttons, the `<summary>` of each collapsed raw-message
 * disclosure, and nothing custom. `:not([disabled])` matters -- all three buttons
 * disable themselves while a check is in flight, and a trap that cycles onto a
 * disabled button drops focus onto the document instead.
 */
/**
 * Where Tab should go, or null to let the browser move focus itself.
 *
 * The trap only intervenes at the two ends, which is the whole of containment:
 * forward off the last element goes to the first, backward off the first goes to
 * the last. Anywhere in the middle, natural order is already right and taking it
 * over would break the browser's own handling of anything the selector above
 * does not know about.
 *
 * Focus that is not on any of them -- the panel itself, on the frame after mount
 * -- goes to the first element forward and the last backward, so the first Tab
 * from the opening state enters the list rather than leaving the dialog.
 */
/**
 * @param enabled Whether the check is asked for at all, defaulting to the
 *   deployment's switch. A parameter so a test can drive both states; nothing in
 *   the app passes it.
 */
export function AccessGate({
  children,
  enabled = ACCESS_GATE_ENABLED,
  preloadedIdentity,
  onIdentityChange,
}: {
  children: React.ReactNode;
  enabled?: boolean;
  preloadedIdentity?: GateIdentity | null;
  onIdentityChange?: (identity: GateIdentity) => void;
}) {
  const [loadedIdentity, setLoadedIdentity] = useState<GateIdentity | null>(preloadedIdentity ?? null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const skip = useRef<HTMLButtonElement | null>(null);
  const identity = preloadedIdentity === undefined ? loadedIdentity : preloadedIdentity;
  const setIdentity = useCallback(
    (next: GateIdentity | ((current: GateIdentity | null) => GateIdentity | null)) => {
      const resolved = typeof next === 'function' ? next(identity) : next;
      if (!resolved) return;
      setLoadedIdentity(resolved);
      onIdentityChange?.(resolved);
    },
    [identity, onIdentityChange]
  );

  useEffect(() => {
    if (!enabled || preloadedIdentity !== undefined) return;
    identityRequest()
      .then(gateIdentityFromResponse)
      .then(setIdentity)
      // A gate that cannot reach the server must not become a locked door in
      // front of a working app. It stands aside and says nothing it cannot back.
      .catch(() => setUnreachable(true));
  }, [enabled, preloadedIdentity, setIdentity]);

  const declare = useCallback(
    async (mode: 'service-principal' | 'skipped') => {
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
            ? {
                ...current,
                executionMode: body.decision.mode,
                accessDecision: body.decision,
                servingPrincipal: body.servingPrincipal,
              }
            : current
        );
      } catch (error) {
        setFailure((error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [setIdentity]
  );

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
  }, [setIdentity]);

  // Off by default, and this is the whole of what that means: the app opens under
  // the reader's own token as if the check had never been written. Nothing below
  // has been removed, and nothing records a mode on the way past.
  if (!enabled) return <>{children}</>;
  if (unreachable) return <>{children}</>;
  // The identity read decides whether a gate must cover the app; it does not
  // decide whether the app has pixels. Keeping the shell mounted removes the
  // blank cold-open second and lets this fixed overlay take over if needed.
  if (!identity) return <>{children}</>;

  // Nobody is signed in, so there is no second authority to weigh the service
  // principal against and nothing to forward a token for. The question the gate
  // asks has one truthful answer here, and a dialog with one answer is not a
  // choice. It is a thing people learn to click past before reading, which is
  // how a governance prompt stops working in the place it matters.
  if (identity.identitySource === 'development-fallback') return <>{children}</>;

  /*
   * A decision has been made, so the gate's work is done and it stands aside.
   *
   * There is deliberately no status strip here. One stood above every page for
   * the whole session and was narrowed three times trying to make it tolerable:
   * a paragraph became a line, the line lost the execution claim it had no right
   * to make, then user-verified auto-hid, then the rest became dismissible. None
   * of that answered the objection, because the objection was to a governance
   * status row being the first thing read on every screen of a customer demo.
   *
   * Nothing is lost by removing it. The mode, the principal, and the server's
   * own account of what was verified are on the Connections page, which is
   * somewhere a reader goes and asks rather than somewhere they are told. Please
   * do not reinstate the strip: put it on Connections, where the record already
   * is, or in the header where it can be one control among several.
   */
  if (identity.accessDecision) return <>{children}</>;

  const serving = result?.servingPrincipal ?? identity.servingPrincipal;
  /** A check that ran and did not pass, as distinct from one nobody has run yet. */
  const checkFailed = Boolean(result && !result.verified);
  /** The spaces worth reading about: a green row is not news on a failure screen. */
  const genieProblems = (result?.genie ?? []).filter((verdict) => verdict.status !== 'ok');

  return (
    <Dialog
      overlayClassName="access-gate"
      contentClassName="access-gate-panel"
      labelledBy="access-gate-title"
      describedBy="access-gate-description"
      dismissOnEscape={false}
      dismissOnBackdrop={false}
      onEscape={() => skip.current?.focus()}
    >
      <h1 id="access-gate-title">Access check</h1>
      <GateIntro id="access-gate-description" signedInAs={identity.signedInAs} />

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
                fact that taking it establishes nothing about their own access.
              */}
            <p className="access-gate-fallback">
              <strong>You can still go in.</strong> <em>Proceed as the service principal</em> below grants you nothing
              and claims nothing about your own access.
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
          because that is now the default; service-principal mode is second
          because it is the fallback when verification is skipped or fails.
          Once a check has actually failed the emphasis swaps. Re-running a
          check that just failed for a missing grant is not the next thing
          this reader should be pushed towards.
        */}
      <div className="access-gate-actions">
        {/*
            ONCE THE CHECK HAS FAILED, RE-RUNNING IT IS A REFRESH, so it is the
            app's shared Refresh control and not a door of its own. It said "Check
            my access again", which was the fifth spelling of the same idea in a
            codebase that had already collapsed four of them into one component,
            and it was the only one of those that ran a probe rather than a read --
            which is a distinction the reader does not have and does not want.

            Only in this state. The first visit is not a refresh: there is nothing
            to re-read, the door is offering a choice between three ways in, and
            "Refresh" would be an odd word for the first thing that ever happens.
            So the door keeps its own label and its own explanation there, and this
            is the one place the wording is state-dependent on purpose.
          */}
        {checkFailed ? (
          <div className="access-gate-recheck">
            {/* `void`, because both handlers below are their own error
                  boundary: each ends in a `catch` that puts the failure on
                  screen and a `finally` that clears `busy`, so there is no
                  rejection left for a caller to handle and the click handler
                  is genuinely done when it returns. */}
            <RefreshButton busy={busy} onRefresh={() => void verify()} />
            <span>Runs the same probe again, once the grant above has been made.</span>
          </div>
        ) : (
          <button type="button" className="access-gate-primary" disabled={busy} onClick={() => void verify()}>
            <span className="access-gate-action-label">
              {busy ? 'Checking your access\u2026' : 'Verify my access first'}
            </span>
            {/* One line, because the result says the rest of it. The second
                  sentence here promised that the result would report what was
                  verified and what it could not check, which is a promise about a
                  screen the reader is about to be shown anyway. */}
            <span>Runs a statement on this app’s warehouse under your own token.</span>
          </button>
        )}
        <button
          type="button"
          className={checkFailed ? 'access-gate-primary' : undefined}
          disabled={busy}
          onClick={() => void declare('service-principal')}
        >
          <span className="access-gate-action-label">Proceed as the service principal</span>
          {/* "Who runs questions is reported on Connections" was here and in the
                opening paragraph and in the Genie heading. It is in the opening
                paragraph now, once. The principal stays: it is the only place the
                reader is told which identity the fallback names. */}
          <span>
            The fallback. Establishes nothing about your own access
            {serving?.id ? ` (endpoint principal ${principalLabel(serving.id)})` : ''}.
          </span>
        </button>
        <button
          type="button"
          className="access-gate-skip"
          disabled={busy}
          onClick={() => void declare('skipped')}
          ref={skip}
        >
          <span className="access-gate-action-label">Skip this</span>
          {/* The distinction that has to survive being shortened: this and the
                fallback verify exactly the same amount, which is none, and they are
                RECORDED differently. Without that, a conversation nobody looked at
                could later be read as one that passed. */}
          <span>Checks nothing, and is recorded as a skip rather than as the fallback.</span>
        </button>
      </div>
    </Dialog>
  );
}
