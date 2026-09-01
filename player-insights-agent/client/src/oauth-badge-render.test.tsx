/**
 * The header's OAuth badge: which state it draws, and what each state claims.
 *
 * THE ASSERTIONS THIS FILE EXISTS FOR ARE THE TWO WAYS A STATUS BADGE LIES.
 * Saying yes when nothing was established -- a signed-in reader with no report
 * going green -- and saying no about something it did not establish. The second
 * is why the badge was rewired: it went red on a token that was short of a
 * declared scope, which authenticates perfectly well, and whose shortfall has two
 * possible causes that one token cannot tell apart. Red now means one thing, that
 * no OAuth sign-in reached the app, and the tests below pin the boundary in both
 * directions.
 *
 * PIXELS ARE NOT VERIFIED BY ANY OF THIS. It is markup, wording, the order in
 * the cluster and the rules in shell.css. Nothing here says the chip fits beside
 * the role badge at any particular width.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IdentityChips } from './Layout';
import { OAuthBadge } from './OAuthBadge';
import {
  OAUTH_BADGE_WORD,
  oauthBadgeAccessibleName,
  oauthBadgeLabel,
  oauthBadgeState,
  oauthBadgeTitle,
} from './oauth-badge';
import { HEADER_CLUSTER_ORDER, type RoleResolution } from './role';
import { IDENTITY_RESOLVING, IDENTITY_UNAVAILABLE } from './user-initials';
import type { Identity } from './app-types';
import type { SessionReport, SessionState } from '../../shared/session-contract';
import { partial } from './styles/stylesheet';

function report(state: SessionState, missing: string[] = []): SessionReport {
  return {
    state,
    cause: state === 'stale' ? 'token-lacks-declared-scope' : 'token-carries-every-declared-scope',
    evidence: 'evidence the server wrote',
    explanation: `the server's own sentence about a ${state} session`,
    remedy: null,
    signedIn: true,
    tokenScopes: ['sql', 'dashboards.genie'],
    declaredScopes: ['sql', 'dashboards.genie', ...missing],
    missingScopes: missing,
  };
}

/**
 * A sign-in that reached the app and states no scopes -- an opaque token doing
 * its job. `tokenScopes` is null and nothing failed.
 *
 * This used to stand for the absent sign-in as well, which is the conflation
 * `signedIn` removes: both left `tokenScopes` null, so one fixture served two
 * situations and the badge could only draw them the same colour.
 */
function unreadable(): SessionReport {
  return {
    state: 'undetermined',
    cause: 'undetermined',
    evidence: '',
    explanation: 'the server’s own sentence about a session it could not compare',
    remedy: null,
    signedIn: true,
    tokenScopes: null,
    declaredScopes: null,
    missingScopes: [],
  };
}

/** Nothing was forwarded at all, which is the other half of the old fixture. */
function notForwarded(): SessionReport {
  return { ...unreadable(), signedIn: false };
}

function identity(session?: SessionReport, signedInAs = 'someone@example.com'): Identity {
  return {
    signedInAs,
    // The deployed app, unless a test says otherwise: the development fallback is
    // the one state that is red, so it must never be the default here.
    identitySource: 'databricks-apps',
    executionMode: 'service-principal',
    ...(session ? { session } : {}),
  };
}

const ADMIN: RoleResolution = { state: 'admin', addedAdminsReadable: true };

/** The cluster the badges and the name share, at either width. */
function cluster(session?: SessionReport, className?: string): string {
  return renderToStaticMarkup(
    <IdentityChips identity={identity(session)} role={ADMIN} className={className} />
  );
}

