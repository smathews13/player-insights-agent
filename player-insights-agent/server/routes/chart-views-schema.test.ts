import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { ChartSchema, LiveAnswerSchema, undeclaredAnswerKeys } from './insights-routes';

type LiveAnswer = z.infer<typeof LiveAnswerSchema>;

const FIVE_KEYS = {
  id: 'chart-1',
  title: 'Example breakdown',
  kind: 'bar',
  data: [{ type: 'bar', x: ['alpha'], y: [3] }],
  layout: {},
};
const VIEWS = [
  { id: 'view-1', label: 'Measure A', data: [{ type: 'bar', x: ['alpha'], y: [3] }], layout: {} },
  { id: 'view-2', label: 'Measure B', data: [{ type: 'bar', x: ['alpha'], y: [10] }], layout: {} },
];

/** Only the arrays `undeclaredAnswerKeys` walks; the rest of an answer is not under test. */
function answerWith(charts: unknown[]): LiveAnswer {
  return {
    trace: { stages: [] },
    figures: [],
    charts,
    sources: [],
    derivation: [],
  } as unknown as LiveAnswer;
}

describe('chart views on the wire', () => {
  it('accepts a chart with views, a chart without, and a chart from a model that predates them', () => {
    expect(ChartSchema.safeParse({ ...FIVE_KEYS, view_dimension: 'metric', views: VIEWS }).success).toBe(true);
    expect(ChartSchema.safeParse(FIVE_KEYS).success).toBe(true);
    expect(ChartSchema.safeParse({ ...FIVE_KEYS, views: VIEWS }).success).toBe(true);
  });

  it('refuses a dimension it does not know', () => {
    expect(ChartSchema.safeParse({ ...FIVE_KEYS, view_dimension: 'colour', views: VIEWS }).success).toBe(false);
  });

  it('does not report the two keys as undeclared drift', () => {
    const chart = { ...FIVE_KEYS, view_dimension: 'segment', views: VIEWS };
    expect(undeclaredAnswerKeys(answerWith([chart])).filter((key) => key.startsWith('charts['))).toEqual([]);
  });
});
