/**
 * Proves the tenancy predicates actually filter, against the live schema.
 *
 * The two principals and their rows are created inside a transaction that is
 * always rolled back, so the database is never changed: nothing is committed,
 * and the row counts are re-read afterwards to prove it. Synthetic rows are used
 * rather than real ones because the assertion needs a known owner and a known
 * non-owner, and because the store's real contents are being curated for a
 * snapshot by someone else.
 */
import { Client } from 'pg';
import {
  RUNS_QUERY,
  RUN_TRACE_MESSAGE_QUERY,
  RUN_TRACE_BENCHMARK_QUERY,
  PLAN_APPROVAL_MESSAGE,
  SHARED_RUN_OWNER,
} from '../server/routes/insights-routes.ts';

const ALICE = 'tenancy-probe-alice@app.invalid';
const BOB = 'tenancy-probe-bob@app.invalid';

const MESSAGES_READ = `SELECT m.id, m.role, m.content, m.response_json, m.trace_id, m.created_at
       FROM player_insights.messages m
       JOIN player_insights.conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = $1 AND c.user_email = $2
       ORDER BY m.created_at`;

const HISTORY_READ = `SELECT role, content, response_json FROM (SELECT m.role, m.content, m.response_json, m.created_at
         FROM player_insights.messages m
         JOIN player_insights.conversations c ON c.id = m.conversation_id
         WHERE m.conversation_id = $1 AND c.user_email = $2
         ORDER BY m.created_at DESC LIMIT 12
       ) recent ORDER BY created_at`;

const ATTACHMENT_TEXT_READ = `SELECT filename, extracted_text FROM player_insights.attachments
       WHERE conversation_id = $1 AND user_email = $2 AND extracted_text IS NOT NULL`;

const OWNERSHIP = 'SELECT user_email FROM player_insights.conversations WHERE id = $1';

const SINGLE_DELETE = `DELETE FROM player_insights.attachments
       WHERE id = $1 AND conversation_id = $2 AND user_email = $3
       RETURNING id`;

const CONVERSATION_LIST =
  'SELECT id, title, updated_at FROM player_insights.conversations WHERE user_email = $1 ORDER BY updated_at DESC LIMIT 30';

const client = new Client({
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT ?? 5432),
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
function check(name: string, passed: boolean, detail: string) {
  if (passed) console.log(`  ok    ${name}, ${detail}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}, ${detail}`);
  }
}

await client.connect();

const before = await client.query(`SELECT (SELECT count(*) FROM player_insights.conversations) conversations,
          (SELECT count(*) FROM player_insights.messages) messages,
          (SELECT count(*) FROM player_insights.attachments) attachments,
          (SELECT count(*) FROM player_insights.benchmark_runs) benchmark_runs,
          (SELECT count(*) FROM player_insights.feedback) feedback`
);
console.log('row counts before:', JSON.stringify(before.rows[0]));

