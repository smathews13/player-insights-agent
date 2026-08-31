export type SupportReference = {
  label: 'Correlation ID' | 'Request ID';
  value: string;
};

function readableReference(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Structured support identifiers only; never scrape arbitrary error prose. */
export function errorSupportReferences(error: unknown): SupportReference[] {
  if (!error || typeof error !== 'object') return [];
  const record = error as Record<string, unknown>;
  const related = [record, record.data, record.cause].filter(
    (candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === 'object'
  );
  const correlation =
    related.map((candidate) => readableReference(candidate.correlationId)).find(Boolean) ??
    related.map((candidate) => readableReference(candidate.correlation_id)).find(Boolean) ??
    null;
  const request =
    related.map((candidate) => readableReference(candidate.requestId)).find(Boolean) ??
    related.map((candidate) => readableReference(candidate.request_id)).find(Boolean) ??
    null;
  const references: SupportReference[] = [];
  if (correlation) references.push({ label: 'Correlation ID', value: correlation });
  if (request && request !== correlation) references.push({ label: 'Request ID', value: request });
  return references;
}
