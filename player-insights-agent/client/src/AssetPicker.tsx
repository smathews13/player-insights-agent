/**
 * Pick a workspace asset instead of remembering its identifier.
 *
 * WHAT THIS REPLACES. Every editable row on Connections opened one blank text
 * box. The values it wanted were a Genie space id, a SQL warehouse id, a serving
 * endpoint name and three-part Unity Catalog names, out of a workspace the
 * operator was already signed in to and looking at in another tab. So the box was
 * filled by pasting, and a paste with a stray space in it saved cleanly and
 * failed later somewhere else.
 *
 * THE TEXT BOX DID NOT GO. It sits under the browser on every field, for two
 * reasons that are not the same reason. The first is the fallback: catalog and
 * workspace browse ride optional OAuth scopes, and a sign-in that does not carry
 * them cannot list anything, so typing has to stay reachable or the row becomes
 * uneditable for the deployments that most need editing. The second is
 * `catalog_denylist`, where typing is not a fallback at all: an entry may be a
 * pattern, and no list of tables that exist today can offer one.
 *
 * THE THREE OUTCOMES ARE DRAWN AS THREE THINGS. `shared/browse-contract.ts` keeps
 * `ok`, `unavailable` and `failed` apart, and the value of that separation is
 * spent here or nowhere: an empty `ok` says the workspace answered and there is
 * nothing visible, `unavailable` says nobody looked and offers the permission
 * that would let them, and `failed` says the call broke. A reader is never shown
 * an empty list on the strength of a 403.
 *
 * WHICH LIST, AND WHAT A PICK MEANS, ARE NOT DECIDED HERE. They are in
 * `asset-picker.ts`, which is pure, because the decisions worth asserting are
 * whether a pick is added to a list or replaces it, and whether a `data_catalogs`
 * pick opened one schema or every schema in a catalog. Neither is visible in
 * markup, and both are wrong in a way nobody notices until a customer asks what
 * they granted.
 *
 * NO ANIMATION OF ITS OWN, so there is nothing here for reduced motion to
 * suppress. The list appears when it arrives.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { Button, Input } from './ui';
import { PiaBusyButtonContent } from './PiaLoader';
import { PiaLoadingLabel } from './PiaLoadingLabel';
import type { BrowseItem, BrowseResponse } from '../../shared/browse-contract';
import {
  pickerForField,
  BROWSE_APPS_NO_SCOPE_PROMPT,
  BROWSE_FAILED_CHIP,
  BROWSE_GRANT_PROMPT,
  BROWSE_UNAVAILABLE_CHIP,
  browseEmptyNote,
  browsePageUrl,
  browseTransportFailure,
  browseUrl,
  cursorKind,
  cursorTrail,
  filterItems,
  initialCursor,
  orderPickerItems,
  pickerRowText,
  rowActions,
  alreadyHeld,
  applyPick,
  type AssetPickerSpec,
  type PickerCursor,
  UNITY_CATALOG_ASSET_PICKER,
} from './asset-picker';

/**
 * The row a pick came from, and the list it was found in.
 *
 * Optional on every `onPick`, because most callers want only the string. Two
 * things need more than the string: a caller that has to LABEL what was picked
 * (a Genie space stores a hex id and is recognised by its title), and a caller
 * that has to build an identifier a leaf name alone does not carry (a volume is
 * named by the catalog and schema it sits in).
 */
export interface PickedRow {
  item: BrowseItem;
  cursor: PickerCursor;
}

