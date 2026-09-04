/**
 * The card the app opens on, once a session: who you are signed in as, the
 * scopes this deployment asks for one row at a time, and the disclaimer.
 *
 * Built to `login-gate.md`. Three departures from it, each deliberate and each
 * noted where it happens:
 *
 *   1. REQUIRED SHORTFALLS HAVE A REPAIR, NOT A SKIP. The signed-in user's
 *      forwarded token updates this App resource without replacing any scopes
 *      already granted. Optional or unread checks may still be skipped.
 *   2. THE TWO CORPORATE MARKS ARE HERE NOW, and this note used to say they
 *      could not be. `assets/brand/` held seven PRODUCT marks and no corporate
 *      mark, so the card carried its heading alone rather than substitute a
 *      product logo for one it is not. Both marks have since been committed --
 *      `databricks-logo-full-color.svg` above the lockup and
 *      `databricks-symbol-color.svg` in the disclaimer heading -- and §2 makes
 *      this card and the top bar's attribution the only two places in the
 *      product where full-colour Databricks artwork renders.
 *   3. THE MISSING-SCOPES FOOTER DOES NOT SEND THE READER TO THEIR ADMIN. The
 *      spec's wording is "N scopes are missing. Ask your workspace admin to add
 *      `x` to the app's OAuth configuration", and it cannot be right on this
 *      screen: the names in that list are the app's own declaration minus what
 *      the sign-in carries, so every one of them is already in the app's OAuth
 *      configuration and the admin has nothing to add. The reader's own browser
 *      is the fix. See `missingFooter` for the days that sentence cost.
 *      Singular is handled there too, because "1 scopes" is the likeliest case
 *      and the spec only wrote the plural.
 *
 * SKIP DISMISSES THE CARD AND CHANGES NOTHING ELSE. It remains available only
 * when no required shortfall can be repaired here, and records that the checks
 * were SKIPPED rather than passed.
 * It grants no scope, re-runs no comparison, sends no request, and selects no
 * fallback: after taking it the app still reads governed data as the signed-in
 * person, still gets refused whatever their grants refuse, and still surfaces
 * those refusals unchanged. In particular it CANNOT move execution onto the
 * app's own service principal. That is `POST /api/access-mode`, which belongs to
 * the separate and switched-off `AccessGate` (`shared/access-gate.ts`), is not
 * called from this file, and must not be: reading governed data as the app was
 * removed at the customer's explicit request, and a convenience on this screen
 * is not a reason to reintroduce it.
 *
 * Split in two on purpose. `FirstOpenPanel` is markup and nothing else, so the
 * three states can be rendered and asserted with `renderToStaticMarkup` in a test
 * run that has no DOM. `FirstOpenGate` holds the session latch and the identity.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button } from './ui';
import { RefreshButton } from './RefreshControl';
import type { Identity } from './app-types';
import { PiaLockup } from './PiaMark';
import { UserIdentityChip } from './UserIdentityChip';
import { DATABRICKS_LOGO, DATABRICKS_SYMBOL } from './brand-icons';
// The same octocat the Connections tab links its repository with. One copy, so
// the two seatings cannot come apart. See GithubMark.tsx.
import { GithubMark } from './GithubMark';
import { Dialog } from './Dialog';
import {
  SURFACE_TRANSITION_MS,
  browserMotionRuns,
  completeLoginHandoff,
  initialLoginHandoff,
  readyLoginHandoff,
  requestLoginHandoff,
  type LoginHandoff,
} from './motion-transitions';
import {
  CONTINUE_LABEL,
  DISCLAIMER_TITLE,
  IDENTITY_LABEL,
  OAUTH_BADGE,
  OPTIONAL_SCOPES_HEADING,
  SCOPES_HEADING,
  SKIP_LABEL,
  SKIP_NOTE,
  SOURCE_LABEL,
  SOURCE_URL,
  acknowledgeFirstOpen,
  disclaimerParts,
  firstOpenAcknowledged,
  firstOpenReport,
  offersRefresh,
  offersSkip,
  optionalScopeRows,
  requiredScopeRows,
  showsFirstOpen,
  skipFirstOpenChecks,
  type FirstOpenReport,
  type ScopeRow,
} from './first-open';

/**
 * One scope's verdict, in the app's ONE pill recipe.
 *
 * `.ast-pill` and a family modifier, rather than the three hand-written `.fo-pill`
 * recipes this card used to carry. There were 21 independently-written chip
 * recipes across the app disagreeing about radius, label size and border
 * (`docs/astrolabe-migration-inventory.md`); §2 replaces the lot with one.
 *
 * NEVER COLOUR ALONE, which is a requirement about these three strings rather
 * than about the rules: each pill says what it means in words, so a reader who
 * cannot separate green from red still reads three different verdicts.
 */
