import { describe, expect, it } from 'vitest';
import { storageBannerNotice, type StorageHealth } from './storage-banner-copy';

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

/**
 * Everything the banner says, in the order a reader can reach it.
 *
 * Asserted against this rather than against `detail` alone, because the two
 * halves now divide one statement: the visible line carries what to do and the
 * disclosure carries why. Which half a distinction lands in is a layout
 * decision and will move again. That a distinction is MADE is the thing these
 * tests exist to hold, and pinning it to a field turned a copy edit into a
 * failing test that said nothing about whether the app had got worse.
 */
function said(notice: ReturnType<typeof storageBannerNotice>) {
  return `${notice?.detail ?? ''} ${notice?.reasoning ?? ''}`;
}

describe('a deployment that never ran the grant script', () => {
  const notice = storageBannerNotice(health({ state: 'unavailable', access: 'denied', last_ok_at: null }));

  it('says the app was refused, not that the database is missing', () => {
    expect(notice?.tone).toBe('blocking');
    expect(notice?.heading).toContain('has not been granted access');
    expect(said(notice)).toContain('Postgres is answering and refusing');
  });

  it('stops the reader waiting for it to clear', () => {
    // The behavioural failure, not a wording preference: a deployer told their
    // store is "unreachable" retries, restarts the app, and waits, none of
    // which can work, and all of which happen before they read the docs.
    //
    // "will not clear on its own" is held to the VISIBLE line rather than to
    // the disclosure, because it is the clause that changes what the reader
    // does in the next minute, and a reader who never opens the disclosure is
    // the reader it is for.
    expect(notice?.detail).toContain('will not clear on its own');
    expect(said(notice)).toContain('not an outage');
  });

  it('says nothing is being saved, because nothing is', () => {
    expect(notice?.detail).toContain('nothing you do here is being saved');
  });

  it('puts the target-aware release hook on screen', () => {
    // On screen rather than in a doc link. The deployer who reached this banner
    // is by definition someone who did not read the doc that says to run it,
    // and a second pointer at the same doc is not a fix.
    expect(notice?.remedy).toContain('bundle/app-db-grant.sh');
    expect(notice?.remedy).toContain('TARGET=<target>');
    expect(notice?.remedy).toContain("PROFILE='<profile>'");
  });

  it('explains how releases and reattaches apply it', () => {
    expect(notice?.remedyNote).toContain('does not exist until the app does');
    expect(notice?.remedyNote).toContain('canonical app release');
    expect(notice?.remedyNote).toContain('detach/reattach');
  });
});

describe('a store that is genuinely unreachable', () => {
  const notice = storageBannerNotice(health({ state: 'unavailable', access: 'unknown' }));

  it('keeps the wording it had, because that wording is true of this case', () => {
    expect(notice?.tone).toBe('blocking');
    expect(notice?.heading).toContain('Lakebase is unreachable');
    expect(said(notice)).toContain('a broken connection, not an empty database');
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
    expect(said(notice)).toContain('connected and answering');
    expect(notice?.remedy).toBeNull();
  });
});

/**
 * The banner has to describe the screen it is sitting above.
 *
 * There are no seeded rows on any deployment now, so every one of these states
 * sits above empty lists and the banner may never say otherwise. It used to be
 * able to: a deployment setting decided whether the same three states rendered
 * figures or nothing, and a banner reading "showing representative data" over a
 * set of empty lists was a fabrication in its own right, and the one a reader is
 * most likely to believe, because it is the app telling them what it just did.
 */
describe('what the banner claims is on screen', () => {
  it('never says representative data is shown, in any state', () => {
    for (const state of [
      { state: 'unavailable', access: 'denied' },
      { state: 'unavailable' },
      { content: 'empty' },
    ] as Partial<StorageHealth>[]) {
      const notice = storageBannerNotice(health(state));

      expect(notice?.heading).not.toContain('representative data');
      expect(said(notice)).not.toContain('seeded');
    }
  });

  it('tells a reader that a blank list is not a count of zero', () => {
    const notice = storageBannerNotice(health({ state: 'unavailable' }));

    // The reason this is worth a sentence: the lists it is sitting above are
    // empty, and "your history is gone" is the reading a customer arrives at
    // without being told otherwise.
    expect(said(notice)).toContain('not a count of zero');
    expect(said(notice)).toContain('has not been lost');
  });

  it('keeps the empty store neutral, because nothing is wrong', () => {
    expect(storageBannerNotice(health({ content: 'empty' }))?.tone).toBe('neutral');
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
