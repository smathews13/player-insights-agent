import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DashboardCard } from './DashboardCard';
import type { Dashboard } from '../../shared/dashboard-contract';

const SOURCE = readFileSync(new URL('./DashboardCard.tsx', import.meta.url), 'utf8');
const HTML = '<!DOCTYPE html><html><body><script>alert(1)</script><h1>Players</h1></body></html>';

const DASHBOARD: Dashboard = {
  schemaVersion: 'pia.dashboard/1',
  title: 'Cross-franchise reach',
  html: HTML,
  generatedAt: '2026-09-22T23:00:00Z',
  caveats: ['One source was unavailable.'],
};

describe('DashboardCard', () => {
  it('renders the complete document only through an empty-permission sandbox', () => {
    const markup = renderToStaticMarkup(<DashboardCard dashboard={DASHBOARD} />);

    expect(markup).toContain('title="Cross-franchise reach"');
    expect(markup).toContain('sandbox=""');
    expect(markup).not.toContain('allow-scripts');
    expect(markup).not.toContain('allow-same-origin');
    expect(markup).not.toContain('allow-popups');
    expect(SOURCE).toContain('srcDoc={dashboard.html}');
    expect(SOURCE).not.toContain('dangerouslySetInnerHTML');
  });

  it('shows caveats above the frame and exposes the dedicated HTML download', () => {
    const markup = renderToStaticMarkup(<DashboardCard dashboard={{ ...DASHBOARD, truncated: true }} />);
    const caveat = markup.indexOf('This dashboard was truncated');
    const frame = markup.indexOf('<iframe');

    expect(caveat).toBeGreaterThan(-1);
    expect(caveat).toBeLessThan(frame);
    expect(markup).toContain('One source was unavailable.');
    expect(markup).toContain('Download HTML Dashboard');
  });
});
