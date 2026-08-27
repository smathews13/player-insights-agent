import { Lock, Table2 } from 'lucide-react';
import {
  CASE_REVIEWS,
  CASE_TAGS,
  IMPORT_FILTER_LABELS,
  caseHasAgentLabel,
  caseHasSql,
  mlflowTraceHref,
  type CaseReview,
  type CaseTag,
  type LabCase,
  type LabWorkspace,
} from '../../shared/benchmark-lab-v3';
import { POC_STARTER_QUESTIONS } from '../../shared/eval-dataset';
import { astPill } from './astrolabe-pill';
import { BenchButton, LabSurface } from './BenchmarkLabChrome';
import type { EvaluationLabModel } from './use-evaluation-lab';

const TAG_LABEL: Record<CaseTag, string> = {
  happy_path: 'happy path',
  edge_case: 'edge case',
  refusal: 'refusal',
  multi_turn: 'multi-turn',
  empty_result: 'empty result',
  security: 'security',
};

const REVIEW_LABEL: Record<CaseReview, string> = {
  draft: 'Draft',
  reviewed: 'Reviewed',
  disputed: 'Disputed',
  approved: 'Approved',
};

function reviewFamily(review: CaseReview): 'warn' | 'pos' | 'neg' {
  if (review === 'approved' || review === 'reviewed') return 'pos';
  if (review === 'disputed') return 'neg';
  return 'warn';
}

function mark(ok: boolean): string {
  return ok ? '✓' : '–';
}

export function EvaluationSetTable({
  lab,
  selectedIds,
  expandedId,
  reviewerOnly,
  onToggle,
  onExpand,
}: {
  lab: LabWorkspace;
  selectedIds: readonly string[];
  expandedId: string;
  reviewerOnly: boolean;
  onToggle: (id: string) => void;
  onExpand: (id: string) => void;
}) {
  const rows = lab.cases.filter((row) => !reviewerOnly || row.review === 'draft' || row.review === 'disputed');
  return (
    <table className="bench-sheet">
      <thead>
        <tr>
          <th>Case</th>
          <th>Question or conversation</th>
          <th>Tag</th>
          <th>SQL</th>
          <th>Facts</th>
          <th>Split</th>
          <th>Review</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td className="bench-empty-row" colSpan={8}>
              {reviewerOnly
                ? 'No open reviewer items.'
                : 'No cases yet'}
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <CaseRow
              key={row.id}
              row={row}
              selected={selectedIds.includes(row.id)}
              expanded={expandedId === row.id}
              onToggle={() => onToggle(row.id)}
              onExpand={() => onExpand(row.id)}
            />
          ))
        )}
      </tbody>
    </table>
  );
}

