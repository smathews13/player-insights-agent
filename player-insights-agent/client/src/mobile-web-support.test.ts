import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { partial } from './styles/stylesheet';

const HOME = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const DRAWER = readFileSync(new URL('MobileContextDrawer.tsx', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const RESPONSIVE = partial('responsive.css');

describe('mobile web support', () => {
  it('opts into device safe areas', () => {
    expect(INDEX).toContain('viewport-fit=cover');
    expect(RESPONSIVE).toContain('env(safe-area-inset-left, 0px)');
    expect(RESPONSIVE).toContain('env(safe-area-inset-right, 0px)');
    expect(RESPONSIVE).toContain('env(safe-area-inset-bottom, 0px)');
  });

  it('keeps both Ask side panels reachable as opposite-side drawers', () => {
    expect(HOME).toContain('className="mobile-ask-drawers"');
    expect(HOME).toContain('<SheetContent side="left" className="rail-sheet">');
    expect(HOME).toContain('<MobileContextDrawer label="Agent path"');
    expect(DRAWER).toContain('<SheetContent side="right" className="context-sheet">');
    expect(RESPONSIVE).toMatch(/\.context-sheet-trigger\s*\{[^}]*display:\s*inline-flex/);
  });

  it('uses phone-safe margins, controls, and input type size', () => {
    expect(RESPONSIVE).toMatch(
      /\.page-shell\s*\{[^}]*padding-inline:\s*max\(16px,\s*env\(safe-area-inset-left,\s*0px\)\)/s
    );
    expect(RESPONSIVE).toMatch(/\.rail-sheet-trigger\s*\{[^}]*min-height:\s*44px/);
    expect(RESPONSIVE).toMatch(/textarea\s*\{[^}]*font-size:\s*16px/);
  });
});
