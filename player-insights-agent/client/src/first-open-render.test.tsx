/**
 * What the login gate actually draws, in each of the three states a reader can
 * meet.
 *
 * `renderToStaticMarkup` rather than a DOM, because this suite has no jsdom and
 * no browser is available to it. That reaches everything the card is judged on --
 * the address, the per-scope pills, the verbatim paragraph, which controls exist
 * and whether Continue carries the disabled attribute -- and it does not reach
 * what happens after a click. The two claims that need a click are held against
 * the component source instead, and each says so where it is made.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, beforeEach } from 'vitest';
import type { SessionReport } from '../../shared/session-contract';
import { OPTIONAL_USER_API_SCOPES } from '../../shared/optional-user-api-scopes';
import type { Identity } from './app-types';
import { OPENING_CONSTELLATION } from './constellation';
import { FirstOpenGate, FirstOpenPanel } from './FirstOpenGate';
import { Layout } from './Layout';
import {
  DISCLAIMER_BODY,
  FIRST_OPEN_KEY,
  FIRST_OPEN_OUTCOME_KEY,
  SOURCE_URL,
  acknowledgeFirstOpen,
  firstOpenAcknowledged,
  firstOpenOutcome,
  firstOpenReport,
  forgetFirstOpen,
  skipFirstOpenChecks,
  type AcknowledgementStore,
} from './first-open';
import { partial } from './styles/stylesheet';

const GATE = readFileSync(new URL('./FirstOpenGate.tsx', import.meta.url), 'utf8');
const STATE = readFileSync(new URL('./first-open.ts', import.meta.url), 'utf8');
const PIA_BRAND = partial('pia-brand.css');

/** The app's very first paint, with the identity read still in flight. */
function firstPaint(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>
  );
}

/**
 * A source file with its comments stripped.
 *
 * The assertions below are that certain CALLS do not exist, and the comments
 * explaining why name the very routes they forbid. Read against the raw text they
 * would fail on their own rationale, and the fix a reader would reach for is to
 * delete the explanation -- so the claim is made against the code instead.
 */
