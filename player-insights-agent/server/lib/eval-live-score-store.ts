import { appTable } from '../../shared/app-schema';
import {
  LIVE_SCORE_KEEP,
  parseLiveTraceScore,
  type LiveTraceScore,
} from '../../shared/eval-live-scoring';
import type { LakebaseReader } from './lakebase-store';

export const EVAL_LIVE_SCORES_TABLE = appTable('eval_live_scores');
export const EVAL_LIVE_SCORES_DDL = `CREATE TABLE IF NOT EXISTS ${EVAL_LIVE_SCORES_TABLE} (
  id TEXT PRIMARY KEY,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  score JSONB NOT NULL
)`;

export async function appendLiveScore(
  client: LakebaseReader,
  score: LiveTraceScore
): Promise<LiveTraceScore> {
  const parsed = parseLiveTraceScore(score);
  await client.lakebase.query(
    `INSERT INTO ${EVAL_LIVE_SCORES_TABLE} (id, conversation_id, message_id, score, scored_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       score = EXCLUDED.score, scored_at = now()`,
    [parsed.id, parsed.conversationId, parsed.messageId, JSON.stringify(parsed)]
  );
  return parsed;
}

export async function listLiveScores(
  client: LakebaseReader,
  limit: number = LIVE_SCORE_KEEP
): Promise<LiveTraceScore[]> {
  try {
    const result = await client.lakebase.query(
      `SELECT score FROM ${EVAL_LIVE_SCORES_TABLE} ORDER BY scored_at DESC LIMIT $1`,
      [Math.max(1, Math.min(limit, LIVE_SCORE_KEEP))]
    );
    return (result?.rows ?? [])
      .map((row) => {
        try {
          return parseLiveTraceScore(row.score);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is LiveTraceScore => entry !== null);
  } catch (error) {
    console.warn('[eval-live-scores] Live scores could not be read:', (error as Error).message);
    return [];
  }
}
