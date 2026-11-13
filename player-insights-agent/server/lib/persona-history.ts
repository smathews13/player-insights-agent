/**
 * The persona record: every assignment change, and every question a persona ran.
 *
 * Both tables are append-only. A trigger refuses UPDATE, DELETE and TRUNCATE, so
 * the app's own role cannot rewrite who held a persona or what it was used for.
 * Removing that guarantee takes a deliberate DDL change, not a bug in a route.
 *
 * Assignment changes are written in the same statement as the assignment
 * itself (see `writeSpAssignment`), so a saved change always has its history row.
 */

import { appTable } from '../../shared/app-schema';
import { normalizeAdminEmail } from './admin-identity';
import type { LakebaseReader } from './lakebase-store';

export const SP_ASSIGNMENT_EVENTS_TABLE = appTable('sp_assignment_events');
export const SP_PERSONA_USE_TABLE = appTable('sp_persona_use');
const APPEND_ONLY_FUNCTION = appTable('refuse_append_only_change');
const SP_ASSIGNMENTS_TABLE = appTable('sp_assignments');
const SP_PERSONAS_TABLE = appTable('sp_personas');

/** Long enough for any real question; the run ledger keeps the full prompt. */
export const PERSONA_USE_QUESTION_LIMIT = 4000;
export const PERSONA_REASON_LIMIT = 1000;
const LIST_LIMIT = 500;
const UNDEFINED_TABLE = '42P01';

function appendOnly(table: string, name: string): string[] {
  return [
    `CREATE OR REPLACE TRIGGER ${name}_no_change
       BEFORE UPDATE OR DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${APPEND_ONLY_FUNCTION}()`,
    `CREATE OR REPLACE TRIGGER ${name}_no_truncate
       BEFORE TRUNCATE ON ${table}
       FOR EACH STATEMENT EXECUTE FUNCTION ${APPEND_ONLY_FUNCTION}()`,
  ];
}

export const PERSONA_HISTORY_STATEMENTS: readonly string[] = [
  `ALTER TABLE ${SP_ASSIGNMENTS_TABLE} ADD COLUMN IF NOT EXISTS reason TEXT`,
  `CREATE TABLE IF NOT EXISTS ${SP_ASSIGNMENT_EVENTS_TABLE} (
     id BIGSERIAL PRIMARY KEY,
     email TEXT NOT NULL,
     persona_id TEXT,
     persona_name TEXT,
     reason TEXT CHECK (reason IS NULL OR length(reason) <= ${PERSONA_REASON_LIMIT}),
     actor TEXT NOT NULL,
     recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS sp_assignment_events_email_idx
     ON ${SP_ASSIGNMENT_EVENTS_TABLE} (email, recorded_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${SP_PERSONA_USE_TABLE} (
     id BIGSERIAL PRIMARY KEY,
     run_id TEXT NOT NULL,
     conversation_id TEXT,
     user_email TEXT NOT NULL,
     persona_id TEXT NOT NULL,
     persona_name TEXT,
     persona_client_id TEXT,
     question TEXT,
     recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sp_persona_use_run_idx ON ${SP_PERSONA_USE_TABLE} (run_id)`,
  `CREATE INDEX IF NOT EXISTS sp_persona_use_user_idx
     ON ${SP_PERSONA_USE_TABLE} (user_email, recorded_at DESC)`,
  `CREATE OR REPLACE FUNCTION ${APPEND_ONLY_FUNCTION}() RETURNS trigger
     LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
     END
     $$`,
  ...appendOnly(SP_ASSIGNMENT_EVENTS_TABLE, 'sp_assignment_events'),
  ...appendOnly(SP_PERSONA_USE_TABLE, 'sp_persona_use'),
  // Assignments that predate the history get one row each, so every current
  // assignment has a recorded holder. Replays find rows and insert nothing.
  `INSERT INTO ${SP_ASSIGNMENT_EVENTS_TABLE} (email, persona_id, persona_name, reason, actor, recorded_at)
   SELECT a.email, a.persona_id, p.display_name, NULL, a.updated_by, a.updated_at
     FROM ${SP_ASSIGNMENTS_TABLE} a
     LEFT JOIN ${SP_PERSONAS_TABLE} p ON p.id = a.persona_id
    WHERE NOT EXISTS (SELECT 1 FROM ${SP_ASSIGNMENT_EVENTS_TABLE})
   ON CONFLICT DO NOTHING`,
];

