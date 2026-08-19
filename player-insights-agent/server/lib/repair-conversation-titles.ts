/**
 * Restore the conversation labels an earlier version cut to 80 characters.
 *
 * WHY A REPAIR AND NOT JUST A FIX. The label was derived with `prompt.slice(0, 80)`
 * and STORED that way, so fixing the derivation only helps conversations asked
 * afterwards. Every row written before it keeps a fragment as its permanent label —
 * on example, one of four read "Which three titles had the most active players in the
 * last 30 days, and how many", with nothing to say a question mark had been cut off
 * the end of it. The rail has no other source for that text, so without this the
 * only way those rows ever read properly is for somebody to ask them again.
 *
 * The question itself was never lost: it is in `messages` as the turn's content.
 * This reads it back from there.
 *
 * WHY THE DERIVATION IS NOT DONE IN SQL. `conversationTitle` collapses whitespace,
 * cuts on a word boundary and marks that it cut. Expressing that a second time in
 * Postgres would put two versions of one rule in the codebase, which is the exact
 * defect this repair exists to clean up — the 80-character cut was written twice,
 * in the server and in the browser. So the rows come back to Node and the shared
 * function derives the label.
 *
 * WHY IT IS SAFE TO RUN AT EVERY BOOT. A row is only rewritten when its title is
 * PROVABLY a truncation: exactly 80 characters long, and a prefix of the first
 * question in that conversation. A label somebody meant to be 80 characters is
 * indistinguishable from a cut one by length alone, hence the prefix test; and once
 * a row is repaired it no longer matches, so the second boot updates nothing.
 */
import { APP_SCHEMA } from '../../shared/app-schema';
import { conversationTitle } from '../../shared/conversation-title';

/** The width the old cut used. Only rows of exactly this length are candidates. */
const OLD_CUT_LENGTH = 80;

/**
 * The candidates, and the question each one should be named after.
 *
 * `DISTINCT ON` with the ordering below takes the FIRST question of each
 * conversation, which is what names it. A later turn must not rename it.
 */
const TRUNCATED_TITLES_QUERY = `
  SELECT DISTINCT ON (c.id) c.id, c.title, m.content
    FROM ${APP_SCHEMA}.conversations c
    JOIN ${APP_SCHEMA}.messages m ON m.conversation_id = c.id AND m.role = 'user'
   WHERE length(c.title) = $1
     AND c.title <> m.content
     AND m.content LIKE c.title || '%'
   ORDER BY c.id, m.created_at ASC`;

interface Repair {
  id: string;
  title: string;
}

export interface TitleRepairOutcome {
  /** Rows whose label was restored. */
  repaired: number;
  /** Why nothing happened, when nothing did. Empty when the pass ran cleanly. */
  skipped: string;
}

/**
 * Rewrite truncated conversation labels from the questions that produced them.
 *
 * Never throws. This runs at startup beside the schema pass, and a store that
 * cannot answer a `SELECT` is already reported by that pass and by the watchdog;
 * failing the boot over a cosmetic repair would take the whole app down to fix a
 * label.
 */
export async function repairTruncatedTitles(appkit: {
  lakebase: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}): Promise<TitleRepairOutcome> {
  let rows: Record<string, unknown>[];
  try {
    const result = await appkit.lakebase.query(TRUNCATED_TITLES_QUERY, [OLD_CUT_LENGTH]);
    rows = result.rows ?? [];
  } catch (error) {
    return { repaired: 0, skipped: `the candidate read was refused: ${(error as Error).message}` };
  }

  const repairs: Repair[] = [];
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : '';
    const content = typeof row.content === 'string' ? row.content : '';
    if (!id || !content) continue;
    const restored = conversationTitle(content);
    // A question only just over the cut can derive back to the same 80 characters.
    // Writing that is a no-op with a write's cost and a write's risk.
    if (restored === row.title) continue;
    repairs.push({ id, title: restored });
  }

  let repaired = 0;
  for (const repair of repairs) {
    try {
      await appkit.lakebase.query(
        `UPDATE ${APP_SCHEMA}.conversations SET title = $2 WHERE id = $1`,
        [repair.id, repair.title]
      );
      repaired += 1;
    } catch (error) {
      // Reported per row rather than abandoning the pass: the rows are independent,
      // and one refusal is usually ownership on a single row rather than a broken
      // store, in which case the rest still get their labels back.
      console.warn(`[lakebase] Could not restore the label on conversation ${repair.id}: ` +
          `${(error as Error).message}. It keeps the shortened one.`
      );
    }
  }

  if (repaired > 0) {
    console.log(`[lakebase] Restored ${repaired} conversation label(s) that an earlier version ` +
        `stored cut to ${OLD_CUT_LENGTH} characters. Read back from the question each one was asked with.`
    );
  }

  return { repaired, skipped: '' };
}
