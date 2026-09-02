/**
 * Personas and per-user assignments.
 *
 * Personas and assignments are their own tables because there are many of them.
 *
 * NOTHING HERE IS A CREDENTIAL. A persona row names a Databricks secret
 * scope/key. The OAuth client secret stays in Databricks Secrets. A bug that
 * put the secret in `value` or `note` would ship it to every replica and to
 * the public mirror's schema dump, which is why those columns are not on the
 * table.
 *
 * Until migration 17 has run, every read returns an empty state rather than
 * throwing.
 */

import { randomUUID } from 'node:crypto';
import { appTable } from '../../shared/app-schema';
import {
  SpGrantSchema,
  spGrantSummary,
  type SpAssignment,
  type SpGrant,
  type SpPersona,
  type SpPersonaDefinition,
  type SpPersonaDefinitionWrite,
  type SpPersonaWrite,
} from '../../shared/sp-identity';
import { normalizeAdminEmail } from './admin-identity';
import type { LakebaseReader } from './lakebase-store';

export const SP_PERSONAS_TABLE = appTable('sp_personas');
export const SP_PERSONA_DEFINITIONS_TABLE = appTable('sp_persona_definitions');
export const SP_ASSIGNMENTS_TABLE = appTable('sp_assignments');

const UNDEFINED_TABLE = '42P01';

function missingTable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === UNDEFINED_TABLE) return true;
  const message = (error as Error)?.message ?? '';
  return /does not exist|undefined table|relation .* does not exist/i.test(message);
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

function personaFromRow(row: Record<string, unknown>): SpPersona {
  return {
    id: text(row.id),
    displayName: text(row.display_name),
    clientId: text(row.client_id),
    secretScope: text(row.secret_scope),
    secretKey: text(row.secret_key),
    updatedAt: iso(row.updated_at),
    updatedBy: text(row.updated_by),
  };
}

function assignmentFromRow(row: Record<string, unknown>): SpAssignment {
  return {
    email: normalizeAdminEmail(text(row.email)),
    personaId: text(row.persona_id),
    updatedAt: iso(row.updated_at),
    updatedBy: text(row.updated_by),
  };
}

function capabilities(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function grants(value: unknown): SpGrant[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const grant = SpGrantSchema.safeParse(entry);
    return grant.success ? [grant.data] : [];
  });
}

function definitionFromRow(row: Record<string, unknown>): SpPersonaDefinition {
  const storedCapabilities = capabilities(row.capabilities);
  const structured = grants(row.grants);
  const legacy =
    row.legacy_capabilities === null || row.legacy_capabilities === undefined
      ? structured.length === 0
        ? storedCapabilities
        : []
      : capabilities(row.legacy_capabilities);
  return {
    id: text(row.id),
    displayName: text(row.display_name),
    description: text(row.description),
    capabilities: storedCapabilities,
    grants: structured,
    legacyCapabilities: legacy,
    updatedAt: iso(row.updated_at),
    updatedBy: text(row.updated_by),
  };
}

