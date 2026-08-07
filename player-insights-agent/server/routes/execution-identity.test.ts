import { afterEach, describe, expect, it } from 'vitest';
import {
  accessDecisionFor,
  accessModeFor,
  appServicePrincipal,
  declareAccessMode,
  executionIdentityColumns,
  forgetAccessDecisions,
  forgetServingPrincipal,
  isAccessMode,
  observedServingPrincipal,
  recordVerifiedAccess,
  rememberServingPrincipal,
} from './execution-identity';

const USER = 'analyst@example.com';

afterEach(() => {
  forgetServingPrincipal();
  forgetAccessDecisions();
  delete process.env.DATABRICKS_CLIENT_ID;
});

describe('the app service principal', () => {
  it('is read from the environment each time, because a deploy can change it', () => {
    process.env.DATABRICKS_CLIENT_ID = 'app-sp-1';
    expect(appServicePrincipal()).toBe('app-sp-1');
    process.env.DATABRICKS_CLIENT_ID = 'app-sp-2';
    expect(appServicePrincipal()).toBe('app-sp-2');
  });

  it('is null rather than a placeholder when unset, so nothing stores a fake identity', () => {
    expect(appServicePrincipal()).toBeNull();
    process.env.DATABRICKS_CLIENT_ID = '   ';
    expect(appServicePrincipal()).toBeNull();
  });
});

describe('the serving principal', () => {
  it('is unknown until a preflight report has actually said what it is', () => {
    expect(observedServingPrincipal()).toBeNull();
  });

  it('is remembered with the time it was observed, because it rotates on redeploy', () => {
    rememberServingPrincipal({ principal: 'serving-sp', principal_resolved: true });
    const observed = observedServingPrincipal();
    expect(observed?.id).toBe('serving-sp');
    expect(Date.parse(observed?.observedAt ?? '')).not.toBeNaN();
  });

  it('ignores a report that could not resolve it, so a failed lookup never becomes an identity', () => {
    rememberServingPrincipal({ principal: '<agent-serving-principal>', principal_resolved: false });
    expect(observedServingPrincipal()).toBeNull();
  });

  it('ignores an empty principal even when the report claims it resolved', () => {
    rememberServingPrincipal({ principal: '  ', principal_resolved: true });
    expect(observedServingPrincipal()).toBeNull();
  });
});

describe('the access mode', () => {
  it('defaults to service-principal, which is what executes whether or not anyone was asked', () => {
    expect(accessModeFor('nobody@example.com')).toBe('service-principal');
    expect(accessDecisionFor('nobody@example.com')).toBeNull();
  });

  it('lets a caller put itself in a weaker mode', () => {
    declareAccessMode(USER, 'skipped', 'skipped the gate');
    expect(accessModeFor(USER)).toBe('skipped');
  });

  it('refuses to take user-verified on the caller\u2019s word', () => {
    expect(() => declareAccessMode(USER, 'user-verified', 'trust me')).toThrow(/not.*declaring/i);
    expect(accessModeFor(USER)).toBe('service-principal');
  });

  it('grants user-verified only through the path that ran the checks', () => {
    recordVerifiedAccess(USER, 'holds SELECT on 10 tables');
    expect(accessModeFor(USER)).toBe('user-verified');
    expect(accessDecisionFor(USER)?.detail).toContain('10 tables');
  });

  it('keeps one user\u2019s decision away from another\u2019s', () => {
    recordVerifiedAccess(USER, 'verified');
    expect(accessModeFor('someone.else@example.com')).toBe('service-principal');
  });

  it('recognises exactly the three modes', () => {
    expect(isAccessMode('service-principal')).toBe(true);
    expect(isAccessMode('user-verified')).toBe(true);
    expect(isAccessMode('skipped')).toBe(true);
    expect(isAccessMode('admin')).toBe(false);
    expect(isAccessMode(undefined)).toBe(false);
  });
});

describe('the columns written against a turn', () => {
  it('records all four facts when everything is known', () => {
    process.env.DATABRICKS_CLIENT_ID = 'app-sp';
    rememberServingPrincipal({ principal: 'serving-sp', principal_resolved: true });
    recordVerifiedAccess(USER, 'verified');
    const [app, serving, observedAt, mode] = executionIdentityColumns(USER);
    expect(app).toBe('app-sp');
    expect(serving).toBe('serving-sp');
    expect(typeof observedAt).toBe('string');
    expect(mode).toBe('user-verified');
  });

  it('leaves the serving principal null rather than guessing at it', () => {
    process.env.DATABRICKS_CLIENT_ID = 'app-sp';
    const [app, serving, observedAt, mode] = executionIdentityColumns(USER);
    expect(app).toBe('app-sp');
    expect(serving).toBeNull();
    expect(observedAt).toBeNull();
    // Still the truthful label: the service principals executed it either way.
    expect(mode).toBe('service-principal');
  });

  it('does not carry the asker, which lives on the conversation it belongs to', () => {
    expect(executionIdentityColumns(USER)).not.toContain(USER);
  });
});
