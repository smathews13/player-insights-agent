import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RUNTIME_SETTINGS, FONT_FAMILY_STACKS } from '../../shared/runtime-settings';
import { adoptRuntimeEntityStyles } from './runtime-entity-styles';
import { forgetLiveRuntimeSettings } from './runtime-settings-live';

describe('saved Appearance colors', () => {
  it('apply to date and tag badges without waiting for a reload', () => {
    const setProperty = vi.fn();
    const settings = {
      ...DEFAULT_RUNTIME_SETTINGS,
      entityStyles: {
        ...DEFAULT_RUNTIME_SETTINGS.entityStyles,
        quote: { foreground: '#112233', background: '#ddeeff' },
        tag: { foreground: '#334455', background: '#eeffdd' },
      },
    };

    adoptRuntimeEntityStyles(settings, { setProperty });

    expect(setProperty).toHaveBeenCalledWith('--entity-quote-fg', '#112233');
    expect(setProperty).toHaveBeenCalledWith('--entity-quote-bg', '#ddeeff');
    expect(setProperty).toHaveBeenCalledWith('--entity-tag-fg', '#334455');
    expect(setProperty).toHaveBeenCalledWith('--entity-tag-bg', '#eeffdd');
  });

  it('applies the saved color scheme to the document', () => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const root = {
      classList: {
        add: (name: string) => {
          classes.add(name);
        },
        contains: (name: string) => classes.has(name),
      },
      style: { setProperty: vi.fn() },
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      getAttribute: (name: string) => attrs.get(name) ?? null,
    };
    vi.stubGlobal('document', { documentElement: root, querySelector: () => null });
    adoptRuntimeEntityStyles({ ...DEFAULT_RUNTIME_SETTINGS, colorScheme: 'light' }, root.style);
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.classList.contains('light')).toBe(true);
    adoptRuntimeEntityStyles(DEFAULT_RUNTIME_SETTINGS, root.style);
    expect(root.getAttribute('data-theme')).toBe('dark');
    vi.unstubAllGlobals();
  });

  it('applies saved type to CSS variables without waiting for a reload', () => {
    const setProperty = vi.fn();
    adoptRuntimeEntityStyles(
      {
        ...DEFAULT_RUNTIME_SETTINGS,
        fontBodyColor: '#ffeecc',
        fontMutedColor: '#8899aa',
        fontFamily: 'system',
        fontSize: 'l',
      },
      { setProperty }
    );

    expect(setProperty).toHaveBeenCalledWith('--ast-text', '#ffeecc');
    expect(setProperty).toHaveBeenCalledWith('--foreground', '#ffeecc');
    expect(setProperty).toHaveBeenCalledWith('--ast-text-secondary', '#8899aa');
    expect(setProperty).toHaveBeenCalledWith('--muted-foreground', '#8899aa');
    expect(setProperty).toHaveBeenCalledWith('--font-sans', FONT_FAMILY_STACKS.system);
    expect(setProperty).toHaveBeenCalledWith('--text-base', '15px');
    expect(setProperty).toHaveBeenCalledWith('--ast-fs-13', '15px');
  });
});

afterEach(() => {
  forgetLiveRuntimeSettings();
});
