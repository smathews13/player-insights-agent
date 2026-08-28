import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_EXPERIMENTS, type ExperimentalFeatures } from './experimental-features';
import { OpsPage } from './OpsPage';
import { autoLoadOpsBlock, forgetOpsSession, opsAutoLoadClaimed } from './ops-session';

function renderOps(features: ExperimentalFeatures): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/ops']}>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                features,
                setFeature: () => {},
                role: { state: 'admin', addedAdminsReadable: true },
              }}
            />
          }
        >
          <Route path="/ops" element={<OpsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  forgetOpsSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Cost estimates experiment on Ops', () => {
  it('hides the entire cost surface by default', () => {
    const markup = renderOps({ ...NO_EXPERIMENTS });

    expect(markup).not.toContain('ops-cost-heading');
    expect(markup).not.toContain('Ops cost');
    expect(markup).toContain('ops-health-heading');
    expect(markup).toContain('ops-traffic-heading');
    expect(markup).toContain('ops-latency-heading');
  });

  it('renders the cost surface and its range control when enabled', () => {
    const markup = renderOps({ ...NO_EXPERIMENTS, costEstimates: true });

    expect(markup).toContain('ops-cost-heading');
    expect(markup).toContain('time-range-segments');
  });

  it('does not fetch or claim the cost route while disabled', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const key = '/api/ops/cost:7d';

    expect(autoLoadOpsBlock(false, key, '/api/ops/cost?from=a&to=b')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(opsAutoLoadClaimed(key)).toBe(false);
  });

  it('fetches the cost route once when enabled', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ readAt: '2026-08-28T12:00:00.000Z' }),
    });
    vi.stubGlobal('fetch', fetch);
    const key = '/api/ops/cost:7d';

    await expect(autoLoadOpsBlock(true, key, '/api/ops/cost?from=a&to=b')).resolves.toEqual({
      data: { readAt: '2026-08-28T12:00:00.000Z' },
      failed: '',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/ops/cost?from=a&to=b', {
      headers: { accept: 'application/json' },
    });
    expect(opsAutoLoadClaimed(key)).toBe(true);
  });
});
