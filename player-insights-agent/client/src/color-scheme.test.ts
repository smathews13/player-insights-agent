import { describe, expect, it } from 'vitest';

import { applyColorScheme } from './color-scheme';

function fakeRoot() {
  const attrs = new Map<string, string>();
  const classes = new Set<string>();
  return {
    classList: {
      add: (name: string) => {
        classes.add(name);
      },
      contains: (name: string) => classes.has(name),
    },
    setAttribute: (name: string, value: string) => {
      attrs.set(name, value);
    },
    getAttribute: (name: string) => attrs.get(name) ?? null,
  };
}

describe('color scheme', () => {
  it('keeps the AppKit light class and paints from data-theme', () => {
    const root = fakeRoot();
    applyColorScheme('dark', root);
    expect(root.classList.contains('light')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('dark');

    applyColorScheme('light', root);
    expect(root.classList.contains('light')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('does not require a document to exist', () => {
    expect(() => applyColorScheme('dark', null)).not.toThrow();
  });
});
