import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/runtime-settings';
import { adoptRuntimeEntityStyles } from './runtime-entity-styles';

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
});
