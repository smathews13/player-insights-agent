import { describe, expect, it, vi } from 'vitest';
import {
  conversationTranscript,
  extractJudgeContent,
  formatPrompt,
  GROUNDEDNESS_FEEDBACK_NAME,
  GROUNDEDNESS_PROMPT,
  groundednessPrompt,
  GUIDELINES_PROMPT,
  guidelinesPrompt,
  judgeRequestPayload,
  notApplicable,
  parseJudgeResponse,
  RELEVANCE_TO_QUERY_PROMPT,
  relevanceToQueryPrompt,
  runJudge,
  sanitizeRationale,
  stripMarkdownCodeBlocks,
} from './mlflow-judges';
import { MLFLOW_JUDGE_PROMPT_VERSION } from '../../shared/benchmark-contract';

/**
 * These tests exist to keep two promises the app now makes on screen: that the
 * prompts are MLflow's, and that a judge which could not answer never becomes a
 * judge which said no.
 */

describe('the ported prompts', () => {
  it('carries MLflow 3.14.0 groundedness instructions verbatim', () => {
    // Anchored on the sentences a reader could check against the Python source
    // rather than a hash, so a failure says which sentence moved.
    expect(GROUNDEDNESS_PROMPT).toContain(
      'You must determine whether claim is supported by the document.'
    );
    expect(GROUNDEDNESS_PROMPT).toContain(
      'Do not focus on the correctness or completeness of the claim.'
    );
    expect(GROUNDEDNESS_PROMPT).toContain('Do not make assumptions, approximations, or bring in external knowledge.');
    expect(GROUNDEDNESS_PROMPT).toContain('<claim>\n  <question>{{input}}</question>\n  <answer>{{output}}</answer>\n</claim>');
    expect(GROUNDEDNESS_PROMPT).toContain('<document>{{retrieval_context}}</document>');
    expect(GROUNDEDNESS_PROMPT).toContain("Start each rationale with `Let's think step by step`");
    expect(GROUNDEDNESS_PROMPT).toContain('"result": "yes|no"');
  });

  it('carries MLflow 3.14.0 relevance instructions verbatim, including the trailing constraint', () => {
    expect(RELEVANCE_TO_QUERY_PROMPT).toContain(
      'You must determine whether the answer provides information that is (fully or partially) relevant to the question.'
    );
    expect(RELEVANCE_TO_QUERY_PROMPT).toContain('<question>{{input}}</question>');
    // MLflow appends this line after the JSON block; dropping it would change
    // how often a model returns something outside the vocabulary.
    expect(RELEVANCE_TO_QUERY_PROMPT.trimEnd().endsWith('`result` must only be `yes` or `no`.')).toBe(true);
  });

  it('carries MLflow 3.14.0 guidelines instructions verbatim, including the vacuous-yes rule', () => {
    expect(GUIDELINES_PROMPT).toContain(
      'please assess whether the inputs fully comply with all the provided guidelines'
    );
    expect(GUIDELINES_PROMPT).toContain('If any of the guidelines are not satisfied, the result must be "no".');
    // This sentence is why a guideline that does not bite yields yes rather
        // than no, which matters for the refusal case.
    expect(GUIDELINES_PROMPT).toContain('If none of the guidelines apply to the given inputs, the result must be "yes".');
  });

  it('substitutes placeholders in one pass and does not re-expand substituted text', () => {
    const rendered = formatPrompt('a {{one}} b {{two}}', { one: '{{two}}', two: 'X' });
    // `{{two}}` arriving inside a value must survive as text. MLflow's own
    // chained replacement would render this as `a X b X`, which means an answer
    // could inject text into the document the judge is told to check it
    // against. Deliberate deviation, asserted so it is not "fixed" back.
    expect(rendered).toBe('a {{two}} b X');
  });

  it('leaves a placeholder it was given no value for visible in the prompt', () => {
    // Blanking it would send a judge a prompt with a silently empty section.
    expect(formatPrompt('x {{missing}}', {})).toBe('x {{missing}}');
  });

  it('renders guidelines and context in MLflow’s tag form', () => {
    const prompt = guidelinesPrompt(['Be brief.', 'Cite a source.'], {
      request: 'How many players?',
      response: 'Twelve.',
    });
    expect(prompt).toContain('<guideline>Be brief.</guideline>\n<guideline>Cite a source.</guideline>');
    expect(prompt).toContain('<request>How many players?</request>');
    expect(prompt).toContain('<response>Twelve.</response>');
  });

  it('fills groundedness and relevance prompts with the case under test', () => {
    const grounded = groundednessPrompt('Q?', 'A.', 'DOC');
    expect(grounded).toContain('<question>Q?</question>');
    expect(grounded).toContain('<answer>A.</answer>');
    expect(grounded).toContain('<document>DOC</document>');
    expect(grounded).not.toContain('{{');
    expect(relevanceToQueryPrompt('Q?', 'A.')).not.toContain('{{');
  });

  it('renders a one-turn conversation the multi-turn Guidelines judges read', () => {
    const transcript = conversationTranscript('How many players?', 'Twelve.');
    expect(transcript).toBe('User: How many players?\nAssistant: Twelve.');
    const prompt = guidelinesPrompt(['Address every question.'], { conversation: transcript });
    expect(prompt).toContain('<conversation>User: How many players?\nAssistant: Twelve.</conversation>');
  });
});

