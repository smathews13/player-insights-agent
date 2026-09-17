/**
 * A report: an agent-authored, multi-section document the app renders and exports.
 *
 * WHY THIS IS ITS OWN SHAPE AND NOT A BIGGER ANSWER. An answer is one finding --
 * a headline, the prose behind it, the figures or table that back it. A report is
 * several findings laid out as a document: a franchise-by-franchise summary, a page
 * that pairs a table with the three charts that read it different ways, the "1-page
 * HTML" a field team pastes onto a deck. Forcing that into an answer's single
 * narrative loses the thing that makes it a report -- the SECTIONS, each with its
 * own heading, its own numbers and its own picture.
 *
 * WHO WRITES IT. The agent, from a natural-language request ("do a one-page summary
 * of the major Contoso franchises..."). The server validates it against this contract
 * and the client renders and exports it. Nothing in the app FABRICATES a report:
 * the frontend lays out exactly the sections, figures and charts the agent sent.
 *
 * THE ONE RULE FOR EVERY FIELD. It is reader-facing or it is not here. No trace, no
 * SQL, no tool-call JSON, no internal identifiers. A report is the thing that leaves
 * the app -- onto a slide, into an email -- so it carries only what a reader may see.
 */

export const REPORT_SCHEMA_VERSION = 'pia.report/1';

/** The document palette. `presentation` is black-background for a slide; `page` is a white sheet. */
export type ReportTheme = 'page' | 'presentation';

export type ReportColumnAlign = 'left' | 'right' | 'center';

/** One KPI card: a big pre-formatted number under a label, with an optional small line. */
export interface ReportFigure {
  id?: string;
  label: string;
  /** Already formatted for the reader, e.g. "62%", "1.4M", "3.2 days". The app does not reformat it. */
  value: string;
  caption?: string;
}

/**
 * A table of plain-text cells.
 *
 * Cells are strings the agent already formatted -- this is a report, not a live grid,
 * so there is no sorting, no re-derivation and no Markdown inside a cell. `sources`
 * names the governed tables the figures were read from, shown as a line under it.
 */
export interface ReportTable {
  id?: string;
  title?: string;
  columns: string[];
  align?: ReportColumnAlign[];
  rows: string[][];
  sources?: string[];
}

/** One Plotly panel, the same shape the answer path carries, kept as a spec so a reader can redraw it. */
export interface ReportChart {
  id: string;
  title: string;
  kind: string;
  plotly: { data: Record<string, unknown>[]; layout: Record<string, unknown> };
}

/**
 * One section of the report: a heading, some prose, and any of a KPI row, a table
 * and charts. Every part is optional so a section can be a lead paragraph, a bare
 * table, or a titled block that carries all three.
 */
export interface ReportSection {
  id?: string;
  heading?: string;
  /** Reader-facing Markdown. Rendered through the same safe parser the answer uses. */
  body?: string;
  figures?: ReportFigure[];
  table?: ReportTable;
  charts?: ReportChart[];
  note?: string;
}

export interface Report {
  schema_version: string;
  title: string;
  subtitle?: string;
  /** The agent's design hint. A request for a dark slide sets this to 'presentation'. */
  theme?: ReportTheme;
  /** A lead paragraph under the title, as Markdown. */
  summary?: string;
  sections: ReportSection[];
  sources?: { name: string; freshness?: string }[];
  caveats?: string[];
  /** ISO 8601, as the agent stamped it. Shown in the footer; never invented by the client. */
  generatedAt?: string;
  provenance?: unknown;
}

/* ── Normalisation: the wire's open shape folded onto the contract ───────────── */

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asAlign(value: unknown): ReportColumnAlign | undefined {
  return value === 'left' || value === 'right' || value === 'center' ? value : undefined;
}

function normalizeFigure(raw: unknown): ReportFigure | null {
  const record = asRecord(raw);
  const label = asString(record.label).trim();
  const value = asString(record.value).trim();
  // A KPI with no label or no number is not a KPI, it is a blank card. Drop it.
  if (!label || !value) return null;
  const figure: ReportFigure = { label, value };
  const id = asOptionalString(record.id);
  if (id) figure.id = id;
  const caption = asOptionalString(record.caption);
  if (caption) figure.caption = caption;
  return figure;
}

function normalizeTable(raw: unknown): ReportTable | null {
  const record = asRecord(raw);
  const columns = asStringArray(record.columns);
  const rows = Array.isArray(record.rows)
    ? record.rows.map((row) => asStringArray(row)).filter((row) => row.length > 0)
    : [];
  // A table needs either a header or a body to be worth a block.
  if (columns.length === 0 && rows.length === 0) return null;
  const table: ReportTable = { columns, rows };
  const id = asOptionalString(record.id);
  if (id) table.id = id;
  const title = asOptionalString(record.title);
  if (title) table.title = title;
  const align = Array.isArray(record.align)
    ? record.align.map(asAlign).filter((entry): entry is ReportColumnAlign => entry !== undefined)
    : [];
  if (align.length) table.align = align;
  const sources = asStringArray(record.sources);
  if (sources.length) table.sources = sources;
  return table;
}

