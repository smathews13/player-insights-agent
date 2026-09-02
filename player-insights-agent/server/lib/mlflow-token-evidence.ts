import { isMlflowTraceId } from '../../shared/mlflow-trace-id';
import { attributeTokenUsage, type TokenAttribution, type TokenEvidenceSpan } from '../../shared/llm-token-usage';

const TRACE_DATA_LIMIT_BYTES = 5 * 1024 * 1024;
const TRACE_READ_TIMEOUT_MS = 8_000;
const TOKEN_EVIDENCE_CACHE_MS = 5 * 60_000;

interface CredentialResponse {
  credential_info?: {
    signed_uri?: unknown;
    headers?: unknown;
  };
}

interface TraceArtifact {
  spans?: unknown;
}

export type TraceTokenEvidenceReader = (
  traceId: string,
  stageIds: readonly string[],
  overviewTokens?: number
) => Promise<TokenAttribution | null>;

const evidenceCache = new Map<string, { expiresAt: number; value: TokenEvidenceSpan[] }>();

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function headers(value: unknown): Headers {
  const result = new Headers();
  if (!Array.isArray(value)) return result;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = text(record.name);
    const valueText = text(record.value);
    if (name && valueText) result.set(name, valueText);
  }
  return result;
}

export function tokenEvidenceSpans(value: unknown): TokenEvidenceSpan[] {
  if (!Array.isArray(value)) return [];
  return value.map((span) => {
    if (!span || typeof span !== 'object') return {};
    const record = span as Record<string, unknown>;
    const rawAttributes =
      record.attributes && typeof record.attributes === 'object' && !Array.isArray(record.attributes)
        ? (record.attributes as Record<string, unknown>)
        : {};
    const attributes = Object.fromEntries(
      Object.entries(rawAttributes).filter(([key]) => key === 'mlflow.spanType' || /(?:token|usage|cache)/i.test(key))
    );
    // Deliberately omit span inputs, outputs, events, links, and status. Token
    // attribution needs only this allowlist, so prompts and responses never
    // enter the app response or this cache.
    return {
      span_id: record.span_id,
      parent_span_id: record.parent_span_id,
      name: record.name,
      attributes,
    };
  });
}

async function downloadTraceTokenSpans(traceId: string): Promise<TokenEvidenceSpan[]> {
  const held = evidenceCache.get(traceId);
  if (held && held.expiresAt > Date.now()) return held.value;
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  const client = new WorkspaceClient({});
  const credential = (await client.apiClient.request({
    method: 'GET',
    path: `/api/2.0/mlflow/traces/${encodeURIComponent(traceId)}/credentials-for-data-download`,
    headers: new Headers({ Accept: 'application/json' }),
    raw: false,
  })) as CredentialResponse;
  const signedUri = text(credential.credential_info?.signed_uri);
  if (!signedUri) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRACE_READ_TIMEOUT_MS);
  try {
    const response = await fetch(signedUri, {
      headers: headers(credential.credential_info?.headers),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`trace artifact returned ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > TRACE_DATA_LIMIT_BYTES)
      throw new Error('trace artifact exceeds the token-evidence read limit');
    const body = await response.text();
    if (body.length > TRACE_DATA_LIMIT_BYTES) throw new Error('trace artifact exceeds the token-evidence read limit');
    const parsed = JSON.parse(body) as TraceArtifact;
    const spans = tokenEvidenceSpans(parsed.spans);
    evidenceCache.set(traceId, { expiresAt: Date.now() + TOKEN_EVIDENCE_CACHE_MS, value: spans });
    return spans;
  } finally {
    clearTimeout(timer);
  }
}

/** Read only token-bearing span metadata; failure leaves the stored run intact. */
export const readMlflowTokenEvidence: TraceTokenEvidenceReader = async (traceId, stageIds, overviewTokens) => {
  if (!isMlflowTraceId(traceId)) return null;
  try {
    const spans = await downloadTraceTokenSpans(traceId);
    if (spans.length === 0) return null;
    return attributeTokenUsage(spans, stageIds, overviewTokens);
  } catch (error) {
    console.warn(`[mlflow] Token evidence for ${traceId} could not be read: ${(error as Error).message}`);
    return null;
  }
};
