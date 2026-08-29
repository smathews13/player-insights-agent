import { useState } from 'react';
import { ExperimentalBadge } from './ExperimentalBadge';
import { astPill } from './astrolabe-pill';
import {
  calculateForecast,
  deriveForecastBaseline,
  normalizeForecastAssumptions,
  type ForecastAssumptions,
  type ForecastSuggestionEvidence,
} from './forecast';
import { persistForecastAssumptions, readForecastAssumptions } from './forecast-preferences';
import { Disclosure } from './page-chrome';
import { Input, Skeleton } from './ui';
import type { OpsCostPayload, OpsTrafficPayload } from '../../shared/ops-contract';

interface ForecastBlock<T> {
  data: T | null;
  busy: boolean;
  failed: string;
}

const ASSUMPTION_FIELDS: Array<{
  key: keyof ForecastAssumptions;
  label: string;
  unit?: string;
  exampleUnit: string;
  step: string;
}> = [
  {
    key: 'averageDailyUsers',
    label: 'Average daily users',
    exampleUnit: 'users',
    step: '1',
  },
  {
    key: 'questionsPerUserPerDay',
    label: 'Questions per user per day',
    exampleUnit: 'questions/user/day',
    step: '0.1',
  },
  {
    key: 'activeAppMinutesPerUserPerDay',
    label: 'Active app minutes per user per day',
    unit: 'min',
    exampleUnit: 'min/user/day',
    step: '0.1',
  },
  {
    key: 'averageModelTokensPerQuestion',
    label: 'Average model tokens per question',
    unit: 'tokens',
    exampleUnit: 'tokens/question',
    step: '0.1',
  },
];

function money(amount: number, currency: string): string {
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function exampleBand(field: (typeof ASSUMPTION_FIELDS)[number], value: number, item: ForecastSuggestionEvidence) {
  if (item.range) return { min: item.range.min, max: item.range.max };
  const whole = field.key === 'averageDailyUsers' || field.key === 'averageModelTokensPerQuestion';
  const round = (candidate: number) => (whole ? Math.round(candidate) : Math.round(candidate * 10) / 10);
  return { min: round(value * 0.8), max: round(value * 1.2) };
}

function exampleRangeText(
  field: (typeof ASSUMPTION_FIELDS)[number],
  value: number,
  item: ForecastSuggestionEvidence
): string {
  const range = exampleBand(field, value, item);
  const whole = field.key === 'averageDailyUsers' || field.key === 'averageModelTokensPerQuestion';
  const formatted = (amount: number) =>
    amount.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: whole ? 0 : 1,
    });
  return `Example range: ${formatted(range.min)}–${formatted(range.max)} ${field.exampleUnit}`;
}

const VISIBLE_LIMITS = 3;

function formulaText(component: { id: string; formula: string }): string {
  if (component.id === 'serving-endpoint') {
    return 'Daily questions × observed serving cost per question × assumed-to-observed token ratio';
  }
  if (component.id === 'sql-warehouse') return 'Daily questions × observed attributed SQL cost per question';
  if (component.id === 'app-compute') {
    return 'Users × active minutes per user per day × observed app cost per active minute';
  }
  if (component.id === 'vector-search') return 'Measured daily spend, held fixed';
  return 'Measured attributable daily spend, held fixed';
}

function methodologyLimits(caveats: readonly string[], exclusions: readonly { reason: string }[]): string[] {
  const seen = new Set<string>();
  const activeMinuteExcluded = exclusions.some((item) => item.reason.toLowerCase().includes('active-minute'));
  return caveats.filter((caveat) => {
    const key = caveat.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) return false;
    if (key.includes('databricks list prices')) return false;
    if (activeMinuteExcluded && key.includes('active-minute')) return false;
    seen.add(key);
    return true;
  });
}

