import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_SAMPLE_RATE,
  liveChecksFromAnswer,
  liveScoreSummary,
  shouldSampleLiveTrace,
} from './eval-live-scoring';

describe('live Ask sampling', () => {
  it('keeps the same turn in or out at a given rate', () => {
    const seed = 'conv-1:msg-9';
    const first = shouldSampleLiveTrace(seed, DEFAULT_LIVE_SAMPLE_RATE);
    expect(shouldSampleLiveTrace(seed, DEFAULT_LIVE_SAMPLE_RATE)).toBe(first);
    expect(shouldSampleLiveTrace(seed, 0)).toBe(false);
    expect(shouldSampleLiveTrace(seed, 1)).toBe(true);
    expect(shouldSampleLiveTrace('', 0.5)).toBe(false);
  });

  it('does not treat every turn as sampled at 20%', () => {
    const hits = Array.from({ length: 40 }, (_, index) =>
      shouldSampleLiveTrace(`conv-${index}:msg-${index}`, 0.2)
    ).filter(Boolean).length;
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(40);
  });
});

describe('live deterministic checks', () => {
  it('reuses the flywheel checks so a live score means the same thing as Phase A', () => {
    const checks = liveChecksFromAnswer({
      sql: 'SELECT count(*) FROM cat.sch.players',
      note: '',
      durationMs: 1_200,
    });
    expect(checks.find((entry) => entry.id === 'fqn-present')?.passed).toBe(true);
    expect(checks.find((entry) => entry.id === 'latency-under-budget')?.passed).toBe(true);
  });

  it('summarises checks and judges without inventing a rate', () => {
    expect(
      liveScoreSummary({
        checks: [
          { id: 'fqn-present', label: 'FQN', passed: true, note: '' },
          { id: 'no-refused-sql', label: 'SQL', passed: false, note: '' },
        ],
        judges: [{ name: 'relevance', value: 'yes', state: 'scored', note: '' }],
        turnCount: 4,
      })
    ).toBe('1/2 checks · 1/1 judges · 4 turns');
  });
});
