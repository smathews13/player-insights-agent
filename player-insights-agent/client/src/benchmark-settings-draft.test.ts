import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BENCHMARK_SETTINGS, type BenchmarkSettings } from '../../shared/benchmark-settings';
import {
  createBenchmarkSettingsDraftStore,
  removeBenchmarkCustomJudge,
  replaceBenchmarkSettingsDraft,
  saveBenchmarkSettingsDraft,
  stageBenchmarkCustomJudge,
} from './benchmark-settings-draft';

const ENGLISH_JUDGE = {
  name: 'English',
  guidelines: 'The response must be in English.',
  prompt: '',
};

function loadedStore(settings: BenchmarkSettings = DEFAULT_BENCHMARK_SETTINGS) {
  const store = createBenchmarkSettingsDraftStore(DEFAULT_BENCHMARK_SETTINGS);
  replaceBenchmarkSettingsDraft(store, settings, true);
  return store;
}

function saveOptions(persist: (draft: BenchmarkSettings) => Promise<BenchmarkSettings>) {
  return {
    additionalChangeCount: 0,
    persist,
    onPersisted: vi.fn(),
    onRefresh: vi.fn(),
    commitStaged: vi.fn(() => Promise.resolve()),
  };
}

describe('staged custom judge persistence', () => {
  it('PUTs an added judge exactly once when Save follows Add immediately', async () => {
    const store = loadedStore();
    const staged = stageBenchmarkCustomJudge(store, ENGLISH_JUDGE);
    expect(staged.ok).toBe(true);
    const persist = vi.fn((draft: BenchmarkSettings) => Promise.resolve(draft));
    const options = saveOptions(persist);

    const result = await saveBenchmarkSettingsDraft(store, options);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]?.[0].customJudges).toEqual([ENGLISH_JUDGE]);
    expect(result).toEqual({ kind: 'saved', count: 1, remainingCount: 0, customJudgesChanged: true });
    expect(options.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('PUTs an immediate removal from the same authoritative draft', async () => {
    const saved = { ...DEFAULT_BENCHMARK_SETTINGS, customJudges: [ENGLISH_JUDGE] };
    const store = loadedStore(saved);
    expect(removeBenchmarkCustomJudge(store, 0).removed).toEqual(ENGLISH_JUDGE);
    const persist = vi.fn((draft: BenchmarkSettings) => Promise.resolve(draft));

    await saveBenchmarkSettingsDraft(store, saveOptions(persist));

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]?.[0].customJudges).toEqual([]);
  });

  it('prevents no-op and duplicate in-flight saves', async () => {
    const cleanStore = loadedStore();
    const cleanPersist = vi.fn((draft: BenchmarkSettings) => Promise.resolve(draft));
    const cleanOptions = saveOptions(cleanPersist);
    expect(await saveBenchmarkSettingsDraft(cleanStore, cleanOptions)).toEqual({ kind: 'noop' });
    expect(cleanPersist).not.toHaveBeenCalled();
    expect(cleanOptions.commitStaged).not.toHaveBeenCalled();
    expect(cleanOptions.onRefresh).not.toHaveBeenCalled();

    const store = loadedStore();
    stageBenchmarkCustomJudge(store, ENGLISH_JUDGE);
    let finish!: (settings: BenchmarkSettings) => void;
    const persist = vi.fn(
      (draft: BenchmarkSettings) =>
        new Promise<BenchmarkSettings>((resolve) => {
          finish = () => resolve(draft);
        })
    );
    const options = saveOptions(persist);
    const first = saveBenchmarkSettingsDraft(store, options);
    expect(await saveBenchmarkSettingsDraft(store, options)).toEqual({ kind: 'busy' });
    finish(store.current);
    await first;
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('retains the staged draft and emits no refresh after a PUT failure', async () => {
    const store = loadedStore();
    stageBenchmarkCustomJudge(store, ENGLISH_JUDGE);
    const options = saveOptions(() => Promise.reject(new Error('The settings store refused the write.')));

    await expect(saveBenchmarkSettingsDraft(store, options)).rejects.toThrow('refused');

    expect(store.current.customJudges).toEqual([ENGLISH_JUDGE]);
    expect(store.saved?.customJudges).toEqual([]);
    expect(store.saveInFlight).toBe(false);
    expect(options.onPersisted).not.toHaveBeenCalled();
    expect(options.onRefresh).not.toHaveBeenCalled();
  });

  it('keeps changes staged during a PUT dirty instead of overwriting or claiming them', async () => {
    const store = loadedStore();
    stageBenchmarkCustomJudge(store, ENGLISH_JUDGE);
    const persistedDraft = store.current;
    const options = saveOptions(() => {
      stageBenchmarkCustomJudge(store, {
        name: 'Concise',
        guidelines: 'The response must be concise.',
        prompt: '',
      });
      return Promise.resolve(persistedDraft);
    });

    const result = await saveBenchmarkSettingsDraft(store, options);

    expect(store.current.customJudges).toHaveLength(2);
    expect(store.saved?.customJudges).toEqual([ENGLISH_JUDGE]);
    expect(result).toEqual({ kind: 'saved', count: 1, remainingCount: 1, customJudgesChanged: true });
    expect(options.onPersisted).toHaveBeenCalledWith(persistedDraft, true);
    expect(options.onRefresh).toHaveBeenCalledTimes(1);
  });
});