function normalizeChart(raw: unknown): ReportChart | null {
  const record = asRecord(raw);
  const plotly = asRecord(record.plotly);
  const data = Array.isArray(plotly.data)
    ? plotly.data.filter((trace): trace is Record<string, unknown> => Boolean(trace) && typeof trace === 'object')
    : [];
  // A chart with no traces draws nothing; refuse it rather than ship an empty panel.
  if (data.length === 0) return null;
  const layout = asRecord(plotly.layout);
  return {
    // May be empty here; normalizeReport assigns a unique id across the whole report
    // once every section is in hand, so two id-less charts cannot share one key.
    id: asString(record.id).trim(),
    title: asString(record.title),
    kind: asString(record.kind),
    plotly: { data, layout },
  };
}

function normalizeSection(raw: unknown): ReportSection | null {
  const record = asRecord(raw);
  const section: ReportSection = {};
  const id = asOptionalString(record.id);
  if (id) section.id = id;
  const heading = asOptionalString(record.heading);
  if (heading) section.heading = heading;
  const body = asOptionalString(record.body);
  if (body) section.body = body;
  const figures = Array.isArray(record.figures)
    ? record.figures.map(normalizeFigure).filter((figure): figure is ReportFigure => figure !== null)
    : [];
  if (figures.length) section.figures = figures;
  const table = normalizeTable(record.table);
  if (table) section.table = table;
  const charts = Array.isArray(record.charts)
    ? record.charts.map(normalizeChart).filter((chart): chart is ReportChart => chart !== null)
    : [];
  if (charts.length) section.charts = charts;
  const note = asOptionalString(record.note);
  if (note) section.note = note;
  // A heading or a caption with no content under it is noise, not a section. A
  // section earns its place with at least one of prose, figures, a table or a chart.
  const hasContent = Boolean(section.body || section.figures || section.table || section.charts);
  return hasContent ? section : null;
}

/**
 * Whether a value looks like a report on the wire.
 *
 * Used by the answer router to tell a `type: 'report'` payload from an answer, a
 * plan or a clarification before it tries to render one.
 */
export function isReportPayload(value: unknown): boolean {
  const record = asRecord(value);
  return record.type === 'report' || (typeof record.title === 'string' && Array.isArray(record.sections));
}

/**
 * The wire's open shape folded onto the contract, or null when it is not a report.
 *
 * Null rather than an empty report: a payload with no title or no usable section is
 * not a document, and the caller falls back to whatever it does for an unrenderable
 * response rather than drawing an empty page.
 */
export function normalizeReport(raw: unknown): Report | null {
  const record = asRecord(raw);
  const title = asString(record.title).trim();
  const sections = Array.isArray(record.sections)
    ? record.sections.map(normalizeSection).filter((section): section is ReportSection => section !== null)
    : [];
  if (!title || sections.length === 0) return null;
  // Charts key their rendered image by id (chartPngDataUrls -> report-serializers.ts).
  // Two charts sharing an id -- or several with none, which normalizeChart leaves empty
  // -- would collide in that map and export the same picture for every panel. Walk the
  // report in document order and give each chart a unique id: keep a distinct
  // author-supplied one, synthesise chart-N for the blanks and the clashes.
  const usedChartIds = new Set<string>();
  let chartOrdinal = 0;
  for (const section of sections) {
    if (!section.charts) continue;
    for (const chart of section.charts) {
      chartOrdinal += 1;
      let id = chart.id.trim();
      if (!id || usedChartIds.has(id)) {
        id = `chart-${chartOrdinal}`;
        while (usedChartIds.has(id)) {
          chartOrdinal += 1;
          id = `chart-${chartOrdinal}`;
        }
      }
      chart.id = id;
      usedChartIds.add(id);
    }
  }
  const report: Report = { schema_version: asString(record.schema_version) || REPORT_SCHEMA_VERSION, title, sections };
  const subtitle = asOptionalString(record.subtitle);
  if (subtitle) report.subtitle = subtitle;
  if (record.theme === 'presentation' || record.theme === 'page') report.theme = record.theme;
  const summary = asOptionalString(record.summary);
  if (summary) report.summary = summary;
  const sources = Array.isArray(record.sources)
    ? record.sources
        .map((entry) => {
          const source = asRecord(entry);
          const name = asString(source.name).trim();
          if (!name) return null;
          const freshness = asOptionalString(source.freshness);
          return freshness ? { name, freshness } : { name };
        })
        .filter((entry): entry is { name: string; freshness?: string } => entry !== null)
    : [];
  if (sources.length) report.sources = sources;
  const caveats = asStringArray(record.caveats).filter((caveat) => caveat.trim());
  if (caveats.length) report.caveats = caveats;
  const generatedAt = asOptionalString(record.generatedAt) ?? asOptionalString(record.generated_at);
  if (generatedAt) report.generatedAt = generatedAt;
  if (record.provenance !== undefined) report.provenance = record.provenance;
  return report;
}
