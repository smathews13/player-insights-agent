import { describe, expect, it } from 'vitest';
import { workspaceAppsHref } from './account-routes';

describe('Databricks Apps link', () => {
  it('uses the configured workspace and never guesses one', () => {
    expect(workspaceAppsHref({ DATABRICKS_HOST: 'workspace.example.com/' })).toBe('https://workspace.example.com/apps');
    expect(workspaceAppsHref({})).toBe('');
  });
});
