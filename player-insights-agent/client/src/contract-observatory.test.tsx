import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { ContractDifference, ContractSection } from '../../shared/contract-observatory';
import { ContractSectionDiff } from './ContractPage';
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
