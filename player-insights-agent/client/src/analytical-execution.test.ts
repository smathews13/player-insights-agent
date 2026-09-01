import { describe, expect, it } from 'vitest';

import { dataAccessDisclosure, executionSummary } from './analytical-execution';

/**
 * The panel these lines appear on is where somebody goes to answer "could this
 * have been computed with grants the reader does not have". So the assertions
 * here are mostly about what the wording must NOT permit: a reassuring line
 * over a run that was not the reader's, and a blank where a mode should be.
 */
describe('executionSummary', () => {
  it('says questions run as the signed-in user, verified or not', () => {
    for (const verified of [true, false]) {
      const summary = executionSummary({ mode: 'signed_in_user', verified });
      expect(summary.label).toBe('Questions run as the signed-in user');
      // Not attention. An unverifiable token is the ordinary case for an
      // opaque credential, and colouring it as a problem would train an
      // administrator to ignore the colour on the case that is one.
      expect(summary.tone).toBe('ok');
    }
  });

  it('explains an unverified subject as deferred rather than skipped', () => {
    const summary = executionSummary({ mode: 'signed_in_user', verified: false });
    expect(summary.note).toMatch(/endpoint confirms it/);
    expect(summary.note).not.toMatch(/skip|unchecked|cannot verify/i);
  });

  it('leaves the verified case unqualified', () => {
    expect(executionSummary({ mode: 'signed_in_user', verified: true }).note).toBeNull();
  });

  it('flags execution as the application, which no deployment should show', () => {
    const summary = executionSummary({ mode: 'app_service_principal', verified: false });
    expect(summary.label).toBe('Questions run as the application');
    expect(summary.tone).toBe('attention');
    expect(summary.note).toMatch(/locally/);
  });

  it('never claims the application mode was verified', () => {
    // Guards the wording against a future mode object that arrives with the
    // flag set: `verified` is about a token binding to a person, and there is
    // no person here, so the flag must not be able to soften the line.
    const summary = executionSummary({ mode: 'app_service_principal', verified: true });
    expect(summary.label).toBe('Questions run as the application');
    expect(summary.tone).toBe('attention');
  });

  it('reports an absent field as unknown rather than assuming either mode', () => {
    for (const missing of [null, undefined]) {
      const summary = executionSummary(missing);
      expect(summary.label).toMatch(/not reported/);
      expect(summary.tone).toBe('attention');
      // The failure mode being prevented: an older server omits the field and
      // the page reassures a reader about a boundary it knows nothing about.
      expect(summary.label).not.toMatch(/signed-in user/);
    }
  });

  it('names an unrecognised mode instead of blanking or guessing', () => {
    const summary = executionSummary({ mode: 'on_behalf_of_group', verified: true });
    expect(summary.label).toContain('on_behalf_of_group');
    expect(summary.tone).toBe('attention');
  });

  it('always produces a line, so there is no state the panel renders empty', () => {
    const modes = ['signed_in_user', 'app_service_principal', '', 'nonsense'];
    for (const mode of modes) {
      expect(executionSummary({ mode, verified: false }).label.trim()).not.toBe('');
    }
  });
});

/**
 * The footer of an answered turn, which is the closest this app comes to a
 * receipt: it sits under the figures and says whose grants they were computed
 * under. It asserted for months that a service principal had executed the data
 * access, on a deployment that forwards the reader's own token, so the tests
 * below are mostly about the claims the sentence may no longer make.
 */
describe('dataAccessDisclosure', () => {
  it('says the data was read under the reader’s own grants when the run was theirs', () => {
    for (const verified of [true, false]) {
      const line = dataAccessDisclosure({ mode: 'signed_in_user', verified });
      expect(line).toBe('Data read under your own Unity Catalog grants.');
    }
  });

  it('never tells a reader whose own token ran the query that a service principal did', () => {
    // The defect this replaces, asserted on both flags because an unverifiable
    // token is the ordinary case for an opaque credential and the old sentence
    // would have been reintroduced most easily as a hedge on that flag.
    for (const verified of [true, false]) {
      expect(dataAccessDisclosure({ mode: 'signed_in_user', verified })).not.toMatch(/service principal/i);
    }
  });

  it('says the application read the data on the one path where it does', () => {
    // Reachable only on a laptop, where no proxy forwards a user. Kept accurate
    // rather than deleted: an undisclosed run as the application is the same
    // misreporting in the other direction.
    const line = dataAccessDisclosure({ mode: 'app_service_principal', verified: false });
    expect(line).toBe('Data access scope: application Unity Catalog grants.');
    expect(line).not.toMatch(/your own/i);
  });

  it('says nothing at all rather than naming an identity it was not told', () => {
    for (const missing of [null, undefined]) {
      // Not a guess in either direction, and not a sentence about the absence
      // either. A stored answer that borrowed the reader's session would read as
      // a receipt for a run nobody checked; a run stated as doubtful is a doubt
      // asserted about a run that may have been perfectly ordinary.
      expect(dataAccessDisclosure(missing)).toBeNull();
    }
  });

  it('says nothing for an unrecognised mode instead of guessing which one it resembles', () => {
    expect(dataAccessDisclosure({ mode: 'on_behalf_of_group', verified: true })).toBeNull();
  });

  it('never hedges: the line is a plain statement or it is not there', () => {
    // The sentence removed here read "The identity this data was read as is
    // unconfirmed." It was rendered under every answer whose run predated the
    // identity columns, including on Monitoring, where the app knows exactly who
    // asked -- so it invited a reader to suspect their own question had been
    // answered as somebody else. A softer wording would be the same defect, so
    // what is pinned is that no surviving line expresses doubt at all.
    for (const mode of ['signed_in_user', 'app_service_principal', '', 'nonsense']) {
      const line = dataAccessDisclosure({ mode, verified: false });
      if (line === null) continue;
      expect(line.trim()).not.toBe('');
      expect(line.endsWith('.')).toBe(true);
      expect(line).not.toMatch(/unconfirmed|unverified|unknown|cannot confirm|not confirmed/i);
    }
    expect(dataAccessDisclosure(null)).toBeNull();
  });
});