function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** One rule's body from shell.css, by exact selector. */
function rule(selector: string, css: string = partial('shell.css')) {
  const stripped = withoutComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return stripped.match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

describe('what the badge is actually reporting', () => {
  it('goes green when the server shows it read the sign-in this browser presented', () => {
    // `tokenScopes` is the positive fact: the app was handed a sign-in and could
    // see what it lists. That is what the badge claims, and all it claims.
    expect(oauthBadgeState(identity(report('current')))).toBe('working');
  });

  it('stays green on a stale session, whose shortfall is not an authentication failure', () => {
    // The case that used to be red, and the reason it is not. A token short of a
    // declared scope authenticates fine; the shortfall may equally mean the app
    // was never restarted after the scope was added. Red said the sign-in itself
    // had failed, which is a different and wrong claim. Where the shortfall IS
    // reported is the Connections row for the dependency that refused.
    expect(oauthBadgeState(identity(report('stale', ['catalog.tables:read'])))).toBe('working');
  });

  it('goes red when no OAuth sign-in reached the app at all', () => {
    // The one unambiguous authentication failure this payload carries. On a laptop
    // it is expected and true; on the deployed app it means the platform stopped
    // forwarding the signed-in user, and every user-token path is dead.
    const local: Identity = { ...identity(report('current')), identitySource: 'development-fallback' };
    expect(oauthBadgeState(local)).toBe('not-working');
  });

  it('does not call a signed-in reader green just for being signed in', () => {
    // The whole failure mode in one assertion. An identity with a name and no
    // session report is a server that never reported one, and a badge that reads
    // silence as success is confidently wrong in the one case somebody would look
    // at it.
    expect(oauthBadgeState(identity())).toBe('unknown');
  });

  it('stays neutral for a sign-in that reached the app and states no scopes', () => {
    // An opaque token working exactly as intended. Nothing failed, and nothing
    // about what it carries was established, so neither colour is earned.
    expect(oauthBadgeState(identity(unreadable()))).toBe('unknown');
  });

  it('goes red when nothing was forwarded, which used to arrive as the same grey', () => {
    // The two cases are identical in every other field -- `tokenScopes` is null
    // for both -- so this pair is the whole point of `signedIn`. On the deployed
    // app this one means the platform stopped forwarding the signed-in user.
    expect(oauthBadgeState(identity(notForwarded()))).toBe('not-working');
    expect(oauthBadgeState(identity(unreadable()))).toBe('unknown');
  });

  it('says nothing at all while the identity read is in flight', () => {
    // Not unknown, which is a finding. This is the absence of one.
    expect(oauthBadgeState(identity(undefined, IDENTITY_RESOLVING))).toBe('resolving');
    expect(oauthBadgeState(null)).toBe('resolving');
    expect(oauthBadgeLabel('resolving')).toBe('');
    expect(oauthBadgeAccessibleName('resolving')).toBe('');
  });

  it('treats an identity read that failed as unknown rather than as resolving', () => {
    // A read that gave up has established nothing, and the badge must stop
    // holding an empty placeholder open for an answer that is not coming.
    expect(oauthBadgeState(identity(undefined, IDENTITY_UNAVAILABLE))).toBe('unknown');
  });
});

describe('the words, and whose they are', () => {
  it('quotes the server rather than paraphrasing it', () => {
    // The explanation is written next to the evidence that produced it and is
    // held against that evidence by shared/stated-cause.ts. A reworded copy in
    // the client is a sentence nothing audits, which is how the app once told
    // somebody four things to do, three of them already done.
    const stale = report('stale', ['catalog.tables:read']);
    expect(oauthBadgeTitle(identity(stale))).toBe(stale.explanation);
    expect(oauthBadgeTitle(identity(report('current')))).toBe(report('current').explanation);
  });

  it('supplies its own sentence only where the server supplied none', () => {
    const title = oauthBadgeTitle(identity());
    expect(title).not.toEqual('');
    expect(title).toMatch(/unknown/);
    // And it stays silent while resolving, because `title=""` is a tooltip that
    // flashes empty.
    expect(oauthBadgeTitle(identity(undefined, IDENTITY_RESOLVING))).toEqual('');
  });

  it('says the same word in every drawn state and puts the state in the name', () => {
    // The handoff's design: the colour and the mark carry the state, so the same
    // badge can sit against a different row on the Connections identity card. An
    // accessible name of "OAuth" would announce the label and drop the fact.
    for (const state of ['working', 'not-working', 'unknown'] as const) {
      expect(oauthBadgeLabel(state)).toBe('OAuth');
      expect(oauthBadgeAccessibleName(state)).toMatch(/OAuth sign-in/);
    }
    const names = new Set(
      (['working', 'not-working', 'unknown'] as const).map(oauthBadgeAccessibleName)
    );
    expect(names.size).toBe(3);
  });

  it('derives nothing of its own in the component', () => {
    // Same rule RoleBadge follows. A fetch or a second reading of the session
    // here would be a second answer to a question the server answers once.
    const source = readFileSync(new URL('OAuthBadge.tsx', import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      ' '
    );
    expect(source).not.toMatch(/fetch\(|useIdentity|sessionFreshness/);
  });
});

describe('where it sits, which is no longer the top bar', () => {
  it('is not in the header cluster, at either width', () => {
    // §1 enumerates the chrome's right-hand side -- role chip, avatar, divider,
    // Built on Databricks -- and the sign-in badge is not in it. In the header it
    // answered a question nobody had asked, in the row that also has to hold the
    // navigation.
    expect(cluster(report('current'))).not.toContain('data-testid="oauth-badge"');
    expect(cluster(report('current'), 'mobile-identity')).not.toContain('data-testid="oauth-badge"');
  });

  it('is still the component the two surfaces that ARE about the sign-in draw', () => {
    // MOVED, NOT DELETED, and the distinction is why this file is still here. The
    // login gate states the badge on the way in (`login-gate.md`, Identity block)
    // and the Connections identity card states it beside the address
    // (`design-spec-master.md` §8). Everything above this describe is about what
    // the badge may CLAIM, and that is unchanged by which surface draws it.
    const markup = renderToStaticMarkup(<OAuthBadge identity={identity(report('current'))} />);
    expect(markup).toContain('data-testid="oauth-badge"');
    expect(markup).toContain('OAuth');
  });

  it('is the order role.ts states, rather than one this file invented', () => {
    // The gear moved in front of the attribution rather than closing the header
    // from the far right. It used to sit past "Built on Databricks", which put a
    // control belonging to the reader on the far side of the divider whose job
    // (§1) is to separate the reader from who built the app.
    //
    // The release chip is no longer a member. It states which build is on screen
    // rather than anything about the reader, so it is seated beside the app's own
    // name; see the header brand tests in deployment-time-chip.test.tsx.
    expect(HEADER_CLUSTER_ORDER).toEqual([
      'role-badge',
      'identity-chip',
      'settings-gear',
      'built-on-databricks',
    ]);
    expect(HEADER_CLUSTER_ORDER).not.toContain('deployment-time');
  });

  it('is not flipped back by the stylesheet', () => {
    // The order comes from the markup, so an `order:` here would put what is
    // painted and what is read out into disagreement without touching a
    // component. `order:` and not `border:`, hence the anchor.
    const bodies = [
      ...withoutComments(partial('shell.css')).matchAll(/\.oauth-badge[^{]*\{([^}]*)\}/g),
    ].map((match) => match[1]);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toMatch(/(^|[;{\s])order\s*:/);
  });
});

describe('the three states are told apart by more than a hue', () => {
  it('paints working green and not-working red, from the one status recipe', () => {
    // The families rather than three rules of this badge's own: §2 allows the app
    // one status chip, and a second copy here was how this came to be the surface
    // that would not follow a repaint of the palette. The measured pairs are the
    // recipe's now, so the badge moves when they do.
    expect(renderToStaticMarkup(<OAuthBadge identity={identity(report('current'))} />)).toContain(
      'ast-pill--pos',
    );
    expect(renderToStaticMarkup(<OAuthBadge identity={identity(notForwarded())} />)).toContain(
      'ast-pill--neg',
    );
    const tokens = partial('astrolabe-tokens.css');
    expect(rule('.ast-pill--pos', tokens)).toMatch(/background:\s*var\(--ast-pos-fill\)/);
    expect(rule('.ast-pill--neg', tokens)).toMatch(/background:\s*var\(--ast-neg-fill\)/);
  });

  it('never paints unknown in the working state’s colours', () => {
    // The one styling rule that carries the honesty requirement: a state that
    // established nothing must not be able to look like the state that
    // established everything.
    const markup = renderToStaticMarkup(<OAuthBadge identity={identity(unreadable())} />);
    expect(markup).toContain('ast-pill--neutral');
    expect(markup).not.toContain('ast-pill--pos');
    expect(rule('.ast-pill--neutral', partial('astrolabe-tokens.css'))).not.toMatch(/pos|green/);
  });

  it('gives each drawn state a mark, so colour is not the only signal', () => {
    for (const session of [report('current'), report('stale', ['x']), unreadable()]) {
      const markup = renderToStaticMarkup(<OAuthBadge identity={identity(session)} />);
      expect(markup).toMatch(/<svg/);
    }
  });

  it('reserves the resolving chip’s width with content rather than a measured number', () => {
    // THE CLUSTER MUST NOT SHIFT WHEN THE IDENTITY READ LANDS, and this used to be
    // held by `width: 62px; height: 22px` -- correct once, against a 12px chip,
    // and falsified the moment the badge took the 11px pill recipe. Re-measuring
    // it would have needed a browser this project does not run.
    //
    // So the box now holds a mark and the word, made invisible. It is exactly as
    // wide as whatever replaces it at any type size, and there is no number left
    // to go stale.
    const resolving = renderToStaticMarkup(<OAuthBadge identity={identity(undefined, IDENTITY_RESOLVING)} />);
    expect(resolving).toContain('oauth-badge-reserve');
    expect(resolving).toContain(OAUTH_BADGE_WORD);
    expect(resolving).toMatch(/<svg/);
    // The word is imported rather than typed twice: a placeholder that stopped
    // matching what it holds room for is a shift nobody could see coming.
    expect(readFileSync(new URL('OAuthBadge.tsx', import.meta.url), 'utf8')).toContain('{OAUTH_BADGE_WORD}');
    // Neither the reader nor a screen reader gets any of it. `visibility: hidden`
    // rather than `opacity: 0` is what takes it out of the accessibility tree as
    // well as out of the paint; the badge is aria-hidden while resolving too.
    expect(rule('.oauth-badge-reserve')).toMatch(/visibility:\s*hidden/);
    expect(resolving).toContain('aria-hidden="true"');
    // And the spacer's own gap comes from the box it sits in, so it cannot come
    // to differ from the gap the drawn states are laid out with.
    expect(rule('.oauth-badge-reserve')).toMatch(/gap:\s*inherit/);
    expect(rule(".oauth-badge[data-oauth-state='resolving']")).not.toMatch(/width|height/);
  });
});
