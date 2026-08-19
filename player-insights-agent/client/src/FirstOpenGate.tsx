/**
 * The card the app opens on, once a session: who you are signed in as, the
 * scopes this deployment asks for one row at a time, and the disclaimer.
 *
 * Built to `login-gate.md`. Three departures from it, each deliberate and each
 * noted where it happens:
 *
 *   1. CONTINUE IS NEVER DISABLED. The spec renders it disabled beside Refresh
 *      whenever a scope is missing. The standing instruction for this screen is
 *      that a missing scope warns and does not lock the reader out, and a gate
 *      whose only control is dead is a dead end for a reader whose admin is in
 *      another timezone. Refresh is added exactly as the spec asks -- second
 *      control, app-wide style -- so the reader gains the spec's recheck without
 *      losing the way past.
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
 * SKIP DISMISSES THE CARD AND CHANGES NOTHING ELSE. The spec predates it. It is
 * the way past a failing check, named for what it does, and its entire effect is
 * to close this card and record that the checks were SKIPPED rather than passed.
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
import { AstrolabeLockup } from './AstrolabeMark';
import { UserIdentityChip } from './UserIdentityChip';
import { ConceptFlicker } from './ConceptFlicker';
import { DATABRICKS_LOGO, DATABRICKS_SYMBOL } from './brand-icons';
import { OpeningSequence } from './OpeningSequence';
import {
  RISE_SETTLE_MS,
  gateRiseMs,
  gateRiseStyle,
  prefersReducedMotion,
  showsOpeningSequence,
} from './opening-sequence';
import { TRANSITION_MS, transitionRuns, type GateStage } from './login-transition';
import {
  CONTINUE_LABEL,
  DISCLAIMER_TITLE,
  IDENTITY_CAPTION,
  IDENTITY_LABEL,
  OAUTH_BADGE,
  OPTIONAL_SCOPES_HEADING,
  OPTIONAL_SCOPES_NOTE,
  REQUIRED_SCOPES_NOTE,
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
 * GitHub's own mark, drawn inline because the spec says to and because it is
 * GitHub's logo rather than a Databricks asset, so it does not belong in the
 * brand directory that `brand-icons.test.ts` holds byte-for-byte against the
 * Databricks library. The standard octocat-circle path, unaltered.
 */
