/**
 * Service-principal personas: who the app may run as when the experimental
 * SP-identity pivot is on.
 *
 * Personas are admin-defined identities (a display name and a Databricks
 * service principal application/client id). Secrets are NEVER stored here.
 * Each persona names a Databricks secret scope and key that already holds the
 * OAuth client secret. The running app reads that secret at request time with
 * its own identity; the value is not written to Lakebase, logs, or git.
 *
 * THE PIVOT IS OFF BY DEFAULT. Until an administrator turns it on under
 * Experimental, every warehouse, Genie, Unity Catalog, serving, Cost, and
 * Connections call keeps using the signed-in user's OAuth token. Turning it
 * on does not switch unassigned people: they stay on OAuth so the app does
 * not break. Assigned people run as the persona an admin named for them.
 *
 * Databricks Apps has no user-OAuth scope that mints tokens for other service
 * principals. If this app cannot read the named secret or the token endpoint
 * refuses, the UI says so and those requests stay on OAuth rather than
 * pretending the pivot worked.
 */

import { z } from 'zod';

/** Lakebase / identity-payload flag: the whole app uses assigned SP tokens. */
export const SP_IDENTITY_ENABLED_SETTING = 'sp-identity-enabled';

/** What a request actually used, for the identity card and the record. */
export const SP_EXECUTION_OAUTH = 'oauth' as const;
export const SP_EXECUTION_SERVICE_PRINCIPAL = 'service_principal' as const;
export type SpExecutionKind = typeof SP_EXECUTION_OAUTH | typeof SP_EXECUTION_SERVICE_PRINCIPAL;

/**
 * The identity-mode string the agent gate already understands as "run as the
 * invoker", plus the assigned-persona mode the gate admits when the invoker
 * token belongs to that persona's client id rather than to a human email.
 */
export const ASSIGNED_SERVICE_PRINCIPAL = 'assigned_service_principal';

export const SP_IDENTITY_MINTING_UNAVAILABLE =
  "Databricks Apps cannot mint a token for another service principal from the signed-in user's OAuth scopes. This app can only obtain one by reading that principal's OAuth secret from Databricks Secrets (the scope and key you name on the persona) using the app's own identity, then exchanging it. If the app cannot read that secret, questions stay on OAuth.";

export interface SpPersona {
  id: string;
  displayName: string;
  clientId: string;
  secretScope: string;
  secretKey: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * A credential-free plan for an operator-created service principal.
 *
 * The app's declared user scopes can read/query Databricks resources but cannot
 * administer account service principals or apply grants. Generating one of
 * these records therefore saves the intended persona and its permissions; it
 * never claims that an external identity exists and never stores a secret.
 */
export interface SpPersonaDefinition {
  id: string;
  displayName: string;
  description: string;
  capabilities: string[];
  updatedAt: string;
  updatedBy: string;
}

/** Real Databricks permission vocabulary used as editable starting points. */
export const SP_CAPABILITY_EXAMPLES = [
  'Governed tables — USE CATALOG, USE SCHEMA, SELECT',
  'SQL warehouse — CAN USE',
  'Genie space — CAN RUN',
  'Vector Search index — CAN SELECT',
  'Model serving endpoint — CAN QUERY',
] as const;

export interface SpAssignment {
  email: string;
  personaId: string;
  updatedAt: string;
  updatedBy: string;
}

export interface SpMintingStatus {
  available: boolean;
  detail: string;
}

export interface SpIdentityAssigned {
  id: string;
  displayName: string;
  clientId: string;
}

/** What `/api/identity` adds so every page can say who the next call would run as. */
export interface SpIdentitySummary {
  enabled: boolean;
  minting: SpMintingStatus;
  assigned: SpIdentityAssigned | null;
  executingAs: SpExecutionKind;
  fallbackReason: string | null;
}

export interface SpIdentityRosterRow {
  email: string;
  role: string;
  personaId: string | null;
}

export interface SpIdentityAdminPayload {
  enabled: boolean;
  minting: SpMintingStatus;
  personas: SpPersona[];
  /** Optional while an older deployed server is rolling forward. */
  personaDefinitions?: SpPersonaDefinition[];
  assignments: SpAssignment[];
  roster: SpIdentityRosterRow[];
}

const NAME_MAX = 120;
const DESCRIPTION_MAX = 280;
const CAPABILITY_MAX = 180;
const CAPABILITY_COUNT_MAX = 12;
const SECRET_REF_MAX = 128;
const CLIENT_ID_MAX = 64;

export const SpPersonaWriteSchema = z.object({
  displayName: z.string().trim().min(1).max(NAME_MAX),
  clientId: z
    .string()
    .trim()
    .min(8)
    .max(CLIENT_ID_MAX)
    .regex(/^[0-9a-fA-F-]{8,}$/, 'That does not look like a service principal application id.'),
  secretScope: z.string().trim().min(1).max(SECRET_REF_MAX),
  secretKey: z.string().trim().min(1).max(SECRET_REF_MAX),
});

export const SpPersonaPatchSchema = SpPersonaWriteSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'Nothing to update.',
});

const SpCapabilitySchema = z.string().trim().min(1).max(CAPABILITY_MAX);
const SpCapabilitiesSchema = z.array(SpCapabilitySchema).min(1).max(CAPABILITY_COUNT_MAX);
const SpPersonaDefinitionFields = z.object({
  displayName: z.string().trim().min(1).max(NAME_MAX),
  description: z.string().trim().max(DESCRIPTION_MAX).default(''),
  capabilities: SpCapabilitiesSchema,
});
const uniqueCapabilities = (capabilities: string[] | undefined): boolean =>
  !capabilities ||
  new Set(capabilities.map((capability) => capability.toLocaleLowerCase())).size === capabilities.length;

export const SpPersonaDefinitionWriteSchema = SpPersonaDefinitionFields.refine(
  (value) => uniqueCapabilities(value.capabilities),
  { path: ['capabilities'], message: 'Each permission must be unique.' }
);

export const SpPersonaDefinitionPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(NAME_MAX).optional(),
    description: z.string().trim().max(DESCRIPTION_MAX).optional(),
    capabilities: SpCapabilitiesSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' })
  .refine((value) => uniqueCapabilities(value.capabilities), {
    path: ['capabilities'],
    message: 'Each permission must be unique.',
  });

export const SpIdentityModeSchema = z.object({
  enabled: z.boolean(),
});

export const SpAssignmentWriteSchema = z.object({
  email: z.string().trim().min(3).max(320),
  personaId: z.string().trim().min(1).max(80).nullable(),
});

export type SpPersonaWrite = z.infer<typeof SpPersonaWriteSchema>;
export type SpPersonaDefinitionWrite = z.infer<typeof SpPersonaDefinitionWriteSchema>;
export type SpAssignmentWrite = z.infer<typeof SpAssignmentWriteSchema>;
