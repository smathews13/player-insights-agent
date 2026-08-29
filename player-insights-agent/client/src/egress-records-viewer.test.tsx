import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EgressEventsPayload } from '../../shared/egress-contract';
import { EgressRecordsViewer, EgressStorageMetadataCard, type EgressRecordsViewState } from './EgressPanel';

const PAGE: EgressEventsPayload = {
  events: [],
  readState: 'read',
  pageSize: 20,
  nextCursor: null,
  readAt: '2026-08-28T00:00:00.000Z',
  storage: {
    store: 'Lakebase (Postgres)',
    eventsTable: 'player_insights.egress_events',
    controlsTable: 'player_insights.egress_controls',
    retained: 'Event metadata.',
    retention: 'No automatic expiry is configured in this app.',
    identityScope: 'This app deployment.',
  },
};

function viewer(state: EgressRecordsViewState, payload: EgressEventsPayload | null = null, error = '') {
  return (
    <EgressRecordsViewer
      state={state}
      payload={payload}
      error={error}
      page={0}
      onView={() => {}}
      onRefresh={() => {}}
      onNewer={() => {}}
      onOlder={() => {}}
    />
  );
}

interface ClickableProps {
  children?: ReactNode;
  onClick?: () => void;
}

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement<ClickableProps>(node)) return '';
  return Children.toArray(node.props.children).map(text).join('');
}

function button(node: ReactNode, label: string): ReactElement<ClickableProps> | null {
  if (!isValidElement<ClickableProps>(node)) return null;
  if (node.type === 'button' && text(node) === label) return node;
  for (const child of Children.toArray(node.props.children)) {
    const found = button(child, label);
    if (found) return found;
  }
  return null;
}

describe('egress records viewer states', () => {
  it('renders exact logical tables, retention and deployment identity scope compactly', () => {
    const markup = renderToStaticMarkup(<EgressStorageMetadataCard storage={PAGE.storage} />);
    expect(markup).toContain('player_insights.egress_events');
    expect(markup).toContain('player_insights.egress_controls');
    expect(markup).toContain('No automatic expiry is configured in this app.');
    expect(markup).toContain('This app deployment.');
    expect(markup).not.toMatch(/password|token|hostname/i);
  });

  it.each([
    ['idle', null, '', 'View records'],
    ['loading', null, '', 'Loading egress records.'],
    ['authorization', null, '', 'Administrator access is required'],
    ['error', null, 'The record read failed.', 'The record read failed.'],
  ] as const)('renders the %s state', (state, payload, error, expected) => {
    expect(renderToStaticMarkup(viewer(state, payload, error))).toContain(expected);
  });

  it('separates empty, unavailable and not-migrated results', () => {
    expect(renderToStaticMarkup(viewer('ready', PAGE))).toContain('No reported egress records');
    expect(renderToStaticMarkup(viewer('ready', { ...PAGE, readState: 'unavailable' }))).toContain(
      'Lakebase did not answer'
    );
    expect(renderToStaticMarkup(viewer('ready', { ...PAGE, readState: 'not-migrated' }))).toContain(
      'has not been migrated'
    );
  });

  it('renders record metadata and pagination without exported content', () => {
    const payload: EgressEventsPayload = {
      ...PAGE,
      nextCursor: 'next-page',
      events: [
        {
          id: 'event-1',
          occurredAt: '2026-08-28T00:00:00.000Z',
          actor: 'analyst@example.invalid',
          channel: 'identifier',
          shape: 'identifier',
          outcome: 'left',
          surface: '/runs',
          runId: 'run-1',
          conversationId: null,
          itemCount: 1,
        },
      ],
    };
    const markup = renderToStaticMarkup(viewer('ready', payload));

    expect(markup).toContain('analyst@example.invalid');
    expect(markup).toContain('Run linked');
    expect(markup).not.toContain('run-1');
    expect(markup).toContain('Reported');
    expect(markup).toContain('Newer');
    expect(markup).toContain('Older');
    expect(markup).not.toMatch(/payload|exported content/i);
  });

  it('wires view, refresh and pagination buttons to explicit actions', () => {
    const onView = vi.fn();
    const onRefresh = vi.fn();
    const onNewer = vi.fn();
    const onOlder = vi.fn();
    const idle = EgressRecordsViewer({
      state: 'idle',
      payload: null,
      error: '',
      page: 0,
      onView,
      onRefresh,
      onNewer,
      onOlder,
    });
    button(idle, 'View records')?.props.onClick?.();
    expect(onView).toHaveBeenCalledOnce();

    const ready = EgressRecordsViewer({
      state: 'ready',
      payload: { ...PAGE, nextCursor: 'next-page' },
      error: '',
      page: 1,
      onView,
      onRefresh,
      onNewer,
      onOlder,
    });
    button(ready, 'Refresh')?.props.onClick?.();
    button(ready, 'Newer')?.props.onClick?.();
    button(ready, 'Older')?.props.onClick?.();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onNewer).toHaveBeenCalledOnce();
    expect(onOlder).toHaveBeenCalledOnce();
  });
});
