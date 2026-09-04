import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CONNECTED_RESOURCES, connectedResource } from '../../shared/deployment-config';
import { PiaLoadingLabel } from './PiaLoadingLabel';
import type { CheckSession } from './check-session';
import {
  connectionLoadErrorLabel,
  connectionPlaceholderReadings,
  connectionResourceLoadState,
} from './connection-loading';
import { readConnection, type SettingsPayload } from './connection-model';
import { ConnectionLoadRow } from './ConnectionsPage';
import type { PreflightCheck } from './preflight';
import { partial } from './styles/stylesheet';

function row(id: string, configured = ''): SettingsPayload['resources'][number] {
  return {
    resource: connectedResource(id)!,
    configured,
    configuredFrom: 'artifact',
    actual: '',
    actualObserved: false,
    intended: null,
    intendedAt: '',
    intendedBy: '',
    editable: false,
    changedByLabel: '',
    changedByNote: '',
  };
}

function check(id: string): PreflightCheck {
  return {
    id,
    kind: 'dependency',
    name: id,
    label: id,
    status: 'ok',
    detail: '',
    checked_with: '',
    duration_ms: 1,
    error: '',
    remedy: null,
  };
}

function payload(resources: SettingsPayload['resources'], checks: PreflightCheck[] = []): SettingsPayload {
  return {
    resources,
    checks,
    drift: [],
    status: 'ok',
    appBuildSha: '',
    modelBuildSha: '',
    orchestratorReported: false,
    storeAvailable: true,
    checkedAt: '2026-09-02T16:00:00.000Z',
  };
}

function reading(id: string, configured = '', observed?: PreflightCheck) {
  return readConnection({ row: row(id, configured), check: observed, findings: [] });
}

function session(over: Partial<CheckSession> = {}): CheckSession {
  return {
    settings: null,
    report: null,
    error: '',
    load: { firstLoad: true, settings: 'pending', report: 'pending' },
    ...over,
  };
}

describe('Connections first-load settlement', () => {
  const unresolved = reading('sql-warehouse', 'warehouse-1');

  it('loads every unresolved row before the first effect starts', () => {
    expect(connectionResourceLoadState(unresolved, null, true)).toBe('loading');
    expect(connectionPlaceholderReadings().map((candidate) => candidate.resource.id)).toEqual(
      CONNECTED_RESOURCES.filter(
        (resource) => resource.namesRemoteObject && resource.id !== 'notebook-declaration'
      ).map((resource) => resource.id)
    );
  });

  it('renders cached rows immediately during a revisit', () => {
    const cached = session({
      settings: payload([row('sql-warehouse', 'warehouse-1')], [check('sql-warehouse')]),
      load: { firstLoad: false, settings: 'ready', report: 'ready' },
    });
    expect(connectionResourceLoadState(reading('sql-warehouse', 'warehouse-1', check('sql-warehouse')), cached)).toBe(
      'ready'
    );
  });

  it('settles rows progressively when settings carries authoritative evidence', () => {
    const settings = payload(
      [row('sql-warehouse', 'warehouse-1'), row('genie-data', 'space-1'), row('llm-gateway')],
      [check('sql-warehouse')]
    );
    const progressive = session({
      settings,
      load: { firstLoad: true, settings: 'ready', report: 'pending' },
    });
    expect(
      connectionResourceLoadState(reading('sql-warehouse', 'warehouse-1', check('sql-warehouse')), progressive, true)
    ).toBe('ready');
    expect(connectionResourceLoadState(reading('genie-data', 'space-1'), progressive, true)).toBe('loading');
    expect(connectionResourceLoadState(reading('llm-gateway'), progressive, true)).toBe('ready');
  });

  it('replaces an unresolved row with a useful row-specific error', () => {
    const failed = session({
      load: { firstLoad: false, settings: 'error', report: 'error' },
    });
    expect(connectionResourceLoadState(unresolved, failed, false)).toBe('error');
    const markup = renderToStaticMarkup(<ConnectionLoadRow reading={unresolved} state="error" />);
    expect(markup).toContain(connectionLoadErrorLabel(unresolved));
    expect(markup).toContain('Refresh to try again');
    expect(markup).not.toContain('pia-flick-slot');
  });
});

describe('canonical PIA loading geometry', () => {
  const connections = readFileSync(new URL('./ConnectionsPage.tsx', import.meta.url), 'utf8');
  const css = partial('connections.css');
  const loader = partial('pia-loader.css');

  it('uses one stable primary loader and no generic skeleton bars', () => {
    expect(connections.match(/data-testid="connections-primary-loader"/g)).toHaveLength(1);
    expect(connections).not.toContain('<Skeleton');
    const markup = renderToStaticMarkup(<PiaLoadingLabel label="Loading connections" />);
    expect(markup.match(/pia-loader-mark--inline/g)).toHaveLength(1);
  });

  it('gives every resource a useful row-local loading label', () => {
    for (const resource of CONNECTED_RESOURCES) {
      const markup = renderToStaticMarkup(<ConnectionLoadRow reading={reading(resource.id)} state="loading" />);
      expect(markup).toContain(`Loading ${resource.label}`);
      expect(markup.match(/pia-loader-mark--inline/g)).toHaveLength(1);
    }
  });

  it('reserves height and clips labels without horizontal growth', () => {
    expect(css).toMatch(/\.connections-primary-loader\s*\{[^}]*min-height:\s*88px[^}]*overflow:\s*hidden/s);
    expect(connections).toContain('<PiaLoadingLabel seat="compact" label="Loading connections"');
    expect(css).toMatch(
      /\.pia-loader\.connection-row-loader\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/s
    );
    expect(css).toMatch(/\.connection-row-summary,[\s\S]*?min-height:\s*48px/);
  });

  it('freezes on the static PIA D-pad for both motion vetoes', () => {
    const reduced = loader.slice(loader.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.pia-loader__phase--dpad,[\s\S]*?opacity:\s*1/s);
    expect(loader).toMatch(/html\[data-animations='off'\] \.pia-loader__phase--dpad,[\s\S]*?opacity:\s*1/s);
  });
});
