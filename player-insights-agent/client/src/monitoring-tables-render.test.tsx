import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

const TABLE = '<your_catalog>.<your_schema>.gold_title_daily_summary';

vi.mock('./data-entity-state', () => ({
  useTrackedTables: () => [TABLE],
  useWorkspaceHost: () => 'https://workspace.example.test',
  useRequestedEntity: () => '',
}));

import { TablesReadMost } from './MonitoringPage';

describe('Monitoring ranked table links', () => {
  it('keeps the shared Connections and Databricks routes on every evidenced table', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <TablesReadMost rows={[{ table: TABLE, runs: 3 }]} />
      </MemoryRouter>
    );

    expect(markup).toContain(`/connections?entity=${encodeURIComponent(TABLE)}`);
    expect(markup).toContain(
      'https://workspace.example.test/explore/data/<your_catalog>/<your_schema>/gold_title_daily_summary'
    );
    expect(markup).toContain(`Open ${TABLE} in Databricks`);
    expect(markup).toContain('data-entity-part="catalog"');
    expect(markup).toContain('data-entity-part="schema"');
    expect(markup).toContain('data-entity-part="table"');
  });
});
