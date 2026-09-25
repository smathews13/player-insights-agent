export type ContractDifferenceKind = 'backend-only' | 'frontend-only';

export interface ContractSection {
  id: string;
  label: string;
  schemaVersion: string | null;
  fields: string[];
}

export interface ContractSide {
  label: string;
  revision: string;
  note: string;
  sections: ContractSection[];
}

export interface ContractDifference {
  sectionId: string;
  sectionLabel: string;
  field: string;
  kind: ContractDifferenceKind;
}

export interface ContractFailure {
  runId: string;
  conversationId: string;
  traceId: string | null;
  messageId: string | null;
  occurredAt: string;
  kind: 'schema-violation' | 'undeclared-fields';
  code: string;
  fields: string[];
  detail: string;
}

export interface ContractObservatoryPayload {
  generatedAt: string;
  backend: ContractSide;
  frontend: ContractSide;
  differences: ContractDifference[];
  failures: ContractFailure[];
  failureReadState: 'ready' | 'unavailable';
  failureReadReason: string;
}

export function compareContractSections(
  backend: readonly ContractSection[],
  frontend: readonly ContractSection[]
): ContractDifference[] {
  const differences: ContractDifference[] = [];
  const backendById = new Map(backend.map((section) => [section.id, section]));
  const frontendById = new Map(frontend.map((section) => [section.id, section]));
  const sectionIds = [...new Set([...backendById.keys(), ...frontendById.keys()])].sort();

  for (const sectionId of sectionIds) {
    const backendSection = backendById.get(sectionId);
    const frontendSection = frontendById.get(sectionId);
    const sectionLabel = backendSection?.label ?? frontendSection?.label ?? sectionId;
    const backendFields = new Set(backendSection?.fields ?? []);
    const frontendFields = new Set(frontendSection?.fields ?? []);
    for (const field of [...backendFields].filter((name) => !frontendFields.has(name)).sort()) {
      differences.push({ sectionId, sectionLabel, field, kind: 'backend-only' });
    }
    for (const field of [...frontendFields].filter((name) => !backendFields.has(name)).sort()) {
      differences.push({ sectionId, sectionLabel, field, kind: 'frontend-only' });
    }
  }
  return differences;
}
