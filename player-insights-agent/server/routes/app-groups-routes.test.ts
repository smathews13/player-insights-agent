import { describe, expect, it, vi } from 'vitest';
import { setupAppGroupsRoutes } from './app-groups-routes';
import type { InsightsAppKit } from './insights-routes';

describe('Teams admin routes', () => {
  it('registers reads and writes only under the guarded admin prefix', () => {
    const get = vi.fn();
    const put = vi.fn();
    setupAppGroupsRoutes({
      server: { extend: (register: (app: { get: typeof get; put: typeof put }) => void) => register({ get, put }) },
    } as unknown as InsightsAppKit);
    expect(get).toHaveBeenCalledWith('/api/admin/app-groups', expect.any(Function));
    expect(put).toHaveBeenCalledWith('/api/admin/app-groups', expect.any(Function));
  });
});
