import { describe, expect, it } from 'vitest';

import { SIGN_OUT_DOES_NOT_CLEAR, freshSignIn } from './fresh-sign-in';
import { staleSignInNotice } from './stale-sign-in';
import type { SessionReport } from './session-contract';

/**
 * When the app may tell somebody to sign in again, and the three neighbouring
 * states where it must not.
 *
 * A row on the Connections page can be red for three different reasons and only
 * ONE of them is fixed by a new sign-in. The tests below are mostly negative for
 * that reason: what is being protected is not that the sentence appears, it is
 * that it does not appear over the other two. A reader who genuinely lacks a
 * grant and is sent to a private browsing window has been sent round the exact
 * loop this module exists to end, and they will come back with the same 403 and
 * less patience.
 */

/** The healthy case, and the base every other case below is a departure from. */
const CURRENT: SessionReport = {
  state: 'current',
  cause: 'token-carries-every-declared-scope',
  evidence: 'The app declares 2 permissions and the sign-in carries both.',
  explanation: 'Your sign-in to this app carries every permission the app asks for.',
  remedy: null,
  signedIn: true,
  tokenScopes: ['sql', 'unity-catalog'],
  declaredScopes: ['sql', 'catalog.tables:read'],
  missingScopes: [],
};

describe('a session short of a permission the app declares', () => {
  /**
   * The case that cost several days. Five Connections rows read 403; they were
   * exactly the five most recently declared permissions, and the four that
   * stayed green were the ones the browser's sign-in already carried.
   */
  const STALE: SessionReport = {
    ...CURRENT,
    state: 'stale',
    cause: 'token-lacks-declared-scope',
    evidence: 'The app declares 2 permissions including `dashboards.genie`.',
    explanation: 'Your sign-in to this app does not carry `dashboards.genie`.',
    remedy: freshSignIn(),
    tokenScopes: ['sql'],
    declaredScopes: ['sql', 'dashboards.genie'],
    missingScopes: ['dashboards.genie'],
  };

  it('is offered a new sign-in, and names the permission it is short of', () => {
    const notice = staleSignInNotice(STALE);
    expect(notice).not.toBeNull();
    expect(notice?.missing).toEqual(['dashboards.genie']);
    expect(notice?.action).toContain('private browsing window');
  });

  it('ignores optional catalog shortfalls for the sign-in remedy', () => {
    expect(
      staleSignInNotice({
        ...STALE,
        missingScopes: ['catalog.tables:read', 'catalog.schemas:read'],
      })
    ).toBeNull();
    expect(
      staleSignInNotice({
        ...STALE,
        missingScopes: ['dashboards.genie', 'catalog.tables:read'],
      })?.missing
    ).toEqual(['dashboards.genie']);
  });

  /**
   * THE LINE THAT STOPS THE WRONG ACTION, and it is asserted to be the SAME
   * STRING the per-row remedy carries rather than merely to say something
   * similar. Two wordings of this fact is one wording too many: the version
   * that cost an afternoon told somebody to sign out of Databricks, which does
   * not clear this app's sign-in and never did.
   */
  it('carries the private-window line the rest of the app already states', () => {
    expect(staleSignInNotice(STALE)?.guidance).toBe(SIGN_OUT_DOES_NOT_CLEAR);
    expect(staleSignInNotice(STALE)?.guidance).toBe(freshSignIn().guidance);
  });

  it('says "a permission" at one and counts them past one', () => {
    // One is the likeliest case: a permission is usually added to the
    // declaration on its own, so a sign-in behind it is short of exactly that
    // one, and "does not carry 1 permissions" would be the commonest reading.
    expect(staleSignInNotice(STALE)?.lead).toContain('a permission');
    expect(staleSignInNotice(STALE)?.lead).not.toMatch(/\d/);
    const five = staleSignInNotice({
      ...STALE,
      missingScopes: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(five?.lead).toContain('5 permissions');
  });

  /**
   * The whole reason nothing here is written down. Declared scopes are read at
   * runtime from the deployment, and different targets have spelled the same
   * capability differently (with or without a `:read` suffix). A list in the
   * source would be wrong on whichever spelling it was not written for. Uses a
   * REQUIRED ask-path scope: Vector Search browse is optional for the login
   * gate (Sam 2026-08-18), so a VS-only shortfall returns null rather than a
   * notice, and cannot exercise this path.
   */
  it('reports whatever the deployment declared, in the deployment\u2019s own spelling', () => {
    const suffixed = staleSignInNotice({
      ...STALE,
      missingScopes: ['serving.serving-endpoints:read'],
    });
    expect(suffixed?.missing).toEqual(['serving.serving-endpoints:read']);
    const bare = staleSignInNotice({
      ...STALE,
      missingScopes: ['serving.serving-endpoints'],
    });
    expect(bare?.missing).toEqual(['serving.serving-endpoints']);
  });

  it('ignores optional Vector Search shortfalls for the sign-in remedy', () => {
    expect(
      staleSignInNotice({
        ...STALE,
        missingScopes: [
          'vectorsearch.vector-search-indexes:read',
          'vectorsearch.vector-search-endpoints:read',
        ],
      })
    ).toBeNull();
  });
});

describe('the states that must not produce a sign-in prompt', () => {
  /**
   * THE FAILURE MODE THIS IS DESIGNED AGAINST. The reader holds every
   * permission the app declares; the workspace refused the OBJECT. Their token
   * plainly lists the scope, so nothing is missing from it, and a private
   * window would hand them the same permissions and the same 403. What they
   * need is a GRANT, and the Connections row says so.
   */
  it('says nothing to a reader who lacks a grant rather than a permission', () => {
    expect(staleSignInNotice(CURRENT)).toBeNull();
    // And explicitly with the shape a grant refusal leaves behind: the scope is
    // declared, it is carried, and the missing list is therefore empty.
    expect(
      staleSignInNotice({
        ...CURRENT,
        tokenScopes: ['sql', 'unity-catalog'],
        declaredScopes: ['sql', 'catalog.tables:read'],
        missingScopes: [],
      })
    ).toBeNull();
  });

  it('says nothing when the app simply could not reach something', () => {
    // An unreachable dependency establishes nothing about the sign-in, so the
    // comparison is untouched and stays `current`. The row reports the
    // unreachability; this must not add a sign-in prompt underneath it.
    expect(staleSignInNotice(CURRENT)).toBeNull();
  });

  it('says nothing when everything the app asks for is carried', () => {
    expect(staleSignInNotice({ ...CURRENT, missingScopes: [] })).toBeNull();
  });

  /**
   * The three ways the comparison cannot be made: no forwarded sign-in, a token
   * that states no permissions, and a container never told what it declares.
   * Silence is the correct output. A confident wrong diagnosis here is worse
   * than the nothing it replaces.
   */
  it('says nothing when the comparison could not be made at all', () => {
    const undetermined: SessionReport = {
      state: 'undetermined',
      cause: 'undetermined',
      evidence: '',
      explanation: 'Nothing about your sign-in was established.',
      remedy: null,
      signedIn: true,
      tokenScopes: null,
      declaredScopes: null,
      missingScopes: [],
    };
    expect(staleSignInNotice(undetermined)).toBeNull();
    expect(staleSignInNotice({ ...undetermined, signedIn: false })).toBeNull();
    // A server too old to report a session at all, and a page that has not read
    // one yet. Both arrive as an absent report rather than a state.
    expect(staleSignInNotice(null)).toBeNull();
    expect(staleSignInNotice(undefined)).toBeNull();
  });

  /**
   * Fails closed. `stale` is only ever set alongside a forwarded sign-in today,
   * and this is the gate on a sentence that sends people somewhere, so a future
   * edit to the state machine should stop the prompt rather than start showing
   * it to readers whose sign-in was never compared against anything.
   */
  it('refuses to prompt on a stale verdict with nothing signed in behind it', () => {
    expect(
      staleSignInNotice({ ...CURRENT, state: 'stale', signedIn: false, missingScopes: ['sql'] })
    ).toBeNull();
    expect(staleSignInNotice({ ...CURRENT, state: 'stale', missingScopes: [] })).toBeNull();
  });
});
