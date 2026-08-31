import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsDiscardDialog } from './SettingsPage';
import { settingsDismissalAction } from './settings-dismissal';

const SOURCE = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');

describe('Settings dismissal', () => {
  it('routes clean, dirty, and saving states deterministically', () => {
    expect(settingsDismissalAction(0, false)).toBe('close');
    expect(settingsDismissalAction(2, false)).toBe('confirm');
    expect(settingsDismissalAction(2, true)).toBe('ignore');
    expect(settingsDismissalAction(0, true)).toBe('ignore');
  });

  it('renders a concise labelled discard confirmation', () => {
    const html = renderToStaticMarkup(<SettingsDiscardDialog onKeepEditing={() => {}} onDiscard={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="settings-discard-title"');
    expect(html).toContain('aria-describedby="settings-discard-description"');
    expect(html).toContain('Discard changes?');
    expect(html).toContain('Your staged changes have not been saved.');
    expect(html).toContain('Keep editing');
    expect(html).toContain('Discard changes');
  });

  it('uses the same dirty gate for Escape, backdrop, close, and Cancel', () => {
    expect(SOURCE).toContain('onDismiss={requestClose}');
    expect(SOURCE).toMatch(/className="settings-close"[\s\S]*?onClick=\{requestClose\}/);
    expect(SOURCE).toMatch(/className="settings-cancel"[\s\S]*?onClick=\{requestClose\}/);
    expect(SOURCE).toContain("case 'confirm':");
    expect(SOURCE).toContain('setDiscardOpen(true)');
    expect(SOURCE).toContain('<SettingsDiscardDialog');
  });

  it('closes only after explicit discard and leaves successful saves clean', () => {
    expect(SOURCE).toMatch(/const discardChanges = useCallback\(\(\) => \{[\s\S]*?close\(\);/);
    expect(SOURCE).toContain('onDirtyChange={handlePaneDirty}');
    expect(SOURCE).toContain('setPaneDirtyCount(count)');
  });
});
