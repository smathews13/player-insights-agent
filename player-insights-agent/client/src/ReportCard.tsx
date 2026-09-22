/**
 * A report is an agent-authored, multi-section document. The server validates
 * this contract; this component renders it without flattening it into an
 * answer's single narrative.
 */
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui';
import { PiaAvatar } from './PiaMark';
import { AnswerProse } from './DataEntityLinks';
import { AnswerCharts } from './AnswerCharts';
import { ReportExportMenu } from './ExportMenu';
import type { Report, ReportSection } from '../../shared/report-contract';

function ReportFigures({ figures }: { figures: ReportSection['figures'] }) {
  if (!figures?.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {figures.map((figure, index) => (
        <div key={figure.id ?? `${figure.label}-${index}`} className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">{figure.label}</div>
          <div className="text-xl font-semibold">{figure.value}</div>
          {figure.caption ? <div className="text-xs text-muted-foreground">{figure.caption}</div> : null}
        </div>
      ))}
    </div>
  );
}

function ReportTableView({ table }: { table: ReportSection['table'] }) {
  if (!table) return null;
  const width = Math.max(table.columns.length, ...table.rows.map((row) => row.length), 1);
  const columns = Array.from({ length: width }, (_, index) => ({
    key: `column-${index}-${table.columns[index] ?? ''}`,
    label: table.columns[index] ?? '',
    index,
  }));
  const rows = table.rows.map((row, index) => ({
    key: `row-${index}-${row.join('\u001f')}`,
    row,
  }));
  return (
    <div className="space-y-1 overflow-x-auto">
      {table.title ? <div className="text-sm font-medium">{table.title}</div> : null}
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.key}
                className={table.align?.[column.index] === 'right' ? 'text-right' : undefined}
              >
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ key, row }) => (
            <TableRow key={key}>
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={table.align?.[column.index] === 'right' ? 'text-right' : undefined}
                >
                  {row[column.index] ?? ''}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {table.sources?.length ? (
        <p className="text-xs text-muted-foreground">Sources: {table.sources.join(', ')}</p>
      ) : null}
    </div>
  );
}

function ReportSectionView({ section, sources }: { section: ReportSection; sources: Report['sources'] }) {
  const charts = (section.charts ?? []).map((chart) => ({
    id: chart.id,
    title: chart.title,
    kind: chart.kind,
    data: chart.plotly.data,
    layout: chart.plotly.layout,
  }));
  return (
    <section className="space-y-3">
      {section.heading ? <h4 className="font-semibold">{section.heading}</h4> : null}
      {section.body ? <AnswerProse text={section.body} sources={sources ?? []} blocks="prose" preserveProse /> : null}
      <ReportFigures figures={section.figures} />
      <ReportTableView table={section.table} />
      {charts.length > 0 ? <AnswerCharts charts={charts} /> : null}
      {section.note ? <p className="text-xs text-muted-foreground italic">{section.note}</p> : null}
    </section>
  );
}

export function ReportCard({ report }: { report: Report }) {
  return (
    <Card className="answer-card report-card" data-theme={report.theme ?? 'page'}>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="agent-avatar">
            <PiaAvatar size={32} />
          </div>
          <div className="space-y-1">
            <Badge variant="outline" className="provenance-chip" data-tone="live">
              Report
            </Badge>
            <CardTitle>{report.title}</CardTitle>
            {report.subtitle ? <CardDescription>{report.subtitle}</CardDescription> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {report.summary ? (
          <AnswerProse text={report.summary} sources={report.sources ?? []} blocks="prose" preserveProse />
        ) : null}
        {report.sections.map((section, index) => (
          <ReportSectionView key={section.id ?? index} section={section} sources={report.sources} />
        ))}
        {report.sources?.length ? (
          <div className="space-y-1">
            <div className="text-sm font-medium">Sources</div>
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {report.sources.map((source) => (
                <li key={source.name}>
                  <code>{source.name}</code>
                  {source.freshness ? ` — ${source.freshness}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {report.caveats?.length ? (
          <div className="space-y-1">
            <div className="text-sm font-medium">Caveats</div>
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {report.caveats
                .map((caveat, index) => ({ key: `caveat-${index}-${caveat}`, caveat }))
                .map(({ key, caveat }) => (
                  <li key={key}>{caveat}</li>
                ))}
            </ul>
          </div>
        ) : null}
        <div className="flex justify-end">
          <ReportExportMenu report={report} />
        </div>
      </CardContent>
    </Card>
  );
}
