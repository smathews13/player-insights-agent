# Lakebase isolation, traces and retention

What keeps one person's stored questions and answers away from another, what
leaves the app in traces, and how long anything is kept.

## Who can read the Lakebase schema

The app connects as its own service principal. A person with a Postgres role
on the Lakebase instance (for example, whoever manages the instance) can read
the schema directly, outside the app. Keep that list to the admin group, and
check it when reviewing access.

Inside the app, every route that reads a conversation filters by the
signed-in address (`user_email = $caller`). Administrators are the exception:
they can open any conversation by id (as Run Explorer links do), and with the
shared rail on they can list everyone's. Each time an administrator opens a
conversation that is not theirs, the app writes a `conversation-read` row to
the admin audit table.

### Why there is no Postgres row-level security

Row-level security keyed on the caller would need the caller's address set on
the connection for each request (`SET LOCAL app.user = ...` inside a
transaction). The app's ordinary reads go through a shared connection pool
with no per-request session, so a policy would either see no caller or see the
previous request's. A policy that can be wrong is worse than none, because it
reads as a control.

The decision: route-level filtering by address stays the control, tested in
`server/routes/identity-boundary.test.ts` and `server/routes/shared-rail.test.ts`.
Revisit if every request moves to a pinned connection.

## Traces

The agent logs traces to one MLflow experiment.

- **Who can read it.** `bundle/experiment-access.sh` runs on every release.
  It leaves the app, the endpoint's creator and the admin group on the
  experiment's ACL and removes `users`. `bundle/security-posture.sh` reports
  any extra entry.
- **What a trace holds.** One span processor (`agent/trace_redaction.py`)
  rewrites every span before export:
  - values under credential keys (authorization, tokens, client secrets,
    cookies, the Genie capability) become `[REDACTED]`;
  - values under player identity keys (the agent's unreturnable identity
    columns) become `[REDACTED]`, at any depth;
  - token-shaped text anywhere is scrubbed: bearer tokens, Databricks tokens,
    OAuth secrets, JWTs, private keys.

  The asker's email is kept, because an audit needs to know who asked.
  `agent/tests/test_trace_redaction.py` writes a real span and reads the
  exported trace back.
- **Accepted risk: question and answer text stays in traces.** Debugging a
  wrong answer and running evaluations both need it. The same text is already
  stored with the conversation in Lakebase. Traces sit behind the locked
  experiment ACL above, with identity values and credentials removed. Erasure
  and retention apply to Lakebase, not to traces; the experiment's own
  retention governs them.

## Retention

| Data                                                             | Kept for                                   | Control                                       |
| ---------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| Conversations, messages, runs, run events, attachments, feedback | Until deleted, unless retention is on      | `PLAYER_INSIGHTS_CONVERSATION_RETENTION_DAYS` |
| Raw request latencies and activity minutes                       | 90 days, then rolled up without identities | Built in                                      |
| Sessions                                                         | Until their retention expiry               | Built in                                      |
| Admin audit                                                      | Kept                                       | Not purged                                    |
| Persona assignment history and per-question persona use          | Kept, append-only by trigger               | Not purged                                    |

**Conversation retention is off by default.** Set
`PLAYER_INSIGHTS_CONVERSATION_RETENTION_DAYS` to a whole number of days, from
7 to 3650, to turn it on. Any other value is refused with a warning, and
retention stays off; a value is never clamped. When on, a daily job removes
conversations untouched for longer than the window, each with its messages,
runs, run events, attempts, attachments and feedback. It writes one
`conversations-purged` row to the admin audit table per pass.

## Deleting on request

- **One conversation.** The owner deletes it from the rail. That removes the
  conversation and everything keyed to it, including its runs and their event
  streams.
- **Everything about one person.** A super admin calls
  `POST /api/users/<email>/erase-data` with `{"confirmEmail": "<email>"}`. The
  body must repeat the address. It removes:
  - the person's conversations and everything keyed to them;
  - any other runs and feedback the person wrote;
  - their settings override and activity minutes.

  It writes a `user-data-erased` audit row. Every step is safe to repeat, so a
  failed call is finished by calling again.

What erasure keeps, on purpose:

- **The roster row and persona assignment.** These are administration. An
  admin removes them separately.
- **The admin audit rows.** These record what was done, not what was asked.
- **The persona use log.** This is the append-only record of questions
  answered under a persona's Unity Catalog grants, which is the evidence for
  elevated access. If a legal erasure request has to cover it, a metastore
  admin removes the trigger, deletes the rows and restores the trigger. That
  is a deliberate, recorded act outside the app.
