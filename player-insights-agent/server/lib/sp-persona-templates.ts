import { z } from 'zod';
import { DEFAULT_SP_PERSONA_TEMPLATES } from '../../shared/default-sp-persona-templates';
import {
  SP_PERSONA_TEMPLATES_ENV,
  SpPersonaTemplatesSchema,
  type SpPersonaTemplate,
} from '../../shared/sp-persona-templates';

const DefaultTemplates = SpPersonaTemplatesSchema.parse(DEFAULT_SP_PERSONA_TEMPLATES);
const SpPersonaTemplateOverrideSchema = z.union([
  SpPersonaTemplatesSchema,
  z
    .object({
      mode: z.enum(['replace', 'extend']),
      templates: SpPersonaTemplatesSchema,
    })
    .strict(),
]);

export interface SpPersonaTemplateConfig {
  templates: SpPersonaTemplate[];
  warning: string | null;
}

/**
 * No override returns the public product defaults. A legacy top-level array or
 * `{mode:"replace"}` replaces them. `{mode:"extend"}` appends only new IDs;
 * collisions are rejected rather than silently shadowing a product template.
 *
 * Invalid JSON, contracts, or extension collisions fail closed as a whole. The
 * warning is safe for an administrator: it contains no raw config or values.
 */
export function parseSpPersonaTemplates(raw: string | undefined | null): SpPersonaTemplateConfig {
  if (!raw?.trim()) return { templates: DefaultTemplates, warning: null };
  try {
    const parsed = SpPersonaTemplateOverrideSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      if (Array.isArray(parsed.data)) return { templates: parsed.data, warning: null };
      if (parsed.data.mode === 'replace') return { templates: parsed.data.templates, warning: null };
      const defaultIds = new Set(DefaultTemplates.map((template) => template.id));
      if (parsed.data.templates.some((template) => defaultIds.has(template.id)))
        throw new Error('Template id collision.');
      const extended = SpPersonaTemplatesSchema.safeParse([...DefaultTemplates, ...parsed.data.templates]);
      if (extended.success) return { templates: extended.data, warning: null };
    }
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
