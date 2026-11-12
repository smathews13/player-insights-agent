import { describe, expect, it } from 'vitest';

import {
  auditAll,
  auditDiagnosis,
  escalatesToAnotherAction,
  statesACause,
  UNDETERMINED,
  type Diagnosis,
} from './stated-cause';

/**
 * The guard's own tests.
 *
 * THE SENTENCE THIS FILE EXISTS FOR is quoted verbatim below. On 2026-08-16 the
 * Connections page showed a reader HTTP 403 on twenty-odd Unity Catalog rows and
 * explained it in two halves. The first half was earned: it compared the scope
 * Databricks named in its own refusal against the scope claim on the forwarded
 * token, and returned `undetermined` with no remedy where it could not tell. The
 * second half appended a confident sentence about WHY, and four steps built on
 * it. Nothing in the code could know that why. Three of the four steps were
 * already done and verified. The reader did them again.
 *
 * So the check is not "is this sentence true". Nothing in a test can answer that.
 * It is narrower and it is decidable: a diagnosis whose own `cause` field says
 * nothing was determined must not carry prose that says something was, and must
 * not carry a remedy, which is a claim about a cause wearing an imperative.
 */

const CLEAN_UNDETERMINED: Diagnosis = {
  cause: UNDETERMINED,
  evidence: '',
  explanation:
    'The workspace refused this call and did not say whether a scope or a grant was the reason, ' +
    'so nothing about it was established.',
  remedy: null,
};

const CLEAN_DETERMINED: Diagnosis = {
  cause: 'token-lacks-declared-scope',
  evidence: 'The app declares 7 permissions including `catalog.tables:read`; the token lists `sql`.',
  explanation: 'Your sign-in does not carry `catalog.tables:read`, which the app asks for.',
  remedy: {
    kind: 'ui',
    statement: 'Open the app in a private window.',
    guidance: 'Signing out of Databricks does not clear it.',
  },
};

describe('statesACause', () => {
  /**
   * The real thing, in the words it actually reached the screen in. If this ever
   * stops matching, the detector has been narrowed past the incident it was
   * written for and the narrowing is the bug.
   */
  it('catches the sentence that caused this module', () => {
    expect(
      statesACause(
        'This is happening because the app is missing an OAuth scope that it needs to read ' +
          'Unity Catalog objects on your behalf.'
      )
    ).toBe('because');
  });

  it('catches the same claim written without the connective', () => {
    expect(statesACause('The app is missing a scope it needs.')).toBe('The app is missing');
    expect(statesACause('Your token was minted before the scope was declared.')).toBe('was minted before');
    expect(statesACause('The session predates the declaration.')).toBe('predates');
    expect(statesACause('The app has not been stopped and started since the change.')).toBe('has not been stopped');
  });

  it('catches an accusation aimed at the reader', () => {
    expect(statesACause('You have not signed in again since the scopes changed.')).toBe('You have not');
    expect(statesACause('You never re-consented to the new scope.')).toBe('You never');
  });

  /**
   * The copy the app actually uses when it cannot tell. If any of these tripped
   * the detector, the guard would be unusable and would be turned off, which is
   * worse than not having it.
   */
  it('leaves honest undetermined copy alone', () => {
    for (const honest of [
      CLEAN_UNDETERMINED.explanation,
      'This request carried no forwarded sign-in, so there is nothing to compare against the ' +
        'permissions this app asks for. Nothing about your sign-in was established either way.',
      'The sign-in this request carried does not list its own permissions, so it cannot be compared ' +
        'against the ones this app asks for. Nothing about your sign-in was established.',
      'This deployment was not told which permissions it asks for, so no sign-in can be compared ' +
        'against them. Nothing about your sign-in was established.',
      'The workspace has no such object. This is missing rather than forbidden, so no grant repairs it.',
    ]) {
      expect(statesACause(honest)).toBeNull();
    }
  });
});

describe('escalatesToAnotherAction', () => {
  /**
   * The 401 remedy that stood on the access path until 2026-08-16, verbatim.
   * Three actions in one statement, of which the second could never work: this
   * app's sign-in is not the workspace's and signing out of one does not touch
   * the other.
   */
  it('catches the remedy list that sent a reader round a loop', () => {
    expect(
      escalatesToAnotherAction(
        'Reload this page to pick up a fresh token. If it persists, sign out of the\n' +
          'workspace and back in, then open the app again.'
      )
    ).toMatch(/if it persists/i);
  });

  it('catches the other ways a second action gets hung off the first', () => {
    expect(escalatesToAnotherAction('Run the grant. If that does not work, restart the app.')).toBeTruthy();
    expect(escalatesToAnotherAction('Ask an admin. Failing that, open a ticket.')).toBeTruthy();
    expect(escalatesToAnotherAction('Reload. Otherwise, sign in again.')).toBeTruthy();
  });

  /**
   * The narrowness is the point. A statement may name who it is for, or what it
   * needs, without becoming a list of things to try in order.
   */
  it('leaves a condition that is not an escalation alone', () => {
    expect(escalatesToAnotherAction('Run this as an account admin, if you are one.')).toBeNull();
    expect(escalatesToAnotherAction('Open this app again in a private browsing window, and sign in there.')).toBeNull();
    expect(escalatesToAnotherAction('Reload this page.')).toBeNull();
  });
});

