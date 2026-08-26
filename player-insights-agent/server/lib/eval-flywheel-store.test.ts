import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_SCHEMA } from '../../shared/app-schema';
import { EMPTY_FLYWHEEL_STATE } from '../../shared/eval-flywheel';
import {
  EVAL_FLYWHEEL_TABLE,
  forgetFlywheelState,
  readFlywheelState,
  resolveAskEndpoint,
  resolveAskGuidance,
  writeFlywheelState,
} from './eval-flywheel-store';

function client(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    lakebase: {
      query: (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve({ rows });
      },
    },
  };
}

describe('flywheel state persistence', () => {
  it('qualifies the table with APP_SCHEMA', () => {
    expect(EVAL_FLYWHEEL_TABLE).toBe(`${APP_SCHEMA}.eval_flywheel`);
    const source = fs.readFileSync(path.join(__dirname, 'eval-flywheel-store.ts'), 'utf8');
    expect(source).toContain("appTable('eval_flywheel')");
  });

  it('reads empty state when nothing has been saved', async () => {
    forgetFlywheelState();
    expect(await readFlywheelState(client() as never, { maxAgeMs: 0 })).toEqual(EMPTY_FLYWHEEL_STATE);
  });

  it('writes promoted endpoint and resolves it for the next Ask', async () => {
    const writer = client();
    await writeFlywheelState(
      writer as never,
      {
        ...EMPTY_FLYWHEEL_STATE,
        promoted: {
          endpoint: 'candidate-agent',
          side: 'candidate',
          at: '2026-08-25T00:00:00.000Z',
          note: 'Won 9/10',
          approver: '',
          targetKind: 'prompt-registry',
          targetId: '',
        },
      },
      'admin@example.com'
    );
    expect(writer.calls[0]?.values?.[2]).toBe('admin@example.com');

    forgetFlywheelState();
    const reader = client([
      {
        state: {
          lastSuite: null,
          promoted: { endpoint: 'candidate-agent', side: 'candidate', at: '2026-08-25T00:00:00.000Z', note: 'Won 9/10' },
          lastAgentRunIds: [],
          lastAgentSides: [],
          history: [],
        },
      },
    ]);
    expect(await resolveAskEndpoint(reader as never)).toBe('candidate-agent');
  });

  it('leaves Ask on the deployed agent when nothing has been promoted', async () => {
    forgetFlywheelState();
    expect(await resolveAskEndpoint(client() as never)).toBeUndefined();
  });

  it('resolves promoted Prompt Registry guidance for the next Ask', async () => {
    forgetFlywheelState();
    const reader = client([
      {
        state: {
          ...EMPTY_FLYWHEEL_STATE,
          promotedPrompt: {
            name: 'main.default.pia_guidance',
            alias: 'production',
            version: '3',
            uri: 'prompts:/main.default.pia_guidance@production',
            template: 'Be brief.',
            status: 'moved',
            note: 'Moved.',
          },
        },
      },
    ]);
    expect(await resolveAskGuidance(reader as never)).toBe('Be brief.');
  });
});
