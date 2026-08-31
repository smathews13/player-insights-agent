/**
 * Browse what the signed-in user can see, for Connections pickers.
 *
 * Lists catalogs, schemas, tables, volumes, notebooks, SQL warehouses, Genie
 * spaces, model serving endpoints, Vector Search endpoints/indexes, and Lakebase
 * projects/branches/databases under the forwarded user token. Catalog, notebook,
 * VS and Lakebase browse return a distinct unavailable outcome when their
 * optional scopes are not on the sign-in; MLflow experiment browse is always
 * unavailable because Apps has no MLflow scope. See `shared/browse-contract.ts`.
 *
 * Not admin-gated: Connections is consumer-visible and these lists are about
 * what the reader themselves can see.
 */
import type { Request, Response } from 'express';
import type { InsightsAppKit } from './insights-routes';
import { executionToken } from '../lib/execution-credential';
import {
  browseRequestContext,
  discoverConnectionTypes,
  listCatalogs,
  listExperiments,
  listGenieSpaces,
  listLakebaseBranches,
  listLakebaseDatabases,
  listLakebaseProjects,
  listNotebooks,
  listSchemas,
  listServingEndpoints,
  listTables,
  listVectorSearchEndpoints,
  listVectorSearchIndexes,
  listVolumes,
  listWarehouses,
} from '../lib/browse-assets';

export const BROWSE_ROUTE_DEADLINE_MS = 10_000;
const PAGE_TOKEN_MAX_LENGTH = 2_048;

function queryString(req: Request, name: string): string {
  const raw = req.query[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function pageToken(req: Request): string | undefined {
  const token = queryString(req, 'page_token');
  return token && token.length <= PAGE_TOKEN_MAX_LENGTH ? token : undefined;
}

function pageNumber(req: Request): number {
  const raw = queryString(req, 'page');
  const rawToken = queryString(req, 'page_token');
  if (rawToken.length > PAGE_TOKEN_MAX_LENGTH) return 0;
  if (!raw) return rawToken ? 2 : 1;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && (parsed === 1 || Boolean(rawToken)) ? parsed : 0;
}

function defaultNotebookPath(req: Request): string {
  const email = req.header('x-forwarded-email')?.trim();
  return email ? `/Users/${email}` : '/';
}

async function sendBrowse(
  req: Request,
  res: Response,
  run: (ctx: ReturnType<typeof browseRequestContext>) => Promise<unknown>
): Promise<void> {
  const disconnected = new AbortController();
  const abortDisconnected = () => disconnected.abort(new DOMException('Client disconnected', 'AbortError'));
  const closeDisconnected = () => {
    if (!res.writableEnded) abortDisconnected();
  };
  req.once('aborted', abortDisconnected);
  res.once('close', closeDisconnected);
  const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(BROWSE_ROUTE_DEADLINE_MS)]);
  const ctx = browseRequestContext({
    token: executionToken(req),
    principal: req.header('x-forwarded-email')?.trim() ?? '',
    signal,
    page: pageNumber(req),
  });
  try {
    const payload = await run(ctx);
    if (!res.destroyed && !res.writableEnded) res.status(200).json(payload);
  } finally {
    req.off('aborted', abortDisconnected);
    res.off('close', closeDisconnected);
  }
}

export function setupBrowseRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/browse/connection-types', async (req, res) => {
      await sendBrowse(req, res, discoverConnectionTypes);
    });

    app.get('/api/browse/catalogs', async (req, res) => {
      await sendBrowse(req, res, (ctx) => listCatalogs({ ...ctx, pageToken: pageToken(req) }));
    });

    app.get('/api/browse/schemas', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listSchemas({
          ...ctx,
          catalog: queryString(req, 'catalog'),
          pageToken: pageToken(req),
        })
      );
    });

    app.get('/api/browse/tables', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listTables({
          ...ctx,
          catalog: queryString(req, 'catalog'),
          schema: queryString(req, 'schema'),
          pageToken: pageToken(req),
        })
      );
    });

    app.get('/api/browse/volumes', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listVolumes({
          ...ctx,
          catalog: queryString(req, 'catalog'),
          schema: queryString(req, 'schema'),
          pageToken: pageToken(req),
        })
      );
    });

    app.get('/api/browse/notebooks', async (req, res) => {
      const path = queryString(req, 'path') || defaultNotebookPath(req);
      await sendBrowse(req, res, (ctx) => listNotebooks({ ...ctx, path }));
    });

    app.get('/api/browse/warehouses', async (req, res) => {
      await sendBrowse(req, res, (ctx) => listWarehouses({ ...ctx, pageToken: pageToken(req) }));
    });

    app.get('/api/browse/genie-spaces', async (req, res) => {
      await sendBrowse(req, res, (ctx) => listGenieSpaces({ ...ctx, pageToken: pageToken(req) }));
    });

    // Serves the three settings that name a served model: the foundation model,
    // the benchmark judge, and any agent endpoint a deployment points at. Not
    // the AI Gateway route, which is a three-value routing mode rather than an
    // object in the workspace.
    app.get('/api/browse/serving-endpoints', async (req, res) => {
      await sendBrowse(req, res, (ctx) => listServingEndpoints({ ...ctx, pageToken: pageToken(req) }));
    });

    app.get('/api/browse/vector-search-endpoints', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listVectorSearchEndpoints({
          ...ctx,
          pageToken: pageToken(req),
        })
      );
    });

    app.get('/api/browse/vector-search-indexes', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listVectorSearchIndexes({
          ...ctx,
          endpoint: queryString(req, 'endpoint'),
          pageToken: pageToken(req),
        })
      );
    });

    app.get('/api/browse/lakebase-projects', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listLakebaseProjects({
          ...ctx,
          pageToken: pageToken(req),
        })
      );
    });

    app.get('/api/browse/lakebase-branches', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listLakebaseBranches({
          ...ctx,
          project: queryString(req, 'project'),
          pageToken: pageToken(req),
        })
      );
    });

    app.get('/api/browse/lakebase-databases', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listLakebaseDatabases({
          ...ctx,
          branch: queryString(req, 'branch'),
          pageToken: pageToken(req),
        })
      );
    });

    // Always unavailable: Apps has no MLflow scope. Kept as a route so the
    // Connections experiment picker can show the same grant/fallback surface
    // rather than a blank box with no explanation.
    app.get('/api/browse/experiments', async (req, res) => {
      await sendBrowse(req, res, (ctx) => listExperiments({ ...ctx, pageToken: pageToken(req) }));
    });
  });
}
