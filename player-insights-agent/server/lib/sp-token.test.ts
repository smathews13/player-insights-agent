import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetSpTokens, mintPersonaToken, SP_TOKEN_CACHE_MAX_ENTRIES } from './sp-token';
import type { SpPersona } from '../../shared/sp-identity';

const ENV = {
  DATABRICKS_HOST: 'https://workspace.example.com',
  DATABRICKS_CLIENT_ID: 'app-client',
  DATABRICKS_CLIENT_SECRET: 'app-secret',
};

function persona(id: string): SpPersona {
  return {
    id,
    displayName: id,
    clientId: `client-${id}`,
    secretScope: 'personas',
    secretKey: id,
    updatedAt: '',
    updatedBy: '',
  };
}

beforeEach(() => {
  forgetSpTokens();
});

describe('the persona token cache', () => {
  it('reuses only until the issuer lifetime reaches the safety skew', async () => {
    let now = 1_000;
    const exchange = vi.fn(() =>
      Promise.resolve({ token: `token-${exchange.mock.calls.length}`, expiresInSeconds: 120 })
    );
    const deps = { env: ENV, now: () => now, readSecret: () => Promise.resolve('secret'), exchange };

    await mintPersonaToken(persona('one'), deps);
    now += 59_999;
    await mintPersonaToken(persona('one'), deps);
    expect(exchange).toHaveBeenCalledOnce();

    now += 1;
    await mintPersonaToken(persona('one'), deps);
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently-used tokens at the explicit global maximum', async () => {
    const exchange = vi.fn(({ clientId }: { clientId: string }) =>
      Promise.resolve({
        token: `token-${clientId}`,
        expiresInSeconds: 3_600,
      })
    );
    const deps = { env: ENV, now: () => 0, readSecret: () => Promise.resolve('secret'), exchange };

    for (let index = 0; index < SP_TOKEN_CACHE_MAX_ENTRIES; index += 1) {
      await mintPersonaToken(persona(`persona-${index}`), deps);
    }
    await mintPersonaToken(persona('persona-0'), deps);
    await mintPersonaToken(persona('overflow'), deps);
    await mintPersonaToken(persona('persona-1'), deps);

    expect(exchange).toHaveBeenCalledTimes(SP_TOKEN_CACHE_MAX_ENTRIES + 2);
  });
});