function GithubMark() {
  return (
    <svg className="fo-github" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

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
}: {
  heading: string;
  scopes: readonly ScopeRow[];
  note?: string;
  footer?: ReactNode;
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
              <code className="fo-scope-name">{scope.name}</code>
              <ScopePill status={scope.status} optional={scope.optional} />
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
    <span className="fo-databricks-logo" role="img" aria-label="Databricks" dangerouslySetInnerHTML={{ __html: DATABRICKS_LOGO }} />
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
  onSky = false,
  rising = false,
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
  /**
   * Whether the opening sequence is drawing underneath. The backdrop goes
   * transparent so the constellation shows through it, which `loading-suite.md`
   * asks for: "The constellation keeps drawing behind the gate."
   */
  onSky?: boolean;
  /** Whether the card is mid-rise (`ast-gate-in`). True only for its first 1.2s. */
  rising?: boolean;
  /**
   * Whether Continue has been taken and the card is on its way out
   * (`login-transition.md` phases 1 and 2: the button dips, then the card sinks
   * 26px and fades). Never true under `prefers-reduced-motion: reduce`, where the
   * gate is cut rather than animated away.
   */
  leaving?: boolean;
}) {
  // The rise's own timing, inline because a duration is a property of a seating.
  // See `gateRiseStyle`: the negative delay is what starts the keyframe at its 60%
  // mark, which is the frame the card first becomes visible on.
  const rise = rising ? gateRiseStyle() : undefined;
  const { before, emphasis, after } = disclaimerParts();
  const showRefresh = offersRefresh(report);
  const showSkip = offersSkip(report);
  return (
    <div
      className={`first-open${onSky ? ' on-sky' : ''}${leaving ? ' fo-leaving' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-open-title"
    >
      <div
        className={`first-open-card${rising ? ' ast-anim-gate-in' : ''}${leaving ? ' ast-anim-x-card' : ''}`}
        style={rise}
      >
        {/* The order `login-gate.md` fixes: the Databricks logo, then the
            astrolabe lockup, then identity, scopes, disclaimer, Continue. The
            platform first and the app second, because the reader has just come
            through Databricks OAuth and this card is the app introducing itself
            on the other side of it. */}
        <div className="fo-head">
          <DatabricksLogo />
          {/* The lockup IS the heading, so the dialog takes its name from it.
              The old long app name that used to be set here renders nowhere in
              the app any more (§1). */}
          <AstrolabeLockup as="h1" seat="gate" id="first-open-title" className="fo-title" />
        </div>

        <section className="fo-box fo-identity">
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
          <p className="fo-caption">{IDENTITY_CAPTION}</p>
        </section>

        <ScopeSection
          heading={SCOPES_HEADING}
          scopes={requiredScopeRows(report.scopes)}
          note={REQUIRED_SCOPES_NOTE}
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
          note={OPTIONAL_SCOPES_NOTE}
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
            <GithubMark />
            {SOURCE_LABEL}
          </a>
        </section>

        <div className="fo-foot">
          <div className={showRefresh ? 'fo-actions fo-actions-pair' : 'fo-actions'}>
            {/*
             * LIVE IN EVERY STATE. See the note at the top of this file: the spec
             * disables this whenever a scope is missing, and the standing decision
             * for this screen is that it warns without locking the reader out.
             *
             * One control, named for what taking it means on this verdict. Where
             * a check is failing it says so and records `skipped`; where every row
             * says Granted there is nothing to skip and it is plain Continue. Two
             * buttons that both dismiss the card would leave the reader choosing
             * between synonyms.
             */}
            <Button
              className={`fo-continue${leaving ? ' ast-anim-x-click' : ''}`}
              onClick={showSkip ? onSkip : onContinue}
            >
              {showSkip ? SKIP_LABEL : CONTINUE_LABEL}
            </Button>
            {showRefresh ? <RefreshButton onRefresh={onRefresh} className="fo-refresh" /> : null}
          </div>
          {/*
           * The whole of what skipping costs, in one line. It grants nothing, so
           * the reader must not leave believing the app will now work around the
           * shortfall.
           */}
          {showSkip ? <p className="fo-skip-note">{SKIP_NOTE}</p> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The opaque first frame, drawn before the report is known.
 *
 * THIS IS THE FLICKER FIX AND IT IS THE WHOLE OF IT. The gate used to render
 * nothing at all while `/api/identity` was in flight -- `showsFirstOpen` is false
 * on the `resolving` verdict -- so the app drew its header, its tabs and the Ask
 * tab for as long as that request took, and then a full-viewport login gate
 * dropped over the lot. Nothing was wrong with the gate's timing; what was wrong
 * is that the app treated "we do not know yet" as "there is no gate".
 *
 * Whether the gate shows is answerable on the FIRST FRAME, without asking the
 * server anything: the session latch is in `sessionStorage` and is read
 * synchronously. So this layer goes up immediately, and the report only decides
 * what goes ON it. `Layout` holds the shell back for exactly this stage, so there
 * is no app underneath to be glimpsed rather than an app hidden behind a curtain.
 *
 * It carries the cycling mark rather than a spinner, and it carries the EXISTING
 * one: `ConceptFlicker` is the app's four-glyph slot, seated on the splash, in the
 * working strip and in the primary button. Under `prefers-reduced-motion: reduce`
 * the guard in astrolabe-animation.css resolves the slot to the single d-pad, so
 * this frame is a still mark on Ice for a reader who asked for no motion.
 */
function FirstOpenHold() {
  return (
    <div className="first-open first-open-hold" aria-hidden="true">
      <ConceptFlicker seat="splash" className="fo-hold-mark" />
    </div>
  );
}

/**
 * Everything the app needs to know about the gate: what to draw, and what it may
 * draw itself.
 *
 * A HOOK RATHER THAN A SELF-CONTAINED COMPONENT, because two of the transition's
 * six phases are not the gate's to run. The app surface crossfades in
 * (`ast-x-app`), the top bar's lockup pops at the point the stars converged on
 * (`ast-x-mark`) and the progress line runs under the bar (`ast-x-bar`) -- all
 * three belong to the shell, and the shell cannot join an animation it is not told
 * about. The same call answers the flicker question, which is the other thing only
 * the shell can act on: while the stage is `pending` there is nothing for it to
 * draw.
 *
 * IT DOES NOT READ `/api/identity` ITSELF. The header already read it and this is
 * handed the answer, because two reads are two answers that can disagree and a
 * card contradicting the address in the header is worse than no card. Refresh is
 * a reload for the same reason: the app re-reads identity on load, the latch is
 * still unset so this card comes straight back, and the recheck the spec asks for
 * happens without a second reader of the same endpoint being introduced to do it.
 */
export interface FirstOpen {
  /** Where the gate is in its life. `Layout` reads this and nothing else. */
  stage: GateStage;
  /** The gate's layers, or null once it is gone. */
  gate: ReactNode;
}

export function useFirstOpen(identity: Identity): FirstOpen {
  const [dismissed, setDismissed] = useState(() => firstOpenAcknowledged());
  /*
   * Whether the opening sequence is playing, and how far through it is.
   *
   * ONE LATCH FOR BOTH, which is `opening-sequence.ts`'s argument: the sequence
   * precedes the gate and the gate shows once a session, so the gate's own
   * acknowledgement is what says whether this is the session's first open. A
   * second key would be a second answer to the same question.
   *
   * Read once on mount rather than on every render, so a reader who acknowledges
   * the card does not re-decide the sequence on the way out.
   */
  const [sequence] = useState(() =>
    showsOpeningSequence({ acknowledged: firstOpenAcknowledged(), reducedMotion: prefersReducedMotion() })
  );
  const [intro, setIntro] = useState(sequence);
  const [rising, setRising] = useState(false);
  /*
   * Whether the transition to Ask is running.
   *
   * Read once on mount, like the sequence above and for the same reason: a reader
   * who changes the system preference mid-session must not have a transition
   * half-decided by two different answers to the same question.
   */
  const [animates] = useState(() => transitionRuns({ reducedMotion: prefersReducedMotion() }));
  const [leaving, setLeaving] = useState(false);

  /*
   * The intro's clock, and the two ways out of it.
   *
   * SKIPPABLE WITH ANY CLICK OR KEY (`loading-suite.md`), and the listeners are
   * removed the moment the intro is over rather than living as long as the gate.
   * That is not tidiness: past 60% the card is on screen and being read, and a
   * listener still treating a click as a skip would fire on the reader pressing
   * Continue or opening the source link.
   *
   * `pointerdown` rather than `click` so a press registers on the frame it
   * happens, and `capture` so nothing between here and the window can swallow it.
   */
  useEffect(() => {
    if (!intro) return;
    const arrive = () => {
      setIntro(false);
      setRising(true);
    };
    const timer = window.setTimeout(arrive, gateRiseMs());
    window.addEventListener('pointerdown', arrive, { capture: true });
    window.addEventListener('keydown', arrive, { capture: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', arrive, { capture: true });
      window.removeEventListener('keydown', arrive, { capture: true });
    };
  }, [intro]);

  /*
   * Taking the rise class away once the card has arrived.
   *
   * See RISE_SETTLE_MS: `ast-gate-in` is verbatim from a demo loop and ends by
   * fading the card out so the loop can restart. The app plays the rise and stops
   * before the tail, which leaves the card at its own opacity with no animation on
   * it -- where the keyframe's hold would have put it anyway.
   */
  useEffect(() => {
    if (!rising) return;
    const timer = window.setTimeout(() => setRising(false), RISE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [rising]);

  /*
   * The transition's clock, and the cut that beats it.
   *
   * "The animation never blocks input: a click anywhere during it cuts to the
   * landed state" (`login-transition.md`, Rules). So the same `pointerdown` and
   * `keydown` capture pair the intro uses, for the same reason and with the same
   * caveat about removing them the moment the phase is over: the app is live
   * underneath by this point, and a listener that outlived the transition would
   * treat the reader's first real click as a skip.
   *
   * The latch is already written by the time this runs -- Continue records it
   * before starting the transition -- so a reader who reloads mid-animation gets
   * the app rather than the gate again. An animation is not a thing to be halfway
   * through.
   */
  useEffect(() => {
    if (!leaving) return;
    const land = () => {
      setLeaving(false);
      setDismissed(true);
    };
    const timer = window.setTimeout(land, TRANSITION_MS);
    window.addEventListener('pointerdown', land, { capture: true });
    window.addEventListener('keydown', land, { capture: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', land, { capture: true });
      window.removeEventListener('keydown', land, { capture: true });
    };
  }, [leaving]);

  const report = firstOpenReport(identity);
  /*
   * Which of the four stages this is.
   *
   * `pending` IS THE ONE THAT DID NOT EXIST, and its absence is the flicker. The
   * old line here was `if (dismissed || !showsFirstOpen(report)) return null`,
   * which conflated "the reader has been through the gate" with "the app cannot
   * tell yet whether they have" and answered both with an empty render. The first
   * is a reason to draw nothing; the second is a reason to draw the backdrop and
   * hold the app back, because the answer is a request away and the gate is going
   * to win it in every case but one that never happens (a reader who is somehow
   * acknowledged, which is the `dismissed` branch above).
   */
  const stage: GateStage = dismissed
    ? 'open'
    : leaving
      ? 'arriving'
      : showsFirstOpen(report)
        ? 'gate'
        : 'pending';

  /**
   * Getting past the card, either way.
   *
   * The outcome is filed FIRST and by the caller's own function, because the two
   * record different facts and `first-open.ts` is explicit that a skip must never
   * be written as a pass. Only then does the transition start: an animation that
   * ran before the latch was written would leave a reload mid-animation showing
   * the gate again.
   */
  const leave = (record: () => void) => () => {
    record();
    if (animates) setLeaving(true);
    else setDismissed(true);
  };

  if (stage === 'open') return { stage, gate: null };
  if (stage === 'pending') {
    return { stage, gate: sequence ? <OpeningSequence intro={intro} /> : <FirstOpenHold /> };
  }

  /*
   * The card, drawn only once the intro has handed over.
   *
   * NOT RENDERED AT OPACITY 0 DURING THE INTRO, which is where the design
   * reference and the app part company. The reference has the card present from
   * the first frame because it is a demo loop and `ast-gate-in` reveals it; an
   * invisible dialog is still in the tab order and still read by a screen reader,
   * so a reader on a keyboard would be moving through a login card nobody can see.
   */
  const card = intro ? null : (
    <FirstOpenPanel
      report={report}
      onSky={sequence}
      rising={rising}
      leaving={leaving}
      onContinue={leave(acknowledgeFirstOpen)}
      /*
       * Identical in effect to Continue, and that is the requirement rather than
       * a shortcut: the only difference between them is which outcome is filed.
       * Skip closes the card. It does not grant a scope, does not re-run the
       * comparison, does not ask the server for anything, and cannot move data
       * access onto the app's own service principal -- there is no call here that
       * could, and `POST /api/access-mode` is the only route that can.
       */
      onSkip={leave(skipFirstOpenChecks)}
      onRefresh={() => window.location.reload()}
    />
  );

  return {
    stage,
    gate: (
      <>
        {/* The sky stays for as long as the gate does, because the spec has the
            constellation still drawing behind it. `intro` is what ends: the concepts
            and the wordmark stop once the card is up, and `leaving` is what sends
            the stars to the lockup and takes the whole layer with them. */}
        {sequence ? <OpeningSequence intro={intro} leaving={leaving} /> : null}
        {card}
      </>
    ),
  };
}

/**
 * The gate on its own, for a caller that wants the layers and not the stage.
 *
 * Thin by design. `Layout` uses the hook, because it has to hold its own first
 * paint back and to join the crossfade; this is the same thing for anywhere that
 * only needs the overlay, and it is what the render tests draw.
 */
export function FirstOpenGate({ identity }: { identity: Identity }) {
  return useFirstOpen(identity).gate;
}