function code(source: string): string {
  // Only a line that BEGINS with `//` goes. Stripping every line that merely
  // contains the two characters would take `fetch('https://...')` with it, and an
  // assertion that a call is absent must not be defeated by the call's own URL.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function store(): AcknowledgementStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

const DECLARED = ['serving.serving-endpoints', 'model-serving', 'sql', 'dashboards.genie'];

/**
 * How many optional rows a deployment that declares none of them still draws.
 *
 * READ FROM THE MODULE, NOT COUNTED HERE. It was the literal 3, and the day a
 * fourth optional scope was declared -- `workspace`, for the Connections notebook
 * picker -- two assertions in this file failed for saying the wrong number rather
 * than for finding the wrong thing. The claim is "every optional scope this deploy
 * did not declare reports the effective token verdict for", and that is true at
 * any count.
 */
const OPTIONAL_ROWS = OPTIONAL_USER_API_SCOPES.length;

function session(over: Partial<SessionReport> = {}): SessionReport {
  return {
    state: 'current',
    signedIn: true,
    tokenScopes: DECLARED,
    declaredScopes: DECLARED,
    missingScopes: [],
    cause: 'session-current',
    evidence: 'token lists all four declared scopes',
    explanation: 'The presented sign-in carries every scope this deployment asks for.',
    remedy: null,
    ...over,
  };
}

function identity(over: Partial<Identity> = {}): Identity {
  return {
    signedInAs: 'jordan.lee@example.com',
    executionMode: 'user',
    identitySource: 'databricks-apps',
    session: session(),
    ...over,
  } as Identity;
}

function draw(over: Partial<Identity> = {}): string {
  return renderToStaticMarkup(
    <FirstOpenPanel
      report={firstOpenReport(identity(over))}
      onContinue={() => {}}
      onRefresh={() => {}}
      onSkip={() => {}}
      onAllowRequiredScopes={() => {}}
      onRequestScope={() => {}}
    />
  );
}

/** Strip tags, so a run of text can be asserted across the markup inside it. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('all required scopes granted', () => {
  const markup = draw();

  it('names the app and the address the questions will run under', () => {
    // The heading is the full PIA lockup. The retired product name is gone from
    // visible copy; the
    // Databricks logo above it is the platform's, and it is labelled so that the
    // card names both parties rather than only one.
    expect(text(markup)).toContain('Player Insights Agent');
    expect(text(markup)).not.toContain('Astrolabe');
    expect(markup).toContain('aria-label="Databricks"');
    expect(markup).toContain('You are signing in as');
    expect(markup).toContain('jordan.lee@example.com');
    expect(markup).not.toContain('Questions run under this identity.');
  });

  it('draws the dark sign-in brand as one engraved white D-pad and the readable full wordmark', () => {
    expect(markup).toContain('pia-lockup--hero pia-lockup--full fo-title');
    expect(markup).toContain('pia-mark--dark pia-mark--dpad');
    expect(markup).toContain('width="48"');
    expect(markup).toContain('data-pia-cut="engraved"');
    expect(markup).toContain('Player Insights <span class="pia-accent">Agent</span>');
    expect(markup).not.toContain('pia-mark--cluster');
    expect(PIA_BRAND).toMatch(/\.pia-mark--dark\s*\{[^}]*--pia-mark-ink:\s*var\(--ast-white\)/s);
    expect(PIA_BRAND).toMatch(/\.pia-mark--dark\s*\{[^}]*--pia-mark-accent:\s*var\(--ast-ice-accent\)/s);
    expect(PIA_BRAND).toMatch(/\.pia-type--dark,[\s\S]*?\{[^}]*color:\s*var\(--ast-white\)/);
  });

  it('carries the OAuth badge', () => {
    expect(markup).toContain('OAuth verified');
  });

  it('lists every declared scope with a Granted pill and none missing', () => {
    for (const scope of DECLARED) expect(markup).toContain(scope);
    expect(markup.match(/>Granted</g)).toHaveLength(DECLARED.length);
    expect(markup).not.toContain('>Missing<');
    expect(markup).not.toContain('>Not checked<');
    expect(markup).toContain('Optional scopes');
    expect(markup.match(/>Not requested</g)).toHaveLength(OPTIONAL_ROWS);
    expect(markup.match(/class="sr-only">Request</g)).toHaveLength(OPTIONAL_ROWS);
    expect(markup).toContain('postgres');
    /*
     * The rows carry names and verdicts, and NO row carries a description.
     *
     * `postgres` alone used to be explained here, which made the one optional
     * scope look like the consequential one. Asserting the sentence is absent
     * rather than asserting nothing keeps the asymmetry from coming back: the
     * shared scope-detail map still holds this string, because Connections and
     * the Ops identity table describe every scope from it, so a future edit
     * could reach for it here again without anything else objecting.
     */
    expect(markup).not.toContain('Allows the app to read Lakebase projects, branches, and databases.');
    expect(markup).not.toContain('fo-scope-detail');
    expect(markup).not.toContain('The app cannot answer questions without these: they power serving, SQL, and Genie.');
    expect(markup).not.toContain(
      'Questions still work without these; they unlock Connections browsing (catalogs, tables, notebooks, Vector Search) and Lakebase, and a deployment can omit any of them.'
    );
    expect(markup).not.toContain('Questions do not need these.');
    expect(markup).not.toContain('no Connections field uses it yet');
  });

  it('offers one live Continue and no recheck', () => {
    expect(markup).toContain('Continue');
    expect(markup).not.toContain('Refresh');
    // The AppKit button ships `disabled:` utility classes whatever its state, so
    // the attribute is the thing to assert, not the word.
    expect(markup).not.toContain('disabled=""');
  });

  /*
   * NO SKIP WHERE NOTHING REQUIRED IS SHORT. Optional absence does not stop an
   * ask, so a Skip button would imply a gate that does not exist.
   */
  it('does not offer to skip a check that passed', () => {
    expect(markup).not.toContain('Skip');
    expect(text(markup)).not.toContain('Skipping grants nothing');
  });
});

