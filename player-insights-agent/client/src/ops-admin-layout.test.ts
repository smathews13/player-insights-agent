import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OPS_STYLES = readFileSync(new URL('./styles/ops.css', import.meta.url), 'utf8');
const RESPONSIVE_OPS_STYLES = readFileSync(new URL('./styles/responsive-ops.css', import.meta.url), 'utf8');
const OPS_PAGE_SOURCE = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');

describe('Ops Admin control geometry', () => {
  it('uses one PIA card with a single header and a two-by-two action grid', () => {
    expect(OPS_STYLES).toMatch(
      /\.ops-admin-panel\s*\{[^}]*width:\s*min\(100%,\s*48rem\)[^}]*margin-left:\s*auto[^}]*border:\s*1px solid[^}]*border-radius:\s*var\(--ast-radius-card\)/
    );
    expect(OPS_STYLES).toMatch(
      /\.ops-admin-panel-heading\s*\{[^}]*display:\s*flex[^}]*border-bottom:\s*1px solid var\(--ast-neg-border\)/
    );
    expect(OPS_STYLES).toMatch(
      /\.ops-page-controls\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-auto-rows:\s*1fr[^}]*width:\s*100%/
    );
    expect(OPS_STYLES).toMatch(
      /\.ops-admin-action\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*padding:\s*12px[^}]*background:\s*var\(--card\)/
    );
  });

  it('shows ADMIN once, then the four icon, description, and button actions', () => {
    expect(OPS_PAGE_SOURCE.match(/id="ops-admin-heading">ADMIN<\/strong>/g)).toHaveLength(1);
    expect(OPS_PAGE_SOURCE).toMatch(
      /<ShieldCheck[\s\S]*?<strong>Check all scopes<\/strong>[\s\S]*?<span>Compare user and app catalog access\.<\/span>/
    );
    expect(OPS_PAGE_SOURCE).toMatch(
      /<CircleStop[\s\S]*?<strong>Stop active runs<\/strong>[\s\S]*?without deleting data or history/
    );
    expect(OPS_PAGE_SOURCE).toMatch(
      /<Snowflake[\s\S]*?<strong>Freeze queries<\/strong>[\s\S]*?className="ops-freeze-queries-button"/
    );
    expect(OPS_PAGE_SOURCE).toMatch(
      /<RefreshCw[\s\S]*?<strong>Update all Ops views<\/strong>[\s\S]*?className="ops-update-all-button"/
    );
  });

  it('stacks the panel at the medium breakpoint and fills narrow screens', () => {
    expect(RESPONSIVE_OPS_STYLES).toMatch(
      /@media \(max-width:\s*800px\)[\s\S]*?\.ops-admin-panel\s*\{[^}]*width:\s*min\(100%,\s*18rem\)/
    );
    expect(RESPONSIVE_OPS_STYLES).toMatch(
      /@media \(max-width:\s*800px\)[\s\S]*?\.ops-page-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*18rem\)[^}]*width:\s*100%/
    );
    expect(RESPONSIVE_OPS_STYLES).toMatch(
      /@media \(max-width:\s*480px\)[\s\S]*?\.ops-admin-panel,[\s\S]*?\.ops-admin-action\s*\{[^}]*width:\s*100%/
    );
  });
});
