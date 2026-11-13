import { describe, expect, it } from 'vitest';
import {
  PERSONA_HISTORY_DOWN,
  PERSONA_HISTORY_STATEMENTS,
  PERSONA_USE_QUESTION_LIMIT,
  SP_ASSIGNMENT_EVENTS_TABLE,
  SP_PERSONA_USE_TABLE,
  listAssignmentEvents,
  listPersonaUse,
  normalizeReason,
  recordPersonaUse,
} from './persona-history';
import { SP_ASSIGNMENTS_TABLE, writeSpAssignment, deleteSpPersona } from './sp-identity-store';
import { executionIdentityClaim } from './identity-binding';
import { MIGRATIONS } from '../routes/insights-routes';

interface Call {
  sql: string;
  params: unknown[];
}

function recordingStore(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  return {
    calls,
    lakebase: {
      query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (/FROM\s+\S*sp_personas\s+WHERE id/i.test(sql)) {
          return Promise.resolve({
            rows: [
              {
                id: 'persona-1',
                display_name: 'Regional analyst',
                client_id: 'aaaaaaaa-0000-4000-8000-000000000001',
                secret_scope: 'scope',
                secret_key: 'key',
                updated_at: '2026-11-01T00:00:00.000Z',
                updated_by: 'admin@example.com',
              },
            ],
          });
        }
        return Promise.resolve({ rows });
      },
    },
  };
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('the persona history migration', () => {
  const migration = MIGRATIONS.find((entry) => entry.name === 'persona assignment history and use');

  it('is registered as the next version with its undo', () => {
    expect(migration?.version).toBe(45);
    expect(migration?.statements).toEqual(PERSONA_HISTORY_STATEMENTS);
    expect(migration?.down).toEqual(PERSONA_HISTORY_DOWN);
  });

  it('makes both tables refuse UPDATE, DELETE and TRUNCATE', () => {
    const sql = PERSONA_HISTORY_STATEMENTS.map(collapse);
    for (const table of [SP_ASSIGNMENT_EVENTS_TABLE, SP_PERSONA_USE_TABLE]) {
      expect(sql.some((s) => s.includes(`BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW`))).toBe(true);
      expect(sql.some((s) => s.includes(`BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT`))).toBe(true);
    }
    expect(sql.some((s) => /RAISE EXCEPTION '% is append-only'/.test(s))).toBe(true);
  });

  it('keeps existing assignments working and gives each one history row, once', () => {
    const sql = PERSONA_HISTORY_STATEMENTS.map(collapse);
    expect(sql).toContain(`ALTER TABLE ${SP_ASSIGNMENTS_TABLE} ADD COLUMN IF NOT EXISTS reason TEXT`);
    expect(sql.some((s) => /DROP|DELETE FROM|UPDATE .* SET/i.test(s))).toBe(false);
    const backfill = sql.find((s) => s.startsWith(`INSERT INTO ${SP_ASSIGNMENT_EVENTS_TABLE}`)) ?? '';
    expect(backfill).toContain(`FROM ${SP_ASSIGNMENTS_TABLE} a`);
    expect(backfill).toContain(`WHERE NOT EXISTS (SELECT 1 FROM ${SP_ASSIGNMENT_EVENTS_TABLE})`);
  });

  it('allows one use row per run', () => {
    expect(PERSONA_HISTORY_STATEMENTS.map(collapse)).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS sp_persona_use_run_idx ON ${SP_PERSONA_USE_TABLE} (run_id)`
    );
  });
});

describe('assignment changes', () => {
  it('saves the assignment and its history row in one statement, with the reason', async () => {
    const store = recordingStore([
      {
        email: 'ada@example.com',
        persona_id: 'persona-1',
        updated_at: '2026-11-13T00:00:00.000Z',
        updated_by: 'admin@example.com',
        reason: 'Reproduce the regional view',
      },
    ]);
    const saved = await writeSpAssignment(
      store as never,
      'Ada@example.com',
      'persona-1',
      'admin@example.com',
      '  Reproduce the regional view  '
    );
    expect(saved?.reason).toBe('Reproduce the regional view');
    const write = store.calls.find((call) => call.sql.includes(`INSERT INTO ${SP_ASSIGNMENTS_TABLE}`));
    expect(write?.sql).toContain(`INSERT INTO ${SP_ASSIGNMENT_EVENTS_TABLE}`);
    expect(write?.params).toEqual([
      'ada@example.com',
      'persona-1',
      'admin@example.com',
      'Reproduce the regional view',
      'Regional analyst',
    ]);
  });

  it('records a removal in the same statement that removes it', async () => {
    const store = recordingStore();
    await writeSpAssignment(store as never, 'ada@example.com', null, 'admin@example.com', '');
    expect(store.calls).toHaveLength(1);
    const sql = collapse(store.calls[0].sql);
    expect(sql).toMatch(/^WITH removed AS \( DELETE FROM \S+sp_assignments WHERE email = \$1 RETURNING email \)/);
    expect(sql).toContain(`INSERT INTO ${SP_ASSIGNMENT_EVENTS_TABLE}`);
    expect(store.calls[0].params).toEqual(['ada@example.com', null, 'admin@example.com']);
  });

  it('records the people who lose a persona when it is deleted', async () => {
    const store = recordingStore([{ id: 'persona-1' }]);
    await deleteSpPersona(store as never, 'persona-1', 'admin@example.com');
    const removal = collapse(store.calls[0].sql);
    expect(removal).toContain('DELETE FROM');
    expect(removal).toContain(`INSERT INTO ${SP_ASSIGNMENT_EVENTS_TABLE}`);
    expect(removal).toContain("'The persona was deleted.'");
  });

  it('treats a blank reason as none and caps a long one', () => {
    expect(normalizeReason('   ')).toBeNull();
    expect(normalizeReason(undefined)).toBeNull();
    expect(normalizeReason('x'.repeat(1500))).toHaveLength(1000);
  });
});

describe('persona use', () => {
  it('writes one row per run with the persona and the question', async () => {
    const store = recordingStore();
    await recordPersonaUse(store as never, {
      runId: 'run-1',
      conversationId: 'conversation-1',
      userEmail: 'Ada@Example.com',
      persona: { id: 'persona-1', displayName: 'Regional analyst', clientId: 'client-1' },
      question: 'q'.repeat(PERSONA_USE_QUESTION_LIMIT + 50),
    });
    const call = store.calls[0];
    expect(collapse(call.sql)).toContain('ON CONFLICT (run_id) DO NOTHING');
    expect(call.params.slice(0, 6)).toEqual([
      'run-1',
      'conversation-1',
      'ada@example.com',
      'persona-1',
      'Regional analyst',
      'client-1',
    ]);
    expect(String(call.params[6])).toHaveLength(PERSONA_USE_QUESTION_LIMIT);
  });

  it('reads history newest first, optionally for one person', async () => {
    const store = recordingStore([
      {
        run_id: 'run-1',
        conversation_id: null,
        user_email: 'ada@example.com',
        persona_id: 'persona-1',
        persona_name: 'Regional analyst',
        persona_client_id: 'client-1',
        question: 'How many players?',
        recorded_at: new Date('2026-11-13T00:00:00.000Z'),
      },
    ]);
    const use = await listPersonaUse(store as never, 'Ada@example.com');
    expect(use[0]).toMatchObject({ runId: 'run-1', question: 'How many players?' });
    expect(use[0]?.recordedAt).toBe('2026-11-13T00:00:00.000Z');
    expect(store.calls[0]?.params).toEqual(['ada@example.com']);
    expect(collapse(store.calls[0].sql)).toContain('ORDER BY recorded_at DESC');
    await listAssignmentEvents(store as never);
    expect(store.calls[1]?.params).toEqual([null]);
  });

  it('reads as empty before the migration has run', async () => {
    const store = {
      lakebase: {
        query() {
          return Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
        },
      },
    };
    expect(await listPersonaUse(store as never)).toEqual([]);
    expect(await listAssignmentEvents(store as never)).toEqual([]);
  });
});

describe('the answer identity claim', () => {
  it('names the persona only when the answer ran as one', () => {
    const persona = { id: 'persona-1', displayName: 'Regional analyst', clientId: 'client-1' };
    expect(
      executionIdentityClaim({
        mode: 'assigned_service_principal',
        verified: true,
        persona,
      } as never)
    ).toEqual({ mode: 'assigned_service_principal', verified: true, persona: 'Regional analyst' });
    expect(executionIdentityClaim({ mode: 'signed_in_user', verified: true, persona } as never)).toEqual({
      mode: 'signed_in_user',
      verified: true,
    });
  });
});
