import type { ContractFailure } from '../../shared/contract-observatory';

export function contractFailureKey(failure: ContractFailure, index: number): string {
  return `${failure.messageId || failure.runId || `row-${index}`}:${failure.kind}`;
}