function CaseRow({
  row,
  selected,
  expanded,
  onToggle,
  onExpand,
}: {
  row: LabCase;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
}) {
  const href = row.sourceKind === 'trace' && row.sourceTraceId ? mlflowTraceHref(row.sourceTraceId) : '';
  return (
    <>
      <tr className={row.retired ? 'bench-case-retired' : undefined}>
        <td>
          <label className="bench-case-id-cell">
            <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${row.id}`} />
            <button type="button" className="bench-text-link ast-num" onClick={onExpand} aria-expanded={expanded}>
              {row.id}
            </button>
          </label>
        </td>
        <td>{row.question || row.conversation || 'Empty case'}</td>
        <td>{row.tag ? <span className="bench-tag-capsule">{TAG_LABEL[row.tag]}</span> : '–'}</td>
        <td className="ast-num">{mark(caseHasSql(row))}</td>
        <td className="ast-num">{mark(caseHasAgentLabel(row))}</td>
        <td>
          {row.split === 'held_out' ? (
            <span>
              locked held-out <Lock className="bench-lock" aria-hidden="true" />
            </span>
          ) : (
            'tuning'
          )}
        </td>
        <td>
          <span className={astPill(reviewFamily(row.review), 'bench-chip')}>{REVIEW_LABEL[row.review]}</span>
        </td>
        <td>
          {href ? (
            <a className="bench-text-link ast-num" href={href}>
              {row.sourceTraceId}
            </a>
          ) : (
            'manual'
          )}
        </td>
      </tr>
    </>
  );
}

export function EvaluationSet({ lab }: { lab: EvaluationLabModel }) {
  const toggle = (id: string) => {
    lab.setSelectedIds(lab.selectedIds.includes(id) ? lab.selectedIds.filter((entry) => entry !== id) : [...lab.selectedIds, id]);
  };

  return (
    <LabSurface
      id="lab-evaluation-set"
      title="Evaluation set"
      actions={
        <div className="bench-btn-row">
          <BenchButton variant="primary" onClick={() => void lab.loadImportCandidates()} disabled={lab.busy === 'import'}>
            Import from traces
          </BenchButton>
          <BenchButton onClick={() => void lab.commitVersion()} disabled={lab.busy === 'version'}>
            New dataset version
          </BenchButton>
          <BenchButton onClick={() => lab.setReviewerOnly(!lab.reviewerOnly)} aria-pressed={lab.reviewerOnly}>
            {lab.lab.reviewerQueue}
          </BenchButton>
          <BenchButton onClick={() => void lab.previewAlign()} disabled={lab.busy === 'align'}>
            Align guidelines from labels
          </BenchButton>
        </div>
      }
    >
      <p className="bench-count-line ast-num">{lab.lab.headerLine}</p>
      <p className="bench-caption ast-num">{lab.lab.laneLine}</p>
      {lab.lab.currentVersionId ? (
        <p className="bench-caption ast-num">
          Dataset {lab.lab.currentVersionId}
          {lab.lab.heldOutAudit.length > 0 ? ` · ${lab.lab.heldOutAudit.length} held-out edit(s) recorded after the split` : ''}
        </p>
      ) : null}

      <EvaluationSetTable
        lab={lab.lab}
        selectedIds={lab.selectedIds}
        expandedId={lab.expandedId}
        reviewerOnly={lab.reviewerOnly}
        onToggle={toggle}
        onExpand={(id) => lab.setExpandedId(lab.expandedId === id ? '' : id)}
      />

      {lab.expandedId ? <CaseEditor lab={lab} row={lab.lab.cases.find((entry) => entry.id === lab.expandedId)} /> : null}

      {lab.lab.cases.length === 0 ? (
        <div className="bench-empty-samples">
          <ul className="bench-sample-list">
            {POC_STARTER_QUESTIONS.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
          <div className="bench-btn-row bench-pad">
            <BenchButton onClick={() => void lab.addSamples()}>Add these sample questions</BenchButton>
          </div>
        </div>
      ) : null}

      {lab.candidates.length > 0 ? <ImportPane lab={lab} /> : null}
      {lab.alignDraft ? <AlignPreview lab={lab} /> : null}

      {lab.notice ? <p className="bench-caption bench-pad">{lab.notice}</p> : null}
      {lab.error ? <p className="bench-caption bench-pad">{lab.error}</p> : null}
    </LabSurface>
  );
}

function ImportPane({ lab }: { lab: EvaluationLabModel }) {
  return (
    <div className="bench-import-pane">
      <fieldset className="bench-filter-set">
        <legend className="bench-inline-label">Keep turns with</legend>
        {lab.lab.importFilters.map((entry) => (
          <label key={entry.id}>
            <input
              type="checkbox"
              checked={lab.importFilters.includes(entry.id)}
              onChange={(event) =>
                lab.setImportFilters(
                  event.target.checked ? [...lab.importFilters, entry.id] : lab.importFilters.filter((id) => id !== entry.id)
                )
              }
            />
            {IMPORT_FILTER_LABELS[entry.id]}
          </label>
        ))}
      </fieldset>
      <ul className="bench-turn-grid">
        {lab.candidates.map((entry) => {
          const checked = lab.picked.includes(entry.question);
          return (
            <li key={entry.question}>
              <label className={checked ? 'bench-turn-card is-picked' : 'bench-turn-card'}>
                <Table2 className="bench-turn-icon" aria-hidden="true" strokeWidth={1.75} />
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    lab.setPicked(
                      event.target.checked
                        ? [...lab.picked, entry.question]
                        : lab.picked.filter((question) => question !== entry.question)
                    )
                  }
                  aria-label={entry.question}
                />
                <span className="bench-turn-question">{entry.question}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="bench-btn-row bench-pad">
        <BenchButton variant="primary" onClick={() => void lab.importPicked()} disabled={lab.picked.length === 0}>
          Add {lab.picked.length} to the dataset
        </BenchButton>
      </div>
    </div>
  );
}

function AlignPreview({ lab }: { lab: EvaluationLabModel }) {
  return (
    <div className="bench-align-preview bench-pad">
      <textarea
        className="bench-align-text"
        aria-label="Aligned guidelines preview"
        rows={6}
        value={lab.alignDraft}
        onChange={(event) => lab.setAlignDraft(event.target.value)}
      />
      <div className="bench-btn-row">
        <BenchButton variant="primary" onClick={() => void lab.commitAlign()}>
          Save aligned guidelines
        </BenchButton>
      </div>
    </div>
  );
}

function CaseEditor({ lab, row }: { lab: EvaluationLabModel; row: LabCase | undefined }) {
  if (!row) return null;
  return (
    <div className="bench-case-editor">
      <label className="runtime-field">
        <span className="runtime-field-label">Question or conversation</span>
        <textarea
          aria-label="Question or conversation"
          rows={2}
          defaultValue={row.question}
          onBlur={(event) => void lab.saveCase(row.id, { question: event.target.value })}
        />
      </label>
      <label className="runtime-field">
        <span className="runtime-field-label">Ground-truth SQL</span>
        <textarea
          aria-label="Ground-truth SQL"
          rows={3}
          defaultValue={row.groundTruthSql}
          onBlur={(event) => void lab.saveCase(row.id, { groundTruthSql: event.target.value })}
        />
      </label>
      <label className="runtime-field">
        <span className="runtime-field-label">Expected facts or response</span>
        <textarea
          aria-label="Expected facts"
          rows={2}
          defaultValue={row.expectedFacts || row.expectedResponse}
          onBlur={(event) => void lab.saveCase(row.id, { expectedFacts: event.target.value })}
        />
      </label>
      <label className="runtime-field">
        <span className="runtime-field-label">Per-case guidelines</span>
        <textarea
          aria-label="Per-case guidelines"
          rows={2}
          defaultValue={row.perCaseGuidelines}
          onBlur={(event) => void lab.saveCase(row.id, { perCaseGuidelines: event.target.value })}
        />
      </label>
      <div className="bench-btn-row">
        <label className="bench-inline-label">
          Tag
          <select
            className="eval-space-select bench-space-select"
            aria-label="Case tag"
            value={row.tag || 'happy_path'}
            onChange={(event) => void lab.saveCase(row.id, { tag: event.target.value })}
          >
            {CASE_TAGS.map((tag) => (
              <option key={tag} value={tag}>
                {TAG_LABEL[tag]}
              </option>
            ))}
          </select>
        </label>
        <label className="bench-inline-label">
          Review
          <select
            className="eval-space-select bench-space-select"
            aria-label="Review status"
            value={row.review}
            onChange={(event) => void lab.setReview(row.id, event.target.value as CaseReview)}
          >
            {CASE_REVIEWS.map((review) => (
              <option key={review} value={review}>
                {REVIEW_LABEL[review]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

export function CurateStageControls({ lab }: { lab: EvaluationLabModel }) {
  return (
    <>
      <p className="bench-stage-counts ast-num">{lab.lab.stage01Fact}</p>
      <span className={astPill('neutral-outline', 'bench-chip ast-num')}>{lab.lab.reviewerQueue}</span>
      <div className="bench-btn-row">
        <BenchButton variant="primary" onClick={() => void lab.loadImportCandidates()} disabled={lab.busy === 'import'}>
          Import from Ask and Monitoring traces
        </BenchButton>
        <BenchButton onClick={() => void lab.commitVersion()} disabled={lab.busy === 'version'}>
          New dataset version
        </BenchButton>
        <BenchButton onClick={() => void lab.assignSplit('held_out')} disabled={lab.busy === 'split'}>
          Assign tuning / held-out split
        </BenchButton>
        <BenchButton onClick={() => lab.setReviewerOnly(true)}>Open reviewer queue</BenchButton>
        <BenchButton onClick={() => void lab.duplicateSelected()} disabled={lab.busy === 'duplicate'}>
          Duplicate as edge case
        </BenchButton>
      </div>
      {lab.notice ? <p className="bench-caption">{lab.notice}</p> : null}
      {lab.error ? <p className="bench-caption">{lab.error}</p> : null}
    </>
  );
}
