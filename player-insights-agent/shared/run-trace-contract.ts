import { z } from 'zod';

export const StageSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  start: z.number(),
  duration: z.number(),
  status: z.enum(['complete', 'running', 'partial', 'failed', 'cancelled', 'awaiting_approval']),
  calls: z.number(),
  input: z.string(),
  output: z.string(),
  tables: z.array(z.string()).optional(),
  depth: z.number().default(0),
  parent_id: z.string().default(''),
  token_usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
      cachedReadTokens: z.number().int().nonnegative().optional(),
      cacheWriteTokens: z.number().int().nonnegative().optional(),
      cacheStatus: z.enum(['used', 'not-used', 'unavailable']),
      attempts: z.number().int().positive(),
      totalMismatch: z.boolean(),
    })
    .optional(),
});

export const GenieSpaceSchema = z.looseObject({ id: z.string(), title: z.string().default('') });

export const ResourceCallSchema = z.looseObject({
  kind: z.enum(['genie-space', 'vector-index']),
  id: z.string(),
  tool: z.enum(['data_genie', 'genie_mcp', 'dictionary_genie', 'search_semantics']),
  calls: z.number().int().nonnegative(),
});

export const TokenInvocationSchema = z.object({
  invocationId: z.string().min(1),
  stageId: z.string().min(1),
  attempt: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cachedReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  cacheStatus: z.enum(['used', 'not-used', 'unavailable']),
  attempts: z.number().int().positive(),
  totalMismatch: z.boolean(),
});

export const TraceSchema = z.looseObject({
  id: z.string(),
  totalMs: z.number(),
  toolCalls: z.number(),
  stages: z.array(StageSchema),
  genie_spaces: z.array(GenieSpaceSchema).optional(),
  resource_calls: z.array(ResourceCallSchema).optional(),
  genie_transport: z.enum(['direct', 'mcp']).optional(),
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  token_invocations: z.array(TokenInvocationSchema).optional(),
  token_reconciliation: z
    .object({
      attributedTokens: z.number().int().nonnegative(),
      attributedCalls: z.number().int().nonnegative(),
      overviewTokens: z.number().int().nonnegative().optional(),
      coveragePercent: z.number().nonnegative().optional(),
      unattributedTokens: z.number().int().nonnegative().optional(),
      nestedAggregateTokens: z.number().int().nonnegative(),
      mismatchCount: z.number().int().nonnegative(),
      cachedReadTokens: z.number().int().nonnegative().optional(),
      cacheCoveredInputTokens: z.number().int().nonnegative().optional(),
      cacheHitPercent: z.number().nonnegative().optional(),
    })
    .optional(),
});
