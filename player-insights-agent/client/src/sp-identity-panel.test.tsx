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
      onAdd={() => {}}
      onRemove={() => {}}
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

  it('lets an administrator name a persona without typing a secret', () => {
    const markup = render(true);
    expect(markup).toContain('aria-label="Persona display name"');
    expect(markup).toContain('aria-label="Service principal application id"');
    expect(markup).toContain('aria-label="Databricks secret scope"');
    expect(markup).toContain('aria-label="Databricks secret key"');
    expect(markup).not.toContain('never the secret itself');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toMatch(/secret value/i);
    expect(JSON.stringify(payloadWithoutSecrets(PAYLOAD))).not.toMatch(/s3cret|client_secret|secretValue/i);
  });

  it('assigns one persona per roster person, with OAuth as the unassigned choice', () => {
    const markup = render(true);
    expect(markup).toContain('ada@example.com');
    expect(markup).toContain('ben@example.com');
    expect(markup).toContain('OAuth (signed-in user)');
    expect(markup).toContain(`aria-label="Persona for ada@example.com: Finance analyst"`);
    expect(markup).toContain(`aria-label="Persona for ben@example.com: OAuth (signed-in user)"`);
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

function payloadWithoutSecrets(payload: SpIdentityAdminPayload): unknown {
  return {
    personas: payload.personas,
    assignments: payload.assignments,
    roster: payload.roster,
  };
}
