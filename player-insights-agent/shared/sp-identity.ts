/**
 * Service-principal personas: who the app may run as when assigned.
 *
 * Personas are admin-defined identities (a display name and a Databricks
 * service principal application/client id). Secrets are NEVER stored here.
 * Each persona names a Databricks secret scope and key that already holds the
 * OAuth client secret. The running app reads that secret at request time with
 * its own identity; the value is not written to Lakebase, logs, or git.
 *
 * Unassigned people stay on OAuth. Assigned people run as the persona an
 * administrator named for them when its token can be minted.
 *
 * Databricks Apps has no user-OAuth scope that mints tokens for other service
 * principals. If this app cannot read the named secret or the token endpoint
 * refuses, the UI says so and those requests stay on OAuth rather than
 * pretending the pivot worked.
 */

import { z } from 'zod';
import type { OrganizationMapping } from './organization-mapping';
import type { SpPersonaTemplate } from './sp-persona-templates';

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
  /** Stable link to the credential-free definition. Null on pre-v36 legacy rows. */
  definitionId?: string | null;
  displayName: string;
  clientId: string;
  secretScope: string;
  secretKey: string;
  updatedAt: string;
  updatedBy: string;
}

export type SpConnectionState = 'connected' | 'not_connected';
export type SpSyncState = 'synced' | 'not_synced';
export type SpGrantVerificationState = 'verified' | 'mismatch' | 'unsupported' | 'unverified';

export interface SpGrantVerification {
  key: string;
  label: string;
  state: SpGrantVerificationState;
  nextAction: string;
}

export interface SpPersonaDefinitionStatus {
  connection: {
    state: SpConnectionState;
    checkedAt: string | null;
    detail: string;
  };
  sync: {
    state: SpSyncState;
    checkedAt: string | null;
    definitionRevision: number | null;
    detail: string;
    checks: SpGrantVerification[];
  };
}

/**
 * A credential-free configuration for an operator-created service principal.
 *
 * The app's declared user scopes can read/query Databricks resources but cannot
 * administer account service principals or apply grants. Generating one of
 * these records therefore saves the intended persona and its permissions; it
 * never claims that an external identity exists and never stores a secret.
 */
export interface SpPersonaDefinition {
  id: string;
  /** Monotonic definition revision; a change invalidates an older sync check. */
  revision?: number;
  displayName: string;
  description: string;
  /** Compatibility summaries for clients deployed before structured grants. */
  capabilities: string[];
  /** Canonical, validated Databricks grants. */
  grants?: SpGrant[];
  /** Original free-text entries, kept separate until an operator converts them. */
  legacyCapabilities?: string[];
  updatedAt: string;
  updatedBy: string;
  status?: SpPersonaDefinitionStatus;
}

/** Old free-text examples. Read-only compatibility data, never new-row defaults. */
export const SP_CAPABILITY_EXAMPLES = [
  'Governed tables — USE CATALOG, USE SCHEMA, SELECT',
  'SQL warehouse — CAN USE',
  'Genie space — CAN RUN',
  'Vector Search index — CAN SELECT',
  'Model serving endpoint — CAN QUERY',
] as const;

export const SP_GRANT_RESOURCE_TYPES = [
  'SERVING_ENDPOINT',
  'SQL_WAREHOUSE',
  'CATALOG',
  'SCHEMA',
  'TABLE',
  'GENIE_SPACE',
  'VECTOR_SEARCH_INDEX',
  'VECTOR_SEARCH_ENDPOINT',
  'FUNCTION',
  'REGISTERED_MODEL',
  'VOLUME',
] as const;
export type SpGrantResourceType = (typeof SP_GRANT_RESOURCE_TYPES)[number];

export const SP_GRANT_ACTIONS = [
  'READ',
  'VIEW',
  'USE',
  'EXECUTE',
  'WRITE',
  'MODIFY',
  'CREATE',
  'CREATE_SCHEMA',
  'CREATE_TABLE',
  'CREATE_FUNCTION',
  'CREATE_MODEL',
  'CREATE_VOLUME',
  'CREATE_MODEL_VERSION',
  'EDIT',
  'MONITOR',
  'APPLY_TAG',
  'READ_METADATA',
  'ALL_PRIVILEGES',
  'OWNER',
  'MANAGE',
] as const;
export type SpGrantAction = (typeof SP_GRANT_ACTIONS)[number];

