import { describe, expect, it, vi } from 'vitest';
import { createDeclaredConnectionsBatch, type CreateConnectionInput } from './declared-connection-form';

const INPUTS: CreateConnectionInput[] = [
  {
    id: 'catalog-demo',
    label: 'Demo',
    kind: 'unity-catalog',
    resourceType: 'catalog',
    value: 'demo',
  },
  {
    id: 'schema-demo-reporting',
    label: 'Reporting',
    kind: 'unity-catalog',
    resourceType: 'schema',
    value: 'demo.reporting',
  },
];

describe('the Unity Catalog batch client', () => {
  it('submits a multi-selection as one request', async () => {
    const entries = INPUTS.map((input, index) => ({
      connection: {
        ...input,
        note: '',
        state: 'declared' as const,
        origin: 'app' as const,
        createdAt: `2026-09-03T20:00:0${index}.000Z`,
        createdBy: 'admin@example.invalid',
      },
      impact: { headline: 'Remove asset.', consequences: [], recoverable: false },
    }));
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ connections: entries }), { status: 201 }))
    );
    await expect(createDeclaredConnectionsBatch(INPUTS, fetchImpl as typeof fetch)).resolves.toEqual({
      ok: true,
      entries,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/settings/connections/batch',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ connections: INPUTS }) })
    );
  });

  it('returns no rows when the atomic save fails', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'Nothing was added.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    await expect(createDeclaredConnectionsBatch(INPUTS, fetchImpl as typeof fetch)).resolves.toEqual({
      ok: false,
      detail: 'Nothing was added.',
    });
  });
});
