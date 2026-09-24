import type { AppSpendFigure, CostBriefPayload, CostBriefResource } from '../../shared/ops-contract';
import { opsRangeDates } from '../../shared/ops-contract';

/**
 * The trailing-31-day cost brief rendered to Markdown, for the PDF export.
 *
 * The PDF writer (`export-binary.ts`) takes Markdown, so this is the one
 * serialisation the brief needs. It walks the same shape the `/api/ops/cost/brief`
 * endpoint returns and prints only reader-facing figures — the same
 * attributed/standing methodology the on-screen Cost block uses, over a different
 * (trailing-31-complete-day) window. Amounts format in `en-US` so the document and
 * its test read the same regardless of the runner's locale.
 */

const DAY_MS = 86_400_000;

/**
 * Planning assumption for the second, lightly used production deployment.
 *
 * No production traffic baseline exists in the product requirements or tests.
 * Fifteen percent is therefore an intentionally round scenario for “a few
 * intermittent tester questions” beside the observed development testing
 * apparatus. It is disclosed in the export and must never be described as
 * measured spend. Standing cost is not reduced: hosting a second app duplicates
 * every measured fixed/idle remainder in full.
 */
export const PROD_VARIABLE_USAGE_FACTOR = 0.15;

export interface DevProdProjectionResource {
  id: string;
  label: string;
  quality: CostBriefResource['quality'];
  devObserved: number | null;
  devStanding: number | null;
  devVariable: number | null;
  prodProjected: number | null;
  prodStanding: number | null;
  prodVariable: number | null;
  combined: number | null;
}

export interface DevProdProjection {
  currency: string;
  variableUsageFactor: number;
  devObserved: number | null;
  devStanding: number | null;
  devVariable: number | null;
  prodProjected: number | null;
  combined: number | null;
  resources: DevProdProjectionResource[];
}

export interface CostBriefExportView {
  total: number | null;
  standing: number | null;
  attributed: number | null;
  resources: CostBriefResource[];
}

function completeDays(range: CostBriefPayload['range']): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round((to - from) / DAY_MS) + 1 : 0;
}