export interface SpGrantOption {
  action: SpGrantAction;
  label: string;
  privilege: string;
}

export interface SpGrantTypeDefinition {
  label: string;
  identifierHint: string;
  options: readonly SpGrantOption[];
}

/**
 * Exact grant combinations the persona planner offers.
 *
 * Workspace ACL levels and Unity Catalog privileges are deliberately kept in
 * one matrix. The UI never assembles a privilege from an arbitrary action and
 * resource pair, and the API rejects a stale or forged combination.
 */
export const SP_GRANT_MATRIX: Record<SpGrantResourceType, SpGrantTypeDefinition> = {
  SERVING_ENDPOINT: {
    label: 'Serving endpoint',
    identifierHint: 'Endpoint name',
    options: [
      { action: 'VIEW', label: 'View', privilege: 'CAN VIEW' },
      { action: 'USE', label: 'Query', privilege: 'CAN QUERY' },
      { action: 'MANAGE', label: 'Manage', privilege: 'CAN MANAGE' },
    ],
  },
  SQL_WAREHOUSE: {
    label: 'SQL warehouse',
    identifierHint: 'Warehouse ID',
    options: [
      { action: 'VIEW', label: 'View', privilege: 'CAN VIEW' },
      { action: 'MONITOR', label: 'Monitor and run', privilege: 'CAN MONITOR' },
      { action: 'USE', label: 'Use', privilege: 'CAN USE' },
      { action: 'OWNER', label: 'Own', privilege: 'IS OWNER' },
      { action: 'MANAGE', label: 'Manage', privilege: 'CAN MANAGE' },
    ],
  },
  CATALOG: {
    label: 'Catalog',
    identifierHint: 'Catalog name',
    options: [
      { action: 'VIEW', label: 'Browse metadata', privilege: 'BROWSE' },
      { action: 'USE', label: 'Use', privilege: 'USE CATALOG' },
      { action: 'READ_METADATA', label: 'Read security metadata', privilege: 'READ METADATA' },
      { action: 'READ', label: 'Read all current and future data', privilege: 'SELECT' },
      { action: 'MODIFY', label: 'Modify all current and future tables', privilege: 'MODIFY' },
      { action: 'EXECUTE', label: 'Execute all current and future functions', privilege: 'EXECUTE' },
      { action: 'APPLY_TAG', label: 'Apply tags', privilege: 'APPLY TAG' },
      { action: 'CREATE_SCHEMA', label: 'Create schemas', privilege: 'CREATE SCHEMA' },
      { action: 'CREATE_TABLE', label: 'Create tables', privilege: 'CREATE TABLE' },
      { action: 'CREATE_FUNCTION', label: 'Create functions', privilege: 'CREATE FUNCTION' },
      { action: 'CREATE_MODEL', label: 'Create models', privilege: 'CREATE MODEL' },
      { action: 'CREATE_VOLUME', label: 'Create volumes', privilege: 'CREATE VOLUME' },
      { action: 'ALL_PRIVILEGES', label: 'All applicable data privileges', privilege: 'ALL PRIVILEGES' },
      { action: 'MANAGE', label: 'Manage', privilege: 'MANAGE' },
    ],
  },
  SCHEMA: {
    label: 'Schema',
    identifierHint: 'catalog.schema',
    options: [
      { action: 'USE', label: 'Use', privilege: 'USE SCHEMA' },
      { action: 'READ_METADATA', label: 'Read security metadata', privilege: 'READ METADATA' },
      { action: 'READ', label: 'Read all current and future data', privilege: 'SELECT' },
      { action: 'MODIFY', label: 'Modify all current and future tables', privilege: 'MODIFY' },
      { action: 'EXECUTE', label: 'Execute all current and future functions', privilege: 'EXECUTE' },
      { action: 'APPLY_TAG', label: 'Apply tags', privilege: 'APPLY TAG' },
      { action: 'CREATE_TABLE', label: 'Create tables', privilege: 'CREATE TABLE' },
      { action: 'CREATE_FUNCTION', label: 'Create functions', privilege: 'CREATE FUNCTION' },
      { action: 'CREATE_MODEL', label: 'Create models', privilege: 'CREATE MODEL' },
      { action: 'CREATE_VOLUME', label: 'Create volumes', privilege: 'CREATE VOLUME' },
      { action: 'ALL_PRIVILEGES', label: 'All applicable data privileges', privilege: 'ALL PRIVILEGES' },
      { action: 'MANAGE', label: 'Manage', privilege: 'MANAGE' },
    ],
  },
  TABLE: {
    label: 'Table',
    identifierHint: 'catalog.schema.table',
    options: [
      { action: 'READ', label: 'Read', privilege: 'SELECT' },
      { action: 'READ_METADATA', label: 'Read security metadata', privilege: 'READ METADATA' },
      { action: 'WRITE', label: 'Modify', privilege: 'MODIFY' },
      { action: 'APPLY_TAG', label: 'Apply tags', privilege: 'APPLY TAG' },
      { action: 'ALL_PRIVILEGES', label: 'All data privileges', privilege: 'ALL PRIVILEGES' },
      { action: 'MANAGE', label: 'Manage', privilege: 'MANAGE' },
    ],
  },
  GENIE_SPACE: {
    label: 'Genie space',
    identifierHint: 'Genie space ID',
    options: [
      { action: 'VIEW', label: 'View', privilege: 'CAN VIEW' },
      { action: 'USE', label: 'Run', privilege: 'CAN RUN' },
      { action: 'EDIT', label: 'Edit', privilege: 'CAN EDIT' },
      { action: 'MANAGE', label: 'Manage', privilege: 'CAN MANAGE' },
    ],
  },
  VECTOR_SEARCH_INDEX: {
    label: 'Vector Search index',
    identifierHint: 'catalog.schema.index',
    options: [
      { action: 'READ', label: 'Query', privilege: 'SELECT' },
      { action: 'MANAGE', label: 'Manage', privilege: 'MANAGE' },
    ],
  },
  VECTOR_SEARCH_ENDPOINT: {
    label: 'Vector Search endpoint',
    identifierHint: 'Endpoint name',
    options: [
      { action: 'CREATE', label: 'Create endpoints', privilege: 'CAN CREATE' },
      { action: 'USE', label: 'Create indexes', privilege: 'CAN USE' },
      { action: 'MANAGE', label: 'Manage', privilege: 'CAN MANAGE' },
    ],
  },
  FUNCTION: {
    label: 'Function',
    identifierHint: 'catalog.schema.function',
    options: [
      { action: 'EXECUTE', label: 'Execute / call', privilege: 'EXECUTE' },
      { action: 'READ_METADATA', label: 'Read security metadata', privilege: 'READ METADATA' },
      { action: 'ALL_PRIVILEGES', label: 'All function privileges', privilege: 'ALL PRIVILEGES' },
      { action: 'MANAGE', label: 'Manage', privilege: 'MANAGE' },
    ],
  },
  REGISTERED_MODEL: {
    label: 'Registered model',
    identifierHint: 'catalog.schema.model',
    options: [
      { action: 'EXECUTE', label: 'Load / use', privilege: 'EXECUTE' },
      { action: 'READ_METADATA', label: 'Read security metadata', privilege: 'READ METADATA' },
      { action: 'APPLY_TAG', label: 'Apply tags', privilege: 'APPLY TAG' },
      { action: 'CREATE_MODEL_VERSION', label: 'Create model versions', privilege: 'CREATE MODEL VERSION' },
      { action: 'ALL_PRIVILEGES', label: 'All model privileges', privilege: 'ALL PRIVILEGES' },
      { action: 'MANAGE', label: 'Manage', privilege: 'MANAGE' },
    ],
  },
  VOLUME: {
    label: 'Volume',
    identifierHint: 'catalog.schema.volume',
    options: [
      { action: 'READ', label: 'Read files', privilege: 'READ VOLUME' },
      { action: 'READ_METADATA', label: 'Read security metadata', privilege: 'READ METADATA' },
      { action: 'WRITE', label: 'Write files', privilege: 'WRITE VOLUME' },
      { action: 'APPLY_TAG', label: 'Apply tags', privilege: 'APPLY TAG' },
      { action: 'ALL_PRIVILEGES', label: 'All volume privileges', privilege: 'ALL PRIVILEGES' },
      { action: 'MANAGE', label: 'Manage', privilege: 'MANAGE' },
    ],
  },
};

