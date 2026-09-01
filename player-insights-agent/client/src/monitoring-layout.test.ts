import { describe, expect, it } from 'vitest';

import { partial, stylesheet } from './styles/stylesheet';

const CSS = stylesheet().replace(/\/\*[\s\S]*?\*\//g, ' ');
const MONITORING = partial('monitoring.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const RESPONSIVE = partial('responsive-monitoring.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

function rule(selector: string, source = MONITORING): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return body;
}

function media(maxWidth: number): string {
  const start = RESPONSIVE.indexOf(`@media (max-width: ${maxWidth}px)`);
  if (start < 0) throw new Error(`no ${maxWidth}px Monitoring media query`);
  const next = RESPONSIVE.indexOf('@media ', start + 1);
  return RESPONSIVE.slice(start, next < 0 ? undefined : next);
}

describe('Monitoring heading and action geometry', () => {
  it('keeps the heading left and the compact action group right on desktop', () => {
    const heading = rule('.page-heading', CSS);
    const actions = rule('.monitoring-heading-actions');

    expect(heading).toMatch(/display:\s*flex/);
    expect(heading).toMatch(/justify-content:\s*space-between/);
    expect(actions).toMatch(/display:\s*flex/);
    expect(actions).toMatch(/justify-content:\s*flex-end/);
    expect(actions).toMatch(/flex-wrap:\s*wrap/);
    expect(actions).toMatch(/min-width:\s*0/);
  });

  it('wraps actions beneath the heading at tablet width', () => {
    const tablet = media(800);

    expect(CSS).toMatch(/@media\s*\(max-width:\s*800px\)[\s\S]*?\.page-heading\s*\{[^}]*flex-direction:\s*column/);
    expect(tablet).toMatch(/\.monitoring-heading-actions\s*\{[^}]*width:\s*100%/);
    expect(tablet).toMatch(/\.monitoring-heading-actions\s*\{[^}]*justify-content:\s*flex-start/);
  });

  it('stacks the selector and freshness controls on a phone', () => {
    const phone = media(480);

    expect(phone).toMatch(/\.monitoring-heading-actions\s*\{[^}]*flex-direction:\s*column/);
    expect(phone).toMatch(/\.monitoring-heading-actions\s*\{[^}]*align-items:\s*flex-start/);
    expect(phone).toMatch(
      /\.monitoring-heading-period,\s*\.monitoring-heading-actions \.refresh-control\s*\{[^}]*max-width:\s*100%/
    );
  });

  it('lets all four segments share the narrowest supported row without clipping', () => {
    const narrow = media(380);

    expect(narrow).toMatch(/\.monitoring-heading-period\s*\{[^}]*width:\s*100%/);
    expect(narrow).toMatch(
      /\.monitoring-heading-period \.time-range,\s*\.monitoring-heading-period \.time-range-segments\s*\{[^}]*width:\s*100%/
    );
    expect(narrow).toMatch(
      /\.monitoring-heading-period \.time-range-segment\s*\{[^}]*min-width:\s*0[^}]*flex:\s*1\s+1\s+0/
    );
  });
});

describe('Monitoring KPI and secondary-filter geometry', () => {
  it('keeps every card header shrinkable while its period badge stays intact', () => {
    const head = rule('.monitoring-tile-head');
    const badge = rule('.monitoring-period-badge');

    expect(head).toMatch(/min-width:\s*0/);
    expect(head).toMatch(/display:\s*flex/);
    expect(head).toMatch(/justify-content:\s*space-between/);
    expect(badge).toMatch(/flex:\s*none/);
    expect(badge).toMatch(/white-space:\s*nowrap/);
  });

  it('preserves equal card heights and aligned outcome rows', () => {
    expect(rule('.monitoring-tile')).toMatch(/grid-template-rows:\s*auto\s+1fr\s+auto/);
    expect(rule('.monitoring-tile')).toMatch(/min-height:\s*82px/);
    expect(rule('.monitoring-outcomes-tile')).toMatch(/grid-template-rows:\s*auto\s+1fr\s+auto/);
    expect(rule('.monitoring-outcome-grid')).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('keeps all five cards on one desktop row and reflows them on tablet and phone', () => {
    expect(rule('.monitoring-strip')).toContain('grid-template-columns: repeat(7, minmax(0, 1fr))');
    expect(rule('.monitoring-outcomes-tile')).toContain('grid-column: span 3');
    expect(media(800)).toMatch(
      /\.monitoring-page \.monitoring-strip\s*\{[^}]*'questions threads'[^}]*'outcomes outcomes'[^}]*'rated median'/
    );
    expect(media(480)).toMatch(
      /\.monitoring-outcome-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
    );
  });

  it('leaves the lower row to Person, Outcome, Rating, Table, and Search', () => {
    expect(rule('.monitoring-filters')).toMatch(/display:\s*flex/);
    expect(rule('.monitoring-filters')).toMatch(/flex-wrap:\s*wrap/);
    expect(MONITORING).not.toContain('.monitoring-period {');
    expect(MONITORING).not.toContain('.monitoring-filters-rule');
    expect(rule('.monitoring-search')).toMatch(/margin-left:\s*auto/);
    expect(media(1180)).toMatch(/\.monitoring-search\s*\{[^}]*flex:\s*1\s+1\s+100%/);
  });
});
