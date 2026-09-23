import { describe, expect, it, vi } from 'vitest';
import { DASHBOARD_SCHEMA_VERSION, isDashboardPayload, normalizeDashboard } from './dashboard-contract';

describe('dashboard contract', () => {
  it('normalizes the complete standalone HTML envelope without rewriting it', () => {
    const html = '\n<!DOCTYPE html><html><body><h1>Players</h1></body></html>\n';
    expect(
      normalizeDashboard({
        schema_version: DASHBOARD_SCHEMA_VERSION,
        title: 'Player dashboard',
        html,
        generated_at: '2026-09-22T23:00:00Z',
        caveats: ['  One segment was unavailable.  '],
      })
    ).toEqual({
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      title: 'Player dashboard',
      html,
      generatedAt: '2026-09-22T23:00:00Z',
      caveats: ['One segment was unavailable.'],
    });
  });

  it('recognizes the explicit response type and the dashboard document shape', () => {
    expect(isDashboardPayload({ type: 'dashboard' })).toBe(true);
    expect(isDashboardPayload({ title: 'Players', html: '<!DOCTYPE html>' })).toBe(true);
    expect(isDashboardPayload({ type: 'report', title: 'Players' })).toBe(false);
  });

  it('logs a diagnostic without logging HTML when the envelope is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeDashboard({ title: '', html: '<script>secret()</script>' })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[dashboard] Dropped malformed dashboard payload.',
      expect.objectContaining({ hasTitle: false, hasHtml: true })
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    warn.mockRestore();
  });

  it('rejects an unknown version instead of rendering it as the current contract', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      normalizeDashboard({
        schema_version: 'pia.dashboard/2',
        title: 'Future dashboard',
        html: '<!DOCTYPE html><html></html>',
      })
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[dashboard] Unsupported dashboard schema version.',
      expect.objectContaining({ expected: DASHBOARD_SCHEMA_VERSION, received: 'pia.dashboard/2' })
    );
    warn.mockRestore();
  });
});