export async function listSpPersonas(client: LakebaseReader): Promise<SpPersona[]> {
  try {
    const result = await client.lakebase.query(
      `SELECT id, display_name, client_id, secret_scope, secret_key, updated_at, updated_by
         FROM ${SP_PERSONAS_TABLE}
        ORDER BY display_name, id`
    );
    return (result?.rows ?? []).map(personaFromRow);
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function readSpPersona(client: LakebaseReader, id: string): Promise<SpPersona | null> {
  try {
    const result = await client.lakebase.query(
      `SELECT id, display_name, client_id, secret_scope, secret_key, updated_at, updated_by
         FROM ${SP_PERSONAS_TABLE}
        WHERE id = $1`,
      [id]
    );
    const row = result?.rows?.[0];
    return row ? personaFromRow(row) : null;
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

export async function insertSpPersona(
  client: LakebaseReader,
  write: SpPersonaWrite,
  updatedBy: string
): Promise<SpPersona> {
  const id = randomUUID();
  const result = await client.lakebase.query(
    `INSERT INTO ${SP_PERSONAS_TABLE}
       (id, display_name, client_id, secret_scope, secret_key, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING id, display_name, client_id, secret_scope, secret_key, updated_at, updated_by`,
    [id, write.displayName, write.clientId, write.secretScope, write.secretKey, updatedBy]
  );
  return personaFromRow(result.rows[0]);
}

export async function updateSpPersona(
  client: LakebaseReader,
  id: string,
  write: Partial<SpPersonaWrite>,
  updatedBy: string
): Promise<SpPersona | null> {
  const current = await readSpPersona(client, id);
  if (!current) return null;
  const next = {
    displayName: write.displayName ?? current.displayName,
    clientId: write.clientId ?? current.clientId,
    secretScope: write.secretScope ?? current.secretScope,
    secretKey: write.secretKey ?? current.secretKey,
  };
  const result = await client.lakebase.query(
    `UPDATE ${SP_PERSONAS_TABLE}
        SET display_name = $2,
            client_id = $3,
            secret_scope = $4,
            secret_key = $5,
            updated_by = $6,
            updated_at = now()
      WHERE id = $1
      RETURNING id, display_name, client_id, secret_scope, secret_key, updated_at, updated_by`,
    [id, next.displayName, next.clientId, next.secretScope, next.secretKey, updatedBy]
  );
  const row = result?.rows?.[0];
  return row ? personaFromRow(row) : null;
}

export async function deleteSpPersona(client: LakebaseReader, id: string): Promise<boolean> {
  try {
    await client.lakebase.query(`DELETE FROM ${SP_ASSIGNMENTS_TABLE} WHERE persona_id = $1`, [id]);
    const result = await client.lakebase.query(`DELETE FROM ${SP_PERSONAS_TABLE} WHERE id = $1 RETURNING id`, [id]);
    return (result?.rows?.length ?? 0) > 0;
  } catch (error) {
    if (missingTable(error)) return false;
    throw error;
  }
}

export async function listSpPersonaDefinitions(client: LakebaseReader): Promise<SpPersonaDefinition[]> {
  try {
    const result = await client.lakebase.query(
      `SELECT id, display_name, description, capabilities, grants, legacy_capabilities, updated_at, updated_by
         FROM ${SP_PERSONA_DEFINITIONS_TABLE}
        ORDER BY display_name, id`
    );
    return (result?.rows ?? []).map(definitionFromRow);
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function readSpPersonaDefinition(client: LakebaseReader, id: string): Promise<SpPersonaDefinition | null> {
  try {
    const result = await client.lakebase.query(
      `SELECT id, display_name, description, capabilities, grants, legacy_capabilities, updated_at, updated_by
         FROM ${SP_PERSONA_DEFINITIONS_TABLE}
        WHERE id = $1`,
      [id]
    );
    const row = result?.rows?.[0];
    return row ? definitionFromRow(row) : null;
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

export async function insertSpPersonaDefinition(
  client: LakebaseReader,
  write: SpPersonaDefinitionWrite,
  updatedBy: string
): Promise<SpPersonaDefinition> {
  const id = randomUUID();
  const structured = write.grants;
  const legacy =
    structured.length > 0
      ? write.legacyCapabilities
      : [...new Set([...write.capabilities, ...write.legacyCapabilities])];
  const compatibility = [...structured.map(spGrantSummary), ...legacy];
  const result = await client.lakebase.query(
    `INSERT INTO ${SP_PERSONA_DEFINITIONS_TABLE}
       (id, display_name, description, capabilities, grants, legacy_capabilities, updated_by, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, now())
     RETURNING id, display_name, description, capabilities, grants, legacy_capabilities, updated_at, updated_by`,
    [
      id,
      write.displayName,
      write.description,
      JSON.stringify(compatibility),
      JSON.stringify(structured),
      JSON.stringify(legacy),
      updatedBy,
    ]
  );
  return definitionFromRow(result.rows[0]);
}

export async function updateSpPersonaDefinition(
  client: LakebaseReader,
  id: string,
  write: Partial<SpPersonaDefinitionWrite>,
  updatedBy: string
): Promise<SpPersonaDefinition | null> {
  const current = await readSpPersonaDefinition(client, id);
  if (!current) return null;
  const structured = write.grants ?? current.grants ?? [];
  const currentStructuredSummaries = new Set((current.grants ?? []).map(spGrantSummary));
  const legacy =
    write.legacyCapabilities ??
    (write.capabilities
      ? write.capabilities.filter((capability) => !currentStructuredSummaries.has(capability))
      : (current.legacyCapabilities ?? []));
  const compatibility = [...structured.map(spGrantSummary), ...legacy];
  const next = {
    displayName: write.displayName ?? current.displayName,
    description: write.description ?? current.description,
    capabilities: compatibility,
    grants: structured,
    legacyCapabilities: legacy,
  };
  const result = await client.lakebase.query(
    `UPDATE ${SP_PERSONA_DEFINITIONS_TABLE}
        SET display_name = $2,
            description = $3,
            capabilities = $4::jsonb,
            grants = $5::jsonb,
            legacy_capabilities = $6::jsonb,
            updated_by = $7,
            updated_at = now()
      WHERE id = $1
      RETURNING id, display_name, description, capabilities, grants, legacy_capabilities, updated_at, updated_by`,
    [
      id,
      next.displayName,
      next.description,
      JSON.stringify(next.capabilities),
      JSON.stringify(next.grants),
      JSON.stringify(next.legacyCapabilities),
      updatedBy,
    ]
  );
  const row = result?.rows?.[0];
  return row ? definitionFromRow(row) : null;
}

export async function deleteSpPersonaDefinition(client: LakebaseReader, id: string): Promise<boolean> {
  try {
    const result = await client.lakebase.query(
      `DELETE FROM ${SP_PERSONA_DEFINITIONS_TABLE} WHERE id = $1 RETURNING id`,
      [id]
    );
    return (result?.rows?.length ?? 0) > 0;
  } catch (error) {
    if (missingTable(error)) return false;
    throw error;
  }
}

export async function listSpAssignments(client: LakebaseReader): Promise<SpAssignment[]> {
  try {
    const result = await client.lakebase.query(
      `SELECT email, persona_id, updated_at, updated_by
         FROM ${SP_ASSIGNMENTS_TABLE}
        ORDER BY email`
    );
    return (result?.rows ?? []).map(assignmentFromRow);
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function assignmentForEmail(client: LakebaseReader, email: string): Promise<SpAssignment | null> {
  const normalised = normalizeAdminEmail(email);
  if (!normalised) return null;
  try {
    const result = await client.lakebase.query(
      `SELECT email, persona_id, updated_at, updated_by
         FROM ${SP_ASSIGNMENTS_TABLE}
        WHERE email = $1`,
      [normalised]
    );
    const row = result?.rows?.[0];
    return row ? assignmentFromRow(row) : null;
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

export async function writeSpAssignment(
  client: LakebaseReader,
  email: string,
  personaId: string | null,
  updatedBy: string
): Promise<SpAssignment | null> {
  const normalised = normalizeAdminEmail(email);
  if (!normalised) return null;
  if (!personaId) {
    await client.lakebase.query(`DELETE FROM ${SP_ASSIGNMENTS_TABLE} WHERE email = $1`, [normalised]);
    return null;
  }
  const persona = await readSpPersona(client, personaId);
  if (!persona) return null;
  const result = await client.lakebase.query(
    `INSERT INTO ${SP_ASSIGNMENTS_TABLE} (email, persona_id, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE
        SET persona_id = EXCLUDED.persona_id,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
     RETURNING email, persona_id, updated_at, updated_by`,
    [normalised, personaId, updatedBy]
  );
  return assignmentFromRow(result.rows[0]);
}
