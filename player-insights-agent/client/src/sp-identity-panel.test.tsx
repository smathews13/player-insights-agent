import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EMPTY_SP_IDENTITY, SpIdentityEditor, UNASSIGNED_PERSONA } from './SpIdentityPanel';
import { SP_IDENTITY_MINTING_UNAVAILABLE, type SpIdentityAdminPayload } from '../../shared/sp-identity';

const PAYLOAD: SpIdentityAdminPayload = {
  ...EMPTY_SP_IDENTITY,
  minting: {
    available: true,
    detail: 'This app can read a named secret and exchange it for a token.',
  },
  personas: [
    {
      id: 'persona-1',
      displayName: 'Finance analyst',
      clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
      secretScope: 'astrolabe',
      secretKey: 'finance-sp',
      updatedAt: '2026-08-26T00:00:00.000Z',
      updatedBy: 'admin@example.com',
    },
  ],
  roster: [
    { email: 'ada@example.com', role: 'admin', personaId: 'persona-1' },
    { email: 'ben@example.com', role: 'consumer', personaId: null },
  ],
};

function render(enabled: boolean, payload: SpIdentityAdminPayload = PAYLOAD): string {
  return renderToStaticMarkup(
    <SpIdentityEditor
      enabled={enabled}
      payload={payload}
      busy={false}
      error={null}
      onRename={() => {}}
      onAssign={() => {}}
    />
  );
}

describe('Settings → Identity', () => {
  it('grays the pane until the experimental switch is on', () => {
    const off = render(false);
    expect(off).toContain('data-testid="sp-identity-pane"');
    expect(off).toContain('disabled=""');
    expect(off).toContain('Turn SP identities on under Experimental');
  });

  it('lets an administrator name an existing SP role without exposing credentials', () => {
    const markup = render(true);
    expect(markup).toContain('SP user roles');
    expect(markup).toContain('aria-label="SP role name"');
    expect(markup).toContain('Save role name');
    expect(markup).not.toMatch(/application \/? client id/i);
    expect(markup).not.toMatch(/secret scope|secret key|secret reference/i);
    expect(markup).not.toContain(PAYLOAD.personas[0].clientId);
    expect(markup).not.toContain(PAYLOAD.personas[0].secretScope);
    expect(markup).not.toContain(PAYLOAD.personas[0].secretKey);
  });

  it('only renames backend-defined identities instead of creating unusable roles', () => {
    const source = readFileSync(new URL('SpIdentityPanel.tsx', import.meta.url), 'utf8');
    expect(source).toContain("method: 'PATCH'");
    expect(source).toContain('body: JSON.stringify({ displayName })');
    expect(source).not.toContain("method: 'POST'");
    expect(source).not.toContain("method: 'DELETE'");
    expect(source).toContain('never deletes the stored identity');
  });

  it('assigns one SP role per roster person, with OAuth as the unassigned choice', () => {
    const markup = render(true);
    expect(markup).toContain('ada@example.com');
    expect(markup).toContain('ben@example.com');
    expect(markup).toContain('Signed-in user (OAuth)');
    expect(markup).toContain(`aria-label="SP role for ada@example.com: Finance analyst"`);
    expect(markup).toContain(`aria-label="SP role for ben@example.com: Signed-in user (OAuth)"`);
    expect(markup).toContain('<th scope="col">Email</th>');
    expect(markup).toContain('<th scope="col">Human role</th>');
    expect(markup).toContain('<th scope="col">SP role</th>');
    expect(UNASSIGNED_PERSONA).toBe('oauth');
    expect(UNASSIGNED_PERSONA).not.toBe('');
  });

  it('says so when this app cannot mint a token for another service principal', () => {
    const markup = render(true, {
      ...PAYLOAD,
      minting: {
        available: false,
        detail: 'This app has no service-principal credentials of its own.',
      },
    });
    expect(markup).toContain('This app has no service-principal credentials of its own.');
  });

  it('does not lecture about minting, empty personas, or who assigns', () => {
    const empty = render(true, {
      ...EMPTY_SP_IDENTITY,
      minting: { available: false, detail: SP_IDENTITY_MINTING_UNAVAILABLE },
      roster: PAYLOAD.roster,
    });
    expect(empty).not.toContain(SP_IDENTITY_MINTING_UNAVAILABLE);
    expect(empty).not.toContain('No personas yet.');
    expect(empty).not.toContain('Who runs as which persona');
    expect(empty).not.toContain('Administrators assign this');
    expect(empty).not.toContain('People using the app do not pick a persona on Ask');
    expect(empty).not.toContain('never the secret itself');
    expect(empty).toContain('sp-identity-assignments');
  });
});

describe('Ask has no persona picker', () => {
  it('does not import the identity pane or offer a persona control', () => {
    const home = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
    expect(home).not.toContain('SpIdentity');
    expect(home).not.toContain('sp-identity');
    expect(home).not.toContain('UNASSIGNED_PERSONA');
    expect(home).not.toMatch(/aria-label=\{?['"]Persona/);
  });
});
