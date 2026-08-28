import { describe, expect, it } from 'vitest';
import {
  EXPERIMENTAL_FEATURE_KEYS,
  NO_EXPERIMENTS,
  persistExperimentalFeatures,
  readExperimentalFeatures,
  showsBenchmarkLab,
  showsEgressControls,
  showsForecasting,
  type PreferenceStore,
} from './experimental-features';
import { LEGACY_SP_IDENTITIES_BROWSER_KEY } from './sp-identity-mode';

/**
 * The preference behind the Benchmark Lab, and the ways a browser can refuse to
 * hold it.
 *
 * The interesting cases are all failures rather than the happy path, because the
 * happy path is a string comparison. What matters is that every way of not
 * having an answer -- no storage, a store that throws, a value written by an
 * earlier shape of this file, a value written by hand -- lands on off, and that
 * none of them reaches the caller as an exception. A nav bar that throws while
 * deciding whether to draw a link takes the whole header down with it.
 */

const KEY = EXPERIMENTAL_FEATURE_KEYS.benchmarkLab;

/** A `localStorage` that is only a Map, so a test can see what was written. */
function fakeStore(seed: Record<string, string> = {}): PreferenceStore & { written: Map<string, string> } {
  const written = new Map(Object.entries(seed));
  return {
    written,
    getItem: (key) => written.get(key) ?? null,
    setItem: (key, value) => {
      written.set(key, value);
    },
  };
}

/** A store that is present and hostile, which is a private window with a full quota. */
function throwingStore(where: 'read' | 'write'): PreferenceStore {
  return {
    getItem: () => {
      if (where === 'read') throw new Error('SecurityError: storage is not available');
      return 'true';
    },
    setItem: () => {
      if (where === 'write') throw new Error('QuotaExceededError');
    },
  };
}

describe('reading which experiments a browser has opted into', () => {
  it('treats a browser that has never been asked as opted into nothing', () => {
    // Against NO_EXPERIMENTS rather than a literal, so this keeps asserting
    // "every experiment off" as experiments are added instead of asserting how
    // many there were on the day it was written.
    expect(readExperimentalFeatures(fakeStore())).toEqual(NO_EXPERIMENTS);
  });

  it('enables a feature only for the exact string true', () => {
    expect(readExperimentalFeatures(fakeStore({ [KEY]: 'true' })).benchmarkLab).toBe(true);
  });

  /**
   * Every one of these means "nobody deliberately asked for this", so every one
   * of them has to read as off. '1' and 'yes' are what a person types when they
   * are setting the key by hand; '{"benchmarkLab":true}' is what an earlier
   * shape of this module would have written, and it must not be honoured as a
   * truthy string.
   */
  it('reads anything other than true as off, including values that look affirmative', () => {
    for (const raw of ['', ' ', '1', 'yes', 'TRUE', 'True', 'on', 'enabled', '{"benchmarkLab":true}', 'null']) {
      expect(readExperimentalFeatures(fakeStore({ [KEY]: raw })).benchmarkLab, raw).toBe(false);
    }
  });

  it('reads nothing when there is no storage at all, rather than failing', () => {
    expect(readExperimentalFeatures(null)).toEqual(NO_EXPERIMENTS);
  });

  it('reads nothing when the store itself throws on being read', () => {
    expect(readExperimentalFeatures(throwingStore('read'))).toEqual(NO_EXPERIMENTS);
  });

  it('does not hand back the shared default object for a caller to mutate', () => {
    const features = readExperimentalFeatures(null);
    features.benchmarkLab = true;
    expect(NO_EXPERIMENTS.benchmarkLab).toBe(false);
  });
});

describe('recording an experiment for the next visit', () => {
  it('writes the value the reader will read back', () => {
    const store = fakeStore();
    expect(persistExperimentalFeatures({ ...NO_EXPERIMENTS, benchmarkLab: true }, store)).toBe(true);
    expect(readExperimentalFeatures(store).benchmarkLab).toBe(true);
  });

  it('records being turned off as its own value rather than by removing the key', () => {
    const store = fakeStore({ [KEY]: 'true' });
    persistExperimentalFeatures({ ...NO_EXPERIMENTS, benchmarkLab: false }, store);
    expect(store.written.get(KEY)).toBe('false');
    expect(readExperimentalFeatures(store).benchmarkLab).toBe(false);
  });

  /**
   * The caller is expected to keep the toggle moving on a false here, so this
   * says "it did not stick" rather than "it did not work". Reported rather than
   * thrown for the same reason: an exception from a preference write would have
   * to be caught at every call site or take down the page that set it.
   */
  it('reports a store that cannot be written to without throwing at the caller', () => {
    const on = { ...NO_EXPERIMENTS, benchmarkLab: true };
    expect(persistExperimentalFeatures(on, throwingStore('write'))).toBe(false);
    expect(persistExperimentalFeatures(on, null)).toBe(false);
  });
});

