import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { ContractDifference, ContractFailure, ContractSection } from '../../shared/contract-observatory';
import { ContractSectionDiff } from './ContractPage';
import { contractFailureKey } from './contract-view';
import { NO_EXPERIMENTS, showsContractObservatory } from './experimental-features';
import { navEntries } from './role';
import { SettingsPage } from './SettingsPage';

const BACKEND: ContractSection = {
  id: 'answer',
  label: 'Answer',
  schemaVersion: null,
  fields: ['id', 'takeaway', 'future_backend_field'],
};

const FRONTEND: ContractSection = {
  id: 'answer',
  label: 'Answer',
  schemaVersion: 'pia.answer/1',
  fields: ['id', 'takeaway', 'schema_version'],
};

const DIFFERENCES: ContractDifference[] = [
  {
    sectionId: 'answer',
    sectionLabel: 'Answer',
    field: 'future_backend_field',
    kind: 'backend-only',
  },
  {
    sectionId: 'answer',
    sectionLabel: 'Answer',
    field: 'schema_version',
    kind: 'frontend-only',
  },
];

describe('experimental contract observatory', () => {
  it('adds the Contract tab only for administrators when the deployment toggle is on', () => {
    const enabled = { ...NO_EXPERIMENTS, contractObservatory: true };
    expect(showsContractObservatory(enabled)).toBe(true);
    expect(navEntries('admin', enabled).map((entry) => entry.label)).toContain('Contract');
    expect(navEntries('super_admin', enabled).map((entry) => entry.label)).toContain('Contract');
    expect(navEntries('consumer', enabled).map((entry) => entry.label)).not.toContain('Contract');
    expect(navEntries('admin', NO_EXPERIMENTS).map((entry) => entry.label)).not.toContain('Contract');
  });

  it('renders a collapsible side-by-side field comparison with missing sides apparent', () => {
    const markup = renderToStaticMarkup(
      <ContractSectionDiff backend={BACKEND} frontend={FRONTEND} differences={DIFFERENCES} />
    );
    expect(markup).toContain('<details');
    expect(markup).toContain('Backend');
    expect(markup).toContain('Frontend');
    expect(markup).toContain('future_backend_field');
    expect(markup).toContain('Not accepted by frontend');
    expect(markup).toContain('Not declared by backend reference');
  });

  it('labels observed stored envelopes without calling them the backend reference', () => {
    const markup = renderToStaticMarkup(
      <ContractSectionDiff
        backend={BACKEND}
        frontend={FRONTEND}
        differences={DIFFERENCES}
        backendLabel="Observed stored"
        backendMissingLabel="Not observed in stored envelopes"
      />
    );
    expect(markup).toContain('Observed stored');
    expect(markup).toContain('Observed stored version');
    expect(markup).toContain('Not observed in stored envelopes');
    expect(markup).not.toContain('Backend version');
    expect(markup).not.toContain('backend reference');
  });

  it('keys orphan failures by message id rather than their empty run id', () => {
    const failure = (messageId: string): ContractFailure => ({
      runId: '',
      conversationId: 'conv-1',
      traceId: null,
      messageId,
      occurredAt: '2026-09-24T19:00:00.000Z',
      kind: 'missing-stored-trace',
      code: 'STORED_DOCUMENT_TRACE_MISSING',
      fields: ['trace'],
      detail: 'Stored trace is missing.',
    });
    expect(contractFailureKey(failure('msg-1'), 0)).toBe('msg-1:missing-stored-trace');
    expect(contractFailureKey(failure('msg-2'), 1)).toBe('msg-2:missing-stored-trace');
  });

  it('offers the deployment-wide toggle in administrator Settings', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <SettingsPage
          initialSection="experimental"
          features={{ ...NO_EXPERIMENTS }}
          role={{ state: 'admin', addedAdminsReadable: true }}
          experimentalLoaded
        />
      </MemoryRouter>
    );
    expect(markup).toContain('Contract observatory');
    expect(markup).toContain('aria-label="Show Contract tab"');
  });
});
