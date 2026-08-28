import { browserPreferenceStore, type PreferenceStore } from './experimental-features';
import { normalizeForecastAssumptions, type ForecastAssumptions } from './forecast';

export const FORECAST_ASSUMPTIONS_KEY = 'pia.experimental.forecasting-assumptions';

const FIELDS: Array<keyof ForecastAssumptions> = [
  'averageDailyUsers',
  'questionsPerUserPerDay',
  'activeAppMinutesPerUserPerDay',
  'averageModelTokensPerQuestion',
];

/** Read and normalize a saved scenario; obsolete pricing, table, and buffer fields are ignored. */
export function readForecastAssumptions(
  store: PreferenceStore | null = browserPreferenceStore()
): ForecastAssumptions | null {
  if (!store) return null;
  try {
    const parsed = JSON.parse(store.getItem(FORECAST_ASSUMPTIONS_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (
      !FIELDS.every(
        (field) => typeof record[field] === 'number' && Number.isFinite(record[field]) && record[field] >= 0
      )
    ) {
      return null;
    }
    return normalizeForecastAssumptions(record as Partial<ForecastAssumptions>);
  } catch {
    return null;
  }
}

/** Best-effort browser persistence. The current scenario still works when storage refuses. */
export function persistForecastAssumptions(
  assumptions: ForecastAssumptions,
  store: PreferenceStore | null = browserPreferenceStore()
): boolean {
  if (!store) return false;
  try {
    store.setItem(FORECAST_ASSUMPTIONS_KEY, JSON.stringify(normalizeForecastAssumptions(assumptions)));
    return true;
  } catch {
    return false;
  }
}
