import { describe, expect, it } from 'vitest';

import {
  browseAppsHasNoScopeDetail,
  browseScopeUnavailableDetail,
  isBrowseOk,
  isBrowseUnavailable,
  isCatalogBrowseScope,
  type BrowseResponse,
} from './browse-contract';

describe('browse-contract', () => {
  it('keeps ok, unavailable and failed as three statuses', () => {
    const ok: BrowseResponse = {
      status: 'ok',
      kind: 'catalogs',
      items: [],
      next_page_token: '',
      path: '',
    };
    const unavailable: BrowseResponse = {
      status: 'unavailable',
      kind: 'catalogs',
      reason: 'scope_not_carried',
      scope: 'catalog.catalogs:read',
      detail: browseScopeUnavailableDetail('catalog.catalogs:read'),
    };
    const failed: BrowseResponse = {
      status: 'failed',
      kind: 'catalogs',
      detail: 'broke',
      error: 'timeout',
    };

    expect(isBrowseOk(ok)).toBe(true);
    expect(isBrowseUnavailable(ok)).toBe(false);
    expect(isBrowseOk(unavailable)).toBe(false);
    expect(isBrowseUnavailable(unavailable)).toBe(true);
    expect(isBrowseOk(failed)).toBe(false);
    expect(isBrowseUnavailable(failed)).toBe(false);
  });

  it('an empty ok list is still ok, not unavailable', () => {
    const empty: BrowseResponse = {
      status: 'ok',
      kind: 'warehouses',
      items: [],
      next_page_token: '',
      path: '',
    };
    expect(isBrowseOk(empty)).toBe(true);
    expect(empty.items).toEqual([]);
  });

  it('names the three optional catalog scopes as catalog browse scopes', () => {
    expect(isCatalogBrowseScope('catalog.catalogs:read')).toBe(true);
    expect(isCatalogBrowseScope('catalog.schemas:read')).toBe(true);
    expect(isCatalogBrowseScope('catalog.tables:read')).toBe(true);
    expect(isCatalogBrowseScope('sql')).toBe(false);
    expect(isCatalogBrowseScope('dashboards.genie')).toBe(false);
  });

  it('unavailable prose names the scope and does not use an em dash', () => {
    const detail = browseScopeUnavailableDetail('catalog.catalogs:read');
    expect(detail).toContain('`catalog.catalogs:read`');
    expect(detail).toContain('Browsing is unavailable');
    expect(detail).not.toMatch(/\u2014/);
    expect(detail).not.toMatch(/—/);
  });

  it('names Apps having no scope as a distinct unavailable reason', () => {
    const unavailable: BrowseResponse = {
      status: 'unavailable',
      kind: 'experiments',
      reason: 'apps_has_no_scope',
      scope: '',
      detail: browseAppsHasNoScopeDetail('MLflow'),
    };
    expect(isBrowseUnavailable(unavailable)).toBe(true);
    expect(unavailable.detail).toContain('no MLflow scope');
    expect(unavailable.detail).not.toMatch(/\u2014/);
  });
});
