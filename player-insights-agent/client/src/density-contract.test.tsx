import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/runtime-settings';
import { writeRuntimeAppearanceAttributes } from './runtime-entity-styles';

const ROOT_CSS = readFileSync(new URL('./styles/appearance-preferences.css', import.meta.url), 'utf8');
const ROUTE_DENSITY_FILES = [
  'density-runs.css',
  'density-monitoring.css',
  'density-ops.css',
  'density-connections.css',
  'density-architecture.css',
  'density-settings.css',
  'density-benchmark.css',
] as const;
const CSS = [
  ROOT_CSS,
  ...ROUTE_DENSITY_FILES.map((file) => readFileSync(new URL(`./styles/${file}`, import.meta.url), 'utf8')),
].join('\n');
const DIALOG = readFileSync(new URL('./Dialog.tsx', import.meta.url), 'utf8');

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

function pixelToken(source: string, name: string): number {
  const value = source.match(new RegExp(`${name}:\\s*(\\d+)px`))?.[1];
  if (!value) throw new Error(`Missing ${name}`);
  return Number(value);
}

describe('app-wide density contract', () => {
  it('covers every major surface family with the canonical compact root selector', () => {
    const families = {
      chrome: ['.app-nav-tab', '.account-menu-group > button'],
      conversation: ['.conversation-row', '.composer', '.attachment-chip', '.answer-card-content', '.run-process-body'],
      runExplorer: [
        '.run-list-filters',
        '.run-detail-head',
        '.summary-grid',
        '.trace-dag.map .dag-node',
        '.trace-gantt tbody td',
        '.trace-detail-content',
      ],
      monitoring: [
        '.monitoring-filters',
        '.monitoring-tile',
        '.monitoring-row td',
        '.monitoring-drawer-section',
        '.monitoring-user-row',
        '.user-profile-modal-kpi',
      ],
      operations: [
        '.ops-block-head',
        '.ops-tile',
        '.ops-number-ticker',
        '.ops-chart',
        '.ops-table td',
        '.ops-methodology-rows > div',
        '.ops-forecast-horizon',
      ],
      connections: [
        '.connection-group',
        '.connection-row-summary',
        '.connections-table td',
        '.asset-picker-row',
        '.identity-fact',
        '.deployment-card-body',
        '.plane-card-body',
      ],
      architecture: ['.arch-loop-tiles li', '.arch-node', '.arch-legend li', '.arch-rail-row', '.arch-contract-row'],
      settings: [
        '.settings-modal-content',
        '.settings-rail button',
        '.runtime-section',
        '.appearance-display-row',
        '.settings-data-table td',
      ],
      evaluation: [
        '.benchmark-lab',
        '.bench-region-head',
        '.bench-stage',
        '.bench-sheet td',
        '.bench-failure-drawer',
        '.eval-compare-grid',
      ],
      portals: [
        ".app-select-content [data-slot='select-item']",
        ".monitoring-chip-menu [data-slot='select-item']",
        '.user-profile-modal',
      ],
    };

    for (const [family, selectors] of Object.entries(families)) {
      for (const selector of selectors) {
        expect(CSS, `${family} is missing ${selector}`).toContain(selector);
      }
    }
    expect(CSS.match(/html\[data-density='compact']/g)?.length).toBeGreaterThan(80);
  });

  it('keeps route-only density CSS in each lazy route bundle', () => {
    for (const route of ['runs', 'monitoring', 'ops', 'connections', 'architecture', 'settings', 'benchmark']) {
      const routeCss = readFileSync(new URL(`./styles/routes/${route}.css`, import.meta.url), 'utf8');
      expect(routeCss).toContain(`@import '../density-${route}.css';`);
    }
    for (const routeSentinel of [
      '.monitoring-page',
      '.ops-page',
      '.connections-page',
      '.architecture-page',
      '.settings-modal-body',
      '.benchmark-lab',
    ]) {
      expect(ROOT_CSS, `${routeSentinel} leaked into the initial stylesheet`).not.toContain(routeSentinel);
    }
  });

  it('tightens spacing and rows by roughly 15–25 percent without changing typography', () => {
    const comfortable = block(':root');
    const compact = block("html[data-density='compact']");
    const proportionalTokens = [
      '--density-page-gap',
      '--density-section-gap',
      '--density-card-gap',
      '--density-card-padding-block',
      '--density-inline-padding',
      '--density-row-height',
      '--density-row-padding-block',
      '--density-table-padding-block',
      '--density-modal-padding',
    ];

    for (const token of proportionalTokens) {
      const ratio = pixelToken(compact, token) / pixelToken(comfortable, token);
      expect(ratio, token).toBeGreaterThanOrEqual(0.75);
      expect(ratio, token).toBeLessThanOrEqual(0.85);
    }

    expect(CSS).not.toMatch(/html\[data-density='compact'][^{]*\{[^}]*font-size\s*:/s);
    expect(CSS).not.toMatch(/html\[data-density='compact'][^{]*\{[^}]*--text-/s);
  });

  it('keeps desktop controls at 32px and restores 44px touch targets on mobile', () => {
    const compact = block("html[data-density='compact']");
    expect(pixelToken(compact, '--density-control-height')).toBeGreaterThanOrEqual(32);
    expect(CSS).toMatch(
      /@media \(max-width:\s*800px\)[\s\S]*?html\[data-density='compact']\s*\{[^}]*--density-row-height:\s*44px[^}]*--density-control-height:\s*44px/s
    );
    expect(CSS).not.toMatch(/html\[data-density='compact'][^{]*\{[^}]*overflow\s*:/s);
  });

  it('puts portalled content under the same html density contract', () => {
    const attributes = new Map<string, string>();
    writeRuntimeAppearanceAttributes(
      { ...DEFAULT_RUNTIME_SETTINGS, density: 'compact' },
      { setAttribute: (name, value) => attributes.set(name, value) }
    );
    const markup = renderToStaticMarkup(
      <html data-density={attributes.get('data-density')}>
        <body>
          <div data-portal-root="">
            <div className="app-select-content" data-slot="select-content">
              <div data-slot="select-item">Compact portal row</div>
            </div>
          </div>
        </body>
      </html>
    );

    expect(markup).toContain('<html data-density="compact">');
    expect(markup).toContain('data-portal-root=""');
    expect(markup).toContain('data-slot="select-item"');
    expect(DIALOG).toContain('createPortal(overlay, document.body)');
    expect(CSS).toContain("html[data-density='compact'] .app-select-content [data-slot='select-item']");
  });
});
