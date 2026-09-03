import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ADVISORY_RESOURCE_BUDGET_ENFORCEMENT,
  GATEWAY_USAGE_ATTRIBUTION_HOOKS,
} from '../../shared/ai-gateway-contract';

describe('Cost and Gateway enforcement contracts', () => {
  it('keeps advisory behavior in the contract without visible advisory copy', () => {
    const source = readFileSync(new URL('./CostBudgets.tsx', import.meta.url), 'utf8');
    expect(source).toContain('label="Monthly app budget"');
    expect(source).not.toMatch(/Advisory|advisory/);
    expect(ADVISORY_RESOURCE_BUDGET_ENFORCEMENT).toMatchObject({
      source: 'advisory-resource-budget',
      label: 'Advisory',
      blocksUsage: false,
      approximate: false,
    });
    expect(ADVISORY_RESOURCE_BUDGET_ENFORCEMENT.detail).toMatch(/resource budgets remain advisory/i);
  });

  it('keeps future usage attribution hooks disabled until scopes are known', () => {
    expect(GATEWAY_USAGE_ATTRIBUTION_HOOKS.map((hook) => hook.source)).toEqual([
      'system.ai_gateway.usage',
      'system.billing.usage',
      'external-model-spend',
    ]);
    expect(GATEWAY_USAGE_ATTRIBUTION_HOOKS.every((hook) => hook.enabled === false)).toBe(true);
    expect(GATEWAY_USAGE_ATTRIBUTION_HOOKS.find((hook) => hook.source === 'system.billing.usage')?.requires).toContain(
      'account_id'
    );
  });
});
