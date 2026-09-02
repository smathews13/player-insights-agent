import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONVERSATION_RUN_STATUS_QUERY, MIGRATIONS, conversationListQuery } from '../routes/insights-routes';
import {
  MONITORING_DETAIL_QUERY,
  MONITORING_PERSON_SEEN_QUERY,
  MONITORING_PERSON_TABLES_QUERY,
  MONITORING_QUESTIONS_QUERY,
} from '../routes/monitoring-routes';

const ROUTE_SOURCE = readFileSync(new URL('../routes/insights-routes.ts', import.meta.url), 'utf8');
const INDEX_MIGRATION = MIGRATIONS.find((migration) => migration.name === 'query path indexes');
const INDEX_SQL =
  INDEX_MIGRATION?.statements.filter((statement) => /^\s*CREATE\s+INDEX\b/i.test(statement)).map(collapse) ?? [];
const ALL_INDEX_SQL = MIGRATIONS.flatMap((migration) => migration.statements)
  .filter((statement) => /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement))
  .map(collapse);

function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function indexNamed(name: string): string {
  return ALL_INDEX_SQL.find((statement) => new RegExp(`\\b${name}\\b`, 'i').test(statement)) ?? '';
}

describe('the production query-path index migration', () => {
  it('is versioned, online, and replay-safe for existing data and racing replicas', () => {
    expect(INDEX_MIGRATION?.version).toBe(24);
    expect(INDEX_MIGRATION?.lock).toBe('session');
    expect(INDEX_SQL).toHaveLength(3);
    for (const statement of INDEX_SQL) {
      expect(statement).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /);
      expect(statement).not.toMatch(/\bWHERE\b/i);
    }
    expect(INDEX_MIGRATION?.down).toHaveLength(3);
    for (const statement of INDEX_MIGRATION?.down ?? []) {
      expect(collapse(statement)).toMatch(/^DROP INDEX CONCURRENTLY IF EXISTS player_insights\./);
    }
    expect(INDEX_MIGRATION?.statements.map(collapse)).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS player_insights.conversations_owner_updated_idx',
      INDEX_SQL[0],
      'DROP INDEX CONCURRENTLY IF EXISTS player_insights.attachments_conversation_owner_created_idx',
      INDEX_SQL[1],
      'DROP INDEX CONCURRENTLY IF EXISTS player_insights.feedback_message_owner_created_idx',
      INDEX_SQL[2],
    ]);
  });

  it('keeps each equality predicate before its ordering column', () => {
    expect(indexNamed('conversations_owner_updated_idx')).toContain(
      'ON player_insights.conversations (user_email, updated_at DESC)'
    );
    expect(indexNamed('attachments_conversation_owner_created_idx')).toContain(
      'ON player_insights.attachments (conversation_id, user_email, created_at)'
    );
    expect(indexNamed('feedback_message_owner_created_idx')).toContain(
      'ON player_insights.feedback (message_id, user_email, created_at DESC)'
    );
  });

  it('does not add redundant prefix indexes beside the three composites', () => {
    const newObjects = INDEX_SQL.join('\n');
    expect(newObjects).not.toMatch(/\bconversations\s*\(user_email\)/i);
    expect(newObjects).not.toMatch(/\battachments\s*\(conversation_id(?:,\s*created_at)?\)/i);
    expect(newObjects).not.toMatch(/\bfeedback\s*\(message_id(?:,\s*created_at)?\)/i);
    expect(newObjects).not.toMatch(/\b(?:runs|messages|app_sessions)\b/i);
  });
});

describe('query predicates stay aligned with index columns', () => {
  it('uses owner equality followed by newest update for the private conversation rail', () => {
    const privateRail = collapse(conversationListQuery('owner@example.invalid', false).sql);
    expect(privateRail).toContain('WHERE c.user_email = $1 ORDER BY c.updated_at DESC');
    expect(conversationListQuery('owner@example.invalid', false).params).toEqual(['owner@example.invalid']);

    // A shared rail has no owner equality, so the owner-first composite does not
    // claim to eliminate its global order. This is an explicit edge, not a
    // reason to add a second write-amplifying index without a measured need.
    const sharedRail = collapse(conversationListQuery('owner@example.invalid', true).sql);
    expect(sharedRail).not.toContain('WHERE c.user_email');
    expect(sharedRail).toContain('ORDER BY c.updated_at DESC');
    expect(conversationListQuery('owner@example.invalid', true).params).toEqual([]);
  });

  it('reads and removes attachments by conversation and owner in creation order', () => {
    expect(ROUTE_SOURCE).toMatch(
      /FROM \$\{APP_SCHEMA\}\.attachments\s+WHERE conversation_id = \$1 AND user_email = \$2 ORDER BY created_at/
    );
    expect(ROUTE_SOURCE).toMatch(
      /DELETE FROM \$\{APP_SCHEMA\}\.attachments\s+WHERE conversation_id = \$1 AND user_email = \$2/
    );
    expect(ROUTE_SOURCE).toMatch(/WHERE id = \$1 AND conversation_id = \$2 AND user_email = \$3/);
  });

  it('finds latest feedback by message and owner without excluding sentiment-only rows', () => {
    const feedbackReads = ROUTE_SOURCE.match(
      /WHERE f\.message_id = m\.id AND f\.user_email = \$2\s+ORDER BY f\.created_at DESC LIMIT 1/g
    );
    expect(feedbackReads?.length).toBeGreaterThanOrEqual(2);
    expect(MONITORING_QUESTIONS_QUERY).toContain('WHERE fb.message_id = a.id AND fb.user_email = q.user_email');
    expect(MONITORING_DETAIL_QUERY).toContain('WHERE fb.message_id = a.id AND fb.user_email = c.user_email');
    expect(indexNamed('feedback_message_owner_created_idx')).not.toMatch(/\bWHERE\b/i);
  });
});

describe('existing plan contracts reject overlapping indexes', () => {
  it('keeps conversation run polling on its existing conversation/time index', () => {
    expect(collapse(CONVERSATION_RUN_STATUS_QUERY)).toContain(
      'WHERE conversation_id = $1 AND ($3 OR user_email = $2) ORDER BY created_at DESC LIMIT 1'
    );
    expect(indexNamed('runs_conversation_idx')).toContain('ON player_insights.runs (conversation_id, created_at DESC)');
  });

  it('keeps Monitoring on the existing time and conversation/time indexes', () => {
    expect(MONITORING_QUESTIONS_QUERY).toContain('u.created_at >= $2::timestamptz');
    expect(MONITORING_QUESTIONS_QUERY).toContain('u.created_at < $3::timestamptz');
    expect(MONITORING_QUESTIONS_QUERY).toContain('ORDER BY u.created_at DESC');
    expect(MONITORING_PERSON_SEEN_QUERY).toContain('c.user_email = $2');
    expect(MONITORING_PERSON_TABLES_QUERY).toContain('m.conversation_id = q.conversation_id');
    expect(indexNamed('messages_created_at_idx')).toContain('ON player_insights.messages (created_at DESC)');
    expect(indexNamed('messages_conversation_created_idx')).toContain(
      'ON player_insights.messages (conversation_id, created_at DESC)'
    );
  });

  it('keeps bounded session cleanup on its existing retention index', () => {
    expect(indexNamed('app_sessions_retention_idx')).toContain(
      'ON player_insights.app_sessions (retention_expires_at)'
    );
  });
});
