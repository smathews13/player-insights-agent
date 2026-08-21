/**
 * What the login gate concludes, held against the identity payload it concludes
 * it from.
 *
 * The claim worth testing here is not the wording. It is that the card never
 * says a thing it was not shown: a scope is Granted only where the server's own
 * comparison ran and did not list it, and everything else lands on `unchecked`.
 * A silent slide from "could not be checked" to "fine" is the failure this
 * screen exists to prevent, and it is the one a reader cannot detect by looking.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { SessionReport, SessionState } from '../../shared/session-contract';
import type { Identity } from './app-types';
import {
  DISCLAIMER_BODY,
  DISCLAIMER_EMPHASIS,
  DISCLAIMER_TITLE,
  FIRST_OPEN_KEY,
  acknowledgeFirstOpen,
  disclaimerParts,
  firstOpenAcknowledged,
  firstOpenReport,
  forgetFirstOpen,
  missingFooter,
  offersRefresh,
  optionalScopeRows,
  requiredScopeRows,
  scopeRows,
  showsFirstOpen,
  type AcknowledgementStore,
} from './first-open';
import { OPTIONAL_USER_API_SCOPES } from '../../shared/optional-user-api-scopes';

/**
 * A representative declared set: the four load-bearing base scopes, WITHOUT the
 * optional catalog/workspace browse scopes. Kept deliberately free of the
 * optional names so the rows below prove that the signed-in token, not merely
 * the deployment declaration, decides their badges.
 */
const DECLARED = ['serving.serving-endpoints', 'model-serving', 'sql', 'dashboards.genie'];

function session(over: Partial<SessionReport> = {}): SessionReport {
  return {
    state: 'current' as SessionState,
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
    executionIdentity: 'jordan.lee@example.com',
    executionMode: 'user',
    identitySource: 'databricks-apps',
    session: session(),
    ...over,
  } as Identity;
}

