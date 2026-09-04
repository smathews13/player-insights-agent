import { Check, ChevronRight, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { BrowseItem, BrowseKind, BrowseResponse, UnityCatalogSearchResponse } from '../../shared/browse-contract';
import type { DeclaredResourceType } from '../../shared/notebook-declaration';
import { PiaLoadingLabel } from './PiaLoadingLabel';
import { BrowseGrantPrompt, mergeBrowseItems } from './AssetPicker';
import { browseUrl, type PickerCursor } from './asset-picker';
import { Dialog } from './Dialog';
import { Button } from './ui';

export type UnityCatalogScopeType = Extract<DeclaredResourceType, 'catalog' | 'schema' | 'table'>;

export interface UnityCatalogExplorerSelection {
  resourceType: UnityCatalogScopeType;
  value: string;
  label: string;
  assetType?: 'table' | 'view';
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

export interface ExplorerResult {
  ok: boolean;
  detail: string;
}

// eslint-disable-next-line react-refresh/only-export-components -- pure staged identity shared with focused tests
export function unityCatalogSelectionKey(selection: Pick<UnityCatalogExplorerSelection, 'resourceType' | 'value'>) {
  return `${selection.resourceType}:${selection.value.trim().toLocaleLowerCase()}`;
}

// eslint-disable-next-line react-refresh/only-export-components -- pure staged selection transition shared with tests
export function toggledUnityCatalogSelection(
  current: ReadonlyMap<string, UnityCatalogExplorerSelection>,
  selection: UnityCatalogExplorerSelection
): Map<string, UnityCatalogExplorerSelection> {
  const next = new Map(current);
  const key = unityCatalogSelectionKey(selection);
  if (next.has(key)) next.delete(key);
  else next.set(key, selection);
  return next;
}

function inferredDeclaredItems(
  kind: Extract<BrowseKind, 'catalogs' | 'schemas' | 'tables'>,
  cursor: PickerCursor,
  declared: readonly UnityCatalogExplorerSelection[]
): BrowseItem[] {
  const values = new Map<string, BrowseItem>();
  for (const selection of declared) {
    const parts = selection.value.split('.');
    if (kind === 'catalogs') {
      const catalog = parts[0];
      if (catalog) {
        values.set(catalog.toLocaleLowerCase(), { id: catalog, label: catalog, secondary: '', expandable: true });
      }
    } else if (kind === 'schemas' && parts[0]?.toLocaleLowerCase() === cursor.catalog.toLocaleLowerCase()) {
      const schema = parts[1];
      if (schema) {
        values.set(schema.toLocaleLowerCase(), {
          id: schema,
          label: schema,
          secondary: `${parts[0]}.${schema}`,
          expandable: true,
        });
      }
    } else if (
      kind === 'tables' &&
      selection.resourceType === 'table' &&
      parts[0]?.toLocaleLowerCase() === cursor.catalog.toLocaleLowerCase() &&
      parts[1]?.toLocaleLowerCase() === cursor.schema.toLocaleLowerCase()
    ) {
      values.set(selection.value.toLocaleLowerCase(), {
        id: selection.value,
        label: parts.slice(2).join('.'),
        secondary: selection.value,
        expandable: false,
      });
    }
  }
  return [...values.values()];
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
  selected,
  busy,
  onToggle,
}: {
  selection: UnityCatalogExplorerSelection;
  state: UnityCatalogExplorerRowState;
  selected: boolean;
  busy: boolean;
  onToggle: (selection: UnityCatalogExplorerSelection) => void;
}) {
  const inScope = !state.selectable;
  const checked = inScope || selected;

  return (
    <span className="uc-explorer-choice-wrap">
      <button
        type="button"
        className="uc-explorer-choice"
        role="checkbox"
        aria-checked={checked}
        aria-label={
          inScope
            ? `${state.label}: ${selection.value}`
            : `${selected ? 'Remove' : 'Select'} ${
                selection.resourceType === 'table' ? 'table or view' : selection.resourceType
              } ${selection.value}`
        }
        disabled={inScope || busy}
        onClick={() => onToggle(selection)}
      >
        <span className="uc-explorer-check" aria-hidden="true">
          {checked ? <Check className="size-3.5" /> : null}
        </span>
        <span>{inScope ? state.label : selected ? 'Selected' : state.label}</span>
      </button>
    </span>
  );
}

function ExplorerNode({
  item,
  resourceType,
  catalog,
  schema,
  busy,
  declared,
  staged,
  scopeState,
  onToggle,
}: {
  item: BrowseItem;
  resourceType: UnityCatalogScopeType;
  catalog: string;
  schema: string;
  busy: boolean;
  declared: readonly UnityCatalogExplorerSelection[];
  staged: ReadonlySet<string>;
  scopeState: (resourceType: UnityCatalogScopeType, value: string) => UnityCatalogExplorerRowState;
  onToggle: (selection: UnityCatalogExplorerSelection) => void;
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
          selection={{
            resourceType,
            value,
            label: item.label,
            assetType: resourceType === 'table' ? (/view/i.test(item.secondary) ? 'view' : 'table') : undefined,
          }}
          state={scopeState(resourceType, value)}
          selected={staged.has(unityCatalogSelectionKey({ resourceType, value }))}
          busy={busy}
          onToggle={onToggle}
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
          declared={declared}
          staged={staged}
          scopeState={scopeState}
          onToggle={onToggle}
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
  declared,
  staged,
  scopeState,
  onToggle,
}: {
  kind: Extract<BrowseKind, 'catalogs' | 'schemas' | 'tables'>;
  cursor: PickerCursor;
  enabled: boolean;
  catalog: string;
  schema: string;
  busy: boolean;
  declared: readonly UnityCatalogExplorerSelection[];
  staged: ReadonlySet<string>;
  scopeState: (resourceType: UnityCatalogScopeType, value: string) => UnityCatalogExplorerRowState;
  onToggle: (selection: UnityCatalogExplorerSelection) => void;
}) {
  const state = useExplorerList(kind, cursor, enabled);
  if (!enabled) return null;
  const resourceType: UnityCatalogScopeType = kind === 'catalogs' ? 'catalog' : kind === 'schemas' ? 'schema' : 'table';
  const items = mergeBrowseItems(state.items, inferredDeclaredItems(kind, cursor, declared));

  return (
    <div className="uc-explorer-level">
      {items.length > 0 ? (
        <ul className="uc-explorer-tree" role={kind === 'catalogs' ? 'tree' : 'group'}>
          {items.map((item) => (
            <ExplorerNode
              key={item.id}
              item={item}
              resourceType={resourceType}
              catalog={catalog}
              schema={schema}
              busy={busy}
              declared={declared}
              staged={staged}
              scopeState={scopeState}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
      {state.status === 'loading' ? (
        <PiaLoadingLabel
          className="uc-explorer-loading"
          label={`Loading ${kind === 'tables' ? 'tables and views' : kind}`}
        />
      ) : null}
      {state.status === 'ok' && items.length === 0 ? (
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
          More results are available. Use search to find a specific asset.
        </p>
      ) : null}
    </div>
  );
}

interface SearchState {
  status: 'idle' | 'loading' | 'ok' | 'unavailable' | 'failed';
  items: UnityCatalogExplorerSelection[];
  detail: string;
  more: boolean;
}

function useUnityCatalogSearch(query: string): SearchState {
  const [state, setState] = useState<SearchState>({ status: 'idle', items: [], detail: '', more: false });
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    const controller = new AbortController();
    const generation = window.setTimeout(() => {
      setState({ status: 'loading', items: [], detail: '', more: false });
      void fetch(`/api/browse/unity-catalog/search?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
      })
        .then(async (answer) => (await answer.json()) as UnityCatalogSearchResponse)
        .then((response) => {
          if (controller.signal.aborted) return;
          if (response.status !== 'ok') {
            setState({ status: response.status, items: [], detail: response.detail, more: false });
            return;
          }
          setState({
            status: 'ok',
            items: response.items.map((item) => ({
              resourceType: item.resource_type,
              value: item.value,
              label: item.label,
              assetType: item.asset_type,
            })),
            detail: '',
            more: response.more_results,
          });
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted) {
            setState({ status: 'failed', items: [], detail: error.message, more: false });
          }
        });
    }, 250);
    return () => {
      window.clearTimeout(generation);
      controller.abort();
    };
  }, [query]);
  return query.trim().length < 2 ? { status: 'idle', items: [], detail: '', more: false } : state;
}

function localSearchMatch(value: string, query: string): boolean {
  const normalize = (candidate: string) =>
    candidate
      .trim()
      .toLocaleLowerCase()
      .replace(/[._\-\s]+/g, ' ')
      .replace(/\s+/g, ' ');
  const needle = normalize(query);
  const candidate = normalize(value);
  return candidate.includes(needle) || candidate.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
}

function ExplorerSearchResults({
  query,
  declared,
  staged,
  busy,
  scopeState,
  onToggle,
  onClear,
}: {
  query: string;
  declared: readonly UnityCatalogExplorerSelection[];
  staged: ReadonlySet<string>;
  busy: boolean;
  scopeState: (resourceType: UnityCatalogScopeType, value: string) => UnityCatalogExplorerRowState;
  onToggle: (selection: UnityCatalogExplorerSelection) => void;
  onClear: () => void;
}) {
  const result = useUnityCatalogSearch(query);
  const items = [
    ...new Map(
      [...result.items, ...declared.filter((item) => localSearchMatch(item.value, query))].map((item) => [
        unityCatalogSelectionKey(item),
        item,
      ])
    ).values(),
  ];
  return (
    <div className="uc-explorer-search-results" aria-live="polite">
      {result.status === 'loading' ? (
        <PiaLoadingLabel label="Searching catalogs, schemas, and tables" className="uc-explorer-loading" />
      ) : null}
      {(['catalog', 'schema', 'table'] as const).map((resourceType) => {
        const group = items.filter((item) => item.resourceType === resourceType);
        if (group.length === 0) return null;
        return (
          <section className="uc-explorer-search-group" key={resourceType}>
            <h3>
              {resourceType === 'table'
                ? 'Tables and views'
                : `${resourceType[0].toUpperCase()}${resourceType.slice(1)}s`}
            </h3>
            <ul>
              {group.map((selection) => (
                <li className="uc-explorer-search-row" key={unityCatalogSelectionKey(selection)}>
                  <span className="connection-row-kind">
                    {resourceType === 'table' ? (selection.assetType === 'view' ? 'View' : 'Table') : resourceType}
                  </span>
                  <span className="uc-explorer-search-value" title={selection.value}>
                    {selection.value}
                  </span>
                  <ExplorerChoice
                    selection={selection}
                    state={scopeState(selection.resourceType, selection.value)}
                    selected={staged.has(unityCatalogSelectionKey(selection))}
                    busy={busy}
                    onToggle={onToggle}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {result.status === 'ok' && items.length === 0 ? (
        <p className="uc-explorer-empty">
          No matching visible assets.{' '}
          <button type="button" onClick={onClear}>
            Clear search to browse the hierarchy.
          </button>
        </p>
      ) : null}
      {result.status === 'unavailable' || result.status === 'failed' ? (
        <p className="uc-explorer-error" role="alert">
          {result.detail}
        </p>
      ) : null}
      {result.more ? <p className="uc-explorer-limit">More results may be available. Refine the search.</p> : null}
    </div>
  );
}

export function UnityCatalogScopeExplorer({
  dialogId,
  busy,
  declared,
  scopeState,
  onSave,
  onClose,
  initialFocusRef,
}: {
  dialogId: string;
  busy: boolean;
  declared: readonly UnityCatalogExplorerSelection[];
  scopeState: (resourceType: UnityCatalogScopeType, value: string) => UnityCatalogExplorerRowState;
  onSave: (selections: readonly UnityCatalogExplorerSelection[]) => Promise<ExplorerResult>;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [staged, setStaged] = useState<Map<string, UnityCatalogExplorerSelection>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submitGate = useRef(false);
  const selectedKeys = new Set(staged.keys());
  const toggle = (selection: UnityCatalogExplorerSelection) => {
    setStaged((current) => toggledUnityCatalogSelection(current, selection));
  };
  const dismiss = () => {
    if (!submitting) onClose();
  };
  return (
    <Dialog
      overlayClassName="uc-explorer-overlay"
      contentClassName="uc-explorer-modal"
      overlayTestId="uc-explorer-overlay"
      labelledBy="uc-explorer-title"
      describedBy="uc-explorer-description"
      initialFocusRef={initialFocusRef ?? searchRef}
      onDismiss={dismiss}
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
            disabled={submitting}
            onClick={dismiss}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <label className="uc-explorer-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search catalogs, schemas, and tables</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search catalogs, schemas, and tables"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="uc-explorer-body">
          <div hidden={query.trim().length >= 2}>
            <ExplorerLevel
              kind="catalogs"
              cursor={{ catalog: '', schema: '' }}
              enabled
              catalog=""
              schema=""
              busy={busy || submitting}
              declared={declared}
              staged={selectedKeys}
              scopeState={scopeState}
              onToggle={toggle}
            />
          </div>
          {query.trim().length >= 2 ? (
            <ExplorerSearchResults
              query={query}
              declared={declared}
              staged={selectedKeys}
              busy={busy || submitting}
              scopeState={scopeState}
              onToggle={toggle}
              onClear={() => setQuery('')}
            />
          ) : null}
        </div>
        <footer className="uc-explorer-footer">
          <span className="uc-explorer-save-status" role={error ? 'alert' : 'status'}>
            {error || `${staged.size} selected`}
          </span>
          <Button type="button" variant="outline" disabled={submitting} onClick={dismiss}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={staged.size === 0 || submitting || busy}
            onClick={() => {
              if (submitGate.current) return;
              submitGate.current = true;
              setSubmitting(true);
              setError('');
              void onSave([...staged.values()])
                .then((result) => {
                  if (result.ok) return;
                  submitGate.current = false;
                  setError(result.detail);
                  setSubmitting(false);
                })
                .catch((caught: Error) => {
                  submitGate.current = false;
                  setError(caught.message || 'The Unity Catalog scope was not saved.');
                  setSubmitting(false);
                });
            }}
          >
            {submitting ? <PiaLoadingLabel as="span" announce={false} label="Saving" /> : 'Save'}
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
