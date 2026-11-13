import { describe, expect, it } from 'vitest';
import { describeUserApiScopes } from './scope-announcement';

const env = (value?: string) => (value === undefined ? {} : { PLAYER_INSIGHTS_USER_API_SCOPES: value });

describe('the startup scope line', () => {
  it('names the requested scopes and nothing else when they are the ones PIA uses', () => {
    expect(describeUserApiScopes(env('serving.serving-endpoints,model-serving,sql,dashboards.genie,genie'))).toBe(
      '[scopes] User scopes requested: serving.serving-endpoints, model-serving, sql, dashboards.genie, genie.'
    );
  });

  it('calls out a scope PIA does not use', () => {
    expect(
      describeUserApiScopes(env('serving.serving-endpoints,model-serving,sql,dashboards.genie,clusters'))
    ).toContain('Not used by PIA, remove from app_user_api_scopes: clusters.');
  });

  it('calls out a missing question scope', () => {
    expect(describeUserApiScopes(env('sql,dashboards.genie'))).toContain(
      'Missing for questions: serving.serving-endpoints, model-serving.'
    );
  });

  it('says so when the deployment was not told its scopes', () => {
    expect(describeUserApiScopes(env())).toBe('[scopes] This deployment was not told which user scopes it requests.');
  });
});
