import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAVEAT_RISK } from '../client/src/caveat-priority';
import {
  AnalysisPlanSchema,
  ClarificationSchema,
  LiveAnswerSchema,
  SERVICE_PRINCIPAL_FALLBACK_CAVEAT,
} from '../server/routes/insights-routes';
import { proseOnlyCaveat, PROSE_ONLY_ANSWER_CAVEAT } from './prose-only-answer';
import { REPRESENTATIVE_ANSWER_CAVEAT } from './representative-answer';
import { DEGRADED_ANSWER_MARKER } from './setup-remedies';
import { TERMINAL_KINDS } from './terminal-response';

interface JsonObjectSchema {
  properties: Record<string, unknown>;
  required: string[];
}

interface SharedContract {
  $defs: Record<string, JsonObjectSchema>;
  discriminator: { propertyName: string; mapping: Record<string, string> };
  'x-pia-terminal-kinds': string[];
  'x-pia-renderable': {
    owner: string;
    field: string;
    formats: Record<string, string>;
    frontend_must_not: string[];
  };
  'x-pia-caveats': {
    closed_set: boolean;
    categories: { id: string; rank: number }[];
    stable_forms: { id: string; value: string }[];
  };
}

const CONTRACT = JSON.parse(
  readFileSync(new URL('../../contracts/agent-response.schema.json', import.meta.url), 'utf8')
) as SharedContract;

function keys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

describe('the generated agent response contract', () => {
  it('keeps the Python terminal union aligned with the app dispatcher', () => {
    expect(CONTRACT.discriminator.propertyName).toBe('type');
    expect(CONTRACT['x-pia-terminal-kinds']).toEqual(TERMINAL_KINDS);
    expect(keys(CONTRACT.discriminator.mapping)).toEqual([...TERMINAL_KINDS].sort());
  });

  it('keeps answer, plan, and clarification fields aligned with the app validators', () => {
    // These fields are added by the app after it accepts an agent answer. They
    // do not belong in the Model Serving producer contract.
    const routeOwned = new Set([
      'mode',
      'provenance',
      'runtime_settings',
      'trace_session_id',
      'trace_session_basis',
    ]);
    const liveAnswerFields = Object.keys(LiveAnswerSchema.shape).filter((field) => !routeOwned.has(field));

    expect(liveAnswerFields.sort()).toEqual(keys(CONTRACT.$defs.AnswerContract.properties));
    expect(keys(AnalysisPlanSchema.shape)).toEqual(keys(CONTRACT.$defs.AnalysisPlan.properties));
    expect(keys(ClarificationSchema.shape)).toEqual(keys(CONTRACT.$defs.Clarification.properties));
  });

  it('publishes backend-selected HTML and JSON renderables', () => {
    const renderable = CONTRACT['x-pia-renderable'];

    expect(CONTRACT.$defs.DashboardOutput.required).toContain('renderable');
    expect(keys(CONTRACT.$defs.DashboardOutput.properties)).toEqual(['renderable', 'type']);
    expect(renderable).toMatchObject({
      owner: 'backend',
      field: 'renderable',
    });
    expect(keys(renderable.formats)).toEqual(['html', 'json']);
    expect(renderable.formats.html).toContain('byte-for-byte');
    expect(renderable.formats.json).toContain('Preserve the JSON value');
    expect(renderable.frontend_must_not).toContain('infer a different format from the payload');
    expect(renderable.frontend_must_not).toContain('parse, sanitize, or rewrite HTML');
  });

  it('publishes the exact caveat priorities and stable app-owned forms', () => {
    const caveats = CONTRACT['x-pia-caveats'];
    const stable = new Map(caveats.stable_forms.map((form) => [form.id, form.value]));

    expect(caveats.closed_set).toBe(false);
    expect(caveats.categories.map(({ id, rank }) => [id, rank])).toEqual(Object.entries(CAVEAT_RISK));
    expect(stable.get('degraded-answer')).toBe(DEGRADED_ANSWER_MARKER);
    expect(stable.get('prose-only-answer')).toBe(PROSE_ONLY_ANSWER_CAVEAT);
    expect(stable.get('prose-only-after-stages')).toBe(proseOnlyCaveat(2));
    expect(stable.get('service-principal-fallback')).toBe(SERVICE_PRINCIPAL_FALLBACK_CAVEAT);
    expect(stable.get('historical-untraced-answer')).toBe(REPRESENTATIVE_ANSWER_CAVEAT);
  });
});
