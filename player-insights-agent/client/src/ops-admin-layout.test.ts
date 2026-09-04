import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OPS_STYLES = readFileSync(new URL('./styles/ops.css', import.meta.url), 'utf8');
const RESPONSIVE_OPS_STYLES = readFileSync(new URL('./styles/responsive-ops.css', import.meta.url), 'utf8');
const OPS_PAGE_SOURCE = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');

describe('Ops Admin control geometry', () => {
  it('uses two equal full-content columns with equal-height bars on desktop', () => {
    expect(OPS_STYLES).toMatch(
      /\.ops-page-controls\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-auto-rows:\s*1fr[^}]*width:\s*100%/
    );
    expect(OPS_STYLES).not.toMatch(
      /\.ops-page-controls\s*\{[^}]*(?:width:\s*min\(100%,\s*50%\)|min-width:\s*420px|margin-left:\s*auto)/
    );
    expect(OPS_STYLES).toMatch(
      /\.ops-stop-all,\s*\.ops-admin-action\s*\{[^}]*align-items:\s*center[^}]*padding:\s*6px 8px 6px 10px[^}]*border:\s*1px solid[^}]*border-radius:[^}]*width:\s*100%[^}]*min-height:\s*46px/
    );
  });

  it('pushes both actions to the same right inset', () => {
    expect(OPS_STYLES).toMatch(
      /\.ops-admin-action-scope \.ops-scope-check-button,\s*\.ops-stop-all \.ops-stop-all-button\s*\{[^}]*margin-left:\s*auto/
    );
    expect(OPS_PAGE_SOURCE).toMatch(
      /<section className="ops-stop-all"[\s\S]*?<strong[^>]*>ADMIN<\/strong>[\s\S]*?<span>No data or history is deleted\.<\/span>[\s\S]*?<Button[\s\S]*?className="ops-stop-all-button"/
    );
    expect(OPS_PAGE_SOURCE).toMatch(
      /<section className="ops-admin-action ops-admin-action-scope"[\s\S]*?<strong[^>]*>ADMIN<\/strong>[\s\S]*?<span>Compare user and app catalog access\.<\/span>[\s\S]*?\{action\}/
    );
  });

  it('stacks both bars at the medium breakpoint', () => {
    expect(RESPONSIVE_OPS_STYLES).toMatch(
      /@media \(max-width:\s*800px\)[\s\S]*?\.ops-page-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*width:\s*100%/
    );
  });
});
