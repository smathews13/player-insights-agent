import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_RETENTION_ENV,
  DELETE_CONVERSATION_RUNS,
  conversationRetentionDays,
  eraseConversation,
  eraseUserData,
  purgeExpiredConversations,
  startConversationRetention,
} from './conversation-erasure';

function recordingStore(answers: (sql: string, params: unknown[]) => Record<string, unknown>[] = () => []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  return {
    statements,
    query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      statements.push({ sql, params });
      return Promise.resolve({ rows: answers(sql, params) });
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('retention is off unless configured', () => {
  it('is off when unset, empty or zero', () => {
    expect(conversationRetentionDays({})).toBeNull();
    expect(conversationRetentionDays({ [CONVERSATION_RETENTION_ENV]: '' })).toBeNull();
    expect(conversationRetentionDays({ [CONVERSATION_RETENTION_ENV]: '0' })).toBeNull();
  });

  it('refuses a value it cannot trust rather than clamping it', () => {
    for (const raw of ['1', '6', 'ninety', '30.5', '-30', '99999']) {
      expect(conversationRetentionDays({ [CONVERSATION_RETENTION_ENV]: raw })).toBeNull();
    }
    expect(conversationRetentionDays({ [CONVERSATION_RETENTION_ENV]: '90' })).toBe(90);
  });

  it('issues no statement at all while off', async () => {
    const store = recordingStore();
    const result = await purgeExpiredConversations(store, { env: {} });
    expect(result.enabled).toBe(false);
    expect(store.statements).toEqual([]);
    const stop = startConversationRetention(store, {});
    stop();
    expect(store.statements).toEqual([]);
  });
});

describe('removing one conversation', () => {
  it('names every table keyed to it, by the one id, with the conversation last', async () => {
    const store = recordingStore();
    await eraseConversation(store, 'conv-1');
    const tables = store.statements.map(({ sql }) => sql.match(/DELETE FROM player_insights\.(\w+)/)?.[1]);
    expect(tables).toEqual(['runs', 'feedback', 'attachments', 'messages', 'conversations']);
    for (const { params } of store.statements) expect(params).toEqual(['conv-1']);
  });

  it('removes runs with their events, attempts and labels in one statement', () => {
    const sql = DELETE_CONVERSATION_RUNS.replace(/\s+/g, ' ');
    for (const table of ['run_events', 'run_attempts', 'run_label_overrides']) {
      expect(sql).toContain(`DELETE FROM player_insights.${table} WHERE run_id IN (SELECT run_id FROM gone)`);
    }
  });

  it('never touches the append-only persona history', async () => {
    const store = recordingStore((sql) => (sql.startsWith('SELECT id FROM') ? [{ id: 'conv-1' }] : []));
    await eraseUserData(store, 'reader@example.com');
    await purgeExpiredConversations(store, { env: { [CONVERSATION_RETENTION_ENV]: '30' } });
    const all = store.statements.map(({ sql }) => sql).join(' ');
    expect(all).not.toMatch(/sp_persona_use|sp_assignment_events|sp_assignments/);
  });
});

describe('the retention purge', () => {
  it('removes only conversations past the window, a bounded batch at a time, and audits it', async () => {
    const store = recordingStore((sql) => {
      if (sql.startsWith('SELECT id FROM')) return [{ id: 'old-1' }, { id: 'old-2' }];
      if (sql.startsWith('DELETE FROM player_insights.conversations')) return [{ id: 'x' }];
      if (sql.startsWith('DELETE FROM player_insights.messages')) return [{ id: 'm' }];
      return [];
    });
    const result = await purgeExpiredConversations(store, { env: { [CONVERSATION_RETENTION_ENV]: '30' }, batch: 50 });

    expect(result).toMatchObject({ enabled: true, retentionDays: 30, conversations: 2, messages: 2 });
    const select = store.statements[0];
    expect(select.sql).toContain('updated_at < NOW() - make_interval(days => $1::int)');
    expect(select.params).toEqual([30, 50]);
    const audit = store.statements.find(({ sql }) => sql.startsWith('INSERT INTO player_insights.admin_audit'));
    expect(audit?.params).toContain('conversations-purged');
    expect(audit?.params).toContain('system:conversation-retention');
  });

  it('keeps taking batches until the backlog is gone, with one audit row for the pass', async () => {
    const backlog = ['old-1', 'old-2', 'old-3', 'old-4', 'old-5'];
    const store = recordingStore((sql, params) => {
      if (sql.startsWith('SELECT id FROM')) return backlog.slice(0, Number(params[1])).map((id) => ({ id }));
      if (sql.startsWith('DELETE FROM player_insights.conversations')) {
        backlog.splice(backlog.indexOf(String(params[0])), 1);
        return [{ id: params[0] }];
      }
      return [];
    });
    const result = await purgeExpiredConversations(store, { env: { [CONVERSATION_RETENTION_ENV]: '30' }, batch: 2 });

    expect(result.conversations).toBe(5);
    expect(backlog).toEqual([]);
    expect(store.statements.filter(({ sql }) => sql.startsWith('SELECT id FROM'))).toHaveLength(3);
    expect(store.statements.filter(({ sql }) => sql.includes('admin_audit'))).toHaveLength(1);
  });

  it('stops the pass when a full batch removes nothing, rather than looping', async () => {
    const store = recordingStore((sql) =>
      sql.startsWith('SELECT id FROM') ? [{ id: 'stuck-1' }, { id: 'stuck-2' }] : []
    );
    const result = await purgeExpiredConversations(store, { env: { [CONVERSATION_RETENTION_ENV]: '30' }, batch: 2 });

    expect(result.conversations).toBe(0);
    expect(store.statements.filter(({ sql }) => sql.startsWith('SELECT id FROM'))).toHaveLength(1);
  });

  it('writes no audit row when nothing was old enough', async () => {
    const store = recordingStore();
    await purgeExpiredConversations(store, { env: { [CONVERSATION_RETENTION_ENV]: '30' } });
    expect(store.statements.some(({ sql }) => sql.includes('admin_audit'))).toBe(false);
  });
});

describe('erasing one person', () => {
  it('scopes every person-level statement to their address alone', async () => {
    const store = recordingStore((sql) => (sql.startsWith('SELECT id FROM') ? [{ id: 'conv-9' }] : []));
    await eraseUserData(store, ' Reader@Example.com ');

    const personLevel = store.statements.filter(({ params }) => !params.includes('conv-9'));
    expect(personLevel.length).toBeGreaterThanOrEqual(5);
    for (const { sql, params } of personLevel) {
      expect(sql).toMatch(/WHERE (lower\(user_email\) = \$1|id = \$1)/);
      expect(params).toHaveLength(1);
      expect(String(params[0])).toMatch(/^(user:)?reader@example\.com$/);
    }
    const conversationLevel = store.statements.filter(({ params }) => params.includes('conv-9'));
    expect(conversationLevel.map(({ sql }) => sql.match(/DELETE FROM player_insights\.(\w+)/)?.[1])).toEqual([
      'runs',
      'feedback',
      'attachments',
      'messages',
      'conversations',
    ]);
  });

  it('removes their runs outside any conversation with events, attempts and labels', async () => {
    const store = recordingStore();
    await eraseUserData(store, 'reader@example.com');
    const stray = store.statements.find(({ sql }) =>
      sql.includes('DELETE FROM player_insights.runs WHERE lower(user_email)')
    );
    for (const table of ['run_events', 'run_attempts', 'run_label_overrides']) {
      expect(stray?.sql).toContain(`DELETE FROM player_insights.${table} WHERE run_id IN (SELECT run_id FROM gone)`);
    }
  });
});
