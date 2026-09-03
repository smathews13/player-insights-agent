import { Check, ChevronRight, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { BrowseItem, BrowseKind, BrowseResponse } from '../../shared/browse-contract';
import type { DeclaredResourceType } from '../../shared/notebook-declaration';
import { AstrolabeLoadingLabel } from './AstrolabeLoadingLabel';
import { BrowseGrantPrompt, mergeBrowseItems } from './AssetPicker';
import { browseUrl, type PickerCursor } from './asset-picker';
import { Dialog } from './Dialog';
import { Button } from './ui';

export type UnityCatalogScopeType = Extract<DeclaredResourceType, 'catalog' | 'schema' | 'table'>;

export interface UnityCatalogExplorerSelection {
  resourceType: UnityCatalogScopeType;
  value: string;
  label: string;
}

export interface UnityCatalogExplorerRowState {
  label: string;
  selectable: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components -- pure hierarchy identity shared with focused tests
export function unityCatalogExplorerValue(
  resourceType: UnityCatalogScopeType,
  itemId: string,
  catalog: string
): string {
  return resourceType === 'catalog' ? itemId : resourceType === 'schema' ? `${catalog}.${itemId}` : itemId;
}

interface ExplorerResult {
  ok: boolean;
  detail: string;
}

interface ExplorerListState {
  status: 'idle' | 'loading' | 'ok' | 'unavailable' | 'failed';
  items: BrowseItem[];
  detail: string;
  scope: string;
  reason: 'scope_not_carried' | 'apps_has_no_scope';
  incomplete: boolean;
}

const IDLE_LIST: ExplorerListState = {
  status: 'idle',
  items: [],
  detail: '',
  scope: '',
  reason: 'scope_not_carried',
  incomplete: false,
};

function useExplorerList(kind: BrowseKind, cursor: PickerCursor, enabled: boolean): ExplorerListState {
  const [state, setState] = useState<ExplorerListState>(IDLE_LIST);
  const startedKey = useRef('');
  const settledKey = useRef('');
  const key = browseUrl(kind, cursor);

  useEffect(() => {
    if (!enabled || startedKey.current === key || settledKey.current === key) return;
    startedKey.current = key;
    let live = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(new DOMException('Resource discovery timed out', 'TimeoutError')),
      15_000
    );

    const run = async () => {
      let page = 1;
      let token = '';
      let items: BrowseItem[] = [];
      const seenTokens = new Set<string>();
      setState({ ...IDLE_LIST, status: 'loading' });
      try {
        while (!controller.signal.aborted) {
          const joiner = key.includes('?') ? '&' : '?';
          const url = token ? `${key}${joiner}page_token=${encodeURIComponent(token)}&page=${page}` : key;
          const answer = await fetch(url, { signal: controller.signal });
          if (!answer.ok) throw new Error(`resource discovery answered ${answer.status}`);
          const response = (await answer.json()) as BrowseResponse;
          if (!live) return;
          if (response.status === 'unavailable') {
            settledKey.current = key;
            setState({
              ...IDLE_LIST,
              status: 'unavailable',
              detail: response.detail,
              scope: response.scope,
              reason: response.reason,
            });
            return;
          }
          if (response.status === 'failed') {
            setState({ ...IDLE_LIST, status: 'failed', items, detail: response.detail });
            return;
          }
          items = mergeBrowseItems(items, response.items);
          const nextToken = response.next_page_token;
          const atBound = response.pagination.page >= response.pagination.page_limit;
          setState({
            ...IDLE_LIST,
            status: nextToken && !atBound ? 'loading' : 'ok',
            items,
            incomplete: Boolean(nextToken && atBound),
          });
          if (!nextToken || atBound) {
            settledKey.current = key;
            return;
          }
          if (seenTokens.has(nextToken)) {
            setState({ ...IDLE_LIST, status: 'failed', items, detail: 'Resource discovery repeated a page.' });
            return;
          }
          seenTokens.add(nextToken);
          token = nextToken;
          page += 1;
        }
      } catch (caught) {
        const abortReason = controller.signal.reason as Error | undefined;
        if (!live || (controller.signal.aborted && abortReason?.name !== 'TimeoutError')) return;
        setState({
          ...IDLE_LIST,
          status: 'failed',
          items,
          detail:
            abortReason?.name === 'TimeoutError'
              ? 'Resource discovery reached its deadline.'
              : ((caught as Error).message ?? 'Resource discovery failed.'),
        });
      } finally {
        window.clearTimeout(timeout);
      }
    };

    void run();
    return () => {
      live = false;
      startedKey.current = '';
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [enabled, key, kind]);

  return state;
}

function ExplorerChoice({
  selection,
  state,
  busy,
  onAdd,
}: {
  selection: UnityCatalogExplorerSelection;
  state: UnityCatalogExplorerRowState;
  busy: boolean;
  onAdd: (selection: UnityCatalogExplorerSelection) => Promise<ExplorerResult>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inScope = !state.selectable;

  return (
    <span className="uc-explorer-choice-wrap">
      <button
        type="button"
        className="uc-explorer-choice"
        role="checkbox"
        aria-checked={inScope}
        aria-label={
          inScope
            ? `${state.label}: ${selection.value}`
            : `Add ${selection.resourceType === 'table' ? 'table or view' : selection.resourceType} ${selection.value}`
        }
        disabled={inScope || busy || saving}
        onClick={() => {
          setSaving(true);
          setError('');
          void onAdd(selection).then((result) => {
            if (!result.ok) setError(result.detail);
            setSaving(false);
          });
        }}
      >
        <span className="uc-explorer-check" aria-hidden="true">
          {inScope ? <Check className="size-3.5" /> : null}
        </span>
        <span>{saving ? 'Saving…' : state.label}</span>
      </button>
      {error ? (
        <span className="uc-explorer-row-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function ExplorerNode({
  item,
  resourceType,
  catalog,
  schema,
  busy,
  scopeState,
  onAdd,
}: {
  item: BrowseItem;
  resourceType: UnityCatalogScopeType;
  catalog: string;
  schema: string;
  busy: boolean;
  scopeState: (resourceType: UnityCatalogScopeType, value: string) => UnityCatalogExplorerRowState;
  onAdd: (selection: UnityCatalogExplorerSelection) => Promise<ExplorerResult>;
}) {
  const [expanded, setExpanded] = useState(false);
  const branch = resourceType !== 'table';
  const value = unityCatalogExplorerValue(resourceType, item.id, catalog);
  const childKind: BrowseKind = resourceType === 'catalog' ? 'schemas' : 'tables';
  const childCursor: PickerCursor =
    resourceType === 'catalog' ? { catalog: item.id, schema: '' } : { catalog, schema: item.id };

  return (
    <li
      className={`uc-explorer-node uc-explorer-node--${resourceType}`}
      role="treeitem"
      aria-expanded={branch ? expanded : undefined}
      aria-level={resourceType === 'catalog' ? 1 : resourceType === 'schema' ? 2 : 3}
    >
      <div className="uc-explorer-row">
        {branch ? (
          <button
            type="button"
            className="uc-explorer-expand"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${resourceType} ${value}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((shown) => !shown)}
          >
            <ChevronRight className={expanded ? 'rotate-90' : ''} aria-hidden="true" />
          </button>
        ) : (
          <span className="uc-explorer-leaf-spacer" aria-hidden="true" />
        )}
        <span className="connection-row-kind">
          {resourceType === 'table' ? 'Table/view' : resourceType === 'schema' ? 'Schema' : 'Catalog'}
        </span>
        <span className="uc-explorer-name" title={value}>
          {item.label}
        </span>
        {item.secondary ? <span className="uc-explorer-secondary">{item.secondary}</span> : null}
        <ExplorerChoice
          selection={{ resourceType, value, label: item.label }}
          state={scopeState(resourceType, value)}
          busy={busy}
          onAdd={onAdd}
        />
      </div>
      {branch ? (
        <ExplorerLevel
          kind={childKind}
          cursor={childCursor}
          enabled={expanded}
          catalog={resourceType === 'catalog' ? item.id : catalog}
          schema={resourceType === 'schema' ? item.id : schema}
          busy={busy}
          scopeState={scopeState}
          onAdd={onAdd}
        />
      ) : null}
    </li>
  );
}

function ExplorerLevel({
  kind,
  cursor,
  enabled,
  catalog,
  schema,
  busy,
  scopeState,
  onAdd,
}: {
  kind: Extract<BrowseKind, 'catalogs' | 'schemas' | 'tables'>;
  cursor: PickerCursor;
  enabled: boolean;
  catalog: string;
  schema: string;
  busy: boolean;
  scopeState: (resourceType: UnityCatalogScopeType, value: string) => UnityCatalogExplorerRowState;
  onAdd: (selection: UnityCatalogExplorerSelection) => Promise<ExplorerResult>;
}) {
  const state = useExplorerList(kind, cursor, enabled);
  if (!enabled) return null;
  const resourceType: UnityCatalogScopeType = kind === 'catalogs' ? 'catalog' : kind === 'schemas' ? 'schema' : 'table';

  return (
    <div className="uc-explorer-level">
      {state.items.length > 0 ? (
        <ul className="uc-explorer-tree" role={kind === 'catalogs' ? 'tree' : 'group'}>
          {state.items.map((item) => (
            <ExplorerNode
              key={item.id}
              item={item}
              resourceType={resourceType}
              catalog={catalog}
              schema={schema}
              busy={busy}
              scopeState={scopeState}
              onAdd={onAdd}
            />
          ))}
        </ul>
      ) : null}
      {state.status === 'loading' ? (
        <AstrolabeLoadingLabel
          className="uc-explorer-loading"
          label={`Loading ${kind === 'tables' ? 'tables and views' : kind}`}
        />
      ) : null}
      {state.status === 'ok' && state.items.length === 0 ? (
        <p className="uc-explorer-empty">No {kind === 'tables' ? 'tables or views' : kind} are visible here.</p>
      ) : null}
      {state.status === 'unavailable' ? (
        <BrowseGrantPrompt scope={state.scope} detail={state.detail} reason={state.reason} />
      ) : null}
      {state.status === 'failed' ? (
        <p className="uc-explorer-error" role="alert">
          {state.detail}
        </p>
      ) : null}
      {state.incomplete ? (
        <p className="uc-explorer-limit" role="status">
          This level reached the bounded discovery limit. Additional assets were not hidden as a complete result.
        </p>
      ) : null}
    </div>
  );
}

export function UnityCatalogScopeExplorer({
  dialogId,
  busy,
  scopeState,
  onAdd,
  onClose,
  initialFocusRef,
}: {
  dialogId: string;
  busy: boolean;
  scopeState: (resourceType: UnityCatalogScopeType, value: string) => UnityCatalogExplorerRowState;
  onAdd: (selection: UnityCatalogExplorerSelection) => Promise<ExplorerResult>;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog
      overlayClassName="uc-explorer-overlay"
      contentClassName="uc-explorer-modal"
      overlayTestId="uc-explorer-overlay"
      labelledBy="uc-explorer-title"
      describedBy="uc-explorer-description"
      initialFocusRef={initialFocusRef ?? closeRef}
      onDismiss={onClose}
    >
      <div id={dialogId} className="uc-explorer-frame">
        <header className="uc-explorer-header">
          <div>
            <h2 id="uc-explorer-title">Add Unity Catalog asset</h2>
            <p id="uc-explorer-description">
              Declaring an asset does not grant Unity Catalog permissions or change the deployed agent model.
            </p>
          </div>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon-sm"
            aria-label="Close Add Unity Catalog asset"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="uc-explorer-body">
          <ExplorerLevel
            kind="catalogs"
            cursor={{ catalog: '', schema: '' }}
            enabled
            catalog=""
            schema=""
            busy={busy}
            scopeState={scopeState}
            onAdd={onAdd}
          />
        </div>
      </div>
    </Dialog>
  );
}
