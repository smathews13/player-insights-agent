import { useState } from 'react';
import { ExperimentalBadge } from './ExperimentalBadge';
import { calculateForecast, deriveForecastBaseline, type ForecastAssumptions } from './forecast';
import { persistForecastAssumptions, readForecastAssumptions } from './forecast-preferences';
import { Disclosure } from './page-chrome';
import { Button, Input, Skeleton } from './ui';
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
  step: string;
}> = [
  { key: 'averageDailyUsers', label: 'Average daily users', step: '0.1' },
  { key: 'questionsPerUserPerDay', label: 'Questions per user per day', step: '0.1' },
  { key: 'activeAppMinutesPerUserPerDay', label: 'Active app minutes per user per day', unit: 'min', step: '0.1' },
  { key: 'averageModelTokensPerQuestion', label: 'Average model tokens per question', unit: 'tokens', step: '1' },
  { key: 'governedTableCount', label: 'Governed table count', unit: 'tables', step: '1' },
  {
    key: 'vectorSearchCostPerTableDay',
    label: 'Vector Search cost per table per day',
    unit: 'list price',
    step: '0.01',
  },
  { key: 'contingencyPercent', label: 'Contingency percentage', unit: '%', step: '1' },
];

function money(amount: number, currency: string): string {
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function AssumptionGrid({
  assumptions,
  currency,
  onChange,
}: {
  assumptions: ForecastAssumptions;
  currency: string;
  onChange: (field: keyof ForecastAssumptions, value: number) => void;
}) {
  return (
    <fieldset className="ops-forecast-assumptions">
      <legend>Assumptions</legend>
      <div className="ops-forecast-assumption-grid">
        {ASSUMPTION_FIELDS.map((field) => {
          const unit = field.key === 'vectorSearchCostPerTableDay' ? `${currency} ${field.unit}` : field.unit;
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
                {unit ? <small>{unit}</small> : null}
              </span>
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
    const next = { ...assumptions, [field]: value };
    setSaved(next);
    persistForecastAssumptions(next);
  };

  return (
    <section className="ops-block ops-forecast" aria-labelledby="ops-forecast-heading" data-testid="ops-forecasting">
      <div className="ops-block-head">
        <div className="ops-block-head-text">
          <h3 id="ops-forecast-heading">Forecasting</h3>
          <ExperimentalBadge />
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

            <AssumptionGrid assumptions={assumptions} currency={baseline.currency} onChange={update} />
            <div className="ops-forecast-actions">
              <span>
                Daily questions = {assumptions.averageDailyUsers} × {assumptions.questionsPerUserPerDay} ={' '}
                {result.dailyQuestions.toLocaleString('en-US', { maximumFractionDigits: 2 })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSaved(baseline.defaults);
                  persistForecastAssumptions(baseline.defaults);
                }}
              >
                Use observed defaults
              </Button>
            </div>

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
                        <span>estimated total</span>
                      </p>
                      <ul>
                        {horizon.components.map((component) => (
                          <li key={component.id}>
                            <span>{component.label}</span>
                            <span className="ast-num">{money(component.amount, baseline.currency)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </article>
              ))}
            </div>

            <Disclosure summary="Methodology, formulas, and exclusions" className="ops-forecast-method">
              <div>
                <p>Daily questions = users × questions per user per day.</p>
                <p>
                  Serving = daily stored questions × observed serving cost/stored question × assumed tokens ÷ observed
                  average tokens.
                </p>
                <p>Astrolabe SQL = daily stored questions × observed attributed SQL cost/stored question.</p>
                <p>App compute = users × active minutes/user/day × observed app cost/active minute.</p>
                <p>Vector Search = governed table count × editable cost/table/day.</p>
                <p>Other attributable measured daily costs stay fixed. Contingency is applied last.</p>
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
