import { browserPreferenceStore, type PreferenceStore } from './experimental-features';
import type { ForecastAssumptions } from './forecast';

export const FORECAST_ASSUMPTIONS_KEY = 'pia.experimental.forecasting-assumptions';

const FIELDS: Array<keyof ForecastAssumptions> = [
  'averageDailyUsers',
  'questionsPerUserPerDay',
  'activeAppMinutesPerUserPerDay',
  'averageModelTokensPerQuestion',
  'governedTableCount',
  'vectorSearchCostPerTableDay',
  'contingencyPercent',
];

/** Read one complete, non-negative saved scenario; malformed or older shapes are ignored. */
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
    return {
      averageDailyUsers: record.averageDailyUsers as number,
      questionsPerUserPerDay: record.questionsPerUserPerDay as number,
      activeAppMinutesPerUserPerDay: record.activeAppMinutesPerUserPerDay as number,
      averageModelTokensPerQuestion: record.averageModelTokensPerQuestion as number,
      governedTableCount: record.governedTableCount as number,
      vectorSearchCostPerTableDay: record.vectorSearchCostPerTableDay as number,
      contingencyPercent: record.contingencyPercent as number,
    };
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
    store.setItem(FORECAST_ASSUMPTIONS_KEY, JSON.stringify(assumptions));
    return true;
  } catch {
    return false;
  }
}
