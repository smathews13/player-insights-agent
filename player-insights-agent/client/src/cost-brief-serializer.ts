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

export function serializeCostBriefMarkdown(brief: CostBriefPayload): string {
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
    (typeof brief.total.amount !== 'number' || !Number.isFinite(brief.total.amount)) &&
    (typeof brief.total.dbus !== 'number' || !Number.isFinite(brief.total.dbus));

  const spend = [
    '## Spend',
    [
      `- **Total:** ${figureText(brief.total)}`,
      `- **Attributed to questions:** ${figureText(brief.spendBreakdown.attributed)}`,
      `- **Standing infrastructure:** ${figureText(brief.spendBreakdown.standing)}`,
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
      ...brief.resources.map((resource) => resourceRow(resource, brief.currency)),
    ].join('\n'),
  ];

  const footer =
    '_Attributed + standing reconciles to the total. Standing is the fixed cost of keeping ' +
    'always-on resources online, not caused by any question. Figures marked estimated could ' +
    'not be fully sourced over the window._';

  return `${[...header, ...spend, ...byResource, footer].filter((part) => part.trim()).join('\n\n')}\n`;
}
