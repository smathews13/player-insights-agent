import {
  DEFAULT_LIVE_SAMPLE_RATE,
  liveChecksFromAnswer,
  shouldSampleLiveTrace,
  type LiveJudgeVerdict,
  type LiveTraceScore,
} from '../../shared/eval-live-scoring';
import { extraJudgesFromSettings } from '../../shared/eval-dataset';
import { DEFAULT_BENCHMARK_SETTINGS, type BenchmarkSettings } from '../../shared/benchmark-settings';
import {
  conversationTranscript,
  guidelinesPrompt,
  groundednessPrompt,
  GROUNDEDNESS_FEEDBACK_NAME,
  GUIDELINES_FEEDBACK_NAME,
  RELEVANCE_TO_QUERY_ASSESSMENT_NAME,
  relevanceToQueryPrompt,
  runJudge,
  type JudgeInvoker,
} from './mlflow-judges';
import { appendLiveScore } from './eval-live-score-store';
import type { LakebaseReader } from './lakebase-store';

export interface LiveAskTurn {
  conversationId: string;
  messageId: string;
  traceId?: string;
  question: string;
  response: string;
  sql: string;
  note: string;
  durationMs?: number | null;
  context?: string;
  /** Full Ask thread when known. One Q+A when it is not. */
  turns?: { role: string; content: string }[];
}

const JUDGE_BY_SETTING = {
  groundedness: GROUNDEDNESS_FEEDBACK_NAME,
  relevance: RELEVANCE_TO_QUERY_ASSESSMENT_NAME,
  guidelines: GUIDELINES_FEEDBACK_NAME,
} as const;

export function liveScoreId(conversationId: string, messageId: string): string {
  return `live-${conversationId}-${messageId}`.slice(0, 80);
}

export function scoreLiveDeterministic(
  turn: LiveAskTurn,
  settings: BenchmarkSettings,
  sampleRate: number = DEFAULT_LIVE_SAMPLE_RATE
): LiveTraceScore | null {
  if (!settings.alwaysOnTraces) return null;
  const seed = `${turn.conversationId}:${turn.messageId}`;
  if (!shouldSampleLiveTrace(seed, sampleRate)) return null;
  return {
    id: liveScoreId(turn.conversationId, turn.messageId),
    at: new Date().toISOString(),
    conversationId: turn.conversationId,
    messageId: turn.messageId,
    traceId: turn.traceId ?? '',
    question: turn.question.trim().slice(0, 2000),
    sampled: true,
    sampleRate,
    checks: liveChecksFromAnswer({
      sql: turn.sql,
      note: turn.note,
      durationMs: turn.durationMs,
    }),
    judges: [],
  };
}

export async function scoreLiveJudges(
  turn: LiveAskTurn,
  settings: BenchmarkSettings,
  invoke: JudgeInvoker
): Promise<LiveJudgeVerdict[]> {
  const verdicts: LiveJudgeVerdict[] = [];
  const enabled = new Set(settings.enabledJudges);
  const response = turn.response.trim();
  const question = turn.question.trim();
  const context = (turn.context ?? '').trim();
  const conversation =
    turn.turns && turn.turns.length > 0
      ? turn.turns.map((entry) => `${entry.role}: ${entry.content}`).join('\n')
      : conversationTranscript(question, response);

  const run = async (name: string, prompt: string): Promise<LiveJudgeVerdict> => {
    const judgement = await runJudge(
      { invoke, judgeEndpoint: settings.judgeEndpoint },
      name,
      prompt
    );
    return {
      name,
      value: judgement.state === 'scored' ? judgement.value : null,
      state: judgement.state,
      note: judgement.rationale || judgement.reason,
    };
  };

  if (enabled.has('groundedness')) {
    verdicts.push(
      context
        ? await run(GROUNDEDNESS_FEEDBACK_NAME, groundednessPrompt(question, response, context))
        : {
            name: GROUNDEDNESS_FEEDBACK_NAME,
            value: null,
            state: 'not-applicable',
            note: 'No retrieved context on this turn, so groundedness was not scored.',
          }
    );
  }
  if (enabled.has('relevance')) {
    verdicts.push(await run(RELEVANCE_TO_QUERY_ASSESSMENT_NAME, relevanceToQueryPrompt(question, response)));
  }
  if (enabled.has('guidelines') && settings.guidelinesText.trim()) {
    verdicts.push(
      await run(
        GUIDELINES_FEEDBACK_NAME,
        guidelinesPrompt([settings.guidelinesText.trim()], { request: question, response })
      )
    );
  }
  for (const extra of extraJudgesFromSettings(settings)) {
    if (extra.guidelines.length === 0) continue;
    const prompt =
      extra.kind === 'multi-turn'
        ? guidelinesPrompt(extra.guidelines, { conversation })
        : guidelinesPrompt(extra.guidelines, { request: question, response });
    verdicts.push(await run(extra.name, prompt));
  }
  return verdicts;
}

/**
 * Score one Ask turn if it is in the sample. Never throws to the caller.
 *
 * Fire-and-forget from Ask: a missed score is a missed score, not a failed answer.
 */
export async function scoreSampledAskTurn(input: {
  client: LakebaseReader;
  settings?: BenchmarkSettings;
  turn: LiveAskTurn;
  invokeJudge?: JudgeInvoker;
  sampleRate?: number;
}): Promise<LiveTraceScore | null> {
  try {
    const settings = input.settings ?? DEFAULT_BENCHMARK_SETTINGS;
    const scored = scoreLiveDeterministic(input.turn, settings, input.sampleRate);
    if (!scored) return null;
    if (input.invokeJudge && settings.judgeEndpoint.trim()) {
      try {
        scored.judges = await scoreLiveJudges(input.turn, settings, input.invokeJudge);
      } catch (error) {
        scored.judges = [
          {
            name: 'judges',
            value: null,
            state: 'errored',
            note: `LLM judges could not run: ${(error as Error).message}`,
          },
        ];
      }
    } else {
      scored.judges = [
        {
          name: 'judges',
          value: null,
          state: 'skipped',
          note: 'Deterministic checks ran. LLM judges need a reachable judge model.',
        },
      ];
    }
    await appendLiveScore(input.client, scored);
    return scored;
  } catch (error) {
    console.warn('[eval-live-scores] Sampled Ask turn was not scored:', (error as Error).message);
    return null;
  }
}

export function scheduleLiveAskScore(input: {
  client: LakebaseReader;
  settings?: BenchmarkSettings;
  turn: LiveAskTurn;
  invokeJudge?: JudgeInvoker;
}): void {
  void scoreSampledAskTurn(input);
}
