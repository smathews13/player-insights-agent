import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { NO_EXPERIMENTS, withExperimentalFeature } from './experimental-features';
import {
  changedSettingKeys,
  navigateSettingsSection,
  saveNotice,
  settingsSaveDisabled,
  unsavedChangesLabel,
} from './settings-save-state';

const PAGE = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const RUNTIME = readFileSync(new URL('./RuntimeSettingsPanel.tsx', import.meta.url), 'utf8');
const BENCHMARK = readFileSync(new URL('./BenchmarkSettingsPanel.tsx', import.meta.url), 'utf8');
type TestSection = 'runtime' | 'environment';

describe('staged Settings saves', () => {
  it('stages Forecasting, marks one unsaved change, and enables Save', () => {
    const draft = withExperimentalFeature({ ...NO_EXPERIMENTS }, 'forecasting', true);
    const dirtyCount = changedSettingKeys(NO_EXPERIMENTS, draft).length;

    expect(dirtyCount).toBe(1);
    expect(unsavedChangesLabel(dirtyCount)).toBe('Unsaved changes');
    expect(settingsSaveDisabled(false, dirtyCount, true)).toBe(false);
    expect(PAGE).toContain("withExperimentalFeature(current, 'forecasting', enabled)");
    expect(PAGE).toContain('setFeature(name, draftFeatures[name])');
  });

  it('counts each key once after repeated edits and returns to clean when reverted', () => {
    const first = withExperimentalFeature({ ...NO_EXPERIMENTS }, 'forecasting', true);
    const editedAgain = withExperimentalFeature(first, 'forecasting', true);
    const reverted = withExperimentalFeature(editedAgain, 'forecasting', false);

    expect(changedSettingKeys(NO_EXPERIMENTS, editedAgain)).toEqual(['forecasting']);
    expect(changedSettingKeys(NO_EXPERIMENTS, reverted)).toEqual([]);
    expect(unsavedChangesLabel(0)).toBeNull();
    expect(settingsSaveDisabled(false, 0, true)).toBe(true);
  });

  it('reports the exact saved count and leaves the modal open', () => {
    expect(saveNotice({ kind: 'saved', count: 1 })?.text).toBe('1 change saved');
    expect(saveNotice({ kind: 'saved', count: 3 })?.text).toBe('3 changes saved');
    expect(PAGE).not.toContain('saveLanded(saveState)');
    expect(PAGE).not.toMatch(/setTimeout\(\(\) => close\(\), SAVE_PRESS_MS\)/);
  });

  it('keeps dirty drafts after a failed server save', () => {
    for (const panel of [RUNTIME, BENCHMARK]) {
      const failure = panel.slice(panel.lastIndexOf('} catch (caught)'));
      expect(failure).toContain("onSaveState({ kind: 'failed'");
      expect(failure).not.toContain('onDirtyChange(0)');
    }
    expect(settingsSaveDisabled(false, 2, true)).toBe(false);
  });

  it('discards staged browser-local changes on Cancel without persisting them', () => {
    expect(PAGE).toMatch(/className="settings-cancel"[\s\S]*?type="button"[\s\S]*?onClick=\{requestClose\}/);
    const forecastingHandler = PAGE.slice(
      PAGE.indexOf('aria-label="Show Ops forecasting"') - 500,
      PAGE.indexOf('aria-label="Show Ops forecasting"')
    );
    expect(forecastingHandler).toContain("withExperimentalFeature(current, 'forecasting', enabled)");
    expect(forecastingHandler).not.toContain('setFeature(');
    expect(forecastingHandler).not.toContain('persistExperimentalFeatures');
  });

  it('keeps the dirty pane mounted and guarded after its active tab is clicked again', () => {
    let mountedPane: TestSection = 'runtime';
    let dirtyCount = 2;
    let saveStatus = 'failed';
    const navigation = {
      select: (section: TestSection) => {
        mountedPane = section;
      },
      clearPaneDirty: () => {
        dirtyCount = 0;
      },
      resetSaveState: () => {
        saveStatus = 'idle';
      },
    };

    expect(navigateSettingsSection<TestSection>(mountedPane, 'runtime', dirtyCount, navigation)).toBe(false);
    expect(navigateSettingsSection<TestSection>(mountedPane, 'environment', dirtyCount, navigation)).toBe(false);

    expect(mountedPane).toBe('runtime');
    expect(dirtyCount).toBe(2);
    expect(saveStatus).toBe('failed');
    expect(unsavedChangesLabel(dirtyCount)).toBe('Unsaved changes');
    expect(PAGE).toContain('disabled={section.id !== active && dirtyCount > 0}');
    expect(PAGE).toContain('Save or Cancel the current changes first');
    expect(PAGE).toContain('{dirtyLabel} <span className="ast-num">{dirtyCount}</span>');
    expect(PAGE).not.toContain('setDraftFeatures({ ...savedFeatures })');
  });

  it('allows section navigation once the current pane is clean', () => {
    let mountedPane: TestSection = 'runtime';
    let dirtyCount = 0;
    let saveStatus = 'saved';

    expect(
      navigateSettingsSection<TestSection>(mountedPane, 'environment', dirtyCount, {
        select: (section) => {
          mountedPane = section;
        },
        clearPaneDirty: () => {
          dirtyCount = 0;
        },
        resetSaveState: () => {
          saveStatus = 'idle';
        },
      })
    ).toBe(true);

    expect(mountedPane).toBe('environment');
    expect(dirtyCount).toBe(0);
    expect(saveStatus).toBe('idle');
    expect(unsavedChangesLabel(dirtyCount)).toBeNull();
  });
});
