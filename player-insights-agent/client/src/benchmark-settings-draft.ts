import type { BenchmarkSettings } from '../../shared/benchmark-settings';
import type { CustomJudge } from '../../shared/eval-dataset';
import { stageCustomJudge, type CustomJudgeDraft } from './custom-judge-draft';
import { changedSettingKeys } from './settings-save-state';

export interface BenchmarkSettingsDraftStore {
  current: BenchmarkSettings;
  saved: BenchmarkSettings | null;
  saveInFlight: boolean;
}

export type BenchmarkSettingsSaveResult =
  | { kind: 'busy' }
  | { kind: 'noop' }
  | { kind: 'saved'; count: number; remainingCount: number; customJudgesChanged: boolean };

export function createBenchmarkSettingsDraftStore(initial: BenchmarkSettings): BenchmarkSettingsDraftStore {
  return { current: initial, saved: null, saveInFlight: false };
}

export function replaceBenchmarkSettingsDraft(
  store: BenchmarkSettingsDraftStore,
  settings: BenchmarkSettings,
  saved: boolean
): void {
  store.current = settings;
  if (saved) store.saved = settings;
}

export function updateBenchmarkSettingsDraft(
  store: BenchmarkSettingsDraftStore,
  update: (current: BenchmarkSettings) => BenchmarkSettings
): BenchmarkSettings {
  const next = update(store.current);
  store.current = next;
  return next;
}

export function stageBenchmarkCustomJudge(store: BenchmarkSettingsDraftStore, draft: CustomJudgeDraft) {
  const staged = stageCustomJudge(store.current.customJudges, draft);
  if (staged.ok) {
    store.current = { ...store.current, customJudges: staged.judges };
  }
  return staged;
}

export function removeBenchmarkCustomJudge(
  store: BenchmarkSettingsDraftStore,
  index: number
): { removed: CustomJudge | null; settings: BenchmarkSettings } {
  const removed = store.current.customJudges[index] ?? null;
  if (!removed) return { removed, settings: store.current };
  store.current = {
    ...store.current,
    customJudges: store.current.customJudges.filter((_, entryIndex) => entryIndex !== index),
  };
  return { removed, settings: store.current };
}

export function benchmarkSettingsChangedCount(store: BenchmarkSettingsDraftStore): number {
  return store.saved ? changedSettingKeys(store.saved, store.current).length : 0;
}

export async function saveBenchmarkSettingsDraft(
  store: BenchmarkSettingsDraftStore,
  options: {
    additionalChangeCount: number;
    persist: (draft: BenchmarkSettings) => Promise<BenchmarkSettings>;
    onPersisted: (saved: BenchmarkSettings, draftChangedDuringSave: boolean) => void;
    onRefresh: () => void;
    commitStaged: () => Promise<void>;
  }
): Promise<BenchmarkSettingsSaveResult> {
  if (store.saveInFlight) return { kind: 'busy' };
  const savedAtStart = store.saved;
  const draftAtStart = store.current;
  const changedKeys = savedAtStart ? changedSettingKeys(savedAtStart, draftAtStart) : [];
  const changedCount = changedKeys.length;
  const totalCount = changedCount + options.additionalChangeCount;
  if (totalCount === 0) return { kind: 'noop' };

  store.saveInFlight = true;
  try {
    if (changedCount > 0) {
      const saved = await options.persist(draftAtStart);
      const draftChangedDuringSave = store.current !== draftAtStart;
      store.saved = saved;
      if (!draftChangedDuringSave) store.current = saved;
      options.onPersisted(saved, draftChangedDuringSave);
      options.onRefresh();
    }

    await options.commitStaged();
    return {
      kind: 'saved',
      count: totalCount,
      remainingCount: benchmarkSettingsChangedCount(store),
      customJudgesChanged: changedKeys.includes('customJudges'),
    };
  } finally {
    store.saveInFlight = false;
  }
}