describe('response parsing, ported from MLflow', () => {
  it('reads a bare JSON verdict and strips the rationale preamble MLflow asks for', () => {
    const parsed = parseJudgeResponse('{"rationale":"Let\'s think step by step. It matches.","result":"yes"}');
    expect(parsed).toEqual({ ok: true, value: 'yes', rationale: 'It matches.' });
  });

  it('unwraps a fenced response', () => {
    expect(stripMarkdownCodeBlocks('```json\n{"result":"no"}\n```')).toBe('{"result":"no"}');
    const parsed = parseJudgeResponse('```json\n{"rationale":"r","result":"no"}\n```');
    expect(parsed).toEqual({ ok: true, value: 'no', rationale: 'r' });
  });

  it('finds a fenced block after a preamble', () => {
    const parsed = parseJudgeResponse('Here is my assessment:\n```json\n{"rationale":"r","result":"yes"}\n```');
    expect(parsed.ok).toBe(true);
  });

  it('reads the block-list content shape a reasoning model returns', () => {
    const content = extractJudgeContent({
      choices: [{ message: { content: [{ type: 'reasoning', summary: [] }, { type: 'text', text: '{"result":"yes"}' }] } }],
    });
    expect(content).toBe('{"result":"yes"}');
  });

  it('treats a verdict outside yes/no as unscored rather than guessing', () => {
    const parsed = parseJudgeResponse('{"rationale":"r","result":"partially"}');
    expect(parsed.ok).toBe(false);
    // The whole point: an unrecognised verdict must not be able to become a
    // number in a rate a stakeholder reads as a percentage.
    expect(parsed.ok === false && parsed.error).toContain('neither yes nor no');
  });

  it('reports malformed and empty responses as errors, not as a no', () => {
    expect(parseJudgeResponse('not json').ok).toBe(false);
    expect(parseJudgeResponse('{"rationale":"r"}').ok).toBe(false);
    expect(parseJudgeResponse('').ok).toBe(false);
    expect(parseJudgeResponse(null).ok).toBe(false);
  });

  it('accepts case and whitespace variation in the verdict', () => {
    expect(parseJudgeResponse('{"result":" YES "}')).toMatchObject({ ok: true, value: 'yes' });
  });

  it('leaves a rationale without the preamble untouched', () => {
    expect(sanitizeRationale('Straight to the point.')).toBe('Straight to the point.');
  });
});

describe('invoking a judge', () => {
  const config = (invoke: (payload: Record<string, unknown>) => Promise<unknown>) => ({
    invoke,
    judgeEndpoint: 'databricks-claude-sonnet-4-5',
  });

  const reply = (result: string) => ({
    choices: [{ message: { content: JSON.stringify({ rationale: "Let's think step by step. Fine.", result }) } }],
  });

  it('pins temperature so a re-run measures the agent and not the judge', () => {
    // The one documented deviation from MLflow. Asserted because an unpinned
    // judge would make two runs of the same suite incomparable.
    expect(judgeRequestPayload('p')).toMatchObject({
      messages: [{ role: 'user', content: 'p' }],
      temperature: 0,
    });
  });

  it('records the exact prompt version and provenance on every judgement', async () => {
    const judgement = await runJudge(config(() => Promise.resolve(reply('yes'))), GROUNDEDNESS_FEEDBACK_NAME, 'p');
    expect(judgement.state).toBe('scored');
    expect(judgement.value).toBe('yes');
    expect(judgement.promptVersion).toBe(MLFLOW_JUDGE_PROMPT_VERSION);
    expect(judgement.judgeEndpoint).toBe('databricks-claude-sonnet-4-5');
    // Attribution travels with the individual score, so a rationale lifted out
    // of the data still says what produced it.
    expect(judgement.provenance).toBe(
      'MLflow 3.14.0 groundedness prompt, run against databricks:/databricks-claude-sonnet-4-5'
    );
  });

  it('never describes itself as the managed Databricks judge', async () => {
    const judgement = await runJudge(config(() => Promise.resolve(reply('yes'))), GROUNDEDNESS_FEEDBACK_NAME, 'p');
    const wording = JSON.stringify(judgement).toLowerCase();
    expect(wording).not.toContain('managed judge');
    expect(wording).not.toContain('managed mlflow');
  });

  it('reports a transport failure as errored, with the reason, and not as a no', async () => {
    const judgement = await runJudge(
      config(() => Promise.reject(new Error('endpoint 503'))),
      GROUNDEDNESS_FEEDBACK_NAME,
      'p'
    );
    expect(judgement.state).toBe('errored');
    expect(judgement.value).toBeNull();
    expect(judgement.reason).toContain('endpoint 503');
  });

  it('stops waiting on a hung judge and says the call was abandoned rather than cancelled', async () => {
    vi.useFakeTimers();
    try {
      const pending = runJudge(
        { ...config(() => new Promise(() => {})), timeoutMs: 1_000 },
        GROUNDEDNESS_FEEDBACK_NAME,
        'p'
      );
      await vi.advanceTimersByTimeAsync(1_100);
      const judgement = await pending;
      expect(judgement.state).toBe('errored');
      expect(judgement.reason).toContain('abandoned, not cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a not-applicable judgement that is not a verdict', () => {
    const judgement = notApplicable(GROUNDEDNESS_FEEDBACK_NAME, 'ep', 'no document to check against');
    expect(judgement.state).toBe('not-applicable');
    expect(judgement.value).toBeNull();
    expect(judgement.reason).toBe('no document to check against');
    // A not-applicable judgement carries no rationale, so nothing can render it
    // as an opinion the judge held.
    expect(judgement.rationale).toBe('');
  });
});
