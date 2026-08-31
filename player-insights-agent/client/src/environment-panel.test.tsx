import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EnvironmentInfo } from '../../shared/environment-info';
import { filterEnvironmentItems } from './environment-filter';
import { EnvironmentPanel } from './EnvironmentPanel';
import { environmentInfoFromResponse } from './environment-response';

const INFO: EnvironmentInfo = {
  runtime: { python: '3.11.15', node: 'v22.16.0' },
  variables: [
    { key: 'DATABRICKS_APP_NAME', value: 'astrolabe' },
    { key: 'DATABRICKS_CLIENT_SECRET', value: '***' },
  ],
  packages: [
    { name: 'aiofiles', version: '23.2.1' },
    { name: 'zod', version: '4.3.6' },
  ],
};
const PANEL_SOURCE = readFileSync(new URL('./EnvironmentPanel.tsx', import.meta.url), 'utf8');

describe('Environment panel', () => {
  it('shows live runtime versions as separate badges', () => {
    const markup = renderToStaticMarkup(<EnvironmentPanel initialData={INFO} />);
    expect(markup).toContain('Python 3.11.15');
    expect(markup).toContain('Node.js v22.16.0');
    expect(markup).not.toContain('Python 3.11.15; Node.js v22.16.0');
  });

  it('shows counted Variables and Installed packages tabs with a searchable list and copy control', () => {
    const markup = renderToStaticMarkup(<EnvironmentPanel initialData={INFO} />);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('Variables (2)');
    expect(markup).toContain('Installed packages (2)');
    expect(markup).toContain('aria-label="Search variables"');
    expect(markup).toContain('aria-label="Copy filtered variables"');
    expect(markup).toContain('DATABRICKS_APP_NAME');
  });

  it('says the installed package count includes platform and transitive inventory', () => {
    expect(PANEL_SOURCE).toContain('Live container inventory');
    expect(PANEL_SOURCE).toContain('transitive');
    expect(PANEL_SOURCE).toContain('Databricks base-image packages');
    expect(PANEL_SOURCE).toContain('Read-only');
  });

  it('filters either column without changing the source list', () => {
    expect(filterEnvironmentItems(INFO.variables, 'astrolabe')).toEqual([
      { key: 'DATABRICKS_APP_NAME', value: 'astrolabe' },
    ]);
    expect(filterEnvironmentItems(INFO.packages, '4.3')).toEqual([{ name: 'zod', version: '4.3.6' }]);
    expect(INFO.variables).toHaveLength(2);
  });

  it('renders empty and malformed environment payloads without throwing', () => {
    for (const payload of [
      null,
      {},
      { runtime: null, variables: null, packages: null },
      { runtime: {}, variables: [], packages: [] },
      {
        runtime: { python: null, node: 22 },
        variables: [null, { key: 'SAFE', value: 'yes' }, { key: 7, value: false }],
        packages: [undefined, { name: 'zod', version: '4.3.6' }, { name: null, version: [] }],
      },
    ]) {
      const markup = renderToStaticMarkup(<EnvironmentPanel initialData={payload} />);
      expect(markup).toContain('<h3>Environment</h3>');
      expect(markup).toContain('Python unavailable');
      expect(markup).toContain('Node.js unavailable');
    }
  });

  it('does not offer the Astrolabe tag repair on this pane', () => {
    const markup = renderToStaticMarkup(<EnvironmentPanel initialData={INFO} />);
    expect(markup).not.toContain('Resource tags');
    expect(markup).not.toContain('system_billing=astrolabe');
    expect(markup).not.toContain('Apply tags');
  });

  it('keeps only complete string rows from hostile payloads', () => {
    expect(
      environmentInfoFromResponse({
        variables: [null, { key: 'SAFE', value: 'yes' }, { key: 7, value: false }],
        packages: [
          { name: 'zod', version: '4.3.6' },
          { name: null, version: [] },
        ],
      })
    ).toEqual({
      runtime: { python: '', node: '' },
      variables: [{ key: 'SAFE', value: 'yes' }],
      packages: [{ name: 'zod', version: '4.3.6' }],
    });
  });
});
