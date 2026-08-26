import { APP_SCHEMA } from '../../shared/app-schema';
import type { ConversationTurn } from '../../shared/eval-conversation';
import type { LakebaseReader } from './lakebase-store';

export async function loadConversationTurns(
  client: LakebaseReader,
  conversationId: string
): Promise<ConversationTurn[]> {
  const id = conversationId.trim();
  if (!id) return [];
  const result = await client.lakebase.query(
    `SELECT role, content FROM ${APP_SCHEMA}.messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC, id ASC`,
    [id]
  );
  return (result?.rows ?? [])
    .map((row) => ({
      role: typeof row.role === 'string' ? row.role : '',
      content: typeof row.content === 'string' ? row.content : '',
    }))
    .filter((turn) => turn.role && turn.content.trim());
}

export async function findLatestAnsweredConversation(client: LakebaseReader): Promise<string> {
  const result = await client.lakebase.query(
    `SELECT conversation_id FROM ${APP_SCHEMA}.messages
     WHERE role = 'assistant' AND btrim(content) <> ''
     ORDER BY created_at DESC
     LIMIT 1`
  );
  const id = result?.rows?.[0]?.conversation_id;
  return typeof id === 'string' ? id : '';
}

export async function findConversationIdByQuestion(
  client: LakebaseReader,
  question: string
): Promise<string> {
  const asked = question.trim();
  if (!asked) return '';
  const result = await client.lakebase.query(
    `SELECT conversation_id FROM ${APP_SCHEMA}.messages
     WHERE role = 'user' AND lower(btrim(content)) = lower(btrim($1))
     ORDER BY created_at DESC
     LIMIT 1`,
    [asked]
  );
  const id = result?.rows?.[0]?.conversation_id;
  return typeof id === 'string' ? id : '';
}

export async function loadTurnsForQuestion(
  client: LakebaseReader,
  question: string
): Promise<ConversationTurn[]> {
  const conversationId = await findConversationIdByQuestion(client, question);
  if (!conversationId) return [];
  return loadConversationTurns(client, conversationId);
}
