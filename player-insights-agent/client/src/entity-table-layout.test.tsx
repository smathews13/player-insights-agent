import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TableEntityList } from './DataEntityLinks';
import { partial } from './styles/stylesheet';

const CSS = partial('answer.css');
const LONG_TABLE = 'customer_governance_catalog_with_a_long_name.analytics_reporting_schema.player_engagement_daily';

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
}

describe('declared table responsive geometry', () => {
  it('keeps the full accessible name and metadata in separate sibling tracks', () => {
    const markup = renderToStaticMarkup(
      <TableEntityList
        countVerb="declared"
        tables={[
          {
            name: LONG_TABLE,
            metadata: ['franchise: a very long franchise label', 'certification: untagged', 'owner: analytics'],
          },
        ]}
      />
    );

    expect(markup).toContain('<span class="ast-num">1</span> table declared');
    expect(markup).toContain(`title="${LONG_TABLE}"`);
    expect(markup).toContain(`aria-label="Table ${LONG_TABLE}" tabindex="0"`);
    expect(markup).toContain(`aria-label="Metadata for ${LONG_TABLE}"`);
    expect(markup).toMatch(/entity-table-list-name[^]*<\/span><span class="entity-table-list-metadata"/);
    expect(markup.match(/entity-table-list-meta">/g)).toHaveLength(3);
  });

  it('uses two safe columns at wide and screenshot widths, then one at narrow width', () => {
    const query =
      /@container entity-table-list \(min-width: ([\d.]+)rem\)[^{]*\{[^}]*grid-template-columns: repeat\(2, minmax\(([\d.]+)rem, 1fr\)\)/s.exec(
        CSS
      );
    expect(query).not.toBeNull();
    const breakpoint = Number(query?.[1]) * 16;
    const cardMinimum = Number(query?.[2]) * 16;
    const columnsAt = (width: number) => (width >= breakpoint ? 2 : 1);

    expect(columnsAt(1_200)).toBe(2);
    expect(columnsAt(930)).toBe(2);
    expect((930 - 10) / 2).toBeGreaterThanOrEqual(cardMinimum);
    expect(columnsAt(600)).toBe(1);
    expect(rule('.entity-table-list ul')).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
  });

  it('lets qualifiers truncate before the table segment without page overflow', () => {
    expect(rule('.entity-table-list')).toMatch(/min-width: 0[\s\S]*max-width: 100%[\s\S]*container-type: inline-size/);
    expect(rule('.entity-table-list li')).toMatch(/min-width: 0[\s\S]*max-width: 100%[\s\S]*overflow: hidden/);
    expect(rule('.entity-table-list-name .entity-token')).toMatch(
      /min-width: 0[\s\S]*overflow: hidden[\s\S]*text-overflow: ellipsis/
    );
    expect(rule('.entity-table-list-name .entity-catalog')).toContain('flex: 0 8 auto');
    expect(rule('.entity-table-list-name .entity-schema')).toContain('flex: 0 5 auto');
    expect(rule('.entity-table-list-name .entity-table')).toContain('flex: 1 1 auto');
    expect(rule('.entity-table-list-metadata')).toMatch(/flex-wrap: wrap[\s\S]*max-width: 100%/);
  });
});
