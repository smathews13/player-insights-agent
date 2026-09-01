import { z } from 'zod';

export const AiGatewayModeSchema = z.enum(['', 'mlflow', 'openai']);
export type AiGatewayMode = z.infer<typeof AiGatewayModeSchema>;

export const AiGatewayCandidateKindSchema = z.enum(['model-service', 'legacy-endpoint', 'direct-endpoint']);
export type AiGatewayCandidateKind = z.infer<typeof AiGatewayCandidateKindSchema>;

export const AiGatewayCapabilitiesSchema = z.strictObject({
  rateLimits: z.boolean(),
  budgetEnforcement: z.boolean(),
  usageTracking: z.boolean(),
  inferenceTable: z.boolean(),
  guardrails: z.boolean(),
  routingFallback: z.boolean(),
});
export type AiGatewayCapabilities = z.infer<typeof AiGatewayCapabilitiesSchema>;

export const EMPTY_AI_GATEWAY_CAPABILITIES: AiGatewayCapabilities = {
  rateLimits: false,
  budgetEnforcement: false,
  usageTracking: false,
  inferenceTable: false,
  guardrails: false,
  routingFallback: false,
};

export const EnforcementSourceSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('advisory-resource-budget'),
    label: z.literal('Advisory'),
    approximate: z.literal(false),
    blocksUsage: z.literal(false),
    detail: z.string(),
    identifier: z.string(),
  }),
  z.strictObject({
    source: z.literal('gateway-rate-limit'),
    label: z.literal('Rate limited'),
    approximate: z.literal(true),
    blocksUsage: z.literal(true),
    detail: z.string(),
    identifier: z.string(),
  }),
  z.strictObject({
    source: z.literal('gateway-block-usage-budget'),
    label: z.literal('BLOCK_USAGE'),
    approximate: z.literal(true),
    blocksUsage: z.literal(true),
    detail: z.string(),
    identifier: z.string(),
  }),
  z.strictObject({
    source: z.literal('unavailable'),
    label: z.literal('Unavailable'),
    approximate: z.literal(false),
    blocksUsage: z.literal(false),
    detail: z.string(),
    identifier: z.string(),
  }),
]);
export type EnforcementSource = z.infer<typeof EnforcementSourceSchema>;

export const ADVISORY_RESOURCE_BUDGET_ENFORCEMENT: EnforcementSource = {
  source: 'advisory-resource-budget',
  label: 'Advisory',
  approximate: false,
  blocksUsage: false,
  detail:
    'Resource budgets remain advisory because independent service usage and attribution cannot be stopped reliably.',
  identifier: '',
};

export const AiGatewayCandidateSchema = z.strictObject({
  id: z.string(),
  displayName: z.string(),
  kind: AiGatewayCandidateKindSchema,
  ready: z.boolean(),
  readiness: z.string(),
  compatibleModes: z.array(AiGatewayModeSchema),
  capabilities: AiGatewayCapabilitiesSchema,
  enforcement: z.array(EnforcementSourceSchema),
});
export type AiGatewayCandidate = z.infer<typeof AiGatewayCandidateSchema>;

export const AiGatewayValidationStateSchema = z.enum(['validated', 'invalid', 'permission-blocked', 'unavailable']);
export type AiGatewayValidationState = z.infer<typeof AiGatewayValidationStateSchema>;

export const AiGatewayValidationSchema = z.strictObject({
  state: AiGatewayValidationStateSchema,
  detail: z.string(),
  validatedAt: z.string(),
  candidate: AiGatewayCandidateSchema.nullable(),
});
export type AiGatewayValidation = z.infer<typeof AiGatewayValidationSchema>;

export const AiGatewayDiscoverySchema = z.strictObject({
  status: z.enum(['ok', 'permission-blocked', 'unavailable']),
  items: z.array(AiGatewayCandidateSchema),
  detail: z.string(),
  pagination: z.strictObject({
    pagesRead: z.number().int().nonnegative(),
    pageCap: z.number().int().positive(),
    capped: z.boolean(),
  }),
});
export type AiGatewayDiscovery = z.infer<typeof AiGatewayDiscoverySchema>;

export interface AiGatewayConfiguration {
  mode: AiGatewayMode;
  model: string;
  transport: 'Direct' | 'MLflow' | 'OpenAI';
}

export interface AiGatewaySummary {
  active: AiGatewayConfiguration;
  staged: AiGatewayConfiguration | null;
  configurationState: 'active' | 'staged' | 'invalid' | 'unavailable';
  detail: string;
  validatedAt: string;
  revision: string;
  candidate: AiGatewayCandidate | null;
  rollback: string;
}

export const AiGatewaySelectionSchema = z.strictObject({
  mode: AiGatewayModeSchema,
  candidateId: z.string().trim().min(1).max(500),
  expectedRevision: z.string().trim().min(1).max(200),
});
export type AiGatewaySelection = z.infer<typeof AiGatewaySelectionSchema>;

/**
 * Read-only future attribution hook. Phase 1 deliberately carries only a query
 * description; callers must supply known account/workspace scopes before any IO.
 */
export interface GatewayUsageAttributionHook {
  source: 'system.ai_gateway.usage' | 'system.billing.usage' | 'external-model-spend';
  enabled: false;
  requires: readonly ('account_id' | 'account_scope' | 'warehouse')[];
}

export const GATEWAY_USAGE_ATTRIBUTION_HOOKS: readonly GatewayUsageAttributionHook[] = [
  { source: 'system.ai_gateway.usage', enabled: false, requires: ['warehouse'] },
  { source: 'system.billing.usage', enabled: false, requires: ['account_id', 'account_scope', 'warehouse'] },
  { source: 'external-model-spend', enabled: false, requires: ['account_id', 'account_scope'] },
];

export function gatewayTransport(mode: AiGatewayMode): AiGatewayConfiguration['transport'] {
  if (mode === 'mlflow') return 'MLflow';
  if (mode === 'openai') return 'OpenAI';
  return 'Direct';
}