export interface SpGrant {
  resourceType: SpGrantResourceType;
  resource: string;
  action: SpGrantAction;
  privilege: string;
}

export interface SpGrantResource {
  type: SpGrantResourceType;
  id: string;
  label: string;
  source: 'configured' | 'declared';
}

export interface SpGrantResourceDiscovery {
  status: 'ready' | 'error';
  resources: SpGrantResource[];
  detail: string;
  pagination?: {
    complete: boolean;
    returned: number;
    limit: number;
    incompleteReason: '' | 'result_cap';
  };
}

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
  displayName: string;
}

/** What `/api/identity` adds so every page can say who the next call would run as. */
export interface SpIdentitySummary {
  minting: SpMintingStatus;
  assigned: SpIdentityAssigned | null;
  executingAs: SpExecutionKind;
  fallbackReason: string | null;
}

export interface SpIdentityRosterRow {
  email: string;
  role: string;
  /** Earliest successful app deployer; independent of role and persona assignment. */
  isDeploymentOwner: boolean;
  personaId: string | null;
}

export interface SpIdentityAdminPayload {
  minting: SpMintingStatus;
  personas: SpPersona[];
  /** Optional while an older deployed server is rolling forward. */
  personaDefinitions?: SpPersonaDefinition[];
  /** Deployment-configured, credential-free examples; never persisted by reading. */
  personaTemplates?: SpPersonaTemplate[];
  personaTemplateWarning?: string | null;
  /** Absent while loading or when an older server has not implemented discovery. */
  grantResourceDiscovery?: SpGrantResourceDiscovery;
  /** Official generic Account Console landing page for this deployment's cloud. */
  accountConsoleUrl?: string;
  organizations?: OrganizationMapping[];
  assignments: SpAssignment[];
  roster: SpIdentityRosterRow[];
}

