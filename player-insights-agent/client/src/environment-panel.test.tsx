import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EnvironmentInfo } from '../../shared/environment-info';
import { filterEnvironmentItems } from './environment-filter';
import { EnvironmentPanel } from './EnvironmentPanel';

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

describe('Environment panel', () => {
  it('shows live runtime versions as separate badges', () => {
    const markup = renderToStaticMarkup(<EnvironmentPanel initialData={INFO} />);
    expect(markup).toContain('Python 3.11.15');
    expect(markup).toContain('Node.js v22.16.0');
    expect(markup).not.toContain('Python 3.11.15; Node.js v22.16.0');
  });

  it('shows counted Variables and Packages tabs with a searchable list and copy control', () => {
    const markup = renderToStaticMarkup(<EnvironmentPanel initialData={INFO} />);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('Variables (2)');
    expect(markup).toContain('Packages (2)');
    expect(markup).toContain('aria-label="Search variables"');
    expect(markup).toContain('aria-label="Copy filtered variables"');
    expect(markup).toContain('DATABRICKS_APP_NAME');
  });

  it('filters either column without changing the source list', () => {
    expect(filterEnvironmentItems(INFO.variables, 'astrolabe')).toEqual([
      { key: 'DATABRICKS_APP_NAME', value: 'astrolabe' },
    ]);
    expect(filterEnvironmentItems(INFO.packages, '4.3')).toEqual([{ name: 'zod', version: '4.3.6' }]);
    expect(INFO.variables).toHaveLength(2);
  });
});