/*
 * THE SCREEN THAT PROMPTED THIS. The example deployment declares the three catalog
 * reads, an older sign-in carried none of them, and the card drew three red
 * Missing chips under a heading saying Optional. A reader reads the colour, not
 * the heading, and goes looking for a grant that no ask needs.
 */
describe('a declared optional scope the sign-in does not carry', () => {
  const markup = draw({
    session: session({
      state: 'stale',
      declaredScopes: [...DECLARED, 'catalog.tables:read'],
      tokenScopes: DECLARED,
      missingScopes: ['catalog.tables:read'],
    }),
  });

  it('reports the absence without the red the required rows use', () => {
    expect(markup).toContain('>Not granted<');
    expect(markup).not.toContain('>Missing<');
    expect(markup).not.toContain('ast-pill--neg');
  });

  it('offers no sign-in, because nothing a question needs is short', () => {
    expect(text(markup)).not.toContain('private browsing window');
    expect(markup).not.toContain('Skip checks and continue');
  });
});

describe('a scope is missing', () => {
  const markup = draw({ session: session({ state: 'stale', missingScopes: ['dashboards.genie'] }) });

  it('marks that scope and only that scope', () => {
    expect(markup.match(/>Missing</g)).toHaveLength(1);
    expect(markup.match(/>Granted</g)).toHaveLength(DECLARED.length - 1);
  });

  it('states the fix without setting the scope names a second time', () => {
    const said = text(markup);
    expect(said).toContain('does not carry the permission marked Missing above');
    expect(said).toContain('Open this app again in a private browsing window, and sign in there.');
    // The name is a row with a Missing badge against it, and that is the ONLY
    // place it is set. The footer used to repeat every missing name inline, which
    // on a nine-scope deployment was five mono chips through three sentences of
    // prose, three rows under the badges that had already said it -- and it was
    // what pushed the card past the bottom of a laptop viewport.
    expect(markup).toContain('<code class="fo-scope-name">dashboards.genie</code>');
    expect(markup.match(/<code class="fo-scope-name">dashboards\.genie<\/code>/g)).toHaveLength(1);
  });

  /*
   * THE WRONG ADVICE, HELD OUT BY NAME. This footer used to read "Ask your
   * workspace admin to add `dashboards.genie` to the app's OAuth configuration",
   * on a card whose scope list is the app's OWN declaration -- so the name it
   * quoted was already in the configuration it told the admin to add it to. It
   * was the first thing a reader met on the way in, and it pointed away from the
   * ten-second fix they could do themselves.
   */
  it('never tells a reader to ask an admin for a permission the app already declares', () => {
    expect(text(markup)).not.toMatch(/workspace admin/i);
    expect(text(markup)).not.toMatch(/OAuth configuration/i);
  });

  /*
   * The line readers get wrong. Told only to open a private window, somebody
   * reasonably signs out of Databricks first: it is the obvious way to end a
   * session, it is what every other Databricks surface responds to, and it
   * cannot work here.
   */
  it('says that signing out of Databricks will not do it', () => {
    expect(text(markup)).toContain('Signing out of Databricks does not clear');
  });

  /*
   * THE DEPARTURE FROM THE SPEC, HELD HERE SO IT CANNOT BE UNDONE BY ACCIDENT.
   * `login-gate.md` renders Continue disabled whenever a scope is missing. The
   * standing decision for this screen is that a missing scope warns and does not
   * lock the reader out, so Continue stays live and Refresh is added beside it.
   */
  it('offers one-click access and the recheck without a required-scope skip', () => {
    expect(markup).toContain('Allow serving, SQL, Genie, and workspace browsing');
    expect(markup).toContain('Refresh');
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain('Skip checks and continue');
  });

  it('does not offer the optional-scope skip for a required shortfall', () => {
    expect(text(markup)).not.toContain('Skipping grants nothing');
  });
});

