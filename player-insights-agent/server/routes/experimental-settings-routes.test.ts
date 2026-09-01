import { describe, expect, it } from 'vitest';
import { isAdminRoute } from '../lib/admin-roles';

describe('Experimental settings route scope', () => {
  it('lets signed-in readers consume visibility while admin-gating writes', () => {
    expect(isAdminRoute('/api/experimental-settings')).toBe(false);
    expect(isAdminRoute('/api/admin/experimental-settings')).toBe(true);
  });
});
