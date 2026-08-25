import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RUNTIME_SETTINGS, FONT_FAMILY_STACKS } from '../../shared/runtime-settings';
import { previewRuntimeTypography } from './runtime-entity-styles';
import { previewColorScheme } from './RuntimeSettingsPanel';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Appearance theme switch', () => {
  it('paints light mode as soon as the Dark switch is turned off', () => {
    const attributes = new Map<string, string>([['data-theme', 'dark']]);
    const root = {
      classList: { add: vi.fn() },
      style: { setProperty: vi.fn() },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };
    const themeColor = { setAttribute: vi.fn() };
    vi.stubGlobal('document', {
      documentElement: root,
      querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? themeColor : null),
    });

    const colorScheme = previewColorScheme(false);

    expect(colorScheme).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(themeColor.setAttribute).toHaveBeenCalledWith('content', '#ffffff');
    expect({ ...DEFAULT_RUNTIME_SETTINGS, colorScheme }.colorScheme).toBe('light');
  });

  it('writes type onto the document as soon as Appearance changes it', () => {
    const setProperty = vi.fn();
    previewRuntimeTypography(
      {
        ...DEFAULT_RUNTIME_SETTINGS,
        fontBodyColor: '#ffffff',
        fontMutedColor: '#c5ccd4',
        fontFamily: 'dm-mono',
        fontSize: 's',
      },
      { setProperty }
    );

    expect(setProperty).toHaveBeenCalledWith('--ast-text', '#ffffff');
    expect(setProperty).toHaveBeenCalledWith('--font-sans', FONT_FAMILY_STACKS['dm-mono']);
    expect(setProperty).toHaveBeenCalledWith('--text-base', '12px');
  });
});
