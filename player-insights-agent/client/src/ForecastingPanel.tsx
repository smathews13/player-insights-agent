import { useState } from 'react';
import { ExperimentalBadge } from './ExperimentalBadge';
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

function methodologyEvidence(item: ForecastSuggestionEvidence): string {
  const range = item.range
    ? ` · ${item.range.label} ${item.range.min.toLocaleString()}–${item.range.max.toLocaleString()}`
    : '';
  return `${item.calculation}${item.period ? ` · ${item.period}` : ''}${range}`;
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
}: {
  cost: ForecastBlock<OpsCostPayload>;
  traffic: ForecastBlock<OpsTrafficPayload>;
}) {
  const [saved, setSaved] = useState<ForecastAssumptions | null>(readForecastAssumptions);
  const baseline = deriveForecastBaseline(cost.data, traffic.data);
  const assumptions = saved ?? baseline.defaults;
  const result = calculateForecast(baseline, assumptions);
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
          <span className="ops-block-meta">List-price scenario</span>
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
            <div className="ops-forecast-baseline">
              <p>
                <strong>Baseline:</strong> {baseline.window.from} to {baseline.window.to} ({baseline.window.days}{' '}
                complete {baseline.window.days === 1 ? 'day' : 'days'})
              </p>
              <p>
                <strong>Source:</strong> {baseline.source}
              </p>
              <p>List-price estimate only — not contracted rates, an invoice, a budget, or a commitment.</p>
            </div>

            {partial ? (
              <p className="ops-forecast-partial" role="status">
                Partial estimate: only priced, deployment-attributable components with a defensible denominator are
                summed.
              </p>
            ) : null}
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
              <div>
                <p>
                  Serving = daily stored questions × observed serving cost/stored question × assumed tokens ÷ observed
                  average tokens.
                </p>
                <p>Astrolabe SQL = daily stored questions × observed attributed SQL cost/stored question.</p>
                <p>App compute = users × active minutes/user/day × observed app cost/active minute.</p>
                <p>Vector Search = the configured resource’s measured daily Cost baseline, held fixed.</p>
                <p>Other attributable measured daily costs stay fixed.</p>
                <h5>Assumption baselines</h5>
                <ul>
                  {ASSUMPTION_FIELDS.map((field) => (
                    <li key={field.key}>
                      <strong>{field.label}:</strong> {methodologyEvidence(baseline.evidence[field.key])}
                    </li>
                  ))}
                </ul>
                {baseline.exclusions.length > 0 ? (
                  <>
                    <h5>Excluded from totals</h5>
                    <ul>
                      {baseline.exclusions.map((item) => (
                        <li key={`${item.component}-${item.reason}`}>
                          <strong>{item.component}:</strong> {item.reason}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <h5>Caveats</h5>
                <ul>
                  {baseline.caveats.map((caveat) => (
                    <li key={caveat}>{caveat}</li>
                  ))}
                </ul>
              </div>
            </Disclosure>
          </>
        )}
      </div>
    </section>
  );
}
