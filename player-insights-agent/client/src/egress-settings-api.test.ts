import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { defaultEgressControls, EGRESS_PATHS, type EgressControls } from '../../shared/egress-contract';
import { egressControlsFromResponse, retainPendingEgressDrafts } from './egress-settings-api';

const PANEL = readFileSync(new URL('./EgressPanel.tsx', import.meta.url), 'utf8');

function payload(controls: EgressControls = defaultEgressControls(), stored = true): Response {
  return Response.json({ controls, stored, paths: EGRESS_PATHS });
}

describe('Egress Settings API responses', () => {
  it('loads the complete current policy used to seed editable controls', async () => {
    const controls = { ...defaultEgressControls(), 'chart-image': true };
    await expect(egressControlsFromResponse(payload(controls), 'loaded')).resolves.toEqual({
      controls,
      stored: true,
    });
  });

  it('accepts a successful save snapshot and preserves its storage status', async () => {
    const controls = { ...defaultEgressControls(), 'workspace-link': false };
    await expect(egressControlsFromResponse(payload(controls, false), 'saved')).resolves.toEqual({
      controls,
      stored: false,
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
});