describe('firstOpenReport', () => {
  it('draws nothing while the identity read is still in flight', () => {
    expect(firstOpenReport(null).verdict).toBe('resolving');
    expect(showsFirstOpen(firstOpenReport(null))).toBe(false);
  });

  it('reports every declared scope granted when none is missing', () => {
    const report = firstOpenReport(identity());
    expect(report.verdict).toBe('granted');
    expect(report.oauthVerified).toBe(true);
    expect(report.signedInAs).toBe('jordan.lee@example.com');
    expect(requiredScopeRows(report.scopes).map((s) => s.status)).toEqual([
      'granted',
      'granted',
      'granted',
      'granted',
    ]);
    expect(optionalScopeRows(report.scopes).every((s) => s.status === 'not_declared')).toBe(true);
    expect(report.footer).toBeNull();
    expect(offersRefresh(report)).toBe(false);
  });

  it('never reports zero required scopes for a normal Astrolabe deployment', () => {
    const report = firstOpenReport(identity());

    expect(requiredScopeRows(report.scopes).map((scope) => scope.name)).toEqual(DECLARED);
    expect(report.footer?.lead ?? '').not.toContain(
      'This deployment does not declare any required scopes.'
    );
    expect(optionalScopeRows(report.scopes).map((scope) => scope.name)).toEqual([
      ...OPTIONAL_USER_API_SCOPES,
    ]);
  });

  /*
   * Required names are read from the deployment; optional catalog scopes are
   * always appended so a customer four-scope deploy still lists them.
   */
  it('lists declared scopes first, then optional catalog scopes not on the deploy', () => {
    const declared = ['alpha.one', 'beta.two:read', 'gamma.three'];
    const report = firstOpenReport(
      identity({ session: session({ declaredScopes: declared, tokenScopes: declared }) })
    );
    expect(report.scopes.map((s) => s.name)).toEqual([...declared, ...OPTIONAL_USER_API_SCOPES]);
  });

  it('marks undeclared optional scopes granted when the effective token carries them', () => {
    const report = firstOpenReport(
      identity({
        session: session({
          tokenScopes: [
            ...DECLARED,
            'unity-catalog',
            'workspace',
            'vector-search',
            'postgres',
          ],
        }),
      })
    );

    expect(optionalScopeRows(report.scopes).map((scope) => scope.status)).toEqual(
      OPTIONAL_USER_API_SCOPES.map(() => 'granted')
    );
  });

  it('marks undeclared optional scopes not requested when the effective token does not carry them', () => {
    const report = firstOpenReport(identity());

    expect(optionalScopeRows(report.scopes).map((scope) => scope.status)).toEqual(
      OPTIONAL_USER_API_SCOPES.map(() => 'not_declared')
    );
  });

  it('distinguishes Lakebase requested-but-not-granted from not requested', () => {
    const name = 'postgres';
    const requested = firstOpenReport(
      identity({
        session: session({
          state: 'stale',
          declaredScopes: [...DECLARED, name],
          tokenScopes: DECLARED,
          missingScopes: [name],
        }),
      })
    );
    const notRequested = firstOpenReport(identity());

    expect(requested.scopes.find((scope) => scope.name === name)?.status).toBe('missing');
    expect(notRequested.scopes.find((scope) => scope.name === name)?.status).toBe('not_declared');
  });

  it('treats hostile scope payload values as unreadable instead of rendering or throwing', () => {
    const hostile = identity({
      session: {
        ...session(),
        declaredScopes: ['sql', { toString: () => 'postgres' }, '', '<script>'],
        tokenScopes: ['sql', null, 42],
        missingScopes: 'postgres',
      } as unknown as SessionReport,
    });

    expect(() => firstOpenReport(hostile)).not.toThrow();
    const report = firstOpenReport(hostile);
    expect(report.scopes.some((scope) => scope.name === 'postgres')).toBe(true);
    expect(report.scopes.some((scope) => scope.name === '[object Object]')).toBe(false);
  });

  it('reports the Git-deploy workspace scope from the signed-in token', () => {
    const name = 'workspace.workspace:read';
    const granted = firstOpenReport(
      identity({
        session: session({
          declaredScopes: [...DECLARED, name],
          tokenScopes: [...DECLARED, 'workspace'],
        }),
      })
    );
    const missing = firstOpenReport(
      identity({
        session: session({
          state: 'stale',
          declaredScopes: [...DECLARED, name],
          tokenScopes: DECLARED,
          missingScopes: [name],
        }),
      })
    );

    expect(granted.scopes.find((scope) => scope.name === name)?.status).toBe('granted');
    expect(missing.scopes.find((scope) => scope.name === name)?.status).toBe('missing');
    expect(missing.verdict).toBe('granted');
  });

  it('does not fail the gate when only optional catalog scopes are missing', () => {
    const report = firstOpenReport(
      identity({
        session: session({
          state: 'stale',
          declaredScopes: [...DECLARED, 'catalog.tables:read'],
          tokenScopes: DECLARED,
          missingScopes: ['catalog.tables:read'],
        }),
      })
    );
    expect(report.verdict).toBe('granted');
    expect(report.missing).toEqual([]);
    expect(report.footer).toBeNull();
    expect(report.scopes.find((s) => s.name === 'catalog.tables:read')?.status).toBe('missing');
    expect(report.scopes.find((s) => s.name === 'catalog.tables:read')?.optional).toBe(true);
  });

  it('marks only the scopes the server listed as missing, and states the fix', () => {
    const report = firstOpenReport(
      identity({ session: session({ state: 'stale', missingScopes: ['sql', 'dashboards.genie'] }) })
    );
    expect(report.verdict).toBe('missing');
    expect(report.missing).toEqual(['sql', 'dashboards.genie']);
    const byName = Object.fromEntries(report.scopes.map((s) => [s.name, s.status]));
    expect(byName['sql']).toBe('missing');
    expect(byName['dashboards.genie']).toBe('missing');
    expect(byName['model-serving']).toBe('granted');
    // NOT the names. Every one of them is a row above this footer with a Missing
    // badge against it, and the prose repeating them ran the card off a laptop
    // viewport. The count carries the finding; the rows carry which.
    expect(report.footer?.scopes).toEqual([]);
    expect(report.footer?.lead).toContain('2 permissions');
    expect(report.footer?.lead).not.toContain('sql');
    expect(report.footer?.lead).not.toContain('dashboards.genie');
  });

  /**
   * IT DOES NOT SEND THE READER TO THEIR ADMIN, and this is the assertion that
   * stops the spec's wording coming back. The footer said "Ask your workspace
   * admin to add `x` to the app's OAuth configuration", which cannot be right:
   * `missing` is the app's own declaration minus what the sign-in carries, so
   * every name in it is ALREADY in the app's OAuth configuration and the admin
   * has nothing to add. The reader had the fix in their own browser while five
   * red rows and this card sent them elsewhere for several days.
   */
  it('sends the reader to a new sign-in rather than to their workspace admin', () => {
    const report = firstOpenReport(
      identity({ session: session({ state: 'stale', missingScopes: ['sql'] }) })
    );
    expect(report.footer?.tail).toContain('private browsing window');
    expect(report.footer?.tail).toContain('Signing out of Databricks does not clear');
    expect(report.footer?.tail).not.toMatch(/workspace admin/i);
    expect(report.footer?.lead).not.toMatch(/workspace admin/i);
  });

  it('says one scope in the singular', () => {
    const one = missingFooter({
      missing: ['sql'],
      lead: 'Your sign-in to this app does not carry a permission the app asks for:',
      summary: 'Your sign-in does not carry a permission the app asks for.',
      action: 'x',
      guidance: 'y',
    });
    expect(one.lead).toContain('a permission');
    expect(one.lead).not.toMatch(/\d/);
  });

  /* --- the states that must not claim anything ---------------------------- */

  it('says the check did not complete when the server reported no session', () => {
    const report = firstOpenReport(identity({ session: undefined }));
    expect(report.verdict).toBe('unchecked');
    expect(report.footer?.lead).toContain('did not complete');
    expect(offersRefresh(report)).toBe(true);
  });

  it('says so when the comparison could not be made, and grants nothing', () => {
    const report = firstOpenReport(
      identity({ session: session({ state: 'undetermined', tokenScopes: null }) })
    );
    expect(report.verdict).toBe('unchecked');
    expect(requiredScopeRows(report.scopes).every((s) => s.status === 'unchecked')).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.footer?.lead).toContain('could not be read');
  });

  it('says so when no sign-in was forwarded at all', () => {
    const report = firstOpenReport(identity({ session: session({ signedIn: false, tokenScopes: null }) }));
    expect(report.verdict).toBe('unchecked');
    expect(report.oauthVerified).toBe(false);
  });

  it('says so when the identity read itself failed', () => {
    const report = firstOpenReport(identity({ signedInAs: 'Signed-in user unavailable' }));
    expect(report.verdict).toBe('unchecked');
    expect(report.scopes).toEqual([]);
  });

  it('says so when the address is the local stand-in rather than a person', () => {
    const report = firstOpenReport(identity({ identitySource: 'development-fallback' }));
    expect(report.verdict).toBe('unchecked');
    expect(report.footer?.lead).toContain('No Databricks sign-in');
  });

  it('does not report a shortfall where the deployment declares nothing', () => {
    const report = firstOpenReport(
      identity({ session: session({ declaredScopes: null, missingScopes: [] }) })
    );
    expect(report.verdict).toBe('unchecked');
    expect(report.footer?.lead).toContain('does not declare');
  });
});

