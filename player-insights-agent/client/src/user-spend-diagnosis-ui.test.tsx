import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { OpsCostPayload } from '../../shared/ops-contract';
import { PersonSpend } from './MonitoringPage';
import { beginPanelLoad, rejectPanelLoad, type PanelLoadState } from './monitoring-detail-state';

const EMAIL = 'spend.user@example.test';

function failed(message: string): PanelLoadState<OpsCostPayload> {
  return rejectPanelLoad(beginPanelLoad<OpsCostPayload>('spend', 1), 'spend', 1, message);
}

function render(state: PanelLoadState<OpsCostPayload>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PersonSpend email={EMAIL} state={state} unit="USD" />
    </MemoryRouter>
  );
}

describe('user profile spend diagnosis', () => {
  it.each(['Preparing user spend', 'Billing access required', 'User not added in Identity settings'])(
    'shows %s as its own state',
    (diagnosis) => {
      const html = render(failed(diagnosis));
      expect(html).toContain(diagnosis);
      expect(html).not.toContain('Spend not available yet');
      expect(html).not.toContain('Update Lakebase');
    }
  );

  it('links the missing-schema state to the existing one-click action', () => {
    const html = render(failed('Lakebase update required'));
    expect(html).toContain('Lakebase update required');
    expect(html).toContain('href="/connections"');
    expect(html).toContain('Update Lakebase');
  });

  it('renders measured zero as zero rather than unavailable', () => {
    const html = render({
      status: 'ready',
      key: 'spend',
      requestId: 1,
      error: null,
      data: {
        currency: 'USD',
        spendByUser: {
          dataRevision: 2,
          readAt: '2026-09-03T00:05:00Z',
          requestedRange: { from: '2026-09-02', to: '2026-09-02' },
          range: { from: '2026-09-02', to: '2026-09-02' },
          state: 'ready',
          reason: '',
          users: [
            {
              email: EMAIL,
              total: {
                usd: { amount: 0, quality: 'direct' },
                dbu: { amount: 0, quality: 'direct' },
              },
              metrics: {
                unit: 'USD',
                questions: 0,
                coveredDays: 1,
                costPerQuestion: { value: null, state: 'unavailable', subtitle: 'No questions' },
                averageDaily: { value: 0, state: 'value', subtitle: '' },
                appShare: { value: null, state: 'unavailable', subtitle: 'No comparable app total' },
              },
              components: [],
            },
          ],
          unattributed: [],
          reconciliation: {
            usd: { unit: 'USD', appTotal: 0, users: 0, unattributed: 0, difference: 0 },
            dbu: { unit: 'DBU', appTotal: 0, users: 0, unattributed: 0, difference: 0 },
          },
        },
      } as unknown as OpsCostPayload,
    });
    expect(html).toContain('0.00 USD');
    expect(html).not.toContain('Spend not available yet');
  });
});
