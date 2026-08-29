import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  defaultEgressControls,
  EGRESS_PATHS,
  type EgressControls,
  type EgressStorageMetadata,
} from '../../shared/egress-contract';
import { egressControlsFromResponse, fetchEgressRecordsPage, retainPendingEgressDrafts } from './egress-settings-api';

const PANEL = readFileSync(new URL('./EgressPanel.tsx', import.meta.url), 'utf8');
const STORAGE: EgressStorageMetadata = {
  store: 'Lakebase (Postgres)',
  eventsTable: 'player_insights.egress_events',
  controlsTable: 'player_insights.egress_controls',
  retained: 'Event metadata and policy decisions.',
  retention: 'No automatic expiry is configured in this app.',
  identityScope: 'Rows are scoped to this app deployment and signed-in email.',
};

function payload(controls: EgressControls = defaultEgressControls(), stored = true): Response {
  return Response.json({ controls, stored, paths: EGRESS_PATHS, storage: STORAGE });
}

describe('Egress Settings API responses', () => {
  it('loads the complete current policy used to seed editable controls', async () => {
    const controls = { ...defaultEgressControls(), 'chart-image': true };
    await expect(egressControlsFromResponse(payload(controls), 'loaded')).resolves.toEqual({
      controls,
      stored: true,
      storage: STORAGE,
    });
  });

  it('accepts a successful save snapshot and preserves its storage status', async () => {
    const controls = { ...defaultEgressControls(), 'workspace-link': false };
    await expect(egressControlsFromResponse(payload(controls, false), 'saved')).resolves.toEqual({
      controls,
      stored: false,
      storage: STORAGE,
    });
  });

  it('surfaces the server refusal and rejects incomplete success payloads', async () => {
    await expect(
      egressControlsFromResponse(
        Response.json({ detail: 'Only administrators can change egress controls.' }, { status: 403 }),
        'saved'
      )
    ).rejects.toThrow('Only administrators can change egress controls.');

    await expect(
      egressControlsFromResponse(Response.json({ controls: { 'chart-image': true }, stored: true }), 'saved')
    ).rejects.toThrow('incomplete controls payload');
  });

  it('keeps only unsaved drafts after one of several writes fails', () => {
    const original = defaultEgressControls();
    const draft = { ...original, 'chart-image': !original['chart-image'], 'workspace-link': false };
    const afterFirstWrite = { ...original, 'chart-image': draft['chart-image'] };

    expect(retainPendingEgressDrafts(draft, afterFirstWrite, new Set(['workspace-link']))).toEqual({
      ...afterFirstWrite,
      'workspace-link': false,
    });
  });

  it('keeps panel reads open and writes on the admin route with footer feedback', () => {
    expect(PANEL).toContain("fetch('/api/egress/controls'");
    expect(PANEL).toContain("fetch('/api/egress/admin/controls'");
    expect(PANEL).toContain("onSaveState({ kind: 'saved'");
    expect(PANEL).toContain("onSaveState({ kind: 'failed'");
    expect(PANEL).toContain('retainPendingEgressDrafts');
  });

  it('loads only the fixed recent-records endpoint and encodes the opaque cursor', async () => {
    const calls: string[] = [];
    const fetcher = ((input: string | URL | Request) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return Promise.resolve(
        Response.json({
          events: [],
          readState: 'read',
          pageSize: 20,
          nextCursor: null,
          readAt: '2026-08-28T00:00:00.000Z',
          storage: STORAGE,
        })
      );
    }) as typeof fetch;

    await fetchEgressRecordsPage('cursor+/=', fetcher);

    expect(calls).toEqual(['/api/egress/admin/events?limit=20&cursor=cursor%2B%2F%3D']);
    expect(calls[0]).not.toMatch(/sql|statement|table=/i);
  });

  it('separates authorization from a records response failure', async () => {
    const forbidden = (() =>
      Promise.resolve(
        Response.json({ detail: 'Only administrators can view egress records.' }, { status: 403 })
      )) as typeof fetch;
    const failed = (() =>
      Promise.resolve(Response.json({ detail: 'Lakebase unavailable.' }, { status: 503 }))) as typeof fetch;

    await expect(fetchEgressRecordsPage(null, forbidden)).rejects.toMatchObject({
      kind: 'authorization',
      message: 'Only administrators can view egress records.',
    });
    await expect(fetchEgressRecordsPage(null, failed)).rejects.toMatchObject({
      kind: 'response',
      message: 'Lakebase unavailable.',
    });
  });
});
