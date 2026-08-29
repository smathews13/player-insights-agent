import { z } from 'zod';
import {
  SP_GRANT_ACTIONS,
  SP_GRANT_MATRIX,
  SP_GRANT_RESOURCE_TYPES,
  type SpGrant,
  type SpGrantAction,
  type SpGrantResourceType,
} from './sp-identity';

export const SP_PERSONA_TEMPLATES_ENV = 'PLAYER_INSIGHTS_PERSONA_TEMPLATES';

const TEXT_MAX = 280;
const LIST_MAX = 12;
const GRANT_INTENT_MAX = 24;
const VARIANT_MAX = 4;
const EXAMPLE_PROFILE_ACTIONS = new Set<SpGrantAction>(['READ', 'USE', 'VIEW', 'EXECUTE']);

const SummaryListSchema = z.array(z.string().trim().min(1).max(TEXT_MAX)).max(LIST_MAX);
const SpGrantResourceTypeSchema = z.enum(SP_GRANT_RESOURCE_TYPES);
const SpGrantActionSchema = z.enum(SP_GRANT_ACTIONS);

export const SpPersonaResourceSelectorSchema = z
  .object({
    match: z.enum(['single', 'all']).default('single'),
    sources: z
      .array(z.enum(['configured', 'declared']))
      .min(1)
      .max(2)
      .optional(),
    labels: z.array(z.string().trim().min(1).max(120)).min(1).max(12).optional(),
    ids: z.array(z.string().trim().min(1).max(255)).min(1).max(24).optional(),
    idSuffixes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(255)
          .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
      )
      .min(1)
      .max(24)
      .optional(),
    labelSegments: z
      .array(
        z
          .string()
          .trim()
          .min(2)
          .max(80)
          .regex(/^[A-Za-z0-9_-]+$/)
      )
      .min(1)
      .max(12)
      .optional(),
    choiceLabel: z.string().trim().min(1).max(120),
  })
  .strict()
  .superRefine((selector, context) => {
    if (
      selector.match === 'all' &&
      !selector.labels &&
      !selector.ids &&
      !selector.idSuffixes &&
      !selector.labelSegments
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An all-resources selector must use an exact or bounded resource constraint.',
      });
    }
  });

export const SpPersonaGrantIntentSchema = z
  .object({
    resourceType: SpGrantResourceTypeSchema,
    action: SpGrantActionSchema,
    privilege: z.string().trim().min(1).max(64),
    selector: SpPersonaResourceSelectorSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    const option = SP_GRANT_MATRIX[intent.resourceType].options.find((candidate) => candidate.action === intent.action);
    if (!option) {
      context.addIssue({
        code: 'custom',
        path: ['action'],
        message: `${intent.action} is not valid for ${SP_GRANT_MATRIX[intent.resourceType].label}.`,
      });
    } else if (intent.privilege !== option.privilege) {
      context.addIssue({
        code: 'custom',
        path: ['privilege'],
        message: `${intent.action} maps to ${option.privilege}.`,
      });
    }
  });

export const SpPersonaTemplateVariantSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(TEXT_MAX),
    leastPrivilege: z.boolean(),
    grants: z.array(SpPersonaGrantIntentSchema).min(1).max(GRANT_INTENT_MAX),
  })
  .strict()
  .superRefine((variant, context) => {
    variant.grants.forEach((grant, index) => {
      if (!EXAMPLE_PROFILE_ACTIONS.has(grant.action)) {
        context.addIssue({
          code: 'custom',
          path: ['grants', index, 'action'],
          message: 'Example profiles may request only read, use, view, or execute access.',
        });
      }
    });
  });

export const SpPersonaTemplateSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    displayName: z.string().trim().min(1).max(120),
    roleSummary: z.string().trim().min(1).max(TEXT_MAX),
    purpose: z.string().trim().min(1).max(TEXT_MAX),
    duties: SummaryListSchema.min(1),
    dataBoundaries: SummaryListSchema.min(1),
    exclusions: SummaryListSchema.min(1),
    keyCapabilities: SummaryListSchema.min(1).max(6),
    variants: z.array(SpPersonaTemplateVariantSchema).min(1).max(VARIANT_MAX),
  })
  .strict()
  .superRefine((template, context) => {
    if (template.variants.filter((variant) => variant.leastPrivilege).length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['variants'],
        message: 'Each profile must have exactly one least-privilege variant.',
      });
    }
    if (new Set(template.variants.map((variant) => variant.id)).size !== template.variants.length) {
      context.addIssue({ code: 'custom', path: ['variants'], message: 'Variant ids must be unique.' });
    }
  });

export const SpPersonaTemplatesSchema = z
  .array(SpPersonaTemplateSchema)
  .max(12)
  .refine((templates) => new Set(templates.map((template) => template.id)).size === templates.length, {
    message: 'Profile ids must be unique.',
  });

export type SpPersonaResourceSelector = z.infer<typeof SpPersonaResourceSelectorSchema>;
export type SpPersonaGrantIntent = z.infer<typeof SpPersonaGrantIntentSchema>;
export type SpPersonaTemplateVariant = z.infer<typeof SpPersonaTemplateVariantSchema>;
export type SpPersonaTemplate = z.infer<typeof SpPersonaTemplateSchema>;

export interface SpPersonaTemplateUnresolved {
  rowId: string;
  resourceType: SpGrantResourceType;
  choiceLabel: string;
  candidateCount: number;
  reason: 'selection' | 'overflow';
  selectableCount?: number;
}

export interface SpPersonaTemplateOverflow {
  rowId: string;
  choiceLabel: string;
  candidateCount: number;
  selectableCount: number;
  requiredGrantCount: number;
  grantLimit: number;
  overflowCount: number;
}

export interface ResolvedSpPersonaTemplate {
  grants: SpGrant[];
  rowIds: string[];
  unresolved: SpPersonaTemplateUnresolved[];
  overflow: SpPersonaTemplateOverflow[];
}

export function canonicalTemplateGrant(
  resourceType: SpGrantResourceType,
  resource: string,
  action: SpGrantAction,
  privilege: string
): SpGrant {
  return { resourceType, resource, action, privilege };
}
