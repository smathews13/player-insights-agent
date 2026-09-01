/**
 * Keep the TypeScript Apply plan in step with the Python resolver's key set.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPLYABLE_KEYS,
  APPLY_ENV_VARS,
  intendedFromResources,
  resolveApplyPlan,
  settingsFromDeclaration,
} from './apply-declaration';
import type { NotebookDeclaration } from './notebook-declaration';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PYTHON = readFileSync(join(ROOT, 'agent/apply_from_declaration.py'), 'utf8');

describe('apply-declaration', () => {
  it('intended beats notebook', () => {
    const plan = resolveApplyPlan({
      intended: { warehouse_id: 'wh-app' },
      notebook: { warehouse_id: 'wh-nb', llm_endpoint: 'ep-nb' },
      target: 'customer',
    });
    expect(plan.knobs.find((k) => k.key === 'warehouse_id')?.source).toBe('intended');
    expect(plan.knobs.find((k) => k.key === 'llm_endpoint')?.source).toBe('notebook');
    expect(plan.command).toContain('TARGET=customer');
    expect(plan.command).toContain('--i-am-deploying');
  });

  it('drops notebook catalog_allowlist', () => {
    const declaration = {
      source: 'nb',
      revision: '',
      publishedAt: '',
      publishedBy: '',
      settings: [
        { key: 'catalog_allowlist', value: 'other' },
        { key: 'warehouse_id', value: 'wh-1' },
      ],
      connections: [],
      emptyScopes: false,
    } satisfies NotebookDeclaration;
    expect(settingsFromDeclaration(declaration)).toEqual({ warehouse_id: 'wh-1' });
  });

  it('reads intended from settings resources', () => {
    expect(
      intendedFromResources([
        { resource: { agentKey: 'warehouse_id' }, intended: 'wh-x' },
        { resource: { agentKey: null }, intended: 'nope' },
      ])
    ).toEqual({ warehouse_id: 'wh-x' });
  });

  it('keeps Direct as an explicit empty Gateway route paired with its model', () => {
    const intended = intendedFromResources([
      { resource: { agentKey: 'llm_gateway' }, intended: '' },
      { resource: { agentKey: 'llm_endpoint' }, intended: 'databricks-gpt-5' },
    ]);
    expect(intended).toEqual({ llm_gateway: '', llm_endpoint: 'databricks-gpt-5' });
    const plan = resolveApplyPlan({ intended, target: 'customer' });
    expect(plan.knobs.find((knob) => knob.key === 'llm_gateway')).toMatchObject({
      value: '',
      source: 'intended',
    });
    expect(plan.notes.join(' ')).toMatch(/Direct.*databricks-gpt-5.*revalidates/);
  });

  it('lists the same applyable keys the Python resolver exports', () => {
    for (const key of APPLYABLE_KEYS) {
      expect(PYTHON, `${key} missing from apply_from_declaration.py`).toContain(`"${key}"`);
      expect(APPLY_ENV_VARS[key]).toMatch(/^PLAYER_INSIGHTS_/);
    }
    expect(PYTHON).toContain('NOTEBOOK_REFUSED_KEYS');
    expect(PYTHON).toContain('catalog_allowlist');
  });
});