describe('the check did not run', () => {
  const markup = draw({ session: session({ state: 'undetermined', tokenScopes: null }) });

  it('claims nothing about any scope', () => {
    expect(markup).not.toContain('>Granted<');
    expect(markup).not.toContain('>Missing<');
    // Required declared rows plus every optional scope, all unchecked.
    expect(markup.match(/>Not checked</g)).toHaveLength(DECLARED.length + OPTIONAL_ROWS);
  });

  it('says the scopes could not be read rather than that they are fine', () => {
    expect(text(markup)).toContain('could not be read');
  });

  it('lets the reader in and offers the recheck', () => {
    // A comparison that never ran has not passed either, so the way past is
    // named as a skip here too.
    expect(markup).toContain('Skip checks and continue');
    expect(markup).toContain('Refresh');
    expect(markup).not.toContain('disabled=""');
  });

  it('says so too when the identity read itself never landed', () => {
    const failed = draw({ signedInAs: 'Signed-in user unavailable' });
    expect(text(failed)).toContain('did not complete');
    expect(failed).toContain('Skip checks and continue');
  });
});

describe('the disclaimer', () => {
  it('renders verbatim in every state, with the source link', () => {
    const states = [
      draw(),
      draw({ session: session({ state: 'stale', missingScopes: ['sql'] }) }),
      draw({ session: session({ state: 'undetermined', tokenScopes: null }) }),
    ];
    for (const markup of states) {
      expect(text(markup)).toContain(DISCLAIMER_BODY);
      expect(markup).toContain('Not official Databricks software');
      expect(markup).toContain('Source on GitHub');
      expect(markup).toContain(SOURCE_URL);
    }
  });

  it('opens the source in a new tab without handing it this one', () => {
    expect(draw()).toContain('rel="noreferrer noopener"');
  });
});

