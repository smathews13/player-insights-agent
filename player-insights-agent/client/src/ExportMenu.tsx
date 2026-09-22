import { useId, useState } from 'react';
import {
  Braces,
  Code2,
  Copy,
  Download,
  FileDown,
  FileImage,
  FileText,
  MoreHorizontal,
  Presentation,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from './ui';
import type { NormalizedAnswer } from './answer-shape';
import type { ExportTable } from './export-serializers';
import type { Chart } from './AnswerCharts';
import type { ConversationMessage } from './app-types';
import { PiaBusyButtonContent } from './PiaLoader';
import type { Report } from '../../shared/report-contract';

const loadExportActions = () => import('./export-actions');

interface ExportAction {
  label: string;
  icon: LucideIcon;
  run: () => Promise<void>;
}

function ActionsMenu({ label, actions }: { label: string; actions: readonly ExportAction[] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [outcome, setOutcome] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const activate = async (action: ExportAction) => {
    setBusy(action.label);
    setOutcome(null);
    try {
      await action.run();
      setOutcome({ tone: 'success', text: `${action.label} succeeded.` });
      setOpen(false);
    } catch (error) {
      setOutcome({
        tone: 'error',
        text: error instanceof Error && error.message ? error.message : `${action.label} failed. Try again.`,
      });
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="export-menu">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" aria-label={label} aria-haspopup="menu">
            <Download aria-hidden="true" />
            <span className="export-menu-label">Export</span>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="export-menu-content" align="end" role="menu" aria-label={label}>
          {actions.map((action) => {
            const ActionIcon = action.icon;
            return (
              <button
                type="button"
                role="menuitem"
                key={action.label}
                disabled={Boolean(busy)}
                aria-busy={busy === action.label || undefined}
                onClick={() => void activate(action)}
              >
                <PiaBusyButtonContent
                  busy={busy === action.label}
                  label={action.label}
                  busyLabel={`${action.label}…`}
                  icon={<ActionIcon aria-hidden="true" />}
                />
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      {outcome ? (
        <span
          className={`export-outcome export-outcome--${outcome.tone}`}
          role={outcome.tone === 'error' ? 'alert' : 'status'}
          aria-live={outcome.tone === 'error' ? 'assertive' : 'polite'}
        >
          {outcome.text}
        </span>
      ) : null}
    </div>
  );
}

export function AnswerExportMenu({ question, answer }: { question: string; answer: NormalizedAnswer }) {
  return (
    <ActionsMenu
      label="Export this question and answer"
      actions={[
        {
          label: 'Copy Markdown',
          icon: Copy,
          run: async () => (await loadExportActions()).copyAnswerMarkdown(answer, question),
        },
        {
          label: 'Download Markdown',
          icon: FileDown,
          run: async () => (await loadExportActions()).downloadAnswerMarkdown(answer, question),
        },
        {
          label: 'Download HTML',
          icon: Code2,
          run: async () => (await loadExportActions()).downloadAnswerHtml(answer, question, 'page'),
        },
        {
          label: 'Download HTML for slides',
          icon: Presentation,
          run: async () => (await loadExportActions()).downloadAnswerHtml(answer, question, 'presentation'),
        },
        {
          label: 'Download JSON',
          icon: Braces,
          run: async () => (await loadExportActions()).downloadAnswerJson(answer, question),
        },
        {
          label: 'Download PDF',
          icon: FileText,
          run: async () => (await loadExportActions()).downloadAnswerPdf(answer, question),
        },
      ]}
    />
  );
}

export function ReportExportMenu({ report }: { report: Report }) {
  return (
    <ActionsMenu
      label="Export this report"
      actions={[
        {
          label: 'Copy Markdown',
          icon: Copy,
          run: async () => (await loadExportActions()).copyReportMarkdown(report),
        },
        {
          label: 'Download Markdown',
          icon: FileDown,
          run: async () => (await loadExportActions()).downloadReportMarkdown(report),
        },
        {
          label: 'Download HTML',
          icon: Code2,
          run: async () => (await loadExportActions()).downloadReportHtml(report, 'page'),
        },
        {
          label: 'Download HTML for slides',
          icon: Presentation,
          run: async () => (await loadExportActions()).downloadReportHtml(report, 'presentation'),
        },
        {
          label: 'Download JSON',
          icon: Braces,
          run: async () => (await loadExportActions()).downloadReportJson(report),
        },
      ]}
    />
  );
}

export function TableExportMenu({ table, name = 'answer-table' }: { table: ExportTable; name?: string }) {
  return (
    <ActionsMenu
      label="Export this table"
      actions={[
        {
          label: 'Copy TSV',
          icon: Copy,
          run: async () => (await loadExportActions()).copyTableTsv(table),
        },
        {
          label: 'Download PNG',
          icon: FileImage,
          run: async () => (await loadExportActions()).downloadTablePng(table, name),
        },
        {
          label: 'Download PDF',
          icon: FileText,
          run: async () => (await loadExportActions()).downloadTablePdf(table, name),
        },
      ]}
    />
  );
}

export function ChartExportMenu({ chart, name }: { chart: Chart; name?: string }) {
  const label = name ?? chart.title;
  return (
    <ActionsMenu
      label="Export this chart"
      actions={[
        {
          label: 'Download PNG',
          icon: FileImage,
          run: async () => (await loadExportActions()).downloadChartPng(chart, label),
        },
        {
          label: 'Download JSON',
          icon: Braces,
          run: async () => (await loadExportActions()).downloadChartJson(chart, label),
        },
      ]}
    />
  );
}

export function CostBriefExportMenu() {
  const groupName = useId();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<'observed' | 'dev-prod'>('observed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      const actions = await loadExportActions();
      if (selection === 'observed') await actions.downloadCostBriefPdf();
      else await actions.downloadDevProdCostProjectionPdf();
      setOpen(false);
    } catch (error) {
      setError(error instanceof Error && error.message ? error.message : 'Cost report export failed. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="export-menu cost-brief-export-menu">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Export the trailing 31-day cost breakdown"
            aria-haspopup="dialog"
          >
            <Download aria-hidden="true" />
            <span className="export-menu-label">Export</span>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="export-menu-content cost-brief-export-menu-content"
          align="start"
          role="dialog"
          aria-label="Choose a cost report"
        >
          <div className="cost-brief-export-options" role="radiogroup" aria-label="Cost report type">
            <label className="cost-brief-export-option" data-selected={selection === 'observed'}>
              <input
                type="radio"
                name={groupName}
                value="observed"
                checked={selection === 'observed'}
                onChange={() => setSelection('observed')}
              />
              <FileText aria-hidden="true" />
              <span>Cost report PDF (last 31 days)</span>
            </label>
            <label className="cost-brief-export-option" data-selected={selection === 'dev-prod'}>
              <input
                type="radio"
                name={groupName}
                value="dev-prod"
                checked={selection === 'dev-prod'}
                onChange={() => setSelection('dev-prod')}
              />
              <TrendingUp aria-hidden="true" />
              <span>Dev + Prod projection (last 31 days)</span>
            </label>
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="cost-brief-export-submit"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void activate()}
          >
            <PiaBusyButtonContent busy={busy} label="Export selected" busyLabel="Exporting…" />
          </Button>
        </PopoverContent>
      </Popover>
      {error ? (
        <span className="export-outcome export-outcome--error" role="alert" aria-live="assertive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function ConversationExportMenu({
  title,
  loadMessages,
}: {
  title: string;
  loadMessages: () => Promise<ConversationMessage[]>;
}) {
  return (
    <ActionsMenu
      label="Export whole conversation"
      actions={[
        {
          label: 'Copy Markdown',
          icon: Copy,
          run: async () => (await loadExportActions()).copyConversationMarkdown(title, loadMessages),
        },
        {
          label: 'Download Markdown',
          icon: FileDown,
          run: async () => (await loadExportActions()).downloadConversationMarkdown(title, loadMessages),
        },
        {
          label: 'Download HTML',
          icon: Code2,
          run: async () => (await loadExportActions()).downloadConversationHtml(title, loadMessages, 'page'),
        },
        {
          label: 'Download HTML for slides',
          icon: Presentation,
          run: async () => (await loadExportActions()).downloadConversationHtml(title, loadMessages, 'presentation'),
        },
        {
          label: 'Download JSON',
          icon: Braces,
          run: async () => (await loadExportActions()).downloadConversationJson(title, loadMessages),
        },
        {
          label: 'Download PDF',
          icon: FileText,
          run: async () => (await loadExportActions()).downloadConversationPdf(title, loadMessages),
        },
      ]}
    />
  );
}
