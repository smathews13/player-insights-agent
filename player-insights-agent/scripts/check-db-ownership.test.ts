import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a one-off operator script, deliberately outside the tsconfig projects.
import { schemaNeedsNewName } from './check-db-ownership.mjs';

describe('schemaNeedsNewName', () => {
  const appRole = 'new-app-service-principal';

  it('requires a new schema when another principal owns the existing one', () => {
    expect(schemaNeedsNewName('dead-app-service-principal', appRole)).toBe(true);
  });

  it('keeps the configured schema when the current app owns it', () => {
    expect(schemaNeedsNewName(appRole, appRole)).toBe(false);
  });
});