function AssumptionGrid({
  assumptions,
  examples,
  evidence,
  onChange,
}: {
  assumptions: ForecastAssumptions;
  examples: ForecastAssumptions;
  evidence: Record<keyof ForecastAssumptions, ForecastSuggestionEvidence>;
  onChange: (field: keyof ForecastAssumptions, value: number) => void;
}) {
  return (
    <fieldset className="ops-forecast-assumptions">
      <legend>Assumptions</legend>
      <div className="ops-forecast-assumption-grid">
        {ASSUMPTION_FIELDS.map((field) => {
          return (
            <label key={field.key}>
              <span>{field.label}</span>
              <span className="ops-forecast-input-row">
                <Input
                  type="number"
                  min="0"
                  step={field.step}
                  value={assumptions[field.key]}
                  onChange={(event) => {
                    const next = event.target.valueAsNumber;
                    onChange(field.key, Number.isFinite(next) && next >= 0 ? next : 0);
                  }}
                />
                {field.unit ? <small>{field.unit}</small> : null}
              </span>
              <small className="ops-forecast-assumption-evidence">
                {exampleRangeText(field, examples[field.key], evidence[field.key])}
              </small>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ForecastingBody({
  cost,
  traffic,
  periodLabel = '7 days',
}: {
  cost: ForecastBlock<OpsCostPayload>;
  traffic: ForecastBlock<OpsTrafficPayload>;
  periodLabel?: string;
}) {
  const [saved, setSaved] = useState<ForecastAssumptions | null>(readForecastAssumptions);
  const baseline = deriveForecastBaseline(cost.data, traffic.data);
  const assumptions = saved ?? baseline.defaults;
  const result = calculateForecast(baseline, assumptions);
  const limits = methodologyLimits(baseline.caveats, baseline.exclusions);
  const unavailable =
    cost.failed && !cost.data
      ? `Cost could not be read: ${cost.failed}`
      : cost.data
        ? baseline.unavailableReason
        : cost.busy
          ? ''
          : baseline.unavailableReason;
  const waiting = !unavailable && ((cost.busy && !cost.data) || (traffic.busy && !traffic.data && !traffic.failed));
  const partial =
    baseline.exclusions.length > 0 ||
    baseline.caveats.some((caveat) => caveat.toLowerCase().includes('partial')) ||
    Boolean(traffic.failed || traffic.data?.unread);

  const update = (field: keyof ForecastAssumptions, value: number) => {
    const next = normalizeForecastAssumptions({ ...assumptions, [field]: value });
    setSaved(next);
    persistForecastAssumptions(next);
  };

  return (
    <section className="ops-block ops-forecast" aria-labelledby="ops-forecast-heading" data-testid="ops-forecasting">
      <div className="ops-block-head">
        <div className="ops-block-head-text">
          <ExperimentalBadge />
          <h3 id="ops-forecast-heading">Forecasting</h3>
          <span className={astPill('neutral-outline', 'ops-pill ops-period-pill')}>{periodLabel}</span>
        </div>
      </div>
      <div className="ops-block-body">
        {waiting ? (
          <Skeleton className="ops-skeleton" />
        ) : unavailable ? (
          <div className="ops-absence" role="status">
            <p className="ops-absence-title">Forecast unavailable</p>
            <p className="ops-absence-body">{unavailable}</p>
            <p className="ops-forecast-caveat">
              No unavailable, shared, withheld, or unpriced component is treated as zero.
            </p>
          </div>
        ) : (
          <>
            {traffic.failed ? (
              <p className="ops-forecast-partial" role="status">
                Traffic refresh failed; the last available payload is used where present. {traffic.failed}
              </p>
            ) : null}

            <AssumptionGrid
              assumptions={assumptions}
              examples={baseline.defaults}
              evidence={baseline.evidence}
              onChange={update}
            />
            <div className="ops-forecast-horizons">
              {result.horizons.map((horizon) => (
                <article key={horizon.days} className="ops-forecast-horizon">
                  <h4>{horizon.label}</h4>
                  {horizon.total === null ? (
                    <p className="ops-tile-absent">No priced component can be projected.</p>
                  ) : (
                    <>
                      <p className="ops-forecast-total">
                        <span className="ast-num">{money(horizon.total, baseline.currency)}</span>
                        <span>{partial ? 'estimated subtotal' : 'estimated total'}</span>
                      </p>
                    </>
                  )}
                </article>
              ))}
            </div>

            <Disclosure summary="Methodology, formulas, and exclusions" className="ops-forecast-method">
              <div className="ops-forecast-method-sections">
                <section>
                  <h5>How totals are calculated</h5>
                  <dl className="ops-forecast-formulas">
                    {result.components.map((component) => (
                      <div key={component.id}>
                        <dt>{component.label}</dt>
                        <dd>{formulaText(component)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
                {baseline.exclusions.length > 0 ? (
                  <section>
                    <h5>Not included</h5>
                    <ul className="ops-forecast-not-included">
                      {baseline.exclusions.map((item) => (
                        <li key={`${item.component}-${item.reason}`}>
                          <strong>{item.component}</strong>
                          <span>{item.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {limits.length > 0 ? (
                  <section>
                    <h5>Limits</h5>
                    <ul className="ops-forecast-limits">
                      {limits.slice(0, VISIBLE_LIMITS).map((limit) => (
                        <li key={limit}>{limit}</li>
                      ))}
                    </ul>
                    {limits.length > VISIBLE_LIMITS ? (
                      <details className="ops-forecast-more-limits">
                        <summary>{limits.length - VISIBLE_LIMITS} more</summary>
                        <ul>
                          {limits.slice(VISIBLE_LIMITS).map((limit) => (
                            <li key={limit}>{limit}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </section>
                ) : null}
              </div>
            </Disclosure>
          </>
        )}
      </div>
    </section>
  );
}
