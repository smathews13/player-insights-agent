import {
  SP_PERSONA_TEMPLATES_ENV,
  SpPersonaTemplatesSchema,
  type SpPersonaTemplate,
} from '../../shared/sp-persona-templates';

export interface SpPersonaTemplateConfig {
  templates: SpPersonaTemplate[];
  warning: string | null;
}

/**
 * Deployment-owned examples only. Invalid JSON or an invalid grant contract is
 * ignored as a whole so a typo cannot stage a partially trusted permission plan.
 * The warning is safe for an administrator: it contains no raw config or values.
 */
export function parseSpPersonaTemplates(raw: string | undefined | null): SpPersonaTemplateConfig {
  if (!raw?.trim()) return { templates: [], warning: null };
  try {
    const parsed = SpPersonaTemplatesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { templates: parsed.data, warning: null };
  } catch {
    // The same safe warning covers malformed JSON and a malformed contract.
  }
  return {
    templates: [],
    warning: 'Example profiles are unavailable because this deployment configured an invalid template contract.',
  };
}

export function configuredSpPersonaTemplates(env: NodeJS.ProcessEnv = process.env): SpPersonaTemplateConfig {
  return parseSpPersonaTemplates(env[SP_PERSONA_TEMPLATES_ENV]);
}