export const PERSONA_HISTORY_DOWN: readonly string[] = [
  `DROP TABLE IF EXISTS ${SP_PERSONA_USE_TABLE}`,
  `DROP TABLE IF EXISTS ${SP_ASSIGNMENT_EVENTS_TABLE}`,
  `DROP FUNCTION IF EXISTS ${APPEND_ONLY_FUNCTION}()`,
  `ALTER TABLE ${SP_ASSIGNMENTS_TABLE} DROP COLUMN IF EXISTS reason`,
];

export interface SpAssignmentEvent {
  email: string;
  /** Null when the change removed the persona. */
  personaId: string | null;
  personaName: string | null;
  reason: string | null;
  actor: string;
  recordedAt: string;
}

export interface SpPersonaUse {
  runId: string;
  conversationId: string | null;
  userEmail: string;
  personaId: string;
  personaName: string | null;
  personaClientId: string | null;
  question: string | null;
  recordedAt: string;
}

export interface PersonaUseInput {
  runId: string;
  conversationId: string | null;
  userEmail: string;
  persona: { id: string; displayName: string; clientId: string };
  question: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : '';
}

function missingTable(error: unknown): boolean {
  return (error as { code?: unknown }).code === UNDEFINED_TABLE;
}

/** Blank and whitespace-only reasons are no reason. */
export function normalizeReason(reason: string | null | undefined): string | null {
  const trimmed = (reason ?? '').trim();
  return trimmed ? trimmed.slice(0, PERSONA_REASON_LIMIT) : null;
}

/** One row per persona question. A replayed run id records nothing new. */
export async function recordPersonaUse(client: LakebaseReader, input: PersonaUseInput): Promise<void> {
  await client.lakebase.query(
    `INSERT INTO ${SP_PERSONA_USE_TABLE}
       (run_id, conversation_id, user_email, persona_id, persona_name, persona_client_id, question)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (run_id) DO NOTHING`,
    [
      input.runId,
      input.conversationId,
      normalizeAdminEmail(input.userEmail),
      input.persona.id,
      input.persona.displayName,
      input.persona.clientId,
      input.question.slice(0, PERSONA_USE_QUESTION_LIMIT),
    ]
  );
}

export async function listAssignmentEvents(
  client: LakebaseReader,
  email: string | null = null
): Promise<SpAssignmentEvent[]> {
  const normalised = email ? normalizeAdminEmail(email) : null;
  try {
    const result = await client.lakebase.query(
      `SELECT email, persona_id, persona_name, reason, actor, recorded_at
         FROM ${SP_ASSIGNMENT_EVENTS_TABLE}
        WHERE ($1::text IS NULL OR email = $1)
        ORDER BY recorded_at DESC, id DESC
        LIMIT ${LIST_LIMIT}`,
      [normalised]
    );
    return (result?.rows ?? []).map((row: Record<string, unknown>) => ({
      email: text(row.email) ?? '',
      personaId: text(row.persona_id),
      personaName: text(row.persona_name),
      reason: text(row.reason),
      actor: text(row.actor) ?? '',
      recordedAt: iso(row.recorded_at),
    }));
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function listPersonaUse(client: LakebaseReader, email: string | null = null): Promise<SpPersonaUse[]> {
  const normalised = email ? normalizeAdminEmail(email) : null;
  try {
    const result = await client.lakebase.query(
      `SELECT run_id, conversation_id, user_email, persona_id, persona_name, persona_client_id,
              question, recorded_at
         FROM ${SP_PERSONA_USE_TABLE}
        WHERE ($1::text IS NULL OR user_email = $1)
        ORDER BY recorded_at DESC, id DESC
        LIMIT ${LIST_LIMIT}`,
      [normalised]
    );
    return (result?.rows ?? []).map((row: Record<string, unknown>) => ({
      runId: text(row.run_id) ?? '',
      conversationId: text(row.conversation_id),
      userEmail: text(row.user_email) ?? '',
      personaId: text(row.persona_id) ?? '',
      personaName: text(row.persona_name),
      personaClientId: text(row.persona_client_id),
      question: text(row.question),
      recordedAt: iso(row.recorded_at),
    }));
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}
