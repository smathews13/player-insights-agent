import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReportCard } from './ReportCard';
import type { Report } from '../../shared/report-contract';

const REPORT: Report = {
  schema_version: 'pia.report/1',
  title: 'Contoso Franchise Cross-Play Analysis',
  subtitle: 'Share of players who have also played another T2 / Northwind / Contoso franchise',
  summary: 'Across the 7 major Contoso franchises analysed, **200M unique players** have been identified.',
  sections: [
    {
      heading: 'Cross-Franchise Overlap by Contoso Franchise',
      body: 'Each row shows the total known player base for that franchise.',
      figures: [{ label: 'Combined Contoso Franchise Players', value: '200M', caption: 'Unique players' }],
      table: {
        columns: ['Franchise', 'Total Players', '% Played Another T2 Title'],
        rows: [
          ['Hoops', '122.5M', '63%'],
          ['WWE Contoso', '26.0M', '88%'],
        ],
      },
      note: 'Percentages rounded to nearest whole number.',
    },
  ],
  sources: [{ name: 'cdp_share_prod.global_production.play_by_title', freshness: 'Read during this run' }],
  caveats: ['No time window -- all-time overlap.'],
};

describe('ReportCard', () => {
  it('draws the title, sections, table rows, figures, sources, and caveats', () => {
    const markup = renderToStaticMarkup(<ReportCard report={REPORT} />);

    expect(markup).toContain('Contoso Franchise Cross-Play Analysis');
    expect(markup).toContain('Share of players who have also played another T2 / Northwind / Contoso franchise');
    expect(markup).toContain('Cross-Franchise Overlap by Contoso Franchise');
    expect(markup).toContain('Hoops');
    expect(markup).toContain('122.5M');
    expect(markup).toContain('Combined Contoso Franchise Players');
    expect(markup).toContain('200M');
    expect(markup).toContain('cdp_share_prod.global_production.play_by_title');
    expect(markup).toContain('No time window');
    expect(markup).toContain('Export this report');
  });

  it('draws a report with no figures, table, or caveats', () => {
    const bare: Report = {
      schema_version: 'pia.report/1',
      title: 'Bare Report',
      sections: [{ body: 'Just prose, nothing structured.' }],
    };

    const markup = renderToStaticMarkup(<ReportCard report={bare} />);
    expect(markup).toContain('Bare Report');
    expect(markup).toContain('Just prose, nothing structured.');
  });
});
