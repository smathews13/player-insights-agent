import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IdentityCard } from './IdentityPanel';
import {
  questionsRunAs,
  type DeploymentIdentity,
  type PanelIdentity,
} from './identity-panel-state';

/**
 * The Identity card as it is composed, rather than as its source reads.
 *
 * This file exists for one reviewer comment. The card was read on a live
 * deployment as `Connected as  not reported · questions run as the signed-in
 * user`, over a title reading "Identity and permissions" and a sentence
 * beginning "Which service principals this deployment is connected as". The
 * verdict was that it was garbage text: somebody who opens this card is
 * checking their own permissions, and every one of those strings spent their
 * attention telling them something they already knew.
 *
 * So the assertions below are mostly NEGATIVE, and they name the exact strings
 * that were on screen. A card that reads well today is not the thing being
 * protected -- what is being protected is that these particular sentences
 * cannot come back without failing here rather than on a deployment.
 *
 * `renderToStaticMarkup` runs no effects, which is why the card takes its read
 * as a parameter. That is also the arrangement the page uses, so what is
 * asserted here is what the page draws.
 */
const IDENTITY: PanelIdentity = {
  signedInAs: 'someone@example.com',
  identitySource: 'databricks-apps',
  executionIdentity: 'abcdefab-0000-4000-8000-000000000000',
  executionMode: 'signed_in_user',
  session: {
    state: 'current',
    signedIn: true,
    tokenScopes: ['sql'],
    declaredScopes: ['sql'],
    missingScopes: [],
    cause: 'session-current',
    evidence: 'The presented token lists sql, which is what this deployment declares.',
    explanation: 'A user access token reached the app.',
    remedy: null,
  },
  analyticalExecution: { mode: 'signed_in_user', verified: true },
};

const SIGNED_IN: DeploymentIdentity = { identity: IDENTITY, failed: false };

