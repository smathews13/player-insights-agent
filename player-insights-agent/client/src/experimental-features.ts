/**
 * Which unfinished surfaces this browser has been opted into.
 *
 * A preference about what one person sees in one browser, and deliberately not
 * deployment state: nothing here is read by the server, none of it travels with
 * a conversation, and turning something on for yourself must never change what a
 * customer's deployment offers anybody else. That is why it is localStorage
 * rather than `/api/settings`, which is the store for what the deployment IS.
 *
 * One key per flag, and a flag is on only when its value is exactly "true".
 * Same fail-closed rule the server applies to
 * `PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL`, for the same reason: unset, empty,
 * "1", "yes", stale JSON from an earlier shape of this file and a typo all have to
 * land on off, because every one of them means "nobody deliberately asked for
 * this". A key per flag rather than one JSON blob so that adding the next
 * experiment cannot corrupt or drop this one, and so junk in one key is not junk
 * in all of them.
 *
 * Reading is routed through here, once, rather than at each surface that cares.
 * Three surfaces used to be able to disagree about whether the Benchmark Lab
 * exists, and a nav bar that offers a page the page next to it hides is worse
 * than either answer on its own.
 *
 * Service-principal identities are not an experiment in this file. That pivot
 * is deployment-wide (`sp-identity-enabled`), read and written through the
 * admin API, so every browser shows the same mode.
 */

/** Every experiment, by the name the app refers to it by. */
export interface ExperimentalFeatures {
  /**
   * Benchmarking: the tab, the scorers and the judge details, which together are
   * an internal evaluation workbench rather than part of the product a customer
   * is shown. OFF BY DEFAULT AND DELIBERATELY SO: a customer who never asked for
   * Benchmarking must not meet it after an upgrade, and an operator who wants it
   * turns it on for their own browser on Settings.
   */
  benchmarkLab: boolean;
  /**
   * The egress panel: which paths may be turned off, and what Unity Catalog says
   * about the tables behind it. Unfinished, in that two of its paths are wired
   * and the rest record a preference nothing reads yet.
   *
   * ── THE FLAG HIDES THE PANEL AND NOT THE CONTROLS ──
   *
   * Worth being explicit, because the reverse would be a real defect. The
   * switches this panel edits are DEPLOYMENT state, stored on the server and in
   * force for everybody. Turning this flag off in one browser hides the page
   * that edits them; it does not restore an export path for anybody, including
   * the person who turned it off. Any other behaviour would make a per-browser
   * preference into a way to reopen a control an administrator closed.
   */
  egressControls: boolean;
  /**
   * The Ops forecasting scenario beneath Cost. This is display-only and
   * browser-local: Cost remains visible and server-authorized for every admin,
   * while this unfinished projection is opt-in per browser.
   */
  forecasting: boolean;
}

/**
 * The storage keys, namespaced so they are recognisable in a devtools panel
 * beside whatever else is on the origin.
 */
export const EXPERIMENTAL_FEATURE_KEYS: Readonly<Record<keyof ExperimentalFeatures, string>> = {
  benchmarkLab: 'pia.experimental.benchmark-lab',
  egressControls: 'pia.experimental.egress-controls',
  forecasting: 'pia.experimental.forecasting',
};

/** What a browser that has never been asked gets. */
export const NO_EXPERIMENTS: Readonly<ExperimentalFeatures> = {
  benchmarkLab: false,
  egressControls: false,
  forecasting: false,
};

/**
 * The two methods of `Storage` this needs, so a test can pass a plain object.
 *
 * Narrower than `Storage` on purpose: nothing here should be reaching for
 * `clear()`, which would take preferences this module does not own with it.
 */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * `localStorage`, when there is one that can actually be used.
 *
 * Three states are all reported the same way here, as null: server-side
 * rendering, a browser that has disabled storage for this origin, and a
 * sandboxed iframe where merely READING `window.localStorage` throws a
 * SecurityError before any key is touched. The last is why this is a try/catch
 * around the property access itself and not only around `getItem`.
 */
export function browserPreferenceStore(): PreferenceStore | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

const ENABLED = 'true';

/** Whether one stored value counts as a deliberate yes. */
function enabled(raw: string | null): boolean {
  return raw === ENABLED;
}

/**
 * What this browser has opted into, defaulting to nothing on any doubt.
 *
 * A store that throws on read is treated as a browser that has opted into
 * nothing, rather than as an error worth showing anybody: the honest
 * consequence of unavailable storage is that an experiment stays off, and a
 * dialog about a preference nobody asked for would be a worse outcome than the
 * default they were going to get anyway.
 */
export function readExperimentalFeatures(
  store: PreferenceStore | null = browserPreferenceStore()
): ExperimentalFeatures {
  if (!store) return { ...NO_EXPERIMENTS };
  try {
    return {
      benchmarkLab: enabled(store.getItem(EXPERIMENTAL_FEATURE_KEYS.benchmarkLab)),
      egressControls: enabled(store.getItem(EXPERIMENTAL_FEATURE_KEYS.egressControls)),
      forecasting: enabled(store.getItem(EXPERIMENTAL_FEATURE_KEYS.forecasting)),
    };
  } catch {
    return { ...NO_EXPERIMENTS };
  }
}

/**
 * Records the whole set, and reports whether it will survive a reload.
 *
 * Best effort by design. `setItem` throws when the quota is full and, in a
 * private window, has historically thrown on a store that read back fine, so a
 * write can fail in a session where the read worked. The caller keeps its own
 * state either way: a toggle that refuses to move because the value could not be
 * saved is a control that appears broken, where one that moves and does not
 * persist is a control that worked and a preference that did not stick.
 */
export function persistExperimentalFeatures(
  features: ExperimentalFeatures,
  store: PreferenceStore | null = browserPreferenceStore()
): boolean {
  if (!store) return false;
  try {
    store.setItem(EXPERIMENTAL_FEATURE_KEYS.benchmarkLab, features.benchmarkLab ? ENABLED : 'false');
    store.setItem(EXPERIMENTAL_FEATURE_KEYS.egressControls, features.egressControls ? ENABLED : 'false');
    store.setItem(EXPERIMENTAL_FEATURE_KEYS.forecasting, features.forecasting ? ENABLED : 'false');
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether Benchmarking, its scorers and its judge details are offered.
 *
 * Read by the navigation and by the `/benchmarks` route, so a pasted URL and the
 * tab cannot disagree about whether the surface exists. `BENCHMARK_LAB_ENABLED`
 * stands in front of it as the way to withdraw the surface from every browser at
 * once; this is the per-browser answer an operator sets on Settings.
 */
export function showsBenchmarkLab(features: ExperimentalFeatures): boolean {
  return features.benchmarkLab;
}

/**
 * Whether the egress panel is drawn on the Settings page.
 *
 * Governs ONE surface and no route, unlike the Benchmark Lab flag above: the
 * panel is a set of cards on a page an administrator is already on, so there is
 * no URL for this to hide and none for a bookmark to keep working. Read by the
 * page and by nothing else, because a second reader is how two surfaces come to
 * disagree about whether something exists.
 */
export function showsEgressControls(features: ExperimentalFeatures): boolean {
  return features.egressControls;
}

/** Whether Ops draws the browser-local forecasting scenario beneath Cost. */
export function showsForecasting(features: ExperimentalFeatures): boolean {
  return features.forecasting;
}
