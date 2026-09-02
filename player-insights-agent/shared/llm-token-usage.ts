/**
 * Provider-neutral token evidence projected from MLflow spans.
 *
 * This module never reads span inputs or outputs. The server hands it only span
 * identity, hierarchy, type, name, and attributes; the browser receives only
 * aggregate counts attached to the owning Agent Map step.
 */

export type CacheStatus = 'used' | 'not-used' | 'unavailable';

export interface StepTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
  cacheStatus: CacheStatus;
  attempts: number;
  totalMismatch: boolean;
}

export interface TokenReconciliation {
  attributedTokens: number;
  attributedCalls: number;
  overviewTokens?: number;
  coveragePercent?: number;
  unattributedTokens?: number;
  nestedAggregateTokens: number;
  mismatchCount: number;
  cachedReadTokens?: number;
  cacheCoveredInputTokens?: number;
  cacheHitPercent?: number;
}

export interface TokenEvidenceSpan {
  span_id?: unknown;
  parent_span_id?: unknown;
  name?: unknown;
  span_type?: unknown;
  attributes?: unknown;
}

/** One redacted direct invocation, retained for Timeline and Details audit rows. */
export interface TokenInvocationUsage extends StepTokenUsage {
  invocationId: string;
  stageId: string;
  attempt: number;
}

export interface TokenAttribution {
  stages: Record<string, StepTokenUsage>;
  reconciliation: TokenReconciliation;
  invocations: TokenInvocationUsage[];
}

interface InvocationUsage {
  input?: number;
  output?: number;
  total?: number;
  cachedRead?: number;
  cacheWrite?: number;
}

