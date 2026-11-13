import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const HOME = source('./HomePage.tsx');
const CARD = source('./AnswerCard.tsx');
const MONITORING = source('./MonitoringPage.tsx');
const RUNS = source('./RunExplorer.tsx');
const BENCHMARK = source('./BenchmarkLab.tsx');
const SERVER = source('../../server/routes/insights-routes.ts');

describe('canonical human answer feedback regression', () => {
  it('writes sentiment and never encodes new thumbs as usefulness numbers', () => {
    const clientWrite = HOME.slice(
      HOME.indexOf("fetch('/api/feedback'"),
      HOME.indexOf('async function uploadAttachments')
    );
    expect(clientWrite).toContain('messageId, sentiment');
    expect(clientWrite).not.toMatch(/usefulness|UP_RATING|DOWN_RATING|sentiment\s*:\s*[52]/);

    const serverWrite = SERVER.slice(
      SERVER.indexOf("app.post('/api/feedback'"),
      SERVER.indexOf("app.get('/api/benchmarks/suite'")
    );
    expect(SERVER).toContain("sentiment: z.enum(['up', 'down'])");
    expect(serverWrite).toContain('SELECT $1,$2,$3,$4,NULL,$5');
    expect(serverWrite).not.toMatch(/feedback\.usefulness|sentiment\s*\?\?/);
  });

  it('keeps an optional comment on either rating and never loses typed text', () => {
    expect(CARD).toContain("void saveFeedback('down', { keepCommentOpen: true })");
    expect(CARD).toContain("void saveFeedback('up', { keepCommentOpen: true })");
    expect(CARD).toContain("saveFeedback(feedback.sentiment ?? 'down')");
    expect(CARD).toContain("'What worked well?'");
    expect(CARD).toContain("'What could be better?'");
    expect(CARD).toContain('feedbackInputRef.current?.focus()');
    expect(CARD).toContain('value={feedback.comment}');
    expect(HOME).toContain("const comment = switching ? '' : entry.comment.trim()");
    expect(HOME).toContain('comment: switching ? confirmed.comment : entry.comment');
    expect(HOME).toContain('feedbackWriteQueueRef');
    expect(HOME).toContain('feedbackWriteVersionsRef');
    expect(HOME).toContain('confirmedFeedbackRef');
  });

  it('clears stale negative comments when Helpful replaces Not helpful', () => {
    expect(HOME).toContain('const switching = entry.sentiment !== null && entry.sentiment !== sentiment');
    expect(HOME).toContain("...(switching ? { comment: '' } : {})");
    expect(SERVER).toContain("WHEN ${feedbackDirectionSql('f')} = 'down' OR lower(f.sentiment) = 'up' THEN f.comment");
  });

  it('clears stale helpful comments when Not helpful replaces Helpful', () => {
    // The same switch rule, read in the other direction: it names neither rating.
    expect(HOME).not.toMatch(/sentiment === '(up|down)' \? \{ comment: '' \}/);
    expect(HOME).not.toMatch(/const comment = sentiment === '(up|down)'/);
    expect(SERVER).toContain('comment: parsed.data.comment?.trim() || null,');
  });

  it('keeps human feedback surfaces free of stars, scales, and rating copy', () => {
    const surfaces = [HOME, CARD, MONITORING, RUNS, BENCHMARK].map((value) => value.replace(/\/\*[\s\S]*?\*\//g, ' '));
    for (const value of surfaces) {
      expect(value).not.toMatch(/<Star\b|★|⭐|ratingOutOf|>\s*Rating\s*<|Not rated|Rated helpful|Rated not helpful/);
    }
  });

  it('leaves unrelated evaluation metrics alone', () => {
    const benchmarkContract = source('../../shared/benchmark-contract.ts');
    expect(benchmarkContract).toContain('groundedness');
    expect(benchmarkContract).toContain('relevance');
    expect(benchmarkContract).toContain('guidelines');
  });
});
