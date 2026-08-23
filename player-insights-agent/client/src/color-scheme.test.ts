import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { applyColorScheme, DARK_THEME_COLOR, LIGHT_THEME_COLOR } from './color-scheme';

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
    const meta = fakeRoot();
    applyColorScheme('dark', root, meta);
    expect(root.classList.contains('light')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(meta.getAttribute('content')).toBe(DARK_THEME_COLOR);

    applyColorScheme('light', root, meta);
    expect(root.classList.contains('light')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(meta.getAttribute('content')).toBe(LIGHT_THEME_COLOR);
  });

  it('boots dark before React or settings fetch', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/<html[^>]*class="light"[^>]*data-theme="dark"/);
    expect(html).toMatch(/<meta name="theme-color" content="#11171C"\s*\/>/);
  });

  it('does not require a document to exist', () => {
    expect(() => applyColorScheme('dark', null)).not.toThrow();
  });
});