const NAME_MAX = 120;
const DESCRIPTION_MAX = 280;
const CAPABILITY_MAX = 180;
const CAPABILITY_COUNT_MAX = 12;
export const SP_PERSONA_GRANT_COUNT_MAX = 24;
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

/** Definition-bound connection fields. No raw client secret is accepted. */
export const SpPersonaConnectionWriteSchema = SpPersonaWriteSchema.omit({ displayName: true });

export const SpPersonaPatchSchema = SpPersonaWriteSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'Nothing to update.',
});

const SpCapabilitySchema = z.string().trim().min(1).max(CAPABILITY_MAX);
const SpCapabilitiesSchema = z.array(SpCapabilitySchema).max(CAPABILITY_COUNT_MAX);
const SpGrantResourceTypeSchema = z.enum(SP_GRANT_RESOURCE_TYPES);
const SpGrantActionSchema = z.enum(SP_GRANT_ACTIONS);

export function spGrantIdentifierFault(type: SpGrantResourceType, raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Choose a configured resource or enter its identifier.';
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (value.length > 255 || containsControlCharacter) return 'Use a valid Databricks identifier.';
  const ucParts: Partial<Record<SpGrantResourceType, number>> = {
    CATALOG: 1,
    SCHEMA: 2,
    TABLE: 3,
    VECTOR_SEARCH_INDEX: 3,
    FUNCTION: 3,
    REGISTERED_MODEL: 3,
    VOLUME: 3,
  };
  const partCount = ucParts[type];
  if (partCount) {
    const parts = value.split('.');
    if (parts.length !== partCount || parts.some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,254}$/.test(part))) {
      return `Enter ${SP_GRANT_MATRIX[type].identifierHint} using letters, digits, underscores, or hyphens.`;
    }
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(value)) {
    return `Enter a valid ${SP_GRANT_MATRIX[type].identifierHint.toLowerCase()}.`;
  }
  return null;
}