describe('once per session', () => {
  beforeEach(forgetFirstOpen);

  it('uses the shared dialog without an Escape or backdrop dismissal', () => {
    expect(GATE).toContain("import { Dialog } from './Dialog'");
    expect(GATE).toContain('dismissOnEscape={false}');
    expect(GATE).toContain('dismissOnBackdrop={false}');
    expect(GATE).toContain('describedBy="first-open-description"');
  });

  /*
   * On first open the OPENING SEQUENCE is what the reader meets, and the card
   * follows it at 60% (`#19a`, `loading-suite.md`). This run has no DOM and no
   * effects, so it sees the sequence's first frame: the night sky, and no card.
   *
   * The card being absent rather than present-and-invisible is the claim worth
   * holding. The design reference draws it at `opacity: 0` from the first frame
   * because it is a demo loop; a login dialog rendered invisible is still in the
   * tab order and still read out, so a reader on a keyboard would be moving
   * through a card nobody can see.
   */
  it('opens directly on the card once startup has resolved identity', () => {
    const opening = renderToStaticMarkup(<FirstOpenGate identity={identity()} />);
    expect(opening).not.toContain('ast-opening');
    expect(opening).toContain('You are signing in as');
    expect(opening).toContain('role="dialog"');
    expect(opening).toContain('class="first-open-card ast-login-panel ast-dialog-panel"');
    expect(opening).toContain('tabindex="-1"');
    expect(GATE).toContain('contentClassName="first-open-card ast-login-panel"');
    expect(GATE).not.toContain('initialFocusRef=');
  });

  it('keeps the same neutral outer-panel class while authorization is loading', () => {
    const loading = renderToStaticMarkup(
      <FirstOpenPanel
        report={firstOpenReport(identity())}
        onContinue={() => {}}
        onRefresh={() => {}}
        onSkip={() => {}}
        onAllowRequiredScopes={() => {}}
        onRequestScope={() => {}}
        preparing
      />
    );
    expect(loading).toContain('class="first-open-card ast-login-panel ast-dialog-panel"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Preparing Ask');
  });

  it('keeps the opening sequence populated to the right of the login card', () => {
    /*
     * The claim is right-third coverage on the first screen, and it is held
     * whichever element is drawing it. That matters now because the element
     * lives on Layout, not the gate: one `AppSky` for the session, and the
     * opening layer goes on top of it, so the connectors are `<line>` rather
     * than ConstellationField's `<path>`.
     *
     * The defect this guards is older than either drawing and is what the swap
     * revived: a connector sample taken in list order is all upper-left, and
     * the login screen comes out empty down its right-hand side.
     */
    const opening = firstPaint();
    const rightEdge = (OPENING_CONSTELLATION.width * 2) / 3;
    const starXs = [...opening.matchAll(/<circle[^>]*cx="([^"]+)"/g)].map((match) => Number(match[1]));
    const connectorXs = [
      ...[...opening.matchAll(/<path[^>]*d="M([\d.]+) [\d.]+ ([\d.]+) /g)].flatMap((match) => [
        Number(match[1]),
        Number(match[2]),
      ]),
      ...[...opening.matchAll(/<line[^>]*x1="([\d.]+)"[^>]*x2="([\d.]+)"/g)].flatMap((match) => [
        Number(match[1]),
        Number(match[2]),
      ]),
    ];

    expect(starXs.some((x) => x > rightEdge)).toBe(true);
    expect(connectorXs.length, 'the first screen draws connectors at all').toBeGreaterThan(0);
    expect(connectorXs.some((x) => x > rightEdge)).toBe(true);
  });

  it('keeps the modal independent from the application sky', () => {
    const opening = renderToStaticMarkup(<FirstOpenGate identity={identity()} />);
    expect(opening).not.toContain('data-star-motion-field');
    expect(opening).not.toContain('ast-opening');
    expect(code(GATE)).not.toContain('StarField');
  });

  it('leaves the resolving frame to the top-level startup loader', () => {
    expect(GATE).not.toContain('first-open-hold');
    expect(GATE).not.toContain('ConceptFlicker');
  });

  /*
   * The card itself, drawn directly. `FirstOpenPanel` is the half with no clock in
   * it, which is why the component is split: every claim about what the gate SAYS
   * is made against this, and the claims about WHEN it says it are made against
   * the sequence's own module.
   */
  it('draws the card once the sequence has handed over', () => {
    expect(draw()).toContain('You are signing in as');
  });

  /*
   * The dismissal itself needs a click, which this run cannot make. What it CAN
   * establish is the half that matters after a reload: once the session is
   * acknowledged, mounting the gate again renders nothing at all.
   */
  it('renders nothing once the session has been acknowledged', () => {
    acknowledgeFirstOpen(null);
    expect(renderToStaticMarkup(<FirstOpenGate identity={identity()} />)).toBe('');
  });

  /*
   * THE FLICKER, HELD AT THE POINT IT WAS INTRODUCED. This used to read "draws
   * nothing while the identity is still resolving", and drawing nothing is exactly
   * what put the Ask tab on screen for the second `/api/identity` takes and then
   * dropped a login gate over it. A resolving report is not a reason to draw
   * nothing; it is a reason to draw the backdrop and no card.
   */
  it('draws the backdrop, and no card, while the identity is still resolving', () => {
    const resolving = identity({ signedInAs: 'Resolving signed-in user\u2026' });
    const markup = renderToStaticMarkup(<FirstOpenGate identity={resolving} />);
    expect(markup).toBe('');
  });

  /* Continue writes the latch before it closes, or the card returns on reload. */
  it('records the acknowledgement from Continue', () => {
    // `leave` files the outcome and THEN starts the transition, which is the order
    // that matters: a reload during the 1.2s animation must land on the app rather
    // than on the gate again.
    expect(GATE).toContain('onContinue={leave(acknowledgeFirstOpen)}');
    expect(code(GATE)).toMatch(/const leave = \(record: \(\) => void\) => \(\) => \{\s*record\(\);/);
    // One button, wired to whichever handler the verdict calls for. See the Skip
    // note at the top of the component for why it is one and not two.
    expect(GATE).toContain('onClick={showSkip ? onSkip : onContinue}');
  });

  /*
   * Two reads of `/api/identity` are two answers that can disagree, and a card
   * contradicting the header is worse than no card. Refresh reloads instead.
   */
  it('does not read the identity endpoint a second time', () => {
    expect(GATE).not.toContain("fetch('/api/identity')");
    expect(GATE).toContain('window.location.reload()');
  });

  /* Skip files the honest outcome before it closes, same as Continue. */
  it('records the skip from the Skip control', () => {
    expect(GATE).toContain('onSkip={leave(skipFirstOpenChecks)}');
  });
});

/**
 * THE CUSTOMER COMMITMENT, held here so a convenience cannot quietly undo it.
 *
 * This app must never read governed data as itself. Three service-principal
 * fallback paths were removed at the customer's explicit request, and the one
 * that remains in the tree belongs to the separate, switched-off `AccessGate`:
 * `POST /api/access-mode` with `{"mode":"service-principal"}`, which is the only
 * call in this codebase that can move execution off the signed-in person.
 *
 * Skip is the obvious place for that to come back. It is the control somebody
 * reaches for when a scope check is failing, which is exactly the moment "just
 * proceed as the app" looks like a helpful idea. It is not one: it would answer
 * questions under an identity the reader did not ask for, with grants they do not
 * hold, and it would do it silently.
 *
 * So the assertions are about what Skip CANNOT do. They are deliberately
 * source-level: a click cannot be made in this run, and the property being
 * protected is the absence of a call rather than the result of one.
 */
describe('skipping the checks does not change whose identity the app uses', () => {
  beforeEach(forgetFirstOpen);

  it('reaches no route that could move execution onto the app service principal', () => {
    for (const source of [code(GATE), code(STATE)]) {
      expect(source).not.toContain('/api/access-mode');
      expect(source).not.toContain('/api/access-verification');
      expect(source).not.toContain('service-principal');
      expect(source).not.toContain('app_service_principal');
    }
    // The scope-update button has a fetch; the skip recorder remains entirely
    // local and is still wired directly to the skip handler.
    expect(code(STATE)).not.toContain('fetch(');
    expect(GATE).toContain('onSkip={leave(skipFirstOpenChecks)}');
  });

  it('records that the checks were skipped, which is a different fact from passed', () => {
    const skipped = store();
    skipFirstOpenChecks(skipped);
    expect(firstOpenOutcome(skipped)).toBe('skipped');
    // The card is got past -- that is the point of the control -- but what is on
    // record about the scopes is not that they were satisfied.
    expect(firstOpenAcknowledged(skipped)).toBe(true);

    forgetFirstOpen();
    const passed = store();
    acknowledgeFirstOpen(passed);
    expect(firstOpenOutcome(passed)).toBe('passed');
  });

  it('never lets a dismissal alone be read as a pass', () => {
    // The trap: a session dismissed with only the latch written. Nothing may
    // infer an outcome from it, so the outcome reads as unknown rather than as
    // the optimistic answer.
    const bare = store();
    bare.data[FIRST_OPEN_KEY] = 'true';
    expect(firstOpenAcknowledged(bare)).toBe(true);
    expect(firstOpenOutcome(bare)).toBeNull();
    // And junk in the outcome key is not a pass either.
    bare.data[FIRST_OPEN_OUTCOME_KEY] = 'verified';
    expect(firstOpenOutcome(bare)).toBeNull();
  });

  it('leaves every unsatisfied scope reading exactly as it did before', () => {
    // The report is a pure function of the identity payload, so skipping cannot
    // make a later failure quieter or harder to diagnose: the shortfall is still
    // a shortfall, still named, and the Connections page reads the same source.
    const stale = identity({ session: session({ state: 'stale', missingScopes: ['dashboards.genie'] }) });
    const before = firstOpenReport(stale);
    skipFirstOpenChecks(store());
    const after = firstOpenReport(stale);

    expect(after).toEqual(before);
    expect(after.verdict).toBe('missing');
    expect(after.missing).toEqual(['dashboards.genie']);
    expect(after.scopes.find((row) => row.name === 'dashboards.genie')?.status).toBe('missing');
    expect(after.scopes.some((row) => row.status === 'granted' && row.name === 'dashboards.genie')).toBe(false);
  });
});