describe('auditDiagnosis', () => {
  it('fails a remedy statement that hangs a second action off the first', () => {
    const findings = auditDiagnosis('theOldCopy', {
      ...CLEAN_DETERMINED,
      remedy: {
        kind: 'ui',
        statement: 'Reload this page to pick up a fresh token. If it persists, sign out and back in.',
        guidance: '',
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('hangs a second action off the first');
    expect(findings[0]).toContain('Keep one action in `statement` and drop the rest');
  });

  /**
   * THE CONTINGENCY HAS NOWHERE TO GO NOW, which is a change from what this test
   * used to assert. It passed the same sentence in the note and expected it to be
   * allowed, on the reasoning that a consequence reads differently from a step.
   * The note is `guidance` now, it is one short line a reader needs in order to
   * carry the statement out, and an escalation is not that. Moving it out of the
   * statement was never the point; the point was that the app reaches the next
   * verdict from evidence rather than handing over a list.
   */
  it('refuses the same contingency in the guidance', () => {
    const findings = auditDiagnosis('notFineAnyMore', {
      ...CLEAN_DETERMINED,
      remedy: {
        kind: 'ui',
        statement: 'Reload this page.',
        guidance: 'If it persists, the age of your sign-in was not what was being refused.',
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('hangs a second action off the statement');
  });

  /**
   * The failure mode the rename was for: the whole "Why this is the fix"
   * paragraph, put back into the field it was cut from.
   */
  it('refuses guidance that has grown back into a paragraph', () => {
    const findings = auditDiagnosis('aParagraph', {
      ...CLEAN_DETERMINED,
      remedy: {
        kind: 'ui',
        statement: 'Open the app in a private window.',
        guidance:
          'This app keeps its own sign-in, on its own web address, separately from the Databricks ' +
          'workspace. Signing out of Databricks does not clear it, and the app cannot clear it for ' +
          'you: the sign-in is held by the Databricks proxy in front of the app, in a cookie the ' +
          'app never sees.',
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('over 200');
  });

  /** A line break is the other half of a paragraph, and is refused on its own. */
  it('refuses guidance carrying its own line break', () => {
    const findings = auditDiagnosis('twoLines', {
      ...CLEAN_DETERMINED,
      remedy: { kind: 'ui', statement: 'Reload this page.', guidance: 'One thing.\nAnd another.' },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('contains a line break');
  });

  /** `''` is the commonest correct value, and must not read as a fault. */
  it('passes a remedy whose statement stands on its own', () => {
    expect(
      auditDiagnosis('bare', {
        ...CLEAN_DETERMINED,
        remedy: { kind: 'sql', statement: 'GRANT SELECT ON TABLE a.b.c TO `p`;', guidance: '' },
      })
    ).toEqual([]);
  });

  it('passes a diagnosis that determined nothing and claimed nothing', () => {
    expect(auditDiagnosis('probe', CLEAN_UNDETERMINED)).toEqual([]);
  });

  it('passes a determined cause that quotes what it read', () => {
    expect(auditDiagnosis('session', CLEAN_DETERMINED)).toEqual([]);
  });

  it('fails an undetermined cause whose prose asserts one', () => {
    const findings = auditDiagnosis('probe', {
      ...CLEAN_UNDETERMINED,
      explanation: 'The workspace refused this call. This is because the app is missing an OAuth scope.',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('the explanation a user reads asserts one');
    // The phrase is quoted back, so the developer does not have to hunt for it.
    expect(findings[0]).toContain('"because"');
  });

  /**
   * The remedy list is what actually cost the afternoon, so it is a finding on
   * its own rather than something implied by the sentence above it. A remedy with
   * no prose at all around it would otherwise pass.
   */
  it('fails an undetermined cause that offers a remedy anyway', () => {
    const findings = auditDiagnosis('probe', {
      ...CLEAN_UNDETERMINED,
      remedy: {
        kind: 'cli',
        statement: 'databricks apps stop player-insights-agent\ndatabricks apps start player-insights-agent',
        guidance: '',
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('a remedy is offered');
  });

  it('fails a determined cause that cites no evidence', () => {
    const findings = auditDiagnosis('session', { ...CLEAN_DETERMINED, evidence: '   ' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('cites no evidence');
  });

  /**
   * Restating the verdict is the easy way to satisfy a required field, and it
   * would make the field decorative. Evidence has to quote a value or a count.
   */
  it('fails evidence that quotes nothing it read', () => {
    const findings = auditDiagnosis('session', {
      ...CLEAN_DETERMINED,
      evidence: 'The session is stale.',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('quotes nothing that was read');
  });

  it('fails a verdict with no words beside it', () => {
    expect(auditDiagnosis('session', { ...CLEAN_DETERMINED, explanation: '' })).toEqual([
      expect.stringContaining('has no explanation'),
    ]);
  });

  // DECISIONS.md D9, checked here because this is the one place every diagnosis
  // passes through on its way to a reader.
  it('fails an em dash in copy a reader reaches', () => {
    const findings = auditDiagnosis('session', {
      ...CLEAN_DETERMINED,
      explanation: 'Your sign-in is short of a permission \u2014 the app asks for `catalog.tables:read`.',
    });
    expect(findings).toEqual([expect.stringContaining('em dash in the explanation')]);
  });

  it('reports every fault rather than stopping at the first', () => {
    const findings = auditDiagnosis('probe', {
      cause: UNDETERMINED,
      evidence: '',
      explanation: 'This is because the app is missing a scope.',
      remedy: { kind: 'ui', statement: 'Sign out and back in.', guidance: '' },
    });
    expect(findings).toHaveLength(2);
  });
});

describe('auditAll', () => {
  it('names the producer and the branch a finding came from', () => {
    const findings = auditAll([
      {
        producer: 'refusalCause',
        branches: {
          'cannot tell': { ...CLEAN_UNDETERMINED, explanation: 'Refused, because the app lacks a scope.' },
          'missing scope': CLEAN_DETERMINED,
        },
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('refusalCause (cannot tell)');
  });

  it('is empty for a clean registry', () => {
    expect(auditAll([{ producer: 'sessionFreshness', branches: { current: CLEAN_DETERMINED } }])).toEqual([]);
  });
});
