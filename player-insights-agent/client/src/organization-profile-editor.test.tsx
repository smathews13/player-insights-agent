import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OrganizationProfileRow } from '../../shared/organization-contract';
import { OrganizationRow } from './OrganizationProfileEditor';
import { organizationDraftProblem } from './organization-profile-draft';

const builtIn: OrganizationProfileRow = {
  domain: 'databricks.com',
  domains: ['databricks.com'],
  name: 'Databricks',
  monogram: 'DB',
  logoKey: 'databricks',
  source: 'built-in',
  customized: false,
  defaultName: 'Databricks',
  updatedBy: '',
  updatedAt: '',
};

const added: OrganizationProfileRow = {
  domain: 'studio2games.example',
  domains: ['studio2games.example'],
  name: 'Studio Two',
  monogram: 'S2',
  logoKey: 'monogram',
  source: 'admin',
  customized: true,
  defaultName: 'Studio Two',
  updatedBy: 'admin@example.com',
  updatedAt: '2026-10-06T00:00:00.000Z',
};

function render(row: OrganizationProfileRow, canManage: boolean) {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <OrganizationRow
          row={row}
          busy={false}
          canManage={canManage}
          onSave={() => undefined}
          onReset={() => undefined}
        />
      </tbody>
    </table>
  );
}

describe('organization profile editor', () => {
  it('shows the domain with its @ and keeps the logo of a built-in organization', () => {
    const markup = render(builtIn, true);
    expect(markup).toContain('@example.com');
    expect(markup).toContain('Organization name for databricks.com');
    expect(markup).not.toContain('Short mark for databricks.com');
    expect(markup).not.toContain('Reset organization');
  });

  it('offers a reset once a built-in label has been edited, and a removal for an added organization', () => {
    expect(render({ ...builtIn, customized: true, name: 'Databricks Inc' }, true)).toContain(
      'Reset organization databricks.com'
    );
    const markup = render(added, true);
    expect(markup).toContain('Remove organization studio2games.example');
    expect(markup).toContain('Short mark for studio2games.example');
  });

  it('draws plain text and no controls for a reader who cannot edit', () => {
    const markup = render(added, false);
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<button');
    expect(markup).toContain('Studio Two');
  });

  it('explains what blocks a draft', () => {
    expect(organizationDraftProblem({ domain: '@example.com', name: 'Databricks', monogram: '' })).toBe('');
    expect(organizationDraftProblem({ domain: 'nope', name: 'X', monogram: '' })).toMatch(/email domain/);
    expect(organizationDraftProblem({ domain: 'a.example', name: ' ', monogram: '' })).toMatch(/name/);
    expect(organizationDraftProblem({ domain: 'a.example', name: 'A', monogram: 'toolong' })).toMatch(/short mark/);
    expect(organizationDraftProblem({ name: 'A', monogram: 'ab' })).toBe('');
  });
});