describe('the Ops forecasting experiment', () => {
  it('migrates an existing browser with no forecasting key to off', () => {
    const store = fakeStore({
      [EXPERIMENTAL_FEATURE_KEYS.benchmarkLab]: 'true',
      [EXPERIMENTAL_FEATURE_KEYS.egressControls]: 'true',
    });
    const features = readExperimentalFeatures(store);

    expect(NO_EXPERIMENTS.forecasting).toBe(false);
    expect(features.forecasting).toBe(false);
    expect(showsForecasting(features)).toBe(false);
  });

  it('persists both sides of the toggle without changing other experiments', () => {
    const store = fakeStore();
    const on = { ...NO_EXPERIMENTS, forecasting: true };

    expect(persistExperimentalFeatures(on, store)).toBe(true);
    expect(readExperimentalFeatures(store)).toEqual(on);

    persistExperimentalFeatures({ ...on, forecasting: false }, store);
    expect(store.written.get(EXPERIMENTAL_FEATURE_KEYS.forecasting)).toBe('false');
    expect(readExperimentalFeatures(store)).toEqual(NO_EXPERIMENTS);
  });

  it('ignores and does not rewrite the retired Cost estimates key', () => {
    const legacyKey = 'pia.experimental.cost-estimates';
    const store = fakeStore({ [legacyKey]: 'true' });

    expect(readExperimentalFeatures(store)).toEqual(NO_EXPERIMENTS);
    persistExperimentalFeatures({ ...NO_EXPERIMENTS, forecasting: true }, store);
    expect(store.written.get(legacyKey)).toBe('true');
    expect(Object.values(EXPERIMENTAL_FEATURE_KEYS)).not.toContain(legacyKey);
  });
});

describe('deciding whether to advertise the Benchmark Lab', () => {
  it('hides it for a browser that has not opted in', () => {
    expect(showsBenchmarkLab(readExperimentalFeatures(fakeStore()))).toBe(false);
  });

  it('shows it once the experiment is on', () => {
    expect(showsBenchmarkLab({ ...NO_EXPERIMENTS, benchmarkLab: true })).toBe(true);
  });

  /**
   * One decision, asked the same way by every surface. The nav bar and the
   * mobile sheet reached the same flag through the same call, and the point of
   * asserting it here is that neither is allowed its own reading of the
   * preference: a header that offers a page the sheet beside it hides is the
   * failure this function exists to prevent.
   */
  it('answers from the passed set alone, so no surface can reach its own conclusion', () => {
    expect(showsBenchmarkLab({ ...NO_EXPERIMENTS, benchmarkLab: true })).toBe(true);
    expect(showsBenchmarkLab({ ...NO_EXPERIMENTS, benchmarkLab: false })).toBe(false);
  });
});

/**
 * The egress panel's flag. Asserted beside the Benchmark Lab's rather than in the
 * egress files, because the property worth pinning is the one this module owns:
 * a second flag must not have made the first one's storage or default depend on
 * it. A key per flag is what makes that true, and this is where it is checked.
 */
describe('deciding whether to draw the egress panel', () => {
  it('is off for a browser that has not opted in', () => {
    expect(NO_EXPERIMENTS.egressControls).toBe(false);
    expect(showsEgressControls(readExperimentalFeatures(fakeStore()))).toBe(false);
  });

  it('is on once its own key says so', () => {
    const store = fakeStore({ [EXPERIMENTAL_FEATURE_KEYS.egressControls]: 'true' });
    expect(showsEgressControls(readExperimentalFeatures(store))).toBe(true);
  });

  it('does not turn on because the other experiment did', () => {
    // The reason for a key per flag. One JSON blob, and adding this one could
    // have carried the Benchmark Lab's value into it.
    const store = fakeStore({ [KEY]: 'true' });
    const features = readExperimentalFeatures(store);
    expect(features.benchmarkLab).toBe(true);
    expect(features.egressControls).toBe(false);
  });

  it('does not turn the other experiment on when it is written', () => {
    const store = fakeStore();
    persistExperimentalFeatures({ ...NO_EXPERIMENTS, egressControls: true }, store);
    const features = readExperimentalFeatures(store);
    expect(features.egressControls).toBe(true);
    expect(features.benchmarkLab).toBe(false);
  });
});

/**
 * SP identities used to live here as a third browser key. The Experimental
 * switch still sits on Settings, but the real pivot is deployment-wide. A
 * leftover localStorage value must not turn anything on.
 */
describe('a leftover SP-identities browser key does not opt anyone in', () => {
  it('is ignored when reading experiments', () => {
    const store = fakeStore({ [LEGACY_SP_IDENTITIES_BROWSER_KEY]: 'true' });
    expect(readExperimentalFeatures(store)).toEqual(NO_EXPERIMENTS);
  });

  it('is not written when another experiment is persisted', () => {
    const store = fakeStore({ [LEGACY_SP_IDENTITIES_BROWSER_KEY]: 'true' });
    persistExperimentalFeatures({ ...NO_EXPERIMENTS, egressControls: true }, store);
    expect(store.written.get(LEGACY_SP_IDENTITIES_BROWSER_KEY)).toBe('true');
    expect(readExperimentalFeatures(store).egressControls).toBe(true);
    expect(Object.keys(EXPERIMENTAL_FEATURE_KEYS)).not.toContain('spIdentities');
  });
});
