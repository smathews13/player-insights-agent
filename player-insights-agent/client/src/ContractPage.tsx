import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Check, FileDiff, RefreshCw, X } from 'lucide-react';

import type {
  ContractDifference,
  ContractObservatoryPayload,
  ContractSection,
} from '../../shared/contract-observatory';
import { loadContractObservatory } from './contract-api';
import { ExperimentalBadge } from './ExperimentalBadge';
import { PageHeading } from './page-chrome';
import { Alert, AlertDescription, Button } from './ui';
import './styles/routes/contract.css';

function differencesFor(differences: readonly ContractDifference[], sectionId: string): ContractDifference[] {
  return differences.filter((difference) => difference.sectionId === sectionId);
}

function sectionById(sections: readonly ContractSection[], id: string): ContractSection | undefined {
  return sections.find((section) => section.id === id);
}

function FieldCell({ field, present, side }: { field: string; present: boolean; side: 'backend' | 'frontend' }) {
  const missingLabel = side === 'backend' ? 'Not declared by backend reference' : 'Not accepted by frontend';
  return (
    <div
      className={`contract-field-cell ${
        present ? 'contract-field-cell--present' : `contract-field-cell--missing contract-field-cell--${side}-gap`
      }`}
      data-contract-side={side}
      role="cell"
    >
      {present ? (
        <>
          <Check className="size-3.5" aria-hidden="true" />
          <code>{field}</code>
        </>
      ) : (
        <>
          <X className="size-3.5" aria-hidden="true" />
          <span>{missingLabel}</span>
        </>
      )}
    </div>
  );
}

export function ContractSectionDiff({
  backend,
  frontend,
  differences,
}: {
  backend?: ContractSection;
  frontend?: ContractSection;
  differences: readonly ContractDifference[];
}) {
  const label = backend?.label ?? frontend?.label ?? 'Contract section';
  const fields = [...new Set([...(backend?.fields ?? []), ...(frontend?.fields ?? [])])].sort();
  const backendFields = new Set(backend?.fields ?? []);
  const frontendFields = new Set(frontend?.fields ?? []);
  return (
    <details className="contract-diff-section" open={differences.length > 0}>
      <summary>
        <span>{label}</span>
        <span className={`ast-pill ${differences.length ? 'ast-pill--warn' : 'ast-pill--pos'}`}>
          {differences.length ? `${differences.length} difference${differences.length === 1 ? '' : 's'}` : 'Aligned'}
        </span>
      </summary>
      <div className="contract-version-row">
        <span>
          Backend version <code>{backend?.schemaVersion ?? 'unversioned'}</code>
        </span>
        <span>
          Frontend version <code>{frontend?.schemaVersion ?? 'unversioned'}</code>
        </span>
      </div>
      <div className="contract-diff-grid" role="table" aria-label={`${label} contract comparison`}>
        <div className="contract-diff-header" role="row">
          <div className="contract-diff-heading" role="columnheader">
            Backend
          </div>
          <div className="contract-diff-heading" role="columnheader">
            Frontend
          </div>
        </div>
        {fields.map((field) => (
          <div className="contract-diff-row" role="row" key={field}>
            <FieldCell field={field} present={backendFields.has(field)} side="backend" />
            <FieldCell field={field} present={frontendFields.has(field)} side="frontend" />
          </div>
        ))}
      </div>
    </details>
  );
}

export function ContractPage() {
  const [payload, setPayload] = useState<ContractObservatoryPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      setPayload(await loadContractObservatory(signal));
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const sectionIds = useMemo(
    () =>
      payload
        ? [
            ...new Set([
              ...payload.backend.sections.map((section) => section.id),
              ...payload.frontend.sections.map((section) => section.id),
            ]),
          ]
        : [],
    [payload]
  );
  const backendOnly = payload?.differences.filter((difference) => difference.kind === 'backend-only').length ?? 0;
  const frontendOnly = payload?.differences.filter((difference) => difference.kind === 'frontend-only').length ?? 0;

  return (
    <section className="contract-page">
      <PageHeading
        title="Contract"
        actions={
          <div className="contract-heading-actions">
            <ExperimentalBadge />
            <Button type="button" variant="outline" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw className={`size-4 ${loading ? 'contract-spin' : ''}`} aria-hidden="true" />
              Refresh
            </Button>
          </div>
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading && !payload ? (
        <div className="contract-loading" role="status" aria-live="polite">
          <RefreshCw className="contract-spin size-5" aria-hidden="true" />
          Reading contract evidence
        </div>
      ) : null}

      {payload ? (
        <>
          <div className="contract-summary-grid">
            <article>
              <span>Backend-only fields</span>
              <strong className="ast-num">{backendOnly}</strong>
              <small>At risk of being unrendered</small>
            </article>
            <article>
              <span>Frontend-only fields</span>
              <strong className="ast-num">{frontendOnly}</strong>
              <small>Compatibility or app-owned fields</small>
            </article>
            <article>
              <span>Recorded failures</span>
              <strong className="ast-num">{payload.failures.length}</strong>
              <small>Latest 200 runs inspected</small>
            </article>
          </div>

          <div className="contract-side-notes">
            <p>
              <strong>{payload.backend.label}</strong> <code>{payload.backend.revision}</code>
              <span>{payload.backend.note}</span>
            </p>
            <p>
              <strong>{payload.frontend.label}</strong> <code>{payload.frontend.revision}</code>
              <span>{payload.frontend.note}</span>
            </p>
          </div>

          <section className="contract-comparison" aria-labelledby="contract-comparison-title">
            <div className="contract-section-heading">
              <FileDiff aria-hidden="true" />
              <div>
                <h3 id="contract-comparison-title">Contract comparison</h3>
                <p>
                  Backend-only fields need frontend support. Frontend-only fields are visible but not treated as
                  failures.
                </p>
              </div>
            </div>
            {sectionIds.map((sectionId) => (
              <ContractSectionDiff
                key={sectionId}
                backend={sectionById(payload.backend.sections, sectionId)}
                frontend={sectionById(payload.frontend.sections, sectionId)}
                differences={differencesFor(payload.differences, sectionId)}
              />
            ))}
          </section>

          <section className="contract-failures" aria-labelledby="contract-failures-title">
            <div className="contract-section-heading">
              <AlertTriangle aria-hidden="true" />
              <div>
                <h3 id="contract-failures-title">Contract failures</h3>
                <p>Schema refusals and preserved answers carrying undeclared fields.</p>
              </div>
            </div>
            {payload.failureReadState === 'unavailable' ? (
              <Alert variant="destructive">
                <AlertTriangle aria-hidden="true" />
                <AlertDescription>{payload.failureReadReason}</AlertDescription>
              </Alert>
            ) : payload.failures.length === 0 ? (
              <div className="contract-empty">
                <Check aria-hidden="true" />
                No handoff failures were found in the latest 200 runs.
              </div>
            ) : (
              <div className="contract-failure-list">
                {payload.failures.map((failure) => (
                  <article key={`${failure.runId}:${failure.kind}`} className="contract-failure-card">
                    <div>
                      <span className="ast-pill ast-pill--danger">
                        {failure.kind === 'schema-violation' ? 'Rejected payload' : 'Undeclared fields'}
                      </span>
                      <time dateTime={failure.occurredAt}>
                        {failure.occurredAt ? new Date(failure.occurredAt).toLocaleString() : 'Time unavailable'}
                      </time>
                    </div>
                    <p>{failure.detail}</p>
                    <code>{failure.fields.join(', ')}</code>
                    <Link to={`/runs?run=${encodeURIComponent(failure.runId)}`}>Open in Run Explorer</Link>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
}