export function spGrantOption(resourceType: SpGrantResourceType, action: SpGrantAction): SpGrantOption | undefined {
  return SP_GRANT_MATRIX[resourceType].options.find((option) => option.action === action);
}

export function spGrantKey(grant: Pick<SpGrant, 'resourceType' | 'resource' | 'privilege'>): string {
  return `${grant.resourceType}\u0000${grant.resource.trim().toLocaleLowerCase()}\u0000${grant.privilege}`;
}

export function spGrantSummary(grant: SpGrant): string {
  return `${SP_GRANT_MATRIX[grant.resourceType].label} ${grant.resource} — ${grant.privilege}`;
}

export const SpGrantSchema = z
  .object({
    resourceType: SpGrantResourceTypeSchema,
    resource: z.string().trim().min(1).max(255),
    action: SpGrantActionSchema,
    privilege: z.string().trim().min(1).max(64),
  })
  .superRefine((grant, context) => {
    const identifierFault = spGrantIdentifierFault(grant.resourceType, grant.resource);
    if (identifierFault) context.addIssue({ code: 'custom', path: ['resource'], message: identifierFault });
    const option = spGrantOption(grant.resourceType, grant.action);
    if (!option) {
      context.addIssue({
        code: 'custom',
        path: ['action'],
        message: `${grant.action} is not valid for ${SP_GRANT_MATRIX[grant.resourceType].label}.`,
      });
    } else if (grant.privilege !== option.privilege) {
      context.addIssue({
        code: 'custom',
        path: ['privilege'],
        message: `${grant.action} maps to ${option.privilege} for ${SP_GRANT_MATRIX[grant.resourceType].label}.`,
      });
    }
  });

const SpGrantsSchema = z
  .array(SpGrantSchema)
  .max(SP_PERSONA_GRANT_COUNT_MAX)
  .refine((grants) => new Set(grants.map(spGrantKey)).size === grants.length, {
    message: 'The permissions contain an exact duplicate.',
  });

const SpPersonaDefinitionFields = z.object({
  displayName: z.string().trim().min(1).max(NAME_MAX),
  description: z.string().trim().max(DESCRIPTION_MAX).default(''),
  capabilities: SpCapabilitiesSchema.default([]),
  grants: SpGrantsSchema.default([]),
  legacyCapabilities: SpCapabilitiesSchema.default([]),
});
const uniqueCapabilities = (capabilities: string[] | undefined): boolean =>
  !capabilities ||
  new Set(capabilities.map((capability) => capability.toLocaleLowerCase())).size === capabilities.length;

export const SpPersonaDefinitionWriteSchema = SpPersonaDefinitionFields.refine(
  (value) =>
    (value.grants.length > 0 || value.capabilities.length > 0 || value.legacyCapabilities.length > 0) &&
    uniqueCapabilities(value.capabilities) &&
    uniqueCapabilities(value.legacyCapabilities),
  { path: ['grants'], message: 'Add at least one structured grant or preserve a legacy permission.' }
);

export const SpPersonaDefinitionPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(NAME_MAX).optional(),
    description: z.string().trim().max(DESCRIPTION_MAX).optional(),
    capabilities: SpCapabilitiesSchema.optional(),
    grants: SpGrantsSchema.optional(),
    legacyCapabilities: SpCapabilitiesSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' })
  .refine((value) => uniqueCapabilities(value.capabilities) && uniqueCapabilities(value.legacyCapabilities), {
    path: ['grants'],
    message: 'Each permission must be unique.',
  });

export const SpAssignmentWriteSchema = z.object({
  email: z.string().trim().min(3).max(320),
  personaId: z.string().trim().min(1).max(80).nullable(),
});

export type SpPersonaWrite = z.infer<typeof SpPersonaWriteSchema>;
export type SpPersonaConnectionWrite = z.infer<typeof SpPersonaConnectionWriteSchema>;
export type SpPersonaDefinitionWrite = z.infer<typeof SpPersonaDefinitionWriteSchema>;
export type SpAssignmentWrite = z.infer<typeof SpAssignmentWriteSchema>;