interface ParsedSpan {
  id: string;
  parentId: string;
  name: string;
  type: string;
  usage: InvocationUsage | null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function count(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function nested(source: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const part of path) {
    const currentRecord = record(decoded(current));
    if (!currentRecord) return undefined;
    current = currentRecord[part];
  }
  return current;
}

function firstCount(
  sources: readonly Record<string, unknown>[],
  paths: readonly (readonly string[])[]
): number | undefined {
  for (const source of sources) {
    for (const path of paths) {
      const value = count(nested(source, path));
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * Explicit adapters for the usage shapes emitted by MLflow, OpenAI-compatible
 * gateways, Anthropic, and Databricks model serving.
 */
export function invocationUsage(attributes: unknown): InvocationUsage | null {
  const attrs = record(attributes);
  if (!attrs) return null;
  const candidates = [
    attrs,
    record(decoded(attrs['mlflow.chat.tokenUsage'])),
    record(decoded(attrs['gen_ai.usage'])),
    record(decoded(attrs.usage)),
    record(decoded(attrs.token_usage)),
    record(decoded(attrs['response.usage'])),
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== null);

  const input = firstCount(candidates, [['input_tokens'], ['prompt_tokens'], ['gen_ai.usage.input_tokens']]);
  const output = firstCount(candidates, [['output_tokens'], ['completion_tokens'], ['gen_ai.usage.output_tokens']]);
  const total = firstCount(candidates, [['total_tokens'], ['gen_ai.usage.total_tokens']]);
  const cachedRead = firstCount(candidates, [
    ['cached_input_tokens'],
    ['cache_read_input_tokens'],
    ['cache_read_tokens'],
    ['gen_ai.usage.cached_input_tokens'],
    ['gen_ai.usage.cache_read_input_tokens'],
    ['input_tokens_details', 'cached_tokens'],
    ['prompt_tokens_details', 'cached_tokens'],
  ]);
  const cacheWrite = firstCount(candidates, [
    ['cache_creation_input_tokens'],
    ['cache_write_input_tokens'],
    ['cache_creation_tokens'],
    ['gen_ai.usage.cache_creation_input_tokens'],
    ['gen_ai.usage.cache_write_input_tokens'],
  ]);
  if ([input, output, total, cachedRead, cacheWrite].every((value) => value === undefined)) return null;
  return { input, output, total, cachedRead, cacheWrite };
}

function text(value: unknown): string {
  const valueDecoded = decoded(value);
  return typeof valueDecoded === 'string' ? valueDecoded.trim() : '';
}

function parseSpan(span: TokenEvidenceSpan, index: number): ParsedSpan {
  const attrs = record(span.attributes) ?? {};
  return {
    id: text(span.span_id) || `position-${index}`,
    parentId: text(span.parent_span_id),
    name: text(span.name),
    type: (
      text(span.span_type) ||
      text(attrs['mlflow.spanType']) ||
      text(attrs['gen_ai.operation.name'])
    ).toUpperCase(),
    usage: invocationUsage(attrs),
  };
}

function directLlm(span: ParsedSpan): boolean {
  return span.type === 'LLM' || span.type === 'CHAT_MODEL' || span.type === 'CHAT';
}

function authoritativeTotal(usage: InvocationUsage): number | undefined {
  if (usage.total !== undefined) return usage.total;
  if (usage.input !== undefined && usage.output !== undefined) return usage.input + usage.output;
  return undefined;
}

function ownerStageId(spanName: string, stageIds: readonly string[]): string | null {
  const finder = /(?:^|\.)llm\.(step-\d+)(?:$|\.)/i.exec(spanName)?.[1];
  if (finder && stageIds.includes(finder)) return finder;
  const lower = spanName.toLowerCase();
  return (
    [...stageIds]
      .sort((left, right) => right.length - left.length)
      .find((id) => {
        const candidate = id.toLowerCase();
        return lower === candidate || lower.endsWith(`.${candidate}`) || lower.endsWith(`/${candidate}`);
      }) ?? null
  );
}

function descendantDirectTotal(parent: ParsedSpan, spans: readonly ParsedSpan[]): number {
  const children = new Map<string, ParsedSpan[]>();
  for (const span of spans) {
    const siblings = children.get(span.parentId) ?? [];
    siblings.push(span);
    children.set(span.parentId, siblings);
  }
  let total = 0;
  const visit = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (directLlm(child) && child.usage) total += authoritativeTotal(child.usage) ?? 0;
      else visit(child.id);
    }
  };
  visit(parent.id);
  return total;
}

function add(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

export function attributeTokenUsage(
  rawSpans: readonly TokenEvidenceSpan[],
  stageIds: readonly string[],
  overviewTokens?: number
): TokenAttribution {
  const seen = new Set<string>();
  const spans = rawSpans.map(parseSpan).filter((span) => {
    if (seen.has(span.id)) return false;
    seen.add(span.id);
    return true;
  });
  const stages: Record<string, StepTokenUsage> = {};
  let attributedTokens = 0;
  let attributedCalls = 0;
  let mismatchCount = 0;
  let cachedReadTokens = 0;
  let cacheCoveredInputTokens = 0;
  let cacheReported = false;
  const invocations: TokenInvocationUsage[] = [];
  const attemptsByStage = new Map<string, number>();

  for (const span of spans) {
    if (!directLlm(span) || !span.usage) continue;
    const owner = ownerStageId(span.name, stageIds);
    const usage = span.usage;
    const total = authoritativeTotal(usage);
    const mismatch =
      usage.total !== undefined &&
      usage.input !== undefined &&
      usage.output !== undefined &&
      usage.total !== usage.input + usage.output;
    if (mismatch) mismatchCount += 1;
    if (!owner) continue;
    const attempt = (attemptsByStage.get(owner) ?? 0) + 1;
    attemptsByStage.set(owner, attempt);
    const current = stages[owner] ?? {
      cacheStatus: 'unavailable' as const,
      attempts: 0,
      totalMismatch: false,
    };
    current.inputTokens = add(current.inputTokens, usage.input);
    current.outputTokens = add(current.outputTokens, usage.output);
    current.totalTokens = add(current.totalTokens, total);
    current.cachedReadTokens = add(current.cachedReadTokens, usage.cachedRead);
    current.cacheWriteTokens = add(current.cacheWriteTokens, usage.cacheWrite);
    current.attempts += 1;
    current.totalMismatch ||= mismatch;
    if (usage.cachedRead !== undefined) {
      current.cacheStatus = usage.cachedRead > 0 ? 'used' : current.cacheStatus === 'used' ? 'used' : 'not-used';
      cacheReported = true;
      cachedReadTokens += usage.cachedRead;
      if (usage.input !== undefined) cacheCoveredInputTokens += usage.input;
    }
    stages[owner] = current;
    invocations.push({
      invocationId: span.id,
      stageId: owner,
      attempt,
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: total,
      cachedReadTokens: usage.cachedRead,
      cacheWriteTokens: usage.cacheWrite,
      cacheStatus: usage.cachedRead === undefined ? 'unavailable' : usage.cachedRead > 0 ? 'used' : 'not-used',
      attempts: 1,
      totalMismatch: mismatch,
    });
    attributedCalls += 1;
    attributedTokens += total ?? 0;
  }

  let nestedAggregateTokens = 0;
  for (const span of spans) {
    if (directLlm(span) || !span.usage) continue;
    const total = authoritativeTotal(span.usage);
    if (total === undefined) continue;
    if (descendantDirectTotal(span, spans) === total) nestedAggregateTokens += total;
  }

  const reconciliation: TokenReconciliation = {
    attributedTokens,
    attributedCalls,
    nestedAggregateTokens,
    mismatchCount,
  };
  if (typeof overviewTokens === 'number' && Number.isFinite(overviewTokens) && overviewTokens >= 0) {
    reconciliation.overviewTokens = overviewTokens;
    reconciliation.coveragePercent =
      overviewTokens === 0 ? 100 : Math.min(100, (attributedTokens / overviewTokens) * 100);
    if (overviewTokens > attributedTokens) reconciliation.unattributedTokens = overviewTokens - attributedTokens;
  }
  if (cacheReported) {
    reconciliation.cachedReadTokens = cachedReadTokens;
    reconciliation.cacheCoveredInputTokens = cacheCoveredInputTokens;
    if (cacheCoveredInputTokens > 0) {
      reconciliation.cacheHitPercent = Math.min(100, (cachedReadTokens / cacheCoveredInputTokens) * 100);
    }
  }
  return { stages, reconciliation, invocations };
}
