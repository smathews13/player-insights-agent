import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial } from './styles/stylesheet';

describe('chrome actions use the shared primary blue', () => {
  it('draws the completed-run link as a primary action', () => {
    const page = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
    const css = partial('rail.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const rule = css.match(/(?:^|})\s*\.trace-inspector \.trace-explore\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(page).toContain('<Button variant="default" className="trace-explore w-full"');
    expect(rule).toMatch(/background:\s*var\(--db-blue-600\)/);
    expect(rule).toMatch(/color:\s*#fff/);
    expect(rule).toMatch(/font-weight:\s*600/);
  });
});