function decimal(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A currency amount, or '—' when it could not be sourced. */
function money(value: number | null | undefined, currency: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return currency ? `${decimal(value)} ${currency}` : decimal(value);
}

/** A headline spend figure: its dollar amount, else its DBU amount, else a word. */
function figureText(figure: AppSpendFigure): string {
  if (typeof figure.amount === 'number' && Number.isFinite(figure.amount)) {
    const base = money(figure.amount, figure.currency);
    return figure.completeness === 'complete' && !figure.estimated ? base : `${base} (estimated)`;
  }
  if (typeof figure.dbus === 'number' && Number.isFinite(figure.dbus)) {
    return `${decimal(figure.dbus)} DBU`;
  }
  return 'Unavailable';
}

function resourceRow(resource: CostBriefResource, currency: string): string {
  const escape = (value: string) => value.replaceAll('|', '\\|');
  return `| ${escape(resource.label)} | ${escape(resource.population)} | ${money(resource.amount, currency)} | ${money(
    resource.standingAmount,
    currency
  )} | ${escape(resource.quality)} |`;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function reconciledBreakdown(
  total: number | null,
  attributed: number | null,
  standing: number | null
): { attributed: number | null; standing: number | null } {
  if (!finite(total)) return { attributed, standing };
  if (finite(attributed)) {
    const residual = Math.round(Math.max(0, total - attributed) * 1_000_000) / 1_000_000;
    if (!finite(standing) || Math.abs(attributed + standing - total) > 0.01) {
      return { attributed, standing: residual };
    }
  }
  if (finite(standing) && !finite(attributed)) return { attributed: Math.max(0, total - standing), standing };
  return { attributed, standing };
}

/**
 * Frontend export guard for the component that is intentionally absent from
 * every customer-facing cost view. The API can still include `vector-search`
 * while backend tracking is being removed, so filtering only its row would
 * leave its spend hidden inside the headline. Subtract its fixed and variable
 * portions from all three summaries as well.
 */
export function costBriefExportView(brief: CostBriefPayload): CostBriefExportView {
  const excluded = brief.resources.filter((resource) => resource.id === 'vector-search');
  const resources = brief.resources.filter((resource) => resource.id !== 'vector-search');
  if (excluded.length === 0) {
    const total = finite(brief.total.amount) ? brief.total.amount : null;
    const breakdown = reconciledBreakdown(
      total,
      finite(brief.spendBreakdown.attributed.amount) ? brief.spendBreakdown.attributed.amount : null,
      finite(brief.spendBreakdown.standing.amount) ? brief.spendBreakdown.standing.amount : null
    );
    return {
      total,
      standing: breakdown.standing,
      attributed: breakdown.attributed,
      resources,
    };
  }

  const excludedParts = excluded.map((resource) => {
    if (!finite(resource.amount)) return null;
    const standing = finite(resource.standingAmount)
      ? Math.max(0, Math.min(resource.amount, resource.standingAmount))
      : 0;
    return { total: resource.amount, standing, attributed: Math.max(0, resource.amount - standing) };
  });
  const subtract = (value: number | null | undefined, part: keyof NonNullable<(typeof excludedParts)[number]>) =>
    finite(value) && excludedParts.every((item) => item !== null)
      ? Math.max(0, value - excludedParts.reduce((sum, item) => sum + (item?.[part] ?? 0), 0))
      : null;

  const total = subtract(brief.total.amount, 'total');
  const breakdown = reconciledBreakdown(
    total,
    subtract(brief.spendBreakdown.attributed.amount, 'attributed'),
    subtract(brief.spendBreakdown.standing.amount, 'standing')
  );
  return {
    total,
    standing: breakdown.standing,
    attributed: breakdown.attributed,
    resources,
  };
}

/**
 * Turn one observed Dev bill into a clearly labelled Dev + Prod planning case.
 *
 * Resource treatment follows the existing attribution rather than a hand-built
 * category list:
 * - `standingAmount` is the measured fixed/idle share and is copied at 100%.
 * - the remainder (`amount - standingAmount`) is question-driven and projected
 *   at `PROD_VARIABLE_USAGE_FACTOR`.
 * - resources without a standing share are entirely question-driven.
 *
 * Null stays null. A missing price must not silently become a zero-cost Prod
 * resource, and no projected value is represented as actual spend.
 */
export function buildDevProdProjection(brief: CostBriefPayload): DevProdProjection {
  const exported = costBriefExportView(brief);
  const devObserved = exported.total;
  const devStanding = exported.standing;
  const devVariable = exported.attributed;
  const prodProjected =
    devStanding !== null && devVariable !== null ? devStanding + devVariable * PROD_VARIABLE_USAGE_FACTOR : null;
  const parts = exported.resources.map((resource) => {
    if (!finite(resource.amount)) return { resource, standing: null, variable: null };
    const standing = finite(resource.standingAmount)
      ? Math.max(0, Math.min(resource.amount, resource.standingAmount))
      : 0;
    return { resource, standing, variable: Math.max(0, resource.amount - standing) };
  });
  const rawVariableTotal = parts.reduce((sum, part) => sum + (part.variable ?? 0), 0);
  const variableScale = devVariable !== null && rawVariableTotal > 0 ? Math.max(0, devVariable / rawVariableTotal) : 1;
  const resourceStandingTotal = parts.reduce((sum, part) => sum + (part.standing ?? 0), 0);
  const standingResidual =
    devStanding === null ? 0 : Math.round(Math.max(0, devStanding - resourceStandingTotal) * 1_000_000) / 1_000_000;
  const resources: DevProdProjectionResource[] = parts.map(({ resource, standing, variable }) => {
    if (standing === null || variable === null || !finite(resource.amount)) {
      return {
        id: resource.id,
        label: resource.label,
        quality: resource.quality,
        devObserved: null,
        devStanding: null,
        devVariable: null,
        prodProjected: null,
        prodStanding: null,
        prodVariable: null,
        combined: null,
      };
    }
    const scaledVariable = variable * variableScale;
    const prodVariable = scaledVariable * PROD_VARIABLE_USAGE_FACTOR;
    const projected = standing + prodVariable;
    return {
      id: resource.id,
      label: resource.label,
      quality: resource.quality,
      devObserved: resource.amount,
      devStanding: standing,
      devVariable: scaledVariable,
      prodProjected: projected,
      prodStanding: standing,
      prodVariable,
      combined: resource.amount + projected,
    };
  });
  if (standingResidual > 0) {
    resources.push({
      id: 'reconciled-standing',
      label: 'Reconciled fixed hosting',
      quality: 'estimate',
      devObserved: null,
      devStanding: standingResidual,
      devVariable: 0,
      prodProjected: standingResidual,
      prodStanding: standingResidual,
      prodVariable: 0,
      combined: null,
    });
  }

  return {
    currency: brief.currency,
    variableUsageFactor: PROD_VARIABLE_USAGE_FACTOR,
    devObserved,
    devStanding,
    devVariable,
    prodProjected,
    combined: devObserved !== null && prodProjected !== null ? devObserved + prodProjected : null,
    resources,
  };
}

export function serializeCostBriefMarkdown(brief: CostBriefPayload): string {
  const exported = costBriefExportView(brief);
  const window = opsRangeDates(brief.range);
  const days = completeDays(brief.range);
  const header = [
    '# Cost breakdown — trailing 31 days',
    'Player Insights · Databricks App',
    [
      `- **Window:** ${window}${days ? ` (${days} complete ${days === 1 ? 'day' : 'days'})` : ''}`,
      brief.throughDay
        ? `- **Through:** ${brief.throughDay}${brief.billingLagDays !== null ? ` (billing lag: ${brief.billingLagDays} ${brief.billingLagDays === 1 ? 'day' : 'days'})` : ''}`
        : '',
      `- **Generated:** ${brief.generatedAt}`,
    ]
      .filter(Boolean)
      .join('\n'),
  ];

  // Anything other than a clean read prints the window and the reason, not a
  // table of dashes that reads as "the app spent nothing".
  if (brief.state !== 'ready') {
    const reason = brief.reason || 'No spend could be established for this window.';
    return `${[...header, `_${reason}_`].join('\n\n')}\n`;
  }

  // Billing rows can exist for the window (state 'ready') while none of them
  // could be priced or attributed to this deployment. Say so, rather than let a
  // table of dashes read as "the app spent nothing".
  const unpriced =
    exported.total === null &&
    (brief.resources.some((resource) => resource.id === 'vector-search') ||
      typeof brief.total.dbus !== 'number' ||
      !Number.isFinite(brief.total.dbus));
  const exportFigure = (figure: AppSpendFigure, amount: number | null): AppSpendFigure => ({
    ...figure,
    amount,
    // Resource rows do not carry DBUs, so a payload containing Vector Search
    // cannot produce a DBU headline with that component defensibly removed.
    dbus: brief.resources.some((resource) => resource.id === 'vector-search') ? null : figure.dbus,
  });

  const spend = [
    '## Spend',
    [
      `- **Total:** ${figureText(exportFigure(brief.total, exported.total))}`,
      `- **Attributed to questions:** ${figureText(
        exportFigure(brief.spendBreakdown.attributed, exported.attributed)
      )}`,
      `- **Standing infrastructure:** ${figureText(exportFigure(brief.spendBreakdown.standing, exported.standing))}`,
    ].join('\n'),
    unpriced
      ? '_Billing rows were found for this window, but none could be priced or attributed to this deployment, ' +
        'so no spend figure could be established._'
      : '',
  ];

  const byResource = [
    '## By resource',
    [
      '| Resource | Population | Spend | Standing | Quality |',
      '| --- | --- | ---: | ---: | --- |',
      ...exported.resources.map((resource) => resourceRow(resource, brief.currency)),
    ].join('\n'),
  ];

  const footer =
    '_Attributed + standing reconciles to the total. Standing is the fixed cost of keeping ' +
    'always-on resources online, not caused by any question. Figures marked estimated could ' +
    'not be fully sourced over the window._';

  return `${[...header, ...spend, ...byResource, footer].filter((part) => part.trim()).join('\n\n')}\n`;
}
