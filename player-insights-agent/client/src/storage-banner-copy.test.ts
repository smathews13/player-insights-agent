import { describe, expect, it } from 'vitest';
import { storageBannerNotice, type StorageHealth } from './storage-banner-copy';
import { GRANT_SCRIPT_ENV_VARS } from '../../shared/setup-remedies';

/**
 * The sentence a deployer reads when the figures on screen are invented.
 *
 * Three states produce identical-looking seeded numbers and have three
 * different remedies. Before this, two of them shared one sentence ("Lakebase
 * is unreachable ... This is a broken connection, not an empty database"), and
 * that sentence is actively wrong for a deployment that simply never ran the
 * grant script: the connection is fine, Postgres is answering, and the thing it
 * tells the reader to go and look at is healthy. They lose an afternoon in the
 * Lakebase console and the one-line fix is never mentioned.
 */

function health(overrides: Partial<StorageHealth> = {}): StorageHealth {
  return {
    state: 'ok',
    since: '2026-08-06 10:00',
    last_ok_at: '2026-08-06 10:00',
    last_error: null,
    content: 'populated',
    ...overrides,
  };
}

describe('a deployment that never ran the grant script', () => {
  const notice = storageBannerNotice(health({ state: 'unavailable', access: 'denied', last_ok_at: null }));

  it('says the app was refused, not that the database is missing', () => {
    expect(notice?.tone).toBe('blocking');
    expect(notice?.heading).toContain('has not been granted access');
    expect(notice?.detail).toContain('Postgres is answering and refusing');
  });

  it('stops the reader waiting for it to clear', () => {
    // The behavioural failure, not a wording preference: a deployer told their
    // store is "unreachable" retries, restarts the app, and waits, none of
    // which can work, and all of which happen before they read the docs.
    expect(notice?.detail).toContain('not an outage');
    expect(notice?.detail).toContain('will not clear on its own');
  });

  it('says nothing is being saved, because nothing is', () => {
    expect(notice?.detail).toContain('nothing you do here is being saved');
  });

  it('puts the command and all five variables on screen', () => {
    // On screen rather than in a doc link. The deployer who reached this banner
    // is by definition someone who did not read the doc that says to run it,
    // and a second pointer at the same doc is not a fix.
    expect(notice?.remedy).toContain('node scripts/grant-app-db-access.mjs');
    const shown = `${notice?.remedy}${notice?.remedyNote}`;
    for (const variable of GRANT_SCRIPT_ENV_VARS) expect(shown).toContain(variable);
  });

  it('explains why no redeploy will do it for them', () => {
    // Without this the natural reading is that the bundle failed, and the
    // deployer redeploys instead of running the script.
    expect(notice?.remedyNote).toContain('does not exist until the app does');
    expect(notice?.remedyNote).toContain('Redeploying does not perform it');
  });
});

describe('a store that is genuinely unreachable', () => {
  const notice = storageBannerNotice(health({ state: 'unavailable', access: 'unknown' }));

  it('keeps the wording it had, because that wording is true of this case', () => {
    expect(notice?.tone).toBe('blocking');
    expect(notice?.heading).toContain('Lakebase is unreachable');
    expect(notice?.detail).toContain('a broken connection, not an empty database');
  });

  it('does not tell them to run a script that cannot help', () => {
    // The guard on the branch above. A remedy offered for every failure is a
    // remedy nobody believes by the third time they follow it and it does not
    // work.
    expect(notice?.remedy).toBeNull();
  });

  it('reads the same way on a payload from a server that predates the access field', () => {
    // The app and the browser ship together but cache separately, so a page
    // held from before `access` existed must fall through to the wording it
    // knew, not read `undefined` as a denial and accuse a healthy deployment
    // of skipping its setup.
    const older = storageBannerNotice(health({ state: 'unavailable' }));
    expect(older?.heading).toContain('Lakebase is unreachable');
    expect(older?.remedy).toBeNull();
  });
});

describe('a store that is healthy and empty', () => {
  const notice = storageBannerNotice(health({ content: 'empty' }));

  it('is stated neutrally, because nothing is wrong', () => {
    expect(notice?.tone).toBe('neutral');
    expect(notice?.detail).toContain('connected and answering');
    expect(notice?.remedy).toBeNull();
  });
});

describe('a deployment that is correctly set up', () => {
  it('shows no banner at all', () => {
    // The property everything above depends on. A banner that is always
    // present is furniture, and the reader stops seeing it, which would undo
    // the whole of this change on the deployment it matters for.
    expect(storageBannerNotice(health())).toBeNull();
    expect(storageBannerNotice(health({ access: 'ok' }))).toBeNull();
    expect(storageBannerNotice(health({ content: 'unknown' }))).toBeNull();
  });

  it('shows no banner before the first poll has answered', () => {
    expect(storageBannerNotice(null)).toBeNull();
  });
});
