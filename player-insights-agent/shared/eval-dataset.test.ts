import { describe, expect, it } from 'vitest';
import {
  accuracyScore,
  customJudgeAssessmentName,
  datasetCounts,
  datasetSizeLabel,
  EMPTY_EVAL_DATASET,
  extraJudgesFromSettings,
  customJudgeRunPrompt,
  normalizeSql,
  parseCustomJudges,
  parseEnabledJudges,
  parseEnabledMultiTurnJudges,
  parseEvalDataset,
  POC_STARTER_QUESTIONS,
  sqlMatches,
  starterEvalDataset,
  uniqueQuestionsToAdd,
} from './eval-dataset';

describe('evaluation dataset', () => {
  it('starts empty so no customer data is invented', () => {
    expect(parseEvalDataset(undefined)).toEqual(EMPTY_EVAL_DATASET);
    expect(parseEvalDataset({ rows: [] }).rows).toEqual([]);
  });

  it('counts questions, SQL-backed rows, and expected answers separately', () => {
    const counts = datasetCounts([
      { id: '1', question: 'How many players?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
      { id: '2', question: 'What is a session?', groundTruthSql: '', expectedAnswer: 'A play period', sqlCorrect: '', thumbs: '' },
      { id: '3', question: '', groundTruthSql: 'SELECT 2', expectedAnswer: 'ignored', sqlCorrect: '', thumbs: '' },
    ]);
    expect(counts.questions).toBe(2);
    expect(counts.sqlBacked).toBe(1);
    expect(counts.expectedAnswer).toBe(1);
    expect(counts.milestone).toBe(0);
  });

  it('shows the 10 / 20 / 30 rungs from the question count', () => {
    const ten = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      question: `Q${index}`,
      groundTruthSql: '',
      expectedAnswer: '',
      sqlCorrect: '' as const,
      thumbs: '' as const,
    }));
    expect(datasetCounts(ten).milestone).toBe(10);
    expect(datasetCounts([...ten, ...ten]).milestone).toBe(20);
    expect(datasetSizeLabel(datasetCounts(ten))).toContain('10 questions');
  });

  it('offers the existing POC questions as starter text, without SQL', () => {
    const starter = starterEvalDataset();
    expect(starter.rows).toHaveLength(POC_STARTER_QUESTIONS.length);
    expect(starter.rows.every((row) => row.groundTruthSql === '' && row.expectedAnswer === '')).toBe(true);
    expect(starter.rows.map((row) => row.question)).toEqual([...POC_STARTER_QUESTIONS]);
  });

  it('adds Ask questions that are not already in the dataset', () => {
    const added = uniqueQuestionsToAdd(
      [{ id: '1', question: 'How many players?', groundTruthSql: '', expectedAnswer: '', sqlCorrect: '', thumbs: '' }],
      ['How many players?', '  Which title grew?  ', '']
    );
    expect(added).toHaveLength(1);
    expect(added[0]?.question).toBe('Which title grew?');
  });
});

describe('Genie SQL accuracy math', () => {
  it('treats equivalent SQL as a pass after folding whitespace and case', () => {
    expect(
      sqlMatches(
        'SELECT count(*) FROM cat.sch.players;',
        'select   count(*)\nfrom cat.sch.players'
      )
    ).toBe(true);
  });

  it('does not treat different statements as a pass', () => {
    expect(sqlMatches('SELECT 1', 'SELECT 2')).toBe(false);
    expect(sqlMatches('', 'SELECT 1')).toBe(false);
  });

  it('strips comments before comparing', () => {
    expect(normalizeSql('SELECT 1 -- note\n')).toBe('select 1');
    expect(sqlMatches('SELECT /* skip */ 1', 'select 1')).toBe(true);
  });

  it('reports passed over total, and never invents a percentage for an empty run', () => {
    expect(accuracyScore(9, 10)).toEqual({ passed: 9, total: 10, percent: 90, label: '9/10 = 90%' });
    expect(accuracyScore(1, 3).label).toBe('1/3 = 33.3%');
    expect(accuracyScore(0, 0)).toEqual({
      passed: 0,
      total: 0,
      percent: null,
      label: 'No SQL-backed questions to score',
    });
  });
});

describe('judge selection', () => {
  it('keeps the three built-in judges when nothing is saved', () => {
    expect(parseEnabledJudges(undefined)).toEqual(['groundedness', 'relevance', 'guidelines']);
  });

  it('drops unknown names rather than inventing a judge', () => {
    expect(parseEnabledJudges(['guidelines', 'custom', 'relevance'])).toEqual(['guidelines', 'relevance']);
  });

  it('lets an operator pick conversational judges from the published list', () => {
    expect(parseEnabledMultiTurnJudges(undefined)).toEqual([]);
    expect(parseEnabledMultiTurnJudges(['conversation_completeness', 'invented', 'user_frustration'])).toEqual([
      'conversation_completeness',
      'user_frustration',
    ]);
  });

  it('keeps named custom judges and slugs them the way Guidelines(name=…) does', () => {
    expect(customJudgeAssessmentName('English only')).toBe('custom_english_only');
    expect(parseCustomJudges([{ name: 'english', guidelines: 'The response must be in English.' }])).toEqual([
      { name: 'english', guidelines: 'The response must be in English.', prompt: '' },
    ]);
    expect(parseCustomJudges([{ name: 'tone', prompt: 'Is {{response}} polite? Score {{question}}.' }])).toEqual([
      { name: 'tone', guidelines: '', prompt: 'Is {{response}} polite? Score {{question}}.' },
    ]);
    expect(parseCustomJudges([{ name: '', guidelines: 'x' }])).toEqual([]);
    expect(parseCustomJudges([{ name: 'empty' }])).toEqual([]);
  });

  it('builds extra judges from settings without inventing a score', () => {
    const extras = extraJudgesFromSettings({
      enabledMultiTurnJudges: ['conversation_completeness', 'conversational_guidelines'],
      customJudges: [{ name: 'english', guidelines: 'The response must be in English.', prompt: '' }],
      guidelinesText: 'Be professional.',
    });
    expect(extras).toEqual([
      {
        name: 'conversation_completeness',
        guidelines: [
          'The assistant addresses every question the user asked in the conversation. A single unanswered request is a no.',
        ],
        kind: 'multi-turn',
      },
      {
        name: 'conversational_guidelines',
        guidelines: ['Be professional.'],
        kind: 'multi-turn',
      },
      {
        name: 'custom_english',
        guidelines: ['The response must be in English.'],
        kind: 'custom',
      },
    ]);
  });
});

describe('free-form custom judge prompt', () => {
  it('fills question, response, and conversation placeholders', () => {
    const prompt = customJudgeRunPrompt(
      { prompt: 'Score this.\nQ: {{question}}\nA: {{response}}\nThread:\n{{conversation}}' },
      { question: 'How many?', response: '14', conversation: 'User: How many?\nAssistant: 14' }
    );
    expect(prompt).toContain('Q: How many?');
    expect(prompt).toContain('A: 14');
    expect(prompt).toContain('User: How many?');
    expect(prompt).toContain('"result": "yes|no"');
  });

  it('does not wrap a prompt that already asks for result', () => {
    expect(
      customJudgeRunPrompt({ prompt: 'Return {"result":"yes"} for {{question}}' }, {
        question: 'Q',
        response: 'A',
        conversation: '',
      })
    ).toBe('Return {"result":"yes"} for Q');
  });
});
