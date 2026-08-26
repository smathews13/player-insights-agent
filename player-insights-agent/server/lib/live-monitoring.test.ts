import { describe, expect, it } from 'vitest';
import {
  parseScorerNames,
  probeWorkspaceMonitoring,
  workspaceMonitorFromError,
} from './live-monitoring';

describe('workspace production monitoring probe', () => {
  it('reads scorer names from the list body without inventing any', () => {
    expect(parseScorerNames({ scorers: [{ name: 'guidelines' }, { name: 'relevance' }] })).toEqual([
      'guidelines',
      'relevance',
    ]);
    expect(parseScorerNames({})).toEqual([]);
  });

  it('says blocked when the workspace refuses the list', () => {
    const monitor = workspaceMonitorFromError(new Error('403 PERMISSION_DENIED: missing mlflow scope'));
    expect(monitor.status).toBe('blocked');
    expect(monitor.note).toContain('not available to this app');
    expect(monitor.scorers).toEqual([]);
  });

  it('lists existing scorers when the workspace answers', async () => {
    const monitor = await probeWorkspaceMonitoring(
      {
        apiClient: {
          request: async () => ({ scorers: [{ name: 'guidelines' }] }),
        },
      },
      '123'
    );
    expect(monitor.status).toBe('active');
    expect(monitor.scorers).toEqual(['guidelines']);
  });

  it('does not invent a register when the experiment has none', async () => {
    const monitor = await probeWorkspaceMonitoring(
      {
        apiClient: {
          request: async () => ({ scorers: [] }),
        },
      },
      '123'
    );
    expect(monitor.status).toBe('blocked');
    expect(monitor.note).toContain('notebook');
  });
});
