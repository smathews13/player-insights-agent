import { z } from 'zod';
import { EXPERIMENTAL_FEATURE_KEYS, NO_EXPERIMENTS } from './experimental-settings-browser';

export { EXPERIMENTAL_FEATURE_KEYS, NO_EXPERIMENTS };
export type { ExperimentalFeatures } from './experimental-settings-browser';

/**
 * Deployment-wide experimental surfaces an administrator has enabled.
 *
 * These flags decide which product surfaces the deployment offers. They are
 * therefore app-global Lakebase state, not a browser preference. Missing fields
 * default off without writing anything, so a later default change cannot rewrite
 * an administrator's explicit true or false.
 */
export const ExperimentalSettingsSchema = z.object({
  benchmarkLab: z.boolean().default(false),
  egressControls: z.boolean().default(false),
  forecasting: z.boolean().default(false),
});

export const ExperimentalSettingsPatchSchema = z.strictObject({
  benchmarkLab: z.boolean().optional(),
  egressControls: z.boolean().optional(),
  forecasting: z.boolean().optional(),
});
