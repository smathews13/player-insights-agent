import { useState } from 'react';
import { Download, MoreHorizontal } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from './ui';
import type { NormalizedAnswer } from './answer-shape';
import type { ExportTable } from './export-serializers';
import type { Chart } from './AnswerCharts';
import type { ConversationMessage } from './app-types';
import { PiaBusyButtonContent } from './PiaLoader';

const loadExportActions = () => import('./export-actions');

interface ExportAction {
  label: string;
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
          {actions.map((action) => (
            <button
              type="button"
              role="menuitem"
              key={action.label}
              disabled={Boolean(busy)}
              aria-busy={busy === action.label || undefined}
              onClick={() => void activate(action)}
            >
              <PiaBusyButtonContent busy={busy === action.label} label={action.label} busyLabel={`${action.label}…`} />
            </button>
          ))}
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
          run: async () => (await loadExportActions()).copyAnswerMarkdown(answer, question),
        },
        {
          label: 'Download Markdown',
          run: async () => (await loadExportActions()).downloadAnswerMarkdown(answer, question),
        },
        {
          label: 'Download HTML',
          run: async () => (await loadExportActions()).downloadAnswerHtml(answer, question, 'page'),
        },
        {
          label: 'Download HTML for slides',
          run: async () => (await loadExportActions()).downloadAnswerHtml(answer, question, 'presentation'),
        },
        {
          label: 'Download JSON',
          run: async () => (await loadExportActions()).downloadAnswerJson(answer, question),
        },
        {
          label: 'Download PDF',
          run: async () => (await loadExportActions()).downloadAnswerPdf(answer, question),
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
          run: async () => (await loadExportActions()).copyTableTsv(table),
        },
        {
          label: 'Download PNG',
          run: async () => (await loadExportActions()).downloadTablePng(table, name),
        },
        {
          label: 'Download PDF',
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
          run: async () => (await loadExportActions()).downloadChartPng(chart, label),
        },
        {
          label: 'Download JSON',
          run: async () => (await loadExportActions()).downloadChartJson(chart, label),
        },
      ]}
    />
  );
}

export function CostBriefExportMenu() {
  return (
    <ActionsMenu
      label="Export the trailing 31-day cost breakdown"
      actions={[
        {
          label: 'Download PDF (last 31 days)',
          run: async () => (await loadExportActions()).downloadCostBriefPdf(),
        },
      ]}
    />
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
          run: async () => (await loadExportActions()).copyConversationMarkdown(title, loadMessages),
        },
        {
          label: 'Download Markdown',
          run: async () => (await loadExportActions()).downloadConversationMarkdown(title, loadMessages),
        },
        {
          label: 'Download HTML',
          run: async () => (await loadExportActions()).downloadConversationHtml(title, loadMessages, 'page'),
        },
        {
          label: 'Download HTML for slides',
          run: async () => (await loadExportActions()).downloadConversationHtml(title, loadMessages, 'presentation'),
        },
        {
          label: 'Download JSON',
          run: async () => (await loadExportActions()).downloadConversationJson(title, loadMessages),
        },
        {
          label: 'Download PDF',
          run: async () => (await loadExportActions()).downloadConversationPdf(title, loadMessages),
        },
      ]}
    />
  );
}
