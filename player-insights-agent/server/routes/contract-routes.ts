import type { Application } from 'express';

import backendTemplate from './__fixtures__/backend-app-handoff/template.json';
import { APP_SCHEMA } from '../../shared/app-schema';
import {
  compareContractSections,
  type ContractFailure,
  type ContractObservatoryPayload,
  type ContractSection,
  type ContractSide,
} from '../../shared/contract-observatory';
import { frontendContractSections, type InsightsAppKit } from './insights-routes';

export const CONTRACT_ROUTES = ['/api/admin/contract'] as const;

const RECENT_CONTRACT_RUNS_QUERY = `
  SELECT r.run_id, r.conversation_id, r.trace_id, r.terminal_code, r.created_at, r.completed_at,
         m.id AS message_id, m.response_json
  FROM (
    SELECT run_id, conversation_id, trace_id, terminal_code, terminal_message_id, created_at, completed_at
    FROM ${APP_SCHEMA}.runs
    ORDER BY created_at DESC
    LIMIT 200
  ) r
  LEFT JOIN ${APP_SCHEMA}.messages m ON m.id = r.terminal_message_id
  ORDER BY r.created_at DESC`;

type TemplateRecord = Record<string, unknown>;

function record(value: unknown): TemplateRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as TemplateRecord) : {};
}

function sectionFields(value: unknown): string[] {
  return Object.keys(record(value))
    .filter((field) => !field.startsWith('_'))
    .sort();
}

function backendContractSections(): ContractSection[] {
  const template = record(backendTemplate);
  const envelopes = record(template.envelopes);
  const definitions: Array<[string, string, string]> = [
    ['answer', 'Answer', 'AnswerContract'],
    ['figure', 'Figure', 'Figure'],
    ['chart', 'Chart', 'Chart'],
    ['source', 'Source', 'Source'],
    ['derivation', 'Derivation', 'Derivation'],
    ['trace', 'Trace summary', 'TraceSummary'],
    ['stage', 'Trace stage', 'TraceStage'],
    ['plan', 'Analysis plan', 'AnalysisPlan'],
    ['plan-step', 'Plan step', 'PlanStep'],
    ['plan-candidate', 'Plan candidate', 'PlanCandidate'],
    ['clarification', 'Clarification', 'Clarification'],
    ['report', 'Report', 'Report'],
    ['dashboard', 'Dashboard', 'Dashboard'],
  ];
  const versionFor = (key: string): string | null => {
    const value = record(template[key]);
    const schema = value.schema_version;
    if (typeof schema !== 'string') return null;
    const match = schema.match(/pia\.[a-z-]+\/\d+/i);
    return match?.[0] ?? null;
  };
  return [
    {
      id: 'envelopes',
      label: 'Response envelopes',
      schemaVersion: null,
      fields: Object.keys(envelopes)
        .filter((field) => !field.startsWith('_'))
        .sort(),
    },
    ...definitions.map(([id, label, key]) => ({
      id,
      label,
      schemaVersion: versionFor(key),
      fields: sectionFields(template[key]),
    })),
  ];
}

