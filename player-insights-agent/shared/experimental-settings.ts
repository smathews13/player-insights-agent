import { z } from 'zod';
import { EXPERIMENTAL_FEATURE_KEYS, NO_EXPERIMENTS } from './experimental-settings-browser';

export { EXPERIMENTAL_FEATURE_KEYS, NO_EXPERIMENTS };
export type { ExperimentalFeatures } from './experimental-settings-browser';

/**
 * Deployment-wide experimental surfaces an administrator has enabled.
 *
 * These flags decide which product surfaces the deployment offers. They are
 * therefore app-global Lakebase state, not a browser preference. Missing fields
 * default without writing anything, so a later default change cannot rewrite
 * an administrator's explicit true or false. Every surface defaults off except
 * the AI Gateway route, which defaults on; the store keeps that choice under
 * its own key (see experimental-settings-store.ts).
 */
export const ExperimentalSettingsSchema = z.object({
  aiGateway: z.boolean().default(true),
  benchmarkLab: z.boolean().default(false),
  contractObservatory: z.boolean().default(false),
  egressControls: z.boolean().default(false),
  forecasting: z.boolean().default(false),
  genieCodeMcp: z.boolean().default(false),
  notebookAgentSync: z.boolean().default(false),
});

export const ExperimentalSettingsPatchSchema = z.strictObject({
  aiGateway: z.boolean().optional(),
  benchmarkLab: z.boolean().optional(),
  contractObservatory: z.boolean().optional(),
  egressControls: z.boolean().optional(),
  forecasting: z.boolean().optional(),
  genieCodeMcp: z.boolean().optional(),
  notebookAgentSync: z.boolean().optional(),
});