export interface AssetPickerRowState {
  label: string;
  selectable: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components -- pure pagination helper shared with focused tests
export function mergeBrowseItems(current: readonly BrowseItem[], incoming: readonly BrowseItem[]): BrowseItem[] {
  const merged = new Map(current.map((item) => [item.id.trim(), item]));
  for (const item of incoming) {
    const key = item.id.trim();
    if (key && !merged.has(key)) merged.set(key, item);
  }
  return [...merged.values()];
}

// eslint-disable-next-line react-refresh/only-export-components -- pure pagination helper shared with focused tests
export function shouldAutoAdvanceEmptyPage(response: BrowseResponse | null): boolean {
  return Boolean(
    response?.status === 'ok' &&
      response.items.length === 0 &&
      response.next_page_token &&
      response.pagination.incomplete_reason === 'more_available' &&
      response.pagination.page < response.pagination.page_limit
  );
}

/**
 * The permission a list needs, as a prompt rather than as a finding.
 *
 * Neutral pill, and the same one the login gate gives an ungranted optional
 * scope. A red Missing here would send a reader to an admin about a permission
 * this app records as optional, which is the mistake the Connections page spent a
 * whole pass removing from its "What to fix" panel.
 *
 * When Apps itself has no scope for the family (`apps_has_no_scope`), there is
 * nothing to grant: the heading says so and the grant-action paragraph is
 * omitted.
 */
export function BrowseGrantPrompt({
  scope,
  detail,
  reason = 'scope_not_carried',
}: {
  scope: string;
  detail: string;
  reason?: 'scope_not_carried' | 'apps_has_no_scope';
}) {
  const noAppsScope = reason === 'apps_has_no_scope';
  return (
    <div className="asset-picker-grant" data-testid="asset-picker-grant">
      <p className="asset-picker-grant-head">
        <span className="asset-picker-grant-label">
          {noAppsScope ? BROWSE_APPS_NO_SCOPE_PROMPT : BROWSE_GRANT_PROMPT}
        </span>
        {scope ? <code>{scope}</code> : null}
        <span className="ast-pill ast-pill--neutral">{BROWSE_UNAVAILABLE_CHIP}</span>
      </p>
      {/* The server's own sentence, verbatim. It names the scope and states that
          nothing was established about which assets exist, and rewording it here
          would be a second copy of a vocabulary this repository has already got
          wrong twice. */}
      {detail ? <p className="asset-picker-grant-detail">{detail}</p> : null}
    </div>
  );
}

/**
 * One row: what it is, what it stores, and what taking it would do.
 *
 * The identifier is printed under the name rather than instead of it, which is
 * the whole point of a picker for a Genie space: the operator knows the title and
 * the setting stores an opaque id. Where the workspace reported no name, the row
 * says so instead of presenting the id as one.
 */
export function AssetPickerRow({
  spec,
  cursor,
  item,
  current,
  onOpen,
  onPick,
  rowState,
}: {
  spec: AssetPickerSpec;
  cursor: PickerCursor;
  item: BrowseItem;
  current: string;
  onOpen: (next: PickerCursor) => void;
  onPick: (value: string, picked?: PickedRow) => void;
  rowState?: (value: string, picked: PickedRow) => AssetPickerRowState;
}) {
  const kind = cursorKind(spec, cursor);
  const text = pickerRowText(kind, item);
  const actions = rowActions(spec, cursor, item);
  const unityCatalogType = kind === 'catalogs' ? 'catalog' : kind === 'schemas' ? 'schema' : 'table/view';
  const pickAction = actions.find((action) => action.kind === 'pick');
  const state = pickAction?.kind === 'pick' ? rowState?.(pickAction.value, { item, cursor }) : undefined;
  const warehousePick = kind === 'warehouses' ? actions.find((action) => action.kind === 'pick') : undefined;
  const selected = actions.some((action) => action.kind === 'pick' && alreadyHeld(spec, current, action.value));
  if (warehousePick?.kind === 'pick') {
    return (
      <li className="asset-picker-row asset-picker-row--warehouse" data-selected={selected ? 'true' : undefined}>
        <label className="warehouse-picker-choice">
          <input
            type="radio"
            name={`warehouse-${spec.field}`}
            value={warehousePick.value}
            checked={selected}
            onChange={() => onPick(warehousePick.value, { item, cursor })}
            aria-label={`Choose SQL warehouse ${text.primary}`}
          />
          <span className="asset-picker-row-names">
            <span className="asset-picker-row-name">{text.primary}</span>
            {text.identifier ? <code className="asset-picker-row-id">{text.identifier}</code> : null}
          </span>
          {text.secondary ? (
            <span
              className={`warehouse-picker-status ast-pill ${
                text.secondary.trim().toUpperCase() === 'RUNNING' ? 'ast-pill--pos' : 'ast-pill--neutral'
              }`}
            >
              {text.secondary}
            </span>
          ) : null}
        </label>
      </li>
    );
  }
  return (
    <li
      className="asset-picker-row"
      data-testid={`asset-picker-row-${item.id}`}
      data-selected={selected ? 'true' : undefined}
      aria-current={selected ? 'true' : undefined}
      title={[text.primary, text.identifier, text.secondary].filter(Boolean).join(' · ')}
    >
      <span className="asset-picker-row-names">
        {spec.field === UNITY_CATALOG_ASSET_PICKER.field ? (
          <span className="connection-row-kind">
            {unityCatalogType === 'table/view' ? 'Table/view' : unityCatalogType === 'schema' ? 'Schema' : 'Catalog'}
          </span>
        ) : null}
        <span className="asset-picker-row-name">{text.primary}</span>
        {text.identifier ? <code className="asset-picker-row-id">{text.identifier}</code> : null}
        {text.secondary ? <span className="asset-picker-row-aside">{text.secondary}</span> : null}
        {state ? <span className="asset-picker-row-state">{state.label}</span> : null}
      </span>
      <span className="asset-picker-row-actions">
        {actions.map((action) =>
          action.kind === 'open' ? (
            <Button
              key="open"
              variant="ghost"
              size="sm"
              onClick={() => onOpen(action.cursor)}
              aria-label={
                spec.field === UNITY_CATALOG_ASSET_PICKER.field
                  ? `Browse ${unityCatalogType} ${text.primary}`
                  : `Open ${text.primary}`
              }
            >
              {action.label}
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </Button>
          ) : (
            <span key={`pick-${action.value}`} className="asset-picker-row-pick">
              <Button
                variant="outline"
                size="sm"
                disabled={alreadyHeld(spec, current, action.value) || state?.selectable === false}
                // The row and where it was found travel with the value. The
                // setting stores an id; what a reader recognises is the name
                // beside it, and a caller that keeps only the id has to print
                // the id back at them. The cursor is here for the same reason:
                // a volume row is a leaf name, and only the catalog and schema
                // it was found in make it into an identifier.
                onClick={() => onPick(applyPick(spec, current, action.value), { item, cursor })}
                aria-label={
                  spec.field === UNITY_CATALOG_ASSET_PICKER.field
                    ? `Select ${unityCatalogType} ${action.value}`
                    : `${action.label}: ${action.value}`
                }
              >
                {action.label}
              </Button>
              {/* THE BLAST RADIUS, BESIDE THE BUTTON THAT COMMITS IT. Only
                  `data_catalogs` carries one, and it is the difference between
                  opening one schema and opening every non-system schema in a
                  catalog. The words are the page's own, from
                  shared/data-catalog-scope.ts. */}
              {action.note ? <span className="asset-picker-row-note">{action.note}</span> : null}
            </span>
          )
        )}
      </span>
    </li>
  );
}

/**
 * The browser with an answer already in hand.
 *
 * Split from the fetching below so every one of its states can be composed in a
 * test. `renderToStaticMarkup` runs no effects, so a browser that fetched its own
 * list could only ever be asserted in its loading state, and the states that
 * matter here are the three the contract distinguishes.
 */
export function AssetPickerPanel({
  spec,
  cursor,
  current,
  response,
  loading,
  query,
  onQuery,
  onOpen,
  onPick,
  onRetry,
  onMore,
  loadingMore = false,
  rowState,
}: {
  spec: AssetPickerSpec;
  cursor: PickerCursor;
  /** The draft the editor holds, so a row can say it is already taken. */
  current: string;
  response: BrowseResponse | null;
  loading: boolean;
  query: string;
  onQuery: (next: string) => void;
  onOpen: (next: PickerCursor) => void;
  onPick: (value: string, picked?: PickedRow) => void;
  onRetry: () => void;
  onMore: () => void;
  loadingMore?: boolean;
  rowState?: (value: string, picked: PickedRow) => AssetPickerRowState;
}) {
  const kind = cursorKind(spec, cursor);
  const trail = cursorTrail(spec, cursor);
  const items = response && response.status === 'ok' ? response.items : [];
  const shown = orderPickerItems(kind, filterItems(items, query));

  return (
    <div className="asset-picker" data-testid={`asset-picker-${spec.field}`} data-kind={kind}>
      <div className="asset-picker-head">
        <p className="asset-picker-title">{spec.title}</p>
        {/* Where the reader is, and the way back out. Drawn only for the chained
            lists, and always including the top: a browser that opened inside the
            configured catalog is otherwise one the reader cannot leave. */}
        {trail.length > 1 ? (
          <nav className="asset-picker-trail" aria-label="Where you are">
            {trail.map((step, index) => (
              <span key={step.label} className="asset-picker-trail-step">
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                <button
                  type="button"
                  className="asset-picker-trail-link"
                  disabled={index === trail.length - 1}
                  onClick={() => onOpen(step.cursor)}
                >
                  {step.label}
                </button>
              </span>
            ))}
          </nav>
        ) : null}
      </div>

      {/* Narrowing the pages already loaded. Child APIs are requested only after
          their parent is opened; pagination stays explicit and bounded. */}
      {response && response.status === 'ok' && items.length > 0 ? (
        <div className="asset-picker-filter">
          <Search className="size-3.5" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search loaded results"
            aria-label={`Narrow ${spec.title.toLowerCase()}`}
          />
        </div>
      ) : null}

      {loading ? (
        <div data-testid="asset-picker-loading">
          <PiaLoadingLabel label="Finding resources your sign-in can access" className="asset-picker-loading" />
        </div>
      ) : null}

      {/* BROWSING CANNOT RUN. Not an empty list, and not a failure: the offer of
          the permission that would turn it on, and the way past it meanwhile. */}
      {!loading && response && response.status === 'unavailable' ? (
        <BrowseGrantPrompt scope={response.scope} detail={response.detail} reason={response.reason} />
      ) : null}

      {/* THE CALL BROKE. The workspace's own words, and a retry, because a
          timeout is the one outcome here that a second attempt can change. */}
      {!loading && response && response.status === 'failed' ? (
        <div className="asset-picker-failed" data-testid="asset-picker-failed">
          <p className="asset-picker-failed-head">
            <span className="ast-pill ast-pill--neutral">{BROWSE_FAILED_CHIP}</span>
            <span>{response.detail}</span>
          </p>
          {response.error ? <p className="asset-picker-failed-error">{response.error}</p> : null}
          <div className="asset-picker-failed-actions">
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}

      {/* AN EMPTY ANSWER IS AN ANSWER, and it says which of the two empties it
          is. A reader who cannot tell "there is nothing here" from "nobody
          looked" has been told nothing at all. */}
      {!loading && response?.status === 'ok' && items.length === 0 && response.pagination.complete ? (
        <div className="asset-picker-empty" data-testid="asset-picker-empty">
          <p className="asset-picker-empty-head">{browseEmptyNote(kind)}</p>
        </div>
      ) : null}

      {!loading && shown.length > 0 ? (
        <ul className="asset-picker-rows" aria-label={spec.title}>
          {shown.map((item) => (
            <AssetPickerRow
              key={`${item.id}-${item.label}`}
              spec={spec}
              cursor={cursor}
              item={item}
              current={current}
              onOpen={onOpen}
              onPick={onPick}
              rowState={rowState}
            />
          ))}
        </ul>
      ) : null}

      {!loading && response?.status === 'ok' && items.length > 0 ? (
        <p className="asset-picker-result-count" role="status">
          {items.length} loaded{response.next_page_token ? ' · More available' : ''}
        </p>
      ) : null}

      {!loading && response?.status === 'ok' && items.length > 0 && !response.pagination.complete ? (
        <p className="asset-picker-empty-note" data-testid="asset-picker-partial">
          {response.pagination.incomplete_reason === 'page_cap'
            ? `Discovery stopped at ${response.pagination.page_limit} pages (${response.pagination.page_size * response.pagination.page_limit} resources maximum).`
            : response.pagination.incomplete_reason === 'more_available'
              ? 'More resources are available. Search currently covers the loaded results.'
              : response.pagination.incomplete_reason === 'deadline'
                ? 'Loading the next page reached its deadline.'
                : response.pagination.incomplete_reason === 'cancelled'
                  ? 'Loading the next page was cancelled.'
                  : 'The next page could not be loaded.'}
        </p>
      ) : null}

      {!loading && response?.status === 'ok' && items.length === 0 && !response.pagination.complete ? (
        <div className="asset-picker-empty-note">
          <p role="status">
            {response.pagination.incomplete_reason === 'page_cap'
              ? 'Discovery reached its page limit before finding a visible resource.'
              : response.pagination.incomplete_reason === 'deadline'
                ? 'Resource discovery reached its deadline before finding a visible resource.'
                : response.pagination.incomplete_reason === 'cancelled'
                  ? 'Resource discovery was cancelled before finding a visible resource.'
                  : 'Resource discovery could not finish.'}
          </p>
          {response.pagination.incomplete_reason === 'deadline' ||
          response.pagination.incomplete_reason === 'failed' ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* The filter hid everything the list held. Said, because an empty list
          under a filter box otherwise reads as an empty workspace. */}
      {!loading && items.length > 0 && shown.length === 0 ? (
        <p className="asset-picker-empty-note">Nothing in this list matches what you typed.</p>
      ) : null}

      {!loading && response?.status === 'ok' && items.length > 0 && response.next_page_token ? (
        <div className="asset-picker-more">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            aria-busy={loadingMore || undefined}
            aria-label={`Load more ${spec.title.toLowerCase()}`}
            onClick={onMore}
          >
            <PiaBusyButtonContent busy={loadingMore} label="Load more" busyLabel="Loading more" tone="light" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The browser, fetching its own lists.
 *
 * ONE REQUEST PER LIST A READER ASKED FOR. The fetch is in this component rather
 * than on the page, so nothing is listed until somebody opens an editor: the
 * Connections page deliberately runs its dependency checks once per session, and
 * a page that also browsed seven asset families on mount would undo that.
 */
export function AssetPicker({
  spec,
  current,
  catalog,
  onPick,
  rowState,
}: {
  spec: AssetPickerSpec;
  /** The draft in the editor, which is what a pick adds to or replaces. */
  current: string;
  /**
   * The catalog this deployment is configured with.
   *
   * Only the `schema` field needs it, and it needs it structurally: the value it
   * stores is a bare schema name, so nothing in the field itself says which
   * catalog to list. Passed down from the page, which holds every row.
   */
  catalog?: string;
  onPick: (value: string, picked?: PickedRow) => void;
  rowState?: (value: string, picked: PickedRow) => AssetPickerRowState;
}) {
  const [cursor, setCursor] = useState<PickerCursor>(() => initialCursor(spec, { current, catalog }));
  /** Bumped by Try again, so a retry is a new key rather than a re-run. */
  const [attempt, setAttempt] = useState(0);
  const [pagingKey, setPagingKey] = useState('');
  const pagingController = useRef<AbortController | null>(null);
  const pagingTokens = useRef<Map<string, Set<string>>>(new Map());

  const kind = cursorKind(spec, cursor);
  /**
   * The list this cursor is asking for, and the attempt it is asking on.
   *
   * ONE KEY DOES THE WORK OF THREE PIECES OF STATE. Whether a list has arrived,
   * whether it is still out, and whether the filter box belongs to the list on
   * screen are all answered by comparing against this rather than by a `setState`
   * inside the effect. That is not a style preference: a `setLoading(true)` in an
   * effect body renders once with the previous list and stale-empty flags before
   * the reset lands, which is how a browser flashes the last catalog's tables
   * while opening a new one.
   */
  const key = `${attempt}:${browseUrl(kind, cursor)}`;
  const loadingMore = pagingKey === key;
  const [answers, setAnswers] = useState<ReadonlyMap<string, BrowseResponse>>(() => new Map());
  /** What was typed, and which list it was typed over. */
  const [typed, setTyped] = useState<{ key: string; text: string }>({ key: '', text: '' });

  const response = answers.get(key) ?? null;
  // Derived, not stored: a key with no answer yet IS the pending state.
  const loading = !response;
  // Reset by derivation as well, so opening a catalog cannot carry the previous
  // list's filter into it and show a list that looks empty.
  const query = typed.key === key ? typed.text : '';

  useEffect(() => {
    if (answers.has(key)) return;
    let live = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    const record = (body: BrowseResponse) => {
      if (live) {
        window.clearTimeout(timeout);
        setAnswers((held) => new Map(held).set(key, body));
      }
    };
    fetch(browseUrl(kind, cursor), { signal: controller.signal })
      .then((answer) => {
        if (!answer.ok) throw new Error(`resource discovery answered ${answer.status}`);
        return answer.json() as Promise<BrowseResponse>;
      })
      .then(record, (caught: unknown) =>
        // A throw here is the app route being unreachable, not the workspace
        // refusing anything. Reported as `failed`, which is the outcome that
        // means "nothing was established", rather than as an empty list.
        record(
          browseTransportFailure(
            kind,
            (caught as Error)?.name === 'AbortError'
              ? 'Resource discovery timed out. Try again.'
              : ((caught as Error)?.message ?? '')
          )
        )
      );
    return () => {
      live = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [answers, key, kind, cursor]);

  useEffect(
    () => () => {
      pagingController.current?.abort();
    },
    []
  );

  useEffect(() => {
    pagingController.current?.abort();
    pagingController.current = null;
  }, [key]);

  const more = useCallback(() => {
    if (!response || response.status !== 'ok' || !response.next_page_token) return;
    const token = response.next_page_token;
    const nextPage = response.pagination.page + 1;
    const seen = pagingTokens.current.get(key) ?? new Set<string>();
    if (seen.has(token)) {
      setAnswers((held) => {
        const current = held.get(key);
        if (!current || current.status !== 'ok') return held;
        return new Map(held).set(key, {
          ...current,
          next_page_token: '',
          pagination: { ...current.pagination, complete: false, incomplete_reason: 'failed' },
        });
      });
      return;
    }
    seen.add(token);
    pagingTokens.current.set(key, seen);
    pagingController.current?.abort();
    const controller = new AbortController();
    pagingController.current = controller;
    const timeout = window.setTimeout(
      () => controller.abort(new DOMException('Resource discovery timed out', 'TimeoutError')),
      15_000
    );
    setPagingKey(key);
    fetch(browsePageUrl(kind, cursor, token, nextPage), { signal: controller.signal })
      .then((answer) => {
        if (!answer.ok) throw new Error(`resource discovery answered ${answer.status}`);
        return answer.json() as Promise<BrowseResponse>;
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        // Appended only when the next page is itself an `ok`. A refusal or a
        // failure on page two says nothing about page one, and folding it in
        // would either drop rows already on screen or claim the list ended.
        setAnswers((held) => {
          const current = held.get(key);
          if (!current || current.status !== 'ok') return held;
          if (body.status !== 'ok') {
            return new Map(held).set(key, {
              ...current,
              pagination: {
                ...current.pagination,
                complete: false,
                incomplete_reason: body.status === 'failed' ? body.incomplete_reason : 'failed',
              },
            });
          }
          const items = mergeBrowseItems(current.items, body.items);
          return new Map(held).set(key, {
            ...current,
            items,
            next_page_token: body.next_page_token,
            pagination: {
              ...body.pagination,
              returned: items.length,
            },
          });
        });
      })
      .catch(() => {
        if (controller.signal.aborted && (controller.signal.reason as Error | undefined)?.name !== 'TimeoutError') {
          return;
        }
        setAnswers((held) => {
          const current = held.get(key);
          if (!current || current.status !== 'ok') return held;
          return new Map(held).set(key, {
            ...current,
            pagination: {
              ...current.pagination,
              complete: false,
              incomplete_reason:
                (controller.signal.reason as Error | undefined)?.name === 'TimeoutError' ? 'deadline' : 'failed',
            },
          });
        });
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (pagingController.current === controller) {
          pagingController.current = null;
          setPagingKey((active) => (active === key ? '' : active));
        }
      });
  }, [response, kind, cursor, key]);

  useEffect(() => {
    if (loadingMore || !shouldAutoAdvanceEmptyPage(response)) return;
    const timer = window.setTimeout(more, 0);
    return () => window.clearTimeout(timer);
  }, [loadingMore, more, response]);

  // A query is an explicit request to look beyond the first page. Continue
  // through the bounded page window after a short pause, so a match on page two
  // can appear without eagerly enumerating the workspace when the picker opens.
  useEffect(() => {
    if (query.trim().length < 2 || loadingMore || response?.status !== 'ok' || !response.next_page_token) return;
    const timer = window.setTimeout(more, 250);
    return () => window.clearTimeout(timer);
  }, [loadingMore, more, query, response]);

  const advancingEmptyPage = loadingMore || shouldAutoAdvanceEmptyPage(response);

  return (
    <AssetPickerPanel
      spec={spec}
      cursor={cursor}
      current={current}
      response={response}
      loading={loading || (response?.status === 'ok' && response.items.length === 0 && advancingEmptyPage)}
      loadingMore={loadingMore}
      query={query}
      onQuery={(text) => setTyped({ key, text })}
      onOpen={setCursor}
      onPick={onPick}
      rowState={rowState}
      onRetry={() => setAttempt((was) => was + 1)}
      onMore={more}
    />
  );
}

/**
 * The browser for one Connections field, or nothing where the field has no list.
 *
 * BOTH EDITORS GO THROUGH HERE, which is the reason it exists rather than each of
 * them asking `pickerForField` and rendering the panel itself. The Connections
 * page draws two editors -- one inside a dependency row, one inside the
 * configuration list -- and ten fields between them; two copies of "look up the
 * spec, render the picker, print the note about typing" is two places for a field
 * to be quietly left out of.
 *
 * Returning null for an unmapped field is the whole of the decision at the call
 * site. The AI Gateway route and the answer length limit get the text box alone,
 * which is honest: there is no list of them to browse.
 */
export function AssetPickerField({
  field,
  current,
  catalog,
  onPick,
}: {
  field: string;
  current: string;
  catalog?: string;
  onPick: (value: string, picked?: PickedRow) => void;
}) {
  const spec = pickerForField(field);
  if (!spec) return null;
  return (
    <>
      <AssetPicker spec={spec} current={current} catalog={catalog} onPick={onPick} />
      {/* What typing is FOR on this field, where it is for more than a fallback.
          Empty on almost every field, and a sentence on the denylist, whose
          entries may be patterns that no list of existing tables can offer. */}
      {spec.typeNote ? <p className="asset-picker-type-note">{spec.typeNote}</p> : null}
    </>
  );
}
