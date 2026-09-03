import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { ExperimentalBadge } from './ExperimentalBadge';
import { astPill } from './astrolabe-pill';
import {
  calculateForecast,
  deriveForecastBaseline,
  normalizeForecastAssumptions,
  type ForecastAssumptions,
  type ForecastResult,
  type ForecastSuggestionEvidence,
} from './forecast';
import { persistForecastAssumptions, readForecastAssumptions } from './forecast-preferences';
import { MethodologySections, type MethodologyGroup } from './MethodologySection';
import { NumberTicker, TickerAssumptionField, TickerAssumptionGrid, tickerNumber } from './NumberTicker';
import { Disclosure } from './page-chrome';
import { Skeleton } from './ui';
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

function formulaText(component: { id: string; formula: string }): string {
  if (component.id === 'serving-endpoint') {
    return component.formula.includes('marginal')
      ? 'Daily questions × observed marginal serving cost per question'
      : 'Daily questions × observed serving cost per question × assumed-to-observed token ratio';
  }
  if (component.id === 'foundation-model') {
    return 'Daily questions × observed token cost per question × assumed-to-observed token ratio';
  }
  if (component.id === 'sql-warehouse') return 'Daily questions × observed attributed SQL cost per question';
  if (component.id === 'app-compute') return 'Measured app-compute daily billing rate, held fixed';
  if (component.id === 'vector-search') return 'Measured daily spend, held fixed';
  return 'Measured attributable daily spend, held fixed';
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
    <TickerAssumptionGrid columns={ASSUMPTION_FIELDS.length} legend="Assumptions">
      {ASSUMPTION_FIELDS.map((field) => {
        const inputId = `ops-forecast-${field.key}`;
        const value = assumptions[field.key];
        return (
          <TickerAssumptionField
            key={field.key}
            id={inputId}
            label={field.label}
            unit={field.unit}
            helper={exampleRangeText(field, examples[field.key], evidence[field.key])}
          >
            <NumberTicker
              id={inputId}
              label={field.label}
              step={field.step}
              min={0}
              precision={field.step === 1 ? 0 : 1}
              value={String(value)}
              onChange={(raw) => {
                const next = tickerNumber(raw);
                if (next.valid && next.value !== null) onChange(field.key, next.value);
              }}
            />
          </TickerAssumptionField>
        );
      })}
    </TickerAssumptionGrid>
  );
}

export function ProjectionBreakdown({
  result,
  currency,
  partial,
  open,
  onToggle,
}: {
  result: ForecastResult;
  currency: string;
  partial: boolean;
  open: boolean;
  onToggle: () => void;
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
    <section className="ops-forecast-breakdown">
      <button
        type="button"
        className="ops-forecast-breakdown-trigger"
        aria-expanded={open}
        aria-controls="ops-forecast-breakdown-table"
        onClick={onToggle}
      >
        <span className="ops-forecast-breakdown-label">Projection breakdown</span>
        <span className="ops-forecast-breakdown-actions">
          <span className={astPill('neutral-outline', 'ops-pill')}>Estimated</span>
          <ChevronRight className="ops-forecast-breakdown-chevron" aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div
          id="ops-forecast-breakdown-table"
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
                  {result.horizons.map((horizon) => {
                    const projected = horizon.components.find((item) => item.id === component.id)!;
                    return (
                      <td key={horizon.days}>
                        {projected.amount === null ? (
                          <span className="ops-when-absent" title={projected.unavailable}>
                            Unavailable
                          </span>
                        ) : (
                          <span className="ast-num">{money(projected.amount, currency)}</span>
                        )}
                      </td>
                    );
                  })}
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
      ) : null}
    </section>
  );
}

export function ForecastingBody({
  cost,
  traffic,
  unit = 'USD',
}: {
  cost: ForecastBlock<OpsCostPayload>;
  traffic: ForecastBlock<OpsTrafficPayload>;
  unit?: CostBudgetUnit;
}) {
  const [saved, setSaved] = useState<ForecastAssumptions | null>(readForecastAssumptions);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const baseline = deriveForecastBaseline(cost.data, traffic.data, unit);
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
    result.components.some((component) => component.dailyAmount === null) ||
    baseline.caveats.some((caveat) => caveat.toLowerCase().includes('partial')) ||
    Boolean(traffic.failed || traffic.data?.unread);

  const update = (field: keyof ForecastAssumptions, value: number) => {
    const next = normalizeForecastAssumptions({ ...assumptions, [field]: value });
    setSaved(next);
    persistForecastAssumptions(next);
  };
  const methodologyGroups: MethodologyGroup[] = [
    {
      title: 'How totals are calculated',
      rows: [
        {
          label: 'Observed baseline',
          detail: `${baseline.window.from}–${baseline.window.to} (current calendar month)`,
        },
        ...result.components.map((component) => ({
          label: component.label,
          detail: formulaText(component),
        })),
      ],
    },
  ];

  return (
    <section className="ops-block ops-forecast" aria-labelledby="ops-forecast-heading" data-testid="ops-forecasting">
      <div className="ops-block-head">
        <div className="ops-block-head-text">
          <span className="ops-block-title-group">
            <h3 id="ops-forecast-heading">Cost Forecasting</h3>
            <ExperimentalBadge />
          </span>
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
                  <div className="ops-forecast-card-head">
                    <h4>{horizon.label}</h4>
                    <span className={astPill('neutral-outline', 'ops-pill')}>Estimated</span>
                  </div>
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
            <ProjectionBreakdown
              result={result}
              currency={baseline.currency}
              partial={partial}
              open={breakdownOpen}
              onToggle={() => setBreakdownOpen((current) => !current)}
            />

            <Disclosure summary="Methodology, formulas, and exclusions" className="ops-forecast-method">
              <MethodologySections groups={methodologyGroups} />
            </Disclosure>
          </>
        )}
      </div>
    </section>
  );
}
