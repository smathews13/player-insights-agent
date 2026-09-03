import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EstimatedBadge } from './EstimatedBadge';

describe('shared Estimated badge', () => {
  it('uses the neutral Ops Cost badge treatment', () => {
    const markup = renderToStaticMarkup(<EstimatedBadge />);
    expect(markup).toContain('ast-pill--neutral-outline');
    expect(markup).toContain('ast-estimated-badge');
    expect(markup).toContain('>Estimated</span>');
  });

  it('matches Ops Cost and is shared by every User Monitoring card', () => {
    const ops = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');
    const monitoring = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');
    const opsCss = readFileSync(new URL('./styles/ops.css', import.meta.url), 'utf8');
    const sharedCss = readFileSync(new URL('./styles/astrolabe-chrome.css', import.meta.url), 'utf8');
    expect(ops).toContain("astPill('neutral-outline', 'ops-pill ops-cost-status')");
    for (const declaration of ['align-items: baseline', 'padding: 1px 6px', 'font-size: var(--ast-fs-11)']) {
      expect(opsCss).toContain(declaration);
      expect(sharedCss).toContain(declaration);
    }
    expect(monitoring.match(/<EstimatedBadge \/>/g)).toHaveLength(4);
  });
});
