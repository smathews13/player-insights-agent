import { describe, it, expect, vi } from 'vitest';
import { repairTruncatedTitles } from './repair-conversation-titles';

/** The question found stored as a fragment on example, and the fragment itself. */
const ASKED = 'Which three titles had the most active players in the last 30 days, and how many did each have?';
const CUT = ASKED.slice(0, 80);

interface Row {
  id: string;
  title: string;
  content: string;
}

/**
 * A store that answers the candidate read with the rows given and records updates.
 *
 * Deliberately does NOT re-evaluate the SQL: the conditions in the query are asserted
 * separately below, against its text, because a fake that reimplemented them would
 * agree with the query by construction and prove nothing about it.
 */
function storeWith(rows: Row[]) {
  const updates: { id: string; title: string }[] = [];
  return {
    updates,
    lakebase: {
      query(text: string, params: unknown[] = []) {
        if (text.includes('UPDATE player_insights.conversations')) {
          updates.push({ id: String(params[0]), title: String(params[1]) });
          return Promise.resolve({ rows: [] as Record<string, unknown>[] });
        }
        return Promise.resolve({ rows: rows as unknown as Record<string, unknown>[] });
      },
    },
  };
}

describe('repairTruncatedTitles', () => {
  it('restores the whole question over a label that was cut to 80 characters', async () => {
    const store = storeWith([{ id: 'conv-1', title: CUT, content: ASKED }]);

    const outcome = await repairTruncatedTitles(store);

    expect(outcome.repaired).toBe(1);
    expect(store.updates).toEqual([{ id: 'conv-1', title: ASKED }]);
  });

  it('restores a question only a few characters longer than the cut', async () => {
    // The small overrun is the case a length-based heuristic would most likely miss,
    // and it is the commonest: a question that ran four words past the limit.
    const barely = `${CUT} and`;
    const store = storeWith([{ id: 'conv-1', title: CUT, content: barely }]);

    const outcome = await repairTruncatedTitles(store);

    expect(outcome.repaired).toBe(1);
    expect(store.updates[0].title).toBe(barely);
  });

  it('skips a row whose question derives back to exactly the stored label', async () => {
    const store = storeWith([{ id: 'conv-1', title: CUT, content: CUT }]);

    const outcome = await repairTruncatedTitles(store);

    expect(outcome.repaired).toBe(0);
    expect(store.updates).toEqual([]);
  });

  it('carries on past a row the store refuses, so one bad row costs only itself', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: string[] = [];
    const store = {
      lakebase: {
        query(text: string, params: unknown[] = []) {
          if (text.includes('UPDATE')) {
            const id = String(params[0]);
            if (id === 'conv-1') return Promise.reject(new Error('permission denied for table conversations'));
            updates.push(id);
            return Promise.resolve({ rows: [] as Record<string, unknown>[] });
          }
          return Promise.resolve({
            rows: [
              { id: 'conv-1', title: CUT, content: ASKED },
              { id: 'conv-2', title: CUT, content: ASKED },
            ] as Record<string, unknown>[],
          });
        },
      },
    };

    const outcome = await repairTruncatedTitles(store);

    expect(outcome.repaired).toBe(1);
    expect(updates).toEqual(['conv-2']);
    warn.mockRestore();
  });

  it('reports rather than throws when the store will not answer at all', async () => {
    // This runs during startup. Throwing here would take the app down over a label.
    const store = {
      lakebase: {
        query: () => Promise.reject(new Error('relation player_insights.conversations does not exist')),
      },
    };

    const outcome = await repairTruncatedTitles(store);

    expect(outcome.repaired).toBe(0);
    expect(outcome.skipped).toMatch(/refused/);
  });

  it('asks only for rows whose label is provably a truncation of their first question', async () => {
    // The safety of running this at every boot is entirely in these conditions, and
    // they live in SQL, so they are asserted against the SQL.
    let asked = '';
    const store = {
      lakebase: {
        query(text: string) {
          asked = text.replace(/\s+/g, ' ').trim();
          return Promise.resolve({ rows: [] as Record<string, unknown>[] });
        },
      },
    };

    await repairTruncatedTitles(store);

    // Exactly the old cut's width, and the stored label must be a prefix of the
    // question: length alone cannot tell a cut label from an 80-character one.
    expect(asked).toContain('length(c.title) = $1');
    expect(asked).toContain("m.content LIKE c.title || '%'");
    expect(asked).toContain('c.title <> m.content');
    // The FIRST question names the conversation, not the most recent one.
    expect(asked).toContain('DISTINCT ON (c.id)');
    expect(asked).toContain('ORDER BY c.id, m.created_at ASC');
    expect(asked).toContain("m.role = 'user'");
  });
});
