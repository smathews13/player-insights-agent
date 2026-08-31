import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { NO_FILTERS } from './monitoring-filters';
import {
  beginPanelLoad,
  monitoringDetailKey,
  panelStateForKey,
  personDetailUrl,
  questionDetailUrl,
  rejectPanelLoad,
  resolvePanelLoad,
} from './monitoring-detail-state';

describe('Monitoring detail request identity', () => {
  it('keys a detail by entity and normalized half-open range', () => {
    expect(monitoringDetailKey('question', 'Q-1', '2026-08-01T00:00:00Z', '2026-08-08T00:00:00Z')).toBe(
      'question|q-1|2026-08-01T00:00:00.000Z|2026-08-08T00:00:00.000Z|'
    );
    expect(monitoringDetailKey('question', 'Q-1', '2026-08-02T00:00:00Z', '2026-08-08T00:00:00Z')).not.toBe(
      monitoringDetailKey('question', 'Q-1', '2026-08-01T00:00:00Z', '2026-08-08T00:00:00Z')
    );
  });

  it('includes the same normalized range in question and person requests', () => {
    const question = questionDetailUrl('q/1', '2026-08-01T00:00:00Z', '2026-08-08T00:00:00Z');
    const person = personDetailUrl(
      'reader@example.test',
      '2026-08-01T00:00:00Z',
      '2026-08-08T00:00:00Z',
      NO_FILTERS,
      ''
    );
    for (const url of [question, person]) {
      expect(url).toContain('from=2026-08-01T00%3A00%3A00.000Z');
      expect(url).toContain('to=2026-08-08T00%3A00%3A00.000Z');
    }
  });
});

describe('out-of-order detail responses', () => {
  it('ignores a prior range after the new range starts', () => {
    const oldKey = monitoringDetailKey('person', 'reader@example.test', '2026-08-01', '2026-08-08');
    const newKey = monitoringDetailKey('person', 'reader@example.test', '2026-08-08', '2026-08-15');
    const loadingNew = beginPanelLoad<{ label: string }>(newKey, 2);

    expect(resolvePanelLoad(loadingNew, oldKey, 1, { label: 'old range' })).toBe(loadingNew);
    expect(resolvePanelLoad(loadingNew, newKey, 2, { label: 'new range' })).toEqual(
      expect.objectContaining({ status: 'ready', data: { label: 'new range' } })
    );
  });

  it('hides ready data synchronously when the URL moves to another range', () => {
    const oldKey = monitoringDetailKey('person', 'reader@example.test', '2026-08-01', '2026-08-08');
    const newKey = monitoringDetailKey('person', 'reader@example.test', '2026-08-08', '2026-08-15');
    const ready = resolvePanelLoad(beginPanelLoad<{ label: string }>(oldKey, 1), oldKey, 1, {
      label: 'old range',
    });

    expect(panelStateForKey(ready, newKey, 2)).toEqual({
      status: 'loading',
      key: newKey,
      requestId: 2,
      data: null,
      error: null,
    });
  });

  it('ignores an older retry from the same range', () => {
    const key = monitoringDetailKey('question', 'q1', '2026-08-01', '2026-08-08');
    const latest = beginPanelLoad<{ value: number }>(key, 4);

    expect(rejectPanelLoad(latest, key, 3, 'late failure')).toBe(latest);
    expect(resolvePanelLoad(latest, key, 3, { value: 3 })).toBe(latest);
  });
});

describe('detail request cancellation', () => {
  const source = readFileSync(fileURLToPath(new URL('./MonitoringPage.tsx', import.meta.url)), 'utf8');

  it('passes an abort signal and cancels on key change or unmount', () => {
    expect(source).toContain('fetch(url, { signal: controller.signal })');
    expect(source).toContain('return () => controller.abort()');
    expect(source).toContain('[attempt, errorMessage, key, url]');
  });
});