function backendRevision(): string {
  const about = Array.isArray(record(backendTemplate)._about) ? (record(backendTemplate)._about as unknown[]) : [];
  for (const line of about) {
    if (typeof line !== 'string') continue;
    const match = line.match(/Pinned to backend ([0-9a-f]{7,40})/i);
    if (match) return match[1];
  }
  return 'unknown';
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return '';
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function storedPayload(value: unknown): TemplateRecord | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  const parsed = record(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function fieldsOutside(value: unknown, accepted: readonly string[], prefix = ''): string[] {
  const acceptedFields = new Set(accepted);
  return Object.keys(record(value))
    .filter((field) => !acceptedFields.has(field))
    .map((field) => `${prefix}${field}`);
}

function storedAnswerDrift(payload: TemplateRecord, frontend: readonly ContractSection[]): string[] {
  if (!('takeaway' in payload) || !('trace' in payload)) return [];
  const fieldsFor = (id: string) => frontend.find((section) => section.id === id)?.fields ?? [];
  const found = fieldsOutside(payload, fieldsFor('answer'));
  const trace = record(payload.trace);
  found.push(...fieldsOutside(trace, fieldsFor('trace'), 'trace.'));
  const stages = Array.isArray(trace.stages) ? trace.stages : [];
  stages.forEach((stage, index) => {
    found.push(...fieldsOutside(stage, fieldsFor('stage'), `trace.stages[${index}].`));
  });
  return [...new Set(found)].sort();
}

function contractFailures(rows: readonly TemplateRecord[], frontend: readonly ContractSection[]): ContractFailure[] {
  const failures: ContractFailure[] = [];
  for (const row of rows) {
    const terminalCode = text(row.terminal_code);
    const base = {
      runId: text(row.run_id),
      conversationId: text(row.conversation_id),
      traceId: text(row.trace_id) || null,
      messageId: text(row.message_id) || null,
      occurredAt: timestamp(row.completed_at) || timestamp(row.created_at),
    };
    if (terminalCode === 'OUTPUT_SCHEMA_VIOLATION') {
      failures.push({
        ...base,
        kind: 'schema-violation',
        code: terminalCode,
        fields: ['$payload'],
        detail: 'The backend declared a response shape this frontend could not validate, so no answer was stored.',
      });
      continue;
    }
    const payload = storedPayload(row.response_json);
    if (!payload) continue;
    const fields = storedAnswerDrift(payload, frontend);
    if (fields.length === 0) continue;
    failures.push({
      ...base,
      kind: 'undeclared-fields',
      code: 'PIA_CONTRACT_DRIFT',
      fields,
      detail: 'The answer was preserved, but it carried fields this frontend does not declare or render.',
    });
  }
  return failures.slice(0, 50);
}

export function buildContractComparison(
  rows: readonly TemplateRecord[] = [],
  generatedAt = new Date().toISOString()
): ContractObservatoryPayload {
  const backendSections = backendContractSections();
  const frontendSections = frontendContractSections();
  const backend: ContractSide = {
    label: 'Backend handoff reference',
    revision: backendRevision(),
    note: 'Sanitized contract supplied by the backend owner and bundled with this app.',
    sections: backendSections,
  };
  const frontend: ContractSide = {
    label: 'Frontend accepted contract',
    revision: process.env.PLAYER_INSIGHTS_BUILD_SHA?.trim() || process.env.GIT_COMMIT?.trim() || 'current build',
    note: 'Generated from the schemas and normalizers in the running app build.',
    sections: frontendSections,
  };
  return {
    generatedAt,
    backend,
    frontend,
    differences: compareContractSections(backendSections, frontendSections),
    failures: contractFailures(rows, frontendSections),
    failureReadState: 'ready',
    failureReadReason: '',
  };
}

export function setupContractRoutes(appkit: InsightsAppKit, deps: { isAdminRoute: (path: string) => boolean }): void {
  const uncovered = CONTRACT_ROUTES.filter((path) => !deps.isAdminRoute(path));
  if (uncovered.length > 0) {
    console.error(`[contract] NOT REGISTERED: the admin guard does not cover ${uncovered.join(', ')}.`);
    return;
  }
  appkit.server.extend((app: Application) => {
    app.get('/api/admin/contract', async (_req, res) => {
      const generatedAt = new Date().toISOString();
      try {
        const result = await appkit.lakebase.query(RECENT_CONTRACT_RUNS_QUERY);
        res.json(buildContractComparison(result.rows.map(record), generatedAt));
      } catch (error) {
        res.json({
          ...buildContractComparison([], generatedAt),
          failureReadState: 'unavailable',
          failureReadReason: `Stored contract failures could not be read: ${(error as Error).message}`,
        } satisfies ContractObservatoryPayload);
      }
    });
  });
  console.log('[contract] Registered the admin-only contract observatory route.');
}