/** The markup with its tags removed, which is roughly what a reader is handed. */
function textOf(read: DeploymentIdentity, remedyStatedElsewhere = false): string {
  return renderToStaticMarkup(<IdentityCard read={read} remedyStatedElsewhere={remedyStatedElsewhere} />)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A sign-in short of a required ask-path permission. */
const SHORT_OF_A_PERMISSION: DeploymentIdentity = {
  identity: {
    ...IDENTITY,
    session: {
      ...IDENTITY.session!,
      state: 'stale',
      tokenScopes: ['sql'],
      declaredScopes: ['sql', 'dashboards.genie'],
      missingScopes: ['dashboards.genie'],
    },
  },
  failed: false,
};

describe('IdentityCard', () => {
  it('names the account the app is holding, rather than describing it', () => {
    expect(textOf(SIGNED_IN)).toContain('someone');
  });

  it('prints none of the sentences the card was rebuilt to stop printing', () => {
    const text = textOf(SIGNED_IN);
    expect(text).not.toMatch(/not reported/i);
    expect(text).not.toMatch(/questions run as the signed-in user/i);
    expect(text).not.toMatch(/identity and permissions/i);
    expect(text).not.toMatch(/which service principals this deployment is connected as/i);
    expect(text).not.toMatch(/dependency checks and your own access are separate/i);
  });

  /**
   * THE REMEDY IN `scope-refusal.ts` NAMES THIS CARD. Three of its branches end
   * "The Connected as section of the Connections page lists what your sign-in
   * carries and what this app asks for", so a reader following a 403 arrives here
   * looking for the shortfall. It must be findable.
   *
   * It is now the DIFFERENCE and not the two lists. Both in full was twenty-six
   * monospace chips on a card about two identifiers, and it asked the reader to
   * do by eye a subtraction the server publishes: `missingScopes`. So the carried
   * permission the app does not ask for is gone from the screen, and the declared
   * permission the sign-in lacks -- the only one that explains a 403 -- is on it.
   */
  it('names the permission the sign-in is short of, without printing both lists', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'stale',
          tokenScopes: ['sql'],
          declaredScopes: ['sql', 'dashboards.genie'],
          missingScopes: ['dashboards.genie'],
        },
      },
      failed: false,
    });
    expect(text).toContain('Missing permissions');
    expect(text).toContain('dashboards.genie');
    expect(text).not.toContain('Sign-in carries');
    expect(text).not.toContain('App asks for');
  });

  it('always lists optional catalog permissions, even when undeclared', () => {
    const text = textOf(SIGNED_IN);
    expect(text).toContain('Optional permissions');
    expect(text).toContain('catalog.tables:read');
    expect(text).toContain('catalog.schemas:read');
    expect(text).toContain('catalog.catalogs:read');
  });

  it('marks a declared permission the sign-in does not carry, in words as well as colour', () => {
    const markup = renderToStaticMarkup(
      <IdentityCard
        read={{
          identity: {
            ...IDENTITY,
            session: {
              ...IDENTITY.session!,
              state: 'stale',
              declaredScopes: ['sql', 'dashboards.genie'],
              missingScopes: ['dashboards.genie'],
            },
          },
          failed: false,
        }}
      />
    );
    expect(markup).toMatch(/dashboards\.genie\. This sign-in does not carry it\./);
    expect(markup).not.toMatch(/[—–]/);
    expect(markup).toMatch(/data-absent="true"/);
  });

  it('tells a reader whose sign-in is short of a declared permission to sign in again', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'stale',
          tokenScopes: ['sql'],
          declaredScopes: ['sql', 'dashboards.genie'],
          missingScopes: ['dashboards.genie'],
        },
      },
      failed: false,
    });
    expect(text).toContain('Open this app again in a private browsing window, and sign in there.');
    expect(text).not.toContain('does not carry a permission the app asks for');
    expect(text).not.toContain('Signing out of Databricks does not clear');
  });

  it('leaves the sign-in line to What to fix when that panel is on screen', () => {
    const withPanel = textOf(SHORT_OF_A_PERMISSION, true);
    expect(withPanel).not.toMatch(/private browsing window/i);
    expect(withPanel).toContain('Missing permissions');
    expect(withPanel).toContain('dashboards.genie');
  });

  it('says the sign-in line itself when nothing is blocked, so no panel renders', () => {
    const alone = textOf(SHORT_OF_A_PERMISSION, false);
    expect(alone).toContain('Open this app again in a private browsing window, and sign in there.');
    expect(alone).toContain('Missing permissions');
  });

  it('does not push a private window for optional catalog shortfalls alone', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'stale',
          tokenScopes: ['sql'],
          declaredScopes: ['sql', 'catalog.tables:read'],
          missingScopes: ['catalog.tables:read'],
        },
      },
      failed: false,
    });
    expect(text).not.toMatch(/private browsing window/i);
    expect(text).not.toContain('Missing permissions');
    expect(text).toContain('Optional permissions');
    expect(text).toContain('catalog.tables:read');
  });

  /**
   * THE FAILURE MODE THIS WHOLE FEATURE IS DESIGNED AGAINST. This reader carries
   * every permission the app declares; the workspace refused the OBJECT, which
   * is a grant an admin adds. A private window would hand them the same
   * permissions and the same 403, so offering one sends them round the loop the
   * sign-in prompt exists to end. The row that reported the refusal says what is
   * actually needed; this card must stay quiet.
   */
  it('offers no sign-in to a reader who lacks a grant rather than a permission', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'current',
          tokenScopes: ['sql', 'unity-catalog'],
          declaredScopes: ['sql', 'catalog.tables:read'],
          missingScopes: [],
        },
      },
      failed: false,
    });
    expect(text).not.toMatch(/private browsing window/i);
    expect(text).not.toMatch(/sign in there/i);
  });

  it('offers no sign-in when nothing about the sign-in could be established', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'undetermined',
          tokenScopes: null,
          declaredScopes: null,
          missingScopes: [],
        },
      },
      failed: false,
    });
    expect(text).not.toMatch(/private browsing window/i);
  });

  it('says nothing about permissions when the sign-in stated none', () => {
    // A null list is a sign-in that enumerated nothing, which the badge already
    // reports. An empty row here would read as a sign-in carrying nothing.
    const text = textOf({
      identity: { ...IDENTITY, session: { ...IDENTITY.session!, tokenScopes: null } },
      failed: false,
    });
    expect(text).not.toContain('Sign-in carries');
  });

  it('carries the app OAuth badge, and only the one badge', () => {
    const markup = renderToStaticMarkup(<IdentityCard read={SIGNED_IN} />);
    // The shared badge from `oauth-badge.ts`. A badge invented for this card
    // would be a second opinion about a question one module already answers,
    // which is how a green chip and a red chip came to sit on one screen making
    // opposite claims about one sign-in.
    expect(markup).toContain('data-testid="oauth-badge"');
    expect(markup.match(/data-testid="oauth-badge"/g)).toHaveLength(1);
  });

  it('says the client id is missing rather than leaving the row blank', () => {
    // The absence is the finding: an app with no client id in its environment
    // cannot authenticate its own writes. A gap beside the label would read as
    // a rendering bug instead.
    expect(textOf({ identity: { ...IDENTITY, executionIdentity: '' }, failed: false })).toContain('not set');
  });

  it('reports a failed read as unreadable, not as nothing being connected', () => {
    const text = textOf({ identity: null, failed: true });
    expect(text).toContain('could not be read');
    // And says it in a chip rather than the four-sentence recovery instruction
    // it replaced, which told a reader to reload the page.
    expect(text).not.toMatch(/reload|try again|refresh the page/i);
    expect(text).not.toContain('someone@example.com');
  });

  it('draws no row for a principal it was not given, rather than an empty one', () => {
    const text = textOf({ identity: { ...IDENTITY, signedInAs: '' }, failed: false });
    expect(text).not.toContain('Questions run as');
  });
});

/**
 * Whose grants the next question would be computed with.
 *
 * The mode string itself is an internal identifier and is never printed: this
 * row is read by somebody deciding whether an answer could have been computed
 * with grants they do not hold, and `app_service_principal` is not an answer to
 * that question.
 */
describe('questionsRunAs', () => {
  it("names the app's own client id where the app is what executes", () => {
    expect(
      questionsRunAs({ ...IDENTITY, analyticalExecution: { mode: 'app_service_principal', verified: true } }),
    ).toBe('abcdefab-0000-4000-8000-000000000000');
  });

  it('names the reader where on-behalf-of execution is what that mode means', () => {
    expect(questionsRunAs(IDENTITY)).toBe('someone@example.com');
  });

  it('never prints the internal mode string at a reader', () => {
    for (const mode of ['signed_in_user', 'app_service_principal', 'on_behalf_of_group']) {
      expect(questionsRunAs({ ...IDENTITY, analyticalExecution: { mode, verified: true } })).not.toContain('_');
    }
  });

  it('returns nothing at all when there is no identity, so no row is drawn', () => {
    expect(questionsRunAs(null)).toBe('');
  });
});