function ScopePill({ status, optional = false }: { status: ScopeRow['status']; optional?: boolean }) {
  if (status === 'granted') return <span className="ast-pill ast-pill--pos">Granted</span>;
  // An optional scope the sign-in does not carry is not a red finding. Nothing an
  // ask needs is short, so the row reports the absence and stops there; a red
  // Missing beside the word Optional reads as a contradiction and sends readers
  // looking for a grant they do not need.
  if (status === 'missing') {
    return optional ? (
      <span className="ast-pill ast-pill--neutral">Not granted</span>
    ) : (
      <span className="ast-pill ast-pill--neg">Missing</span>
    );
  }
  if (status === 'not_declared') return <span className="ast-pill ast-pill--neutral">Not requested</span>;
  // Neutral, and worded as an absence of evidence rather than as a finding. A
  // grey "Missing" would send a reader to their admin about a scope nothing
  // showed to be absent.
  return <span className="ast-pill ast-pill--neutral">Not checked</span>;
}

/**
 * A scopes box: heading, a one-line caption, the rows, and any footer.
 *
 * The caption sits directly under the heading so each box says what it is for
 * before the chips. The footer still sits under the rows: it is about a
 * finding the chips just raised, not about the heading.
 */
function ScopeSection({
  heading,
  scopes,
  note,
  footer,
  onRequestScope,
  requestingScope,
}: {
  heading: string;
  scopes: readonly ScopeRow[];
  note?: string;
  footer?: ReactNode;
  onRequestScope?: (scope: string) => void;
  requestingScope?: string | null;
}) {
  /*
   * A BOX WITH NOTHING IN IT IS THE ONE THING NOT DRAWN, and "nothing" has to
   * count the footer as well as the rows. It did not, and the state that costs is
   * the one where the identity read never landed: there are no scope rows at all
   * then, and the only thing the card has to say is the footer sentence explaining
   * that the check did not complete. An early return on the row count alone
   * swallowed it, and the reader met a login card that had silently dropped its
   * own explanation.
   */
  if (scopes.length === 0 && !note && !footer) return null;
  return (
    <section className="fo-box fo-scopes">
      <p className="fo-scopes-head">{heading}</p>
      {note ? <p className="fo-scopes-note">{note}</p> : null}
      {/* No empty list element where there are no rows: `.fo-scope-list` is a grid
          with its own borders, and an empty one draws a stray hairline. */}
      {scopes.length > 0 ? (
        <ul className="fo-scope-list">
          {scopes.map((scope) => (
            <li className="fo-scope-row" key={scope.name} data-optional={scope.optional ? 'true' : undefined}>
              <span>
                {/* The scope name alone, for every row.
 
                    One scope used to carry a sentence of explanation here and the
                    rest did not, which read as though that row were the important
                    one -- and it is the least important, being optional. The list's
                    job on this card is the verdict per scope; what a permission is
                    FOR is answered in Connections, where every scope is described
                    rather than one. Describing a single row is worse than
                    describing none, because the asymmetry is itself a claim. */}
                <code className="fo-scope-name">{scope.name}</code>
              </span>
              <span>
                <ScopePill status={scope.status} optional={scope.optional} />
                {scope.status === 'not_declared' && onRequestScope ? (
                  <Button
                    className="fo-scope-request"
                    onClick={() => onRequestScope(scope.name)}
                    disabled={Boolean(requestingScope)}
                  >
                    {requestingScope === scope.name ? 'Requesting\u2026' : 'Request'}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {footer}
    </section>
  );
}

/**
 * The Databricks logo above the lockup, and the bricks symbol in the disclaimer.
 *
 * §2 makes these two, with the top bar's attribution, the ONLY full-colour
 * Databricks artwork the product renders. Both come through `brand-icons.ts`,
 * which is the only module allowed to resolve anything out of `assets/brand/`.
 *
 * The logo is labelled and the symbol is not, and the difference is what each
 * one is doing. The logo is the first thing on the card and names the platform
 * the reader has just signed in to; the symbol sits immediately before the words
 * "Not official Databricks software", which already say it.
 */
function DatabricksLogo() {
  return (
    <span
      className="fo-databricks-logo"
      role="img"
      aria-label="Databricks"
      dangerouslySetInnerHTML={{ __html: DATABRICKS_LOGO }}
    />
  );
}

function DatabricksSymbol() {
  return <span className="fo-disc-symbol" aria-hidden="true" dangerouslySetInnerHTML={{ __html: DATABRICKS_SYMBOL }} />;
}

export function FirstOpenPanel({
  report,
  onContinue,
  onRefresh,
  onSkip,
  onAllowRequiredScopes,
  onRequestScope,
  allowingRequiredScopes = false,
  requestingScope = null,
  scopeUpdateMessage = null,
  preparing = false,
  leaving = false,
}: {
  report: FirstOpenReport;
  onContinue: () => void;
  onRefresh: () => void;
  /**
   * Taking the card's way past with a check unsatisfied. A separate handler from
   * `onContinue` because the two record different outcomes, and the difference
   * is the one the customer commitment turns on -- see `FirstOpenOutcome`.
   */
  onSkip: () => void;
  /** Adds the required scopes plus workspace browse through the signed-in user's token. */
  onAllowRequiredScopes?: () => void;
  onRequestScope?: (scope: string) => void;
  allowingRequiredScopes?: boolean;
  requestingScope?: string | null;
  scopeUpdateMessage?: { kind: 'success' | 'error'; text: string } | null;
  /** Continue was requested before the hidden Ask shell reached a stable frame. */
  preparing?: boolean;
  /** The panel is fading out and must stop accepting pointer input immediately. */
  leaving?: boolean;
}) {
  const { before, emphasis, after } = disclaimerParts();
  const showRefresh = offersRefresh(report);
  const showSkip = offersSkip(report);
  const canApplyRequiredScopes = report.verdict === 'missing' && Boolean(onAllowRequiredScopes);
  return (
    <Dialog
      overlayClassName={`first-open on-sky${leaving ? ' is-leaving' : ''}`}
      contentClassName="first-open-card ast-login-panel"
      labelledBy="first-open-title"
      describedBy="first-open-description"
      ariaBusy={preparing || allowingRequiredScopes || Boolean(requestingScope)}
      dismissOnEscape={false}
      dismissOnBackdrop={false}
    >
      {/* The order `login-gate.md` fixes: the Databricks logo, then the
            PIA lockup, then identity, scopes, disclaimer, Continue. The
            platform first and the app second, because the reader has just come
            through Databricks OAuth and this card is the app introducing itself
            on the other side of it. */}
      <div className="fo-head">
        <DatabricksLogo />
        {/* The lockup IS the heading, so the dialog takes its name from it.
              The old long app name that used to be set here renders nowhere in
              the app any more (§1). */}
        <PiaLockup as="h1" seat="hero" id="first-open-title" className="fo-title" />
      </div>

      <section className="fo-box fo-identity" id="first-open-description">
        <p className="fo-label">{IDENTITY_LABEL}</p>
        <p className="fo-who">
          <UserIdentityChip identity={report.signedInAs} className="fo-email" />
          {report.oauthVerified ? (
            <span className="ast-pill ast-pill--pos fo-oauth">
              <Check className="fo-check" aria-hidden="true" />
              {OAUTH_BADGE}
            </span>
          ) : null}
        </p>
      </section>

      <ScopeSection
        heading={SCOPES_HEADING}
        scopes={requiredScopeRows(report.scopes)}
        footer={
          report.footer ? (
            <p className="fo-scope-footer">
              {report.footer.lead}
              {report.footer.scopes.map((name, index) => (
                <span key={name}>
                  {index > 0 ? ' \u00b7 ' : ' '}
                  <code className="fo-scope-name">{name}</code>
                </span>
              ))}
              {/*
               * The stop that ends the lead's sentence, which the names are the
               * last thing in. Only where there are names: every other footer is
               * a lead on its own and already punctuated.
               */}
              {report.footer.scopes.length > 0 ? '.' : null}
              {report.footer.tail ? ` ${report.footer.tail}` : null}
            </p>
          ) : null
        }
      />
      <ScopeSection
        heading={OPTIONAL_SCOPES_HEADING}
        scopes={optionalScopeRows(report.scopes)}
        onRequestScope={onRequestScope}
        requestingScope={requestingScope}
      />

      {/*
       * A statement, not an alert: neutral wash, no border, no icon, no amber
       * (spec). It renders in every state and is never truncated.
       */}
      <section className="fo-disclaimer">
        <p className="fo-disc-title">
          <DatabricksSymbol />
          {DISCLAIMER_TITLE}
        </p>
        <p className="fo-disc-body">
          {before}
          <strong>{emphasis}</strong>
          {after}
        </p>
        <a className="fo-source" href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
          <GithubMark className="fo-github" />
          {SOURCE_LABEL}
        </a>
      </section>

      <div className="fo-foot">
        <div className={showRefresh ? 'fo-actions fo-actions-pair' : 'fo-actions'}>
          {/*
           * One primary action. Required shortfalls are repaired with the
           * reader's token; an unread check may be skipped; and a complete
           * check continues into the app.
           */}
          {canApplyRequiredScopes ? (
            <Button
              className="fo-continue"
              onClick={onAllowRequiredScopes}
              disabled={allowingRequiredScopes || scopeUpdateMessage?.kind === 'success'}
            >
              {allowingRequiredScopes ? 'Adding access\u2026' : 'Allow serving, SQL, Genie, and workspace browsing'}
            </Button>
          ) : (
            <Button className="fo-continue" disabled={preparing || leaving} onClick={showSkip ? onSkip : onContinue}>
              {preparing ? 'Preparing Ask\u2026' : showSkip ? SKIP_LABEL : CONTINUE_LABEL}
            </Button>
          )}
          {showRefresh ? <RefreshButton onRefresh={onRefresh} className="fo-refresh" /> : null}
        </div>
        {/*
         * The whole of what skipping costs, in one line. It grants nothing, so
         * the reader must not leave believing the app will now work around the
         * shortfall.
         */}
        {scopeUpdateMessage ? (
          <p className="fo-skip-note" role={scopeUpdateMessage.kind === 'error' ? 'alert' : 'status'}>
            {scopeUpdateMessage.text}
          </p>
        ) : null}
        {preparing ? (
          <p className="fo-skip-note" role="status" aria-live="polite">
            Ask is finishing its initial readiness check.
          </p>
        ) : null}
        {showSkip && !canApplyRequiredScopes ? <p className="fo-skip-note">{SKIP_NOTE}</p> : null}
      </div>
    </Dialog>
  );
}

export type FirstOpenStage = 'pending' | LoginHandoff['stage'];

export interface FirstOpen {
  stage: FirstOpenStage;
  gate: ReactNode;
  focusOnOpen: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useFirstOpen(identity: Identity, shellReady = true): FirstOpen {
  const [handoff, setHandoff] = useState<LoginHandoff>(() => initialLoginHandoff(firstOpenAcknowledged()));
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [allowingRequiredScopes, setAllowingRequiredScopes] = useState(false);
  const [requestingScope, setRequestingScope] = useState<string | null>(null);
  const [scopeUpdateMessage, setScopeUpdateMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  const report = firstOpenReport(identity);
  const stage: FirstOpenStage = handoff.stage === 'open' ? 'open' : showsFirstOpen(report) ? handoff.stage : 'pending';
  const leave = (record: () => void) => () => {
    record();
    setFocusOnOpen(true);
    setHandoff((current) =>
      requestLoginHandoff(current, {
        shellReady,
        animate: browserMotionRuns(),
      })
    );
  };

  useEffect(() => {
    if (!shellReady) return;
    setHandoff((current) => readyLoginHandoff(current, browserMotionRuns()));
  }, [shellReady]);

  useEffect(() => {
    if (handoff.stage !== 'leaving') return;
    const generation = handoff.generation;
    const timer = globalThis.setTimeout(() => {
      setHandoff((current) => completeLoginHandoff(current, generation));
    }, SURFACE_TRANSITION_MS);
    return () => globalThis.clearTimeout(timer);
  }, [handoff]);

  const allowRequiredScopes = async () => {
    setAllowingRequiredScopes(true);
    setScopeUpdateMessage(null);
    try {
      const response = await fetch('/api/app-user-api-scopes', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as { message?: unknown };
      const message = typeof body.message === 'string' ? body.message : '';
      if (!response.ok) {
        throw new Error(message || 'The app could not add access.');
      }
      setScopeUpdateMessage({
        kind: 'success',
        text: message || 'Access was added. Sign in again so the new access takes effect.',
      });
    } catch (error) {
      setScopeUpdateMessage({ kind: 'error', text: (error as Error).message });
    } finally {
      setAllowingRequiredScopes(false);
    }
  };

  const requestOptionalScope = async (scope: string) => {
    setRequestingScope(scope);
    setScopeUpdateMessage(null);
    try {
      const response = await fetch('/api/app-user-api-scopes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: unknown };
      const message = typeof body.message === 'string' ? body.message : '';
      if (!response.ok) throw new Error(message || 'The app could not request this scope.');
      setScopeUpdateMessage({
        kind: 'success',
        text: message || 'Access was requested. Sign in again so the new access takes effect.',
      });
    } catch (error) {
      setScopeUpdateMessage({ kind: 'error', text: (error as Error).message });
    } finally {
      setRequestingScope(null);
    }
  };

  if (stage === 'open') return { stage, gate: null, focusOnOpen };
  if (stage === 'pending') return { stage, gate: null, focusOnOpen };

  return {
    stage,
    focusOnOpen,
    gate: (
      <FirstOpenPanel
        report={report}
        onContinue={leave(acknowledgeFirstOpen)}
        onAllowRequiredScopes={() => void allowRequiredScopes()}
        onRequestScope={(scope) => void requestOptionalScope(scope)}
        allowingRequiredScopes={allowingRequiredScopes}
        requestingScope={requestingScope}
        scopeUpdateMessage={scopeUpdateMessage}
        preparing={stage === 'waiting-for-shell'}
        leaving={stage === 'leaving'}
        onSkip={leave(skipFirstOpenChecks)}
        onRefresh={() => window.location.reload()}
      />
    ),
  };
}

/**
 * The gate on its own, for a caller that wants the layers and not the stage.
 *
 * Thin by design. The startup coordinator uses the hook to keep the mounted
 * application inert until the modal has completed its handoff.
 */
export function FirstOpenGate({ identity }: { identity: Identity }) {
  return useFirstOpen(identity).gate;
}
