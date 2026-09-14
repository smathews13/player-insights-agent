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

  it('carries a staged Vector Search index into the agent release', () => {
    const intended = intendedFromResources([
      { resource: { agentKey: 'semantic_index' }, intended: 'catalog.schema.semantic_index' },
    ]);
    const plan = resolveApplyPlan({ intended, target: 'customer' });
    expect(plan.knobs).toContainEqual({
      key: 'semantic_index',
      label: 'Vector Search index',
      value: 'catalog.schema.semantic_index',
      source: 'intended',
      envVar: 'PLAYER_INSIGHTS_SEMANTIC_INDEX',
    });
  });

  it('keeps Direct as an explicit empty Gateway route paired with its model', () => {
    const intended = intendedFromResources([
      { resource: { agentKey: 'llm_gateway' }, intended: '' },
      { resource: { agentKey: 'llm_gateway_endpoint' }, intended: '' },
      { resource: { agentKey: 'llm_endpoint' }, intended: 'databricks-gpt-5' },
    ]);
    expect(intended).toEqual({
      llm_gateway: '',
      llm_gateway_endpoint: '',
      llm_endpoint: 'databricks-gpt-5',
    });
    const plan = resolveApplyPlan({ intended, target: 'customer' });
    expect(plan.knobs.find((knob) => knob.key === 'llm_gateway')).toMatchObject({
      value: '',
      source: 'intended',
    });
    expect(plan.notes.join(' ')).toMatch(/Direct.*databricks-gpt-5.*revalidates/);
  });

  it('preserves Direct gateway clears in the immutable release declaration', () => {
    const declaration = {
      source: 'connections-apply',
      revision: '',
      publishedAt: '',
      publishedBy: '',
      settings: [
        { key: 'llm_gateway', value: '' },
        { key: 'llm_gateway_endpoint', value: '' },
        { key: 'llm_endpoint', value: 'databricks-gpt-5' },
      ],
      connections: [],
      emptyScopes: false,
    } satisfies NotebookDeclaration;
    const plan = resolveApplyPlan({ notebook: settingsFromDeclaration(declaration), target: 'customer' });
    expect(Object.fromEntries(plan.knobs.map((knob) => [knob.envVar, knob.value]))).toMatchObject({
      PLAYER_INSIGHTS_LLM_GATEWAY: '',
      PLAYER_INSIGHTS_LLM_GATEWAY_ENDPOINT: '',
      PLAYER_INSIGHTS_LLM_ENDPOINT: 'databricks-gpt-5',
    });
  });

  it('keeps a Gateway endpoint separate from the direct foundation endpoint', () => {
    const intended = intendedFromResources([
      { resource: { agentKey: 'llm_gateway' }, intended: 'mlflow' },
      { resource: { agentKey: 'llm_gateway_endpoint' }, intended: 'catalog.schema.gateway_model' },
      { resource: { agentKey: 'llm_endpoint' }, intended: 'databricks-gpt-5' },
    ]);
    const plan = resolveApplyPlan({ intended, target: 'customer' });
    expect(Object.fromEntries(plan.knobs.map((knob) => [knob.envVar, knob.value]))).toMatchObject({
      PLAYER_INSIGHTS_LLM_GATEWAY: 'mlflow',
      PLAYER_INSIGHTS_LLM_GATEWAY_ENDPOINT: 'catalog.schema.gateway_model',
      PLAYER_INSIGHTS_LLM_ENDPOINT: 'databricks-gpt-5',
    });
    expect(plan.notes.join(' ')).toMatch(/mlflow.*catalog\.schema\.gateway_model/);
    expect(plan.notes.join(' ')).not.toMatch(/mlflow.*databricks-gpt-5/);
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
