import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { TimeRangeControl } from './TimeRangeControl';

describe('the Ops timeframe control', () => {
  it('shows only supported presets for a retired custom URL', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/ops?range=custom&from=2026-03-02&to=2026-03-06']}>
        <TimeRangeControl page="Ops cost" />
      </MemoryRouter>
    );

    expect(markup).toContain('aria-label="Time range for Ops cost"');
    for (const label of ['24h', '7 days', '30 days', 'All time']) {
      expect(markup).toContain(`>${label}<`);
    }
    expect(markup.match(/role="radio"/g)).toHaveLength(4);
    expect(markup).toMatch(/aria-checked="true"[^>]*>7 days<\/button>/);
    expect(markup).not.toContain('>Custom<');
    expect(markup).not.toContain('type="date"');
    expect(markup).not.toContain('Pick both dates');
  });
});
