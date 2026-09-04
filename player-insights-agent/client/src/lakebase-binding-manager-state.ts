import type { LakebaseRedeployPlan } from '../../shared/lakebase-binding';

export function lakebaseBindingDraft(plan: LakebaseRedeployPlan): string {
  return plan.desired?.database || plan.active.database;
}

export function canStageLakebaseBinding(plan: LakebaseRedeployPlan, draft: string): boolean {
  const candidate = draft.trim();
  return Boolean(candidate && candidate !== lakebaseBindingDraft(plan).trim());
}
