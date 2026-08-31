import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AIAnalysisCaveat, AI_ANALYSIS_CAVEAT } from './AIAnalysisCaveat';
import { AnswerCard } from './AnswerCard';
import { FinalAnswer } from './FinalAnswer';
import type { Answer, FeedbackEntry } from './app-types';

const OLD_ANSWER_CAVEAT = ['astrolabe analysis.', 'Verify material decisions against cited sources.'].join(' ');
const OLD_COMPOSER_CAVEAT = ['astrolabe can make mistakes.', 'Sources and caveats are included.'].join(' ');
const ROOT = fileURLToPath(new URL('.', import.meta.url));

function productionSources(directory = ROOT): { path: string; source: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec)\.(ts|tsx)$/.test(entry.name)) return [];
    return [{ path, source: readFileSync(path, 'utf8') }];
  });
}

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:#x27|apos);/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function caveatTexts(markup: string): string[] {
  return [...markup.matchAll(/<p[^>]*data-ai-analysis-caveat=""[^>]*>([\s\S]*?)<\/p>/g)].map((match) =>
    visibleText(match[1])
  );
}

const feedback: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

function answer(): Answer {
  return {
    id: 'answer-1',
    mode: 'live',
    provenance: 'live',
    takeaway: 'Players returned more often this week.',
    narrative: 'Weekly returning players increased by 8%.',
    content: '',
    figures: [],
    charts: [],
    sources: [{ name: 'main.analytics.player_activity', freshness: 'Read during this run' }],
    caveats: ['Only 19 of the 30 calendar days have records.'],
    derivation: [],
    document_snippets: [],
    sql: 'select 1',
    trace: {
      id: 'tr-feedfacefeedfacefeedfacefeedface',
      totalMs: 1200,
      toolCalls: 1,
      stages: [
        {
          id: 'attachment',
          name: 'Read attachment context',
          kind: 'tool',
          start: 0,
          duration: 1200,
          status: 'complete',
          calls: 1,
          input: '',
          output: '',
          startMeasured: true,
        },
      ],
    },
    executionIdentity: { mode: 'signed_in_user', verified: true },
  };
}

describe('the shared reader-facing AI caveat', () => {
  it('has one exact sentence and one accessible reading of it', () => {
    expect(AI_ANALYSIS_CAVEAT).toBe('Astrolabe analysis. AI can make mistakes.');
    const markup = renderToStaticMarkup(<AIAnalysisCaveat className="ai-note" />);

    expect(caveatTexts(markup)).toEqual([AI_ANALYSIS_CAVEAT]);
    expect(markup).toContain('aria-hidden="true"');
    expect(visibleText(markup)).toBe(AI_ANALYSIS_CAVEAT);
  });

  it('closes live, loaded, replayed, degraded, and Monitoring answers through AnswerCard', () => {
    const markup = renderToStaticMarkup(
      <AnswerCard
        answer={answer()}
        feedback={feedback}
        onFeedbackChange={() => {}}
        saveFeedback={async () => {}}
        showFeedback={false}
      />
    );

    expect(caveatTexts(markup)).toEqual([AI_ANALYSIS_CAVEAT]);
    expect(markup).toContain('Data read under your own Unity Catalog grants.');
    expect(caveatTexts(markup)[0]).not.toMatch(/Unity Catalog|sources|model/i);
    expect(visibleText(markup)).toContain(
      'Attached reports were used, but this answer includes no document footnotes or quoted snippets.'
    );
  });

  it('closes the Run Explorer final-answer rendering without changing evidence warnings', () => {
    const specificWarning =
      'The sources for this answer are incomplete: part of it came from a query whose tables could not be determined.';
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <FinalAnswer
          takeaway="Players returned more often this week."
          narrative="Weekly returning players increased by 8%."
          sources={[{ name: 'main.analytics.player_activity', freshness: 'Read during this run' }]}
          caveats={[specificWarning]}
        />
      </MemoryRouter>
    );

    expect(caveatTexts(markup)).toEqual([AI_ANALYSIS_CAVEAT]);
    expect(visibleText(markup)).toContain(specificWarning);
  });
});

describe('AI caveat source invariants', () => {
  const sources = productionSources();
  const sourceByName = (name: string) => sources.find((file) => file.path.endsWith(`/${name}`))?.source ?? '';

  it('defines the sentence once and leaves no old generic wording in production source', () => {
    const declarations = sources.flatMap((file) =>
      [...file.source.matchAll(/Astrolabe analysis\. AI can make mistakes\./g)].map(() => file.path)
    );

    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toBe(join(ROOT, 'AIAnalysisCaveat.tsx'));
    for (const file of sources) {
      expect(file.source, file.path).not.toContain(OLD_ANSWER_CAVEAT);
      expect(file.source, file.path).not.toContain(OLD_COMPOSER_CAVEAT);
    }
  });

  it('routes every answer-bearing surface through the shared component', () => {
    expect(sourceByName('AnswerCard.tsx')).toContain('<AIAnalysisCaveat');
    expect(sourceByName('FinalAnswer.tsx')).toContain('<AIAnalysisCaveat');
    expect(sourceByName('HomePage.tsx').match(/<AIAnalysisCaveat/g)).toHaveLength(1);
    expect(sourceByName('StoredAnswerRenderer.tsx')).toContain('<AIAnalysisCaveat');
    expect(sourceByName('MonitoringPage.tsx')).toContain('<AnswerCard');
    expect(sourceByName('RunExplorer.tsx')).toContain('<FinalAnswer');
    expect(sourceByName('RunExplorer.tsx').match(/<AIAnalysisCaveat/g)).toHaveLength(2);
  });

  it('does not introduce independent generic warnings in trace or Benchmark/Lab renderers', () => {
    for (const name of ['TraceTimeline.tsx', 'TraceDag.tsx', 'BenchmarkLab.tsx', 'BenchmarkLabOps.tsx']) {
      const source = sourceByName(name);
      expect(source, name).not.toMatch(
        /AI can make mistakes|Verify material decisions|Sources and caveats are included/
      );
    }
  });
});