await client.query('BEGIN');
try {
  // Two principals, each owning one conversation, one answer, one attachment,
  // one benchmark run and one rating. Rolled back at the end.
  for (const [who, tag] of [
    [ALICE, 'alice'],
    [BOB, 'bob'],
  ] as const) {
    await client.query('INSERT INTO player_insights.conversations (id, user_email, title) VALUES ($1,$2,$3)',
      [`probe-conv-${tag}`, who, `probe ${tag}`]
    );
    await client.query(`INSERT INTO player_insights.messages (id, conversation_id, role, content, response_json, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        `probe-msg-${tag}`,
        `probe-conv-${tag}`,
        'assistant',
        `${tag} private answer`,
        // The runs list counts an assistant turn as a run only once it carries a
        // trace object. A plan proposal has none and is not yet a run.
        JSON.stringify({
          type: 'answer',
          takeaway: `${tag} private takeaway`,
          trace: { totalMs: 1234, stages: [{ status: 'complete' }] },
        }),
        `probe-trace-${tag}`,
      ]
    );
    await client.query(`INSERT INTO player_insights.messages (id, conversation_id, role, content)
       VALUES ($1,$2,$3,$4)`,
      [`probe-msg-${tag}-user`, `probe-conv-${tag}`, 'user', `${tag} private question`]
    );
    await client.query(`INSERT INTO player_insights.attachments
         (id, conversation_id, user_email, filename, mime_type, size_bytes, extracted_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        `probe-att-${tag}`,
        `probe-conv-${tag}`,
        who,
        `${tag}.pdf`,
        'application/pdf',
        123,
        `${tag} private document text`,
      ]
    );
    await client.query(`INSERT INTO player_insights.benchmark_runs (id, suite_id, user_email, status, metrics_json)
       VALUES ($1,$2,$3,$4,$5)`,
      [`probe-bench-${tag}`, 'probe-suite', who, 'complete', JSON.stringify({ score: 1 })]
    );
    await client.query(`INSERT INTO player_insights.feedback (id, message_id, user_email, sentiment, usefulness)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        `probe-fb-${tag}`,
        `probe-msg-${tag}`,
        who,
        tag === 'alice' ? 'up' : 'down',
        // `usefulness` is an integer score on the live schema.
        tag === 'alice' ? 5 : 2,
      ]
    );
  }

  // The hazard the rating predicate exists for: the feedback route accepts any
  // message id, so Bob can rate Alice's answer. Hers must still read as hers.
  await client.query(`INSERT INTO player_insights.feedback (id, message_id, user_email, sentiment, usefulness)
     VALUES ($1,$2,$3,$4,$5)`,
    ['probe-fb-bob-on-alice', 'probe-msg-alice', BOB, 'down', 1]
  );

  console.log('\nreading as Alice, who must not see Bob:\n');

  const bobsMessages = await client.query(MESSAGES_READ, ['probe-conv-bob', ALICE]);
  check('GET /api/conversations/:id/messages',
    bobsMessages.rowCount === 0,
    `Bob's conversation read by Alice returned ${bobsMessages.rowCount} rows`
  );
  const ownMessages = await client.query(MESSAGES_READ, ['probe-conv-alice', ALICE]);
  check('GET /api/conversations/:id/messages (own)',
    (ownMessages.rowCount ?? 0) > 0,
    `Alice's own conversation returned ${ownMessages.rowCount} rows, so the join did not over-filter`
  );

  const bobsHistory = await client.query(HISTORY_READ, ['probe-conv-bob', ALICE]);
  check('ask: conversation history',
    bobsHistory.rowCount === 0,
    `Bob's history read by Alice returned ${bobsHistory.rowCount} rows`
  );
  const ownHistory = await client.query(HISTORY_READ, ['probe-conv-alice', ALICE]);
  check('ask: conversation history (own)',
    (ownHistory.rowCount ?? 0) > 0,
    `Alice's own history returned ${ownHistory.rowCount} rows`
  );

  const bobsAttachments = await client.query(ATTACHMENT_TEXT_READ, ['probe-conv-bob', ALICE]);
  check('ask: attachment text',
    bobsAttachments.rowCount === 0,
    `Bob's document text read by Alice returned ${bobsAttachments.rowCount} rows`
  );

  const owner = await client.query(OWNERSHIP, ['probe-conv-bob']);
  check('ask: ownership check before write',
    owner.rows[0]?.user_email === BOB,
    `resolved Bob's conversation to ${owner.rows[0]?.user_email}, so the ask route refuses Alice`
  );

  const crossDelete = await client.query(SINGLE_DELETE, ['probe-att-bob', 'probe-conv-bob', ALICE]);
  check('DELETE one attachment',
    crossDelete.rowCount === 0,
    `deleting Bob's attachment as Alice removed ${crossDelete.rowCount} rows, so the route answers 404`
  );
  const ownDelete = await client.query(SINGLE_DELETE, [
    'probe-att-alice',
    'probe-conv-alice',
    ALICE,
  ]);
  check('DELETE one attachment (own)',
    ownDelete.rowCount === 1,
    `deleting her own removed ${ownDelete.rowCount} row, so the route answers 204`
  );

  const conversations = await client.query(CONVERSATION_LIST, [ALICE]);
  check('GET /api/conversations',
    !conversations.rows.some((row) => String(row.id).includes('bob')),
    `${conversations.rowCount} conversations, none of them Bob's`
  );

  const runsAsAlice = await client.query(RUNS_QUERY, [PLAN_APPROVAL_MESSAGE, ALICE]);
  const serialized = JSON.stringify(runsAsAlice.rows);
  check('GET /api/runs: conversation runs are private',
    !serialized.includes('bob private'),
    "no trace of Bob's prompt or answer in Alice's runs list"
  );
  check('GET /api/runs: no other address is disclosed',
    !serialized.includes(BOB),
    `Bob's address absent; his shared benchmark run shows as "${SHARED_RUN_OWNER}"`
  );
  const bobsBenchmark = runsAsAlice.rows.find((row) => row.id === 'probe-bench-bob');
  check('GET /api/runs: benchmark runs stay shared',
    bobsBenchmark !== undefined && bobsBenchmark.stakeholder === SHARED_RUN_OWNER,
    bobsBenchmark
      ? `Bob's benchmark run is visible, attributed to "${bobsBenchmark.stakeholder}"`
      : "Bob's benchmark run is missing, so the shared scope broke"
  );
  const ownBenchmark = runsAsAlice.rows.find((row) => row.id === 'probe-bench-alice');
  check('GET /api/runs: your own benchmark run is still yours',
    ownBenchmark?.stakeholder === ALICE,
    `Alice's own benchmark run is attributed to ${ownBenchmark?.stakeholder}`
  );
  const ownConversationRun = runsAsAlice.rows.find((row) => row.id === 'probe-msg-alice');
  check('GET /api/runs: your own conversation runs are present',
    ownConversationRun !== undefined,
    ownConversationRun
      ? 'Alice sees her own answer in the runs list'
      : 'Alice cannot see her own answer, so the join over-filtered',
  );
  check('GET /api/runs: the rating shown is your own',
    ownConversationRun?.rating === 5,
    `Alice's answer carries her own score of ${ownConversationRun?.rating}, not the 1 Bob filed against it`
  );

  const bobsTrace = await client.query(RUN_TRACE_MESSAGE_QUERY, [
    'probe-msg-bob',
    PLAN_APPROVAL_MESSAGE,
    ALICE,
  ]);
  check('GET /api/runs/:id/trace (conversation run)',
    bobsTrace.rowCount === 0,
    `Bob's run trace read by Alice returned ${bobsTrace.rowCount} rows, so the route answers 404`
  );
  const ownTrace = await client.query(RUN_TRACE_MESSAGE_QUERY, [
    'probe-msg-alice',
    PLAN_APPROVAL_MESSAGE,
    ALICE,
  ]);
  check('GET /api/runs/:id/trace (own)',
    ownTrace.rowCount === 1,
    `Alice's own run trace returned ${ownTrace.rowCount} row`
  );

  const bobsBenchTrace = await client.query(RUN_TRACE_BENCHMARK_QUERY, ['probe-bench-bob', ALICE]);
  check('GET /api/runs/:id/trace (benchmark run stays shared, address withheld)',
    bobsBenchTrace.rowCount === 1 && bobsBenchTrace.rows[0]?.user_email === SHARED_RUN_OWNER,
    `readable, attributed to "${bobsBenchTrace.rows[0]?.user_email}"`
  );
} finally {
  await client.query('ROLLBACK');
}

const after = await client.query(`SELECT (SELECT count(*) FROM player_insights.conversations) conversations,
          (SELECT count(*) FROM player_insights.messages) messages,
          (SELECT count(*) FROM player_insights.attachments) attachments,
          (SELECT count(*) FROM player_insights.benchmark_runs) benchmark_runs,
          (SELECT count(*) FROM player_insights.feedback) feedback`
);
console.log('\nrow counts after: ', JSON.stringify(after.rows[0]));
const unchanged = JSON.stringify(before.rows[0]) === JSON.stringify(after.rows[0]);
check('the database is exactly as it was', unchanged, unchanged ? 'rolled back, nothing committed' : 'COUNTS MOVED');

await client.end();
console.log(failures === 0 ? '\nEvery tenancy predicate filters.' : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
