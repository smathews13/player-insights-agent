import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { ExperimentalBadge } from './ExperimentalBadge';
import { astPill } from './astrolabe-pill';
import {
  calculateForecast,
  deriveForecastBaseline,
  normalizeForecastAssumptions,
  stepForecastAssumption,
  type ForecastAssumptions,
  type ForecastResult,
  type ForecastSuggestionEvidence,
} from './forecast';
import { persistForecastAssumptions, readForecastAssumptions } from './forecast-preferences';
import { Disclosure } from './page-chrome';
import { Input, Skeleton } from './ui';
import type { OpsCostPayload, OpsTrafficPayload } from '../../shared/ops-contract';
import type { CostBudgetUnit } from '../../shared/cost-budgets';

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
  step: number;
}> = [
  {
    key: 'averageDailyUsers',
    label: 'Average daily users',
    exampleUnit: 'users',
    step: 1,
  },
  {
    key: 'questionsPerUserPerDay',
    label: 'Questions per user per day',
    exampleUnit: 'questions/user/day',
    step: 0.1,
  },
  {
    key: 'activeAppMinutesPerUserPerDay',
    label: 'Active app minutes per user per day',
    unit: 'min',
    exampleUnit: 'min/user/day',
    step: 0.1,
  },
  {
    key: 'averageModelTokensPerQuestion',
    label: 'Average model tokens per question',
    unit: 'tokens',
    exampleUnit: 'tokens/question',
    step: 1,
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
          const inputId = `ops-forecast-${field.key}`;
          const value = assumptions[field.key];
          return (
            <div className="ops-forecast-assumption" key={field.key}>
              <label htmlFor={inputId}>{field.label}</label>
              <span className="ops-forecast-input-row">
                <span className="ops-forecast-number-control">
                  <Input
                    id={inputId}
                    type="number"
                    inputMode={field.step === 1 ? 'numeric' : 'decimal'}
                    min="0"
                    step={field.step}
                    value={value}
                    onChange={(event) => {
                      const next = event.target.valueAsNumber;
                      onChange(field.key, Number.isFinite(next) && next >= 0 ? next : 0);
                    }}
                  />
                  <span className="ops-forecast-steppers" role="group" aria-label={`${field.label} step controls`}>
                    <button
                      type="button"
                      aria-label={`Increase ${field.label.toLowerCase()}`}
                      aria-controls={inputId}
                      onClick={() => onChange(field.key, stepForecastAssumption(field.key, value, 1))}
                    >
                      <ChevronUp aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Decrease ${field.label.toLowerCase()}`}
                      aria-controls={inputId}
                      disabled={value <= 0}
                      onClick={() => onChange(field.key, stepForecastAssumption(field.key, value, -1))}
                    >
                      <ChevronDown aria-hidden="true" />
                    </button>
                  </span>
                </span>
                {field.unit ? <small>{field.unit}</small> : null}
              </span>
              <small className="ops-forecast-assumption-evidence">
                {exampleRangeText(field, examples[field.key], evidence[field.key])}
              </small>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function ProjectionBreakdown({
  result,
  currency,
  partial,
}: {
  result: ForecastResult;
  currency: string;
  partial: boolean;
}) {
  const complete =
    result.components.length > 0 &&
    result.horizons.every(
      (horizon) =>
        horizon.total !== null &&
        horizon.components.length === result.components.length &&
        result.components.every((component) => horizon.components.some((item) => item.id === component.id))
    );
  if (!complete) return null;

  return (
    <section className="ops-forecast-breakdown" aria-labelledby="ops-forecast-breakdown-heading">
      <h4 id="ops-forecast-breakdown-heading">Projected breakdown</h4>
      <div
        className="ops-forecast-breakdown-scroll"
        role="region"
        aria-label="Projected cost breakdown by horizon"
        tabIndex={0}
      >
        <table>
          <caption className="sr-only">
            Included forecast components for the next 7 days, next 30 days, and six months
          </caption>
          <thead>
            <tr>
              <th scope="col">Component</th>
              {result.horizons.map((horizon) => (
                <th scope="col" key={horizon.days}>
                  {horizon.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.components.map((component) => (
              <tr key={component.id}>
                <th scope="row">{component.label}</th>
                {result.horizons.map((horizon) => (
                  <td key={horizon.days}>
                    <span className="ast-num">
                      {money(horizon.components.find((item) => item.id === component.id)!.amount, currency)}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{partial ? 'Subtotal' : 'Total'}</th>
              {result.horizons.map((horizon) => (
                <td key={horizon.days}>
                  <span className="ast-num">{money(horizon.total!, currency)}</span>
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

export function ForecastingBody({
  cost,
  traffic,
  periodLabel = '7 days',
  unit = 'USD',
}: {
  cost: ForecastBlock<OpsCostPayload>;
  traffic: ForecastBlock<OpsTrafficPayload>;
  periodLabel?: string;
  unit?: CostBudgetUnit;
}) {
  const [saved, setSaved] = useState<ForecastAssumptions | null>(readForecastAssumptions);
  const baseline = deriveForecastBaseline(cost.data, traffic.data, unit);
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
            <ProjectionBreakdown result={result} currency={baseline.currency} partial={partial} />

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
