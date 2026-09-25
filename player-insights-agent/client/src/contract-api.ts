import type { ContractObservatoryPayload } from '../../shared/contract-observatory';

function isContractPayload(value: unknown): value is ContractObservatoryPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Boolean(record.backend && typeof record.backend === 'object') &&
    Boolean(record.frontend && typeof record.frontend === 'object') &&
    Array.isArray(record.differences) &&
    Array.isArray(record.failures)
  );
}

export async function loadContractObservatory(signal?: AbortSignal): Promise<ContractObservatoryPayload> {
  const response = await fetch('/api/admin/contract', { signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string'
        ? body.detail
        : `Contract diagnostics returned HTTP ${response.status}.`;
    throw new Error(detail);
  }
  if (!isContractPayload(body)) {
    throw new Error('Contract diagnostics returned an unreadable response.');
  }
  return body;
}
