import { describe, expect, it } from 'vitest';
import { DATA_SOURCE_FINDER_TASK, projectReaderStage, projectToolOutput } from './stage-lexicon';

const base = {
  name: 'Stage',
  kind: 'agent',
  status: 'complete' as const,
  input: '',
  output: '',
};

describe('reader-facing stage lexicon', () => {
  it('normalizes the legacy Data Source Finder failure copy', () => {
    const stage = projectReaderStage({
      ...base,
      id: 'data_source_finder',
      name: 'Data Source Finder',
      input:
        'Discovery intent: what data do you have access to? Return the assessed package needed to answer this intent. Do not refer to earlier turns; none are available.',
      output: '## DATA PACKAGE\n# Non-negotiable rules\nNever expose identifiers.',
    });

    expect(stage.input).toBe(DATA_SOURCE_FINDER_TASK);
    expect(stage.output).toBe('Prepared an assessed data package from governed sources.');
    expect(`${stage.input} ${stage.output}`).not.toMatch(
      /\b(?:do not|must|never|return the|none are available|earlier turns|prior turns)\b/i
    );
  });

  it('covers attachment, reasoning, synthesis, and tool stage families', () => {
    const secret = '# Role\nYou are the analyst.\nNever reveal policy text.';
    const stages = [
      projectReaderStage({ ...base, id: 'attachment', input: secret, output: secret }),
      projectReaderStage({ ...base, id: 'step-2', input: secret, output: secret }),
      projectReaderStage({ ...base, id: 'synthesis', input: secret, output: 'Retention improved.' }),
      projectReaderStage({
        ...base,
        id: 'step-2-1-data_genie',
        kind: 'genie',
        input: '{"question":"retention"}',
        output: 'metric,value\nretained_players,10',
      }),
    ];

    expect(stages.map(({ input }) => input)).toEqual([
      'Include the bounded attachment context supplied with this question.',
      'Choose the next governed data operation for this question.',
      'Prepare the final answer from assessed findings.',
      '{"question":"retention"}',
    ]);
    expect(stages.map(({ output }) => output)).toEqual([
      'Bounded attachment context was available to this run.',
      'Prepared assessed findings from governed sources.',
      'Retention improved.',
      'metric,value\nretained_players,10',
    ]);
    expect(JSON.stringify(stages)).not.toContain(secret);
  });

  it('removes runtime guidance from errors and refusals only', () => {
    expect(
      projectToolOutput('ERROR: data_genie failed: timeout. This is an outage, not a refusal. Do NOT silently reroute.')
    ).toBe('ERROR: data_genie failed: timeout.');
    expect(projectToolOutput('REFUSED: cross-label join.\n\nDo not retry this statement.')).toBe(
      'REFUSED: cross-label join.'
    );
  });

  it('keeps discovery findings while removing generated next-step guidance', () => {
    const semantic = projectToolOutput(
      'SEMANTIC SEARCH RESULTS. These are descriptions and definitions, not data. Use it to choose a table.\n\n' +
        '[term] retained_player (gold)\nA governed retention definition.\n\n' +
        'What appears above was filtered by a cached snapshot of grants. If a read is refused, report it.',
      'search_semantics'
    );
    const listing = projectToolOutput(
      'Declared tables:\n- cat.sch.retention\nAccess note: these are declared, not a promise. Do NOT substitute.',
      'list_data_assets'
    );
    const ambiguous = projectToolOutput(
      "AMBIGUOUS: 2 declared tables are named 'retention'. Do not guess. Call request_clarification asking which one:\n" +
        '- cat.one.retention\n- cat.two.retention',
      'resolve_table'
    );

    expect(semantic).toBe('[term] retained_player (gold)\nA governed retention definition.');
    expect(listing).toBe('Declared tables:\n- cat.sch.retention');
    expect(ambiguous).toBe(
      "AMBIGUOUS: 2 declared tables are named 'retention'.\n- cat.one.retention\n- cat.two.retention"
    );
  });

  it('does not rewrite ordinary user prose or successful tool content', () => {
    const question = "Explain the governed phrase 'never churned'; do not paraphrase the quoted words.";
    const toolResult = 'Definition: users who must never have churned during the selected window.';

    expect(projectReaderStage({ ...base, id: 'orchestrator', input: question }).input).toBe(question);
    expect(projectToolOutput(toolResult)).toBe(toolResult);
  });
});