describe('scopeRows', () => {
  it('reports nothing as granted when the check did not run', () => {
    expect(scopeRows(['a', 'b'], [], false).every((r) => r.status === 'unchecked')).toBe(true);
  });

  it('still lists optional catalog scopes when nothing was declared', () => {
    const rows = scopeRows(null, [], true);
    expect(rows.map((r) => r.name)).toEqual([...OPTIONAL_USER_API_SCOPES]);
    expect(rows.every((r) => r.optional && r.status === 'not_declared')).toBe(true);
  });

  it('uses the deployment declaration to distinguish not requested', () => {
    const rows = scopeRows(null, [], true, ['sql']);
    expect(rows.every((r) => r.optional && r.status === 'not_declared')).toBe(true);
  });
});

describe('the disclaimer', () => {
  it('reassembles to the quoted paragraph exactly', () => {
    const { before, emphasis, after } = disclaimerParts();
    expect(before + emphasis + after).toBe(DISCLAIMER_BODY);
    expect(emphasis).toBe(DISCLAIMER_EMPHASIS);
  });

  it('carries the spec capitalisation of the heading', () => {
    expect(DISCLAIMER_TITLE).toBe('Not official Databricks software');
  });

  /* The spec forbids em dashes on this surface, and the separator is " · ". */
  it('uses no em dash', () => {
    expect(DISCLAIMER_BODY).not.toContain('\u2014');
  });
});

describe('the once-per-session latch', () => {
  function store(): AcknowledgementStore & { data: Record<string, string> } {
    const data: Record<string, string> = {};
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
  }

  beforeEach(forgetFirstOpen);

  it('is unset before anything is dismissed', () => {
    expect(firstOpenAcknowledged(store())).toBe(false);
  });

  it('records the dismissal under its own key and reads it back', () => {
    const s = store();
    acknowledgeFirstOpen(s);
    expect(s.data[FIRST_OPEN_KEY]).toBe('true');
    forgetFirstOpen();
    expect(firstOpenAcknowledged(s)).toBe(true);
  });

  it('treats anything other than the recorded value as not yet shown', () => {
    const s = store();
    s.data[FIRST_OPEN_KEY] = 'yes';
    expect(firstOpenAcknowledged(s)).toBe(false);
  });

  /*
   * The card must not come back on every navigation for a reader whose browser
   * refuses storage, so the in-memory half answers when the store cannot.
   */
  it('still holds for this loaded copy when storage is unavailable', () => {
    acknowledgeFirstOpen(null);
    expect(firstOpenAcknowledged(null)).toBe(true);
  });

  it('does not throw when storage throws', () => {
    const hostile: AcknowledgementStore = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
    };
    expect(() => acknowledgeFirstOpen(hostile)).not.toThrow();
    forgetFirstOpen();
    expect(firstOpenAcknowledged(hostile)).toBe(false);
  });
});
