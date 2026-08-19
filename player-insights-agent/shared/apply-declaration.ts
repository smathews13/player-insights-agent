/**
 * What Apply would promote into a new model version.
 *
 * Mirrors `agent/apply_from_declaration.py`. The Python module is authoritative
 * for the CLI; this copy powers the Connections Apply panel and
 * `/api/settings/apply` so the app can show the same plan without shelling out.
 *
 * Keep the applyable-key set and precedence in step with the Python file. The
 * test beside this module asserts the overlap that matters for the UI.
 */
import { CONNECTED_RESOURCES } from './deployment-config';
import { declarationFlow, type NotebookDeclaration } from './notebook-declaration';

/** Agent field -> PLAYER_INSIGHTS_* env var, matching agent/config.py ENV_VARS. */
export const APPLY_ENV_VARS: Record<string, string> = {
  catalog: 'PLAYER_INSIGHTS_CATALOG',
  schema: 'PLAYER_INSIGHTS_SCHEMA',
  warehouse_id: 'PLAYER_INSIGHTS_WAREHOUSE_ID',
  data_genie_space_id: 'PLAYER_INSIGHTS_DATA_GENIE_ID',
  dictionary_genie_space_id: 'PLAYER_INSIGHTS_DICTIONARY_GENIE_ID',
  llm_endpoint: 'PLAYER_INSIGHTS_LLM_ENDPOINT',
  llm_gateway: 'PLAYER_INSIGHTS_LLM_GATEWAY',
  catalog_allowlist: 'PLAYER_INSIGHTS_CATALOG_ALLOWLIST',
  catalog_denylist: 'PLAYER_INSIGHTS_CATALOG_DENYLIST',
  max_output_tokens: 'PLAYER_INSIGHTS_MAX_OUTPUT_TOKENS',
};

export const APPLYABLE_KEYS = new Set(Object.keys(APPLY_ENV_VARS));

/** Notebook may publish this; Apply never takes it from a declaration. */
export const NOTEBOOK_REFUSED_KEYS = new Set(['catalog_allowlist']);

export type ApplySource = 'intended' | 'notebook';

export interface ApplyKnob {
  key: string;
  label: string;
  value: string;
  source: ApplySource;
  envVar: string;
}

export interface ApplyPlan {
  knobs: ApplyKnob[];
  notes: string[];
  /** Exact command for a deployer / notebook cell. */
  command: string;
  /** Whether anything is waiting on a re-log. */
  hasOverrides: boolean;
}

const LABELS: Record<string, string> = Object.fromEntries(
  CONNECTED_RESOURCES.filter((resource) => resource.agentKey).map((resource) => [
    resource.agentKey as string,
    resource.label,
  ])
);

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

/** agentKey -> intended value from `/api/settings` resources[]. */
export function intendedFromResources(
  resources: Array<{ resource?: { agentKey?: string | null }; intended?: string | null }> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of resources ?? []) {
    const key = entry.resource?.agentKey;
    const intended = text(entry.intended);
    if (!key || !intended || !APPLYABLE_KEYS.has(key)) continue;
    out[key] = intended;
  }
  return out;
}

/** Settings map from a parsed notebook declaration. */
export function settingsFromDeclaration(declaration: NotebookDeclaration | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!declaration) return out;
  for (const setting of declaration.settings) {
    const key = text(setting.key);
    const value = text(setting.value);
    if (!key || !value) continue;
    if (NOTEBOOK_REFUSED_KEYS.has(key)) continue;
    if (!APPLYABLE_KEYS.has(key)) continue;
    if (declarationFlow(key) === 'refused') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Merge Lakebase intended over notebook. Baseline is omitted: the release script
 * already owns the bundle target.
 */
export function resolveApplyPlan(input: {
  intended?: Record<string, string>;
  notebook?: Record<string, string>;
  target?: string;
}): ApplyPlan {
  const intended = input.intended ?? {};
  const notebook = input.notebook ?? {};
  const knobs: ApplyKnob[] = [];
  const notes: string[] = [];

  for (const key of [...APPLYABLE_KEYS].sort()) {
    const envVar = APPLY_ENV_VARS[key];
    if (!envVar) continue;
    if (intended[key]) {
      knobs.push({
        key,
        label: LABELS[key] ?? key,
        value: intended[key],
        source: 'intended',
        envVar,
      });
      continue;
    }
    if (notebook[key]) {
      knobs.push({
        key,
        label: LABELS[key] ?? key,
        value: notebook[key],
        source: 'notebook',
        envVar,
      });
    }
  }

  if (knobs.some((knob) => knob.key === 'catalog_allowlist' && knob.source === 'intended')) {
    notes.push(
      'Readable scopes were staged by an administrator. If the new list is wider than the live model, the release needs an explicit widen approval.'
    );
  }
  if (knobs.some((knob) => knob.source === 'notebook') && !knobs.some((knob) => knob.source === 'intended')) {
    notes.push(
      'Values come from the notebook declaration. Intended settings on Connections override the notebook when both name the same key.'
    );
  }
  if (knobs.length === 0) {
    notes.push(
      'Nothing is waiting on a new model version from Connections or the notebook. Soft settings that apply immediately are not listed here.'
    );
  }

  const target = text(input.target) || '<your-target>';
  return {
    knobs,
    notes,
    hasOverrides: knobs.length > 0,
    command: `TARGET=${target} bundle/apply-declaration.sh --apply --i-am-deploying`,
  };
}
