import { describe, expect, it } from 'vitest';
import {
  GRANT_SCRIPT_COMMAND,
  GRANT_SCRIPT_ENV_VARS,
  GRANT_HOOK_PATH,
  GRANT_SCRIPT_PATH,
  GRANT_SCRIPT_WHY,
} from './setup-remedies';

describe('grant script operator copy', () => {
  it('keeps the underlying script contract and shows the supported wrapper', () => {
    expect(GRANT_SCRIPT_ENV_VARS).toEqual([
      'DATABRICKS_CONFIG_PROFILE',
      'PGHOST',
      'PGDATABASE',
      'PGUSER',
      'APP_PG_ROLE',
    ]);
    expect(GRANT_SCRIPT_COMMAND).toContain(GRANT_HOOK_PATH);
    expect(GRANT_SCRIPT_COMMAND).toContain('TARGET=<target>');
    expect(GRANT_SCRIPT_COMMAND).toContain("PROFILE='<profile>'");
    expect(GRANT_SCRIPT_COMMAND).toContain('databricks apps start');
    expect(GRANT_SCRIPT_PATH).toBe('scripts/grant-app-db-access.mjs');
  });

  it('says releases apply the grant and reattach remains the manual escape', () => {
    expect(GRANT_SCRIPT_WHY).toContain('reattach');
    expect(GRANT_SCRIPT_WHY).toContain('does not exist until the app does');
    expect(GRANT_SCRIPT_WHY).toContain(GRANT_HOOK_PATH);
    expect(GRANT_SCRIPT_WHY).toContain('failed grant stops the release');
  });

  it('mentions the AppKit cache schema the script drops for ownership', () => {
    expect(GRANT_SCRIPT_WHY).toContain('appkit');
  });
});
