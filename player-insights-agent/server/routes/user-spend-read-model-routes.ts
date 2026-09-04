import type { Application, Request, Response } from 'express';

import { opsDayRange } from '../../shared/ops-contract';
import {
  organizationForEmail,
  organizationOptionsForEmails,
  organizationSuffixesForSelection,
  parseOrganizationMappings,
  type OrganizationFilterOption,
  type OrganizationMapping,
} from '../../shared/organization-mapping';
import { USER_MONITORING_SCHEMA_REVISION, type UserMonitoringPayload } from '../../shared/user-monitoring-contract';
import type { SpendByUserPayload, UserSpendAmount, UserSpendReconciliation } from '../../shared/user-spend-contract';
import {
  readUserSpendReadModelComponents,
  readUserSpendReadModelPage,
  runUserSpendReadModelRefresh,
  type UserSpendReadModelPage,
  type UserSpendRefreshSource,
} from '../lib/user-spend-read-model';
import {
  recoverInitialUserSpendRead,
  type UserSpendRecoveryDiagnosis,
  type UserSpendRecoveryResult,
} from '../lib/user-spend-recovery';
import {
  readUserSpendHourlyComponents,
  readUserSpendHourlyPage,
  rollingCompleteHours,
  runUserSpendHourlyRefresh,
  type RollingHourWindow,
} from '../lib/user-spend-hourly-read-model';
import { buildUserSpendMetrics } from '../lib/user-spend-metrics';
import { invalidAdminEmail, seedRoles } from '../lib/admin-roles';
import { everyKnownUser, readRosterForRequest } from '../lib/user-roster';
import { listSpAssignments } from '../lib/sp-identity-store';
import { userEmail, type InsightsAppKit } from './insights-routes';

export const USER_SPEND_RESPONSE_REVISION = 2;

export const USER_SPEND_READ_MODEL_ROUTES = [
  '/api/monitoring/user-spend',
  '/api/monitoring/user-spend/:email',
] as const;
export const USER_SPEND_SELF_ROUTE = '/api/user-spend/me';

function queryText(req: Request, name: string): string {
  const value = req.query[name];
  return typeof value === 'string' ? value.trim() : '';
}

function organizationSelection(req: Request): string[] {
  return [
    ...new Set(
      queryText(req, 'organization')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ].slice(0, 20);
}

function pageSize(req: Request): number {
  const parsed = Number(queryText(req, 'pageSize'));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.trunc(parsed))) : 25;
}

function pageOffset(req: Request): number {
  const parsed = Number(queryText(req, 'cursor') || queryText(req, 'offset'));
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function wantsRollingHours(req: Request): boolean {
  return queryText(req, 'window') === '24h';
}

function dayRangeForHours(window: RollingHourWindow): ReturnType<typeof opsDayRange> {
  return {
    from: window.from.slice(0, 10),
    to: new Date(Date.parse(window.to) - 1).toISOString().slice(0, 10),
  };
}

function amount(value: number | null, quality: UserSpendAmount['quality']): UserSpendAmount {
  return { amount: value, quality: value === null ? 'unavailable' : quality };
}

function reconciliation(
  unit: 'USD' | 'DBU',
  appTotal: number | null,
  rows: UserSpendReadModelPage['rows']
): UserSpendReconciliation {
  const key = unit === 'USD' ? 'spendUsd' : 'spendDbu';
  const measured = rows.map((row) => row[key]).filter((value): value is number => value !== null);
  return {
    unit,
    appTotal,
    users: appTotal === null ? null : measured.reduce((sum, value) => sum + value, 0),
    unattributed: null,
    difference: null,
  };
}

function freshness(page: UserSpendReadModelPage) {
  const activityComplete = page.rows.every((row) => row.activityComplete);
  const billingComplete = page.rows.every((row) => row.billingComplete);
  return {
    ...page.freshness,
    completeness: {
      activity: activityComplete ? ('complete' as const) : ('partial' as const),
      billing: billingComplete ? ('complete' as const) : ('partial' as const),
      usd:
        billingComplete && page.rows.every((row) => row.spendUsd !== null)
          ? ('complete' as const)
          : ('partial' as const),
      dbu:
        billingComplete && page.rows.every((row) => row.spendDbu !== null)
          ? ('complete' as const)
          : ('partial' as const),
    },
  };
}

function identityRevision(page: UserSpendReadModelPage): string {
  return page.identityRevision;
}

function writeRecoveryFailure(res: Response, diagnosis: UserSpendRecoveryDiagnosis): boolean {
  if (diagnosis === 'ready') return false;
  if (diagnosis === 'lakebase_update_required') {
    res.status(409).json({
      error: 'lakebase_update_required',
      detail: 'Lakebase update required',
      action: 'Open Connections and select Update Lakebase.',
    });
    return true;
  }
  if (diagnosis === 'preparing_user_spend') {
    res.status(503).json({
      error: 'user_spend_preparing',
      detail: 'Preparing user spend',
      action: 'Retry shortly. Another app instance is completing the initial refresh.',
    });
    return true;
  }
  if (diagnosis === 'user_not_rostered') {
    res.status(404).json({ error: 'monitoring_user_not_rostered' });
    return true;
  }
  res.status(503).json({
    error: 'billing_access_required',
    detail: 'Billing access required',
    action: 'Use an administrator identity that can read the app billing sources, then retry.',
  });
  return true;
}

function recoveredPage(result: UserSpendRecoveryResult): UserSpendReadModelPage {
  if (!result.page) throw new Error('Recovered user spend page was missing.');
  return result.page;
}

function listPayload(
  page: UserSpendReadModelPage,
  range: ReturnType<typeof opsDayRange>,
  unit: 'USD' | 'DBU',
  offset: number,
  limit: number,
  organizations: OrganizationFilterOption[],
  manifest: readonly OrganizationMapping[]
): UserMonitoringPayload {
  const first = page.rows[0];
  const appUsd = first?.appSpendUsd ?? null;
  const appDbu = first?.appSpendDbu ?? null;
  const complete = page.rows.every((row) => row.activityComplete && row.billingComplete);
  return {
    schemaRevision: USER_MONITORING_SCHEMA_REVISION,
    readAt: page.freshness.computedAt ?? new Date().toISOString(),
    range,
    unit,
    state: page.available ? (complete ? 'ready' : 'partial') : 'unavailable',
    reason: page.available ? '' : 'The user spend read model has not completed its first refresh.',
    users: page.rows.map((row) => ({
      email: row.email,
      role: row.role,
      persona: row.persona,
      lastActive: row.sourceThrough ?? null,
      organization: organizationForEmail(row.email, manifest),
      questions: row.questions,
      runs: row.runs,
      coveredDays: row.coveredDays,
      tokenUsage: {
        totalTokens: row.totalTokens,
        coveredRuns: row.tokenCoveredRuns,
        coveredQuestions: row.tokenCoveredQuestions,
      },
      spend: {
        usd: amount(row.spendUsd, row.spendUsdQuality),
        dbu: amount(row.spendDbu, row.spendDbuQuality),
      },
      coverage: unit === 'USD' ? row.spendUsdQuality : row.spendDbuQuality,
    })),
    personas: [...new Map(page.rows.flatMap((row) => (row.persona ? [[row.persona.id, row.persona]] : []))).values()]
      .map((persona) => ({
        ...persona,
        count: page.rows.filter((row) => row.persona?.id === persona.id).length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    dataRevision: USER_SPEND_RESPONSE_REVISION,
    organizations,
    identityRevision: identityRevision(page),
    pagination: {
      total: page.total,
      pageSize: limit,
      hasMore: offset + page.rows.length < page.total,
      nextCursor: offset + page.rows.length < page.total ? String(offset + page.rows.length) : null,
    },
    reconciliation: {
      usd: reconciliation('USD', appUsd, page.rows),
      dbu: reconciliation('DBU', appDbu, page.rows),
    },
    freshness: freshness(page),
  };
}

function selectedAmount(page: UserSpendReadModelPage, email: string, unit: 'USD' | 'DBU') {
  const row = page.rows.find((entry) => entry.email.toLowerCase() === email.toLowerCase());
  const value = unit === 'USD' ? row?.spendUsd : row?.spendDbu;
  const quality = unit === 'USD' ? row?.spendUsdQuality : row?.spendDbuQuality;
  return {
    row,
    amount: value ?? null,
    comparable: value !== null && value !== undefined,
    estimated: quality === 'partial' || !row?.billingComplete,
    coveredDays: unit === 'USD' ? (row?.spendUsdCoveredDays ?? 0) : (row?.spendDbuCoveredDays ?? 0),
  };
}

export interface UserSpendReadModelRouteDeps {
  isAdminRoute: (path: string) => boolean;
  source?: UserSpendRefreshSource;
  sourceForRequest?: (req: Request) => UserSpendRefreshSource | null;
  now?: () => number;
}

/**
 * Fast Lakebase-only API for User Monitoring. The existing Cost contract stays
 * intact for mixed-version clients; new clients can move independently to this
 * read model without coupling the monitor modal to the Cost page's live billing
 * request.
 */
export function setupUserSpendReadModelRoutes(appkit: InsightsAppKit, deps: UserSpendReadModelRouteDeps): void {
  const uncovered = USER_SPEND_READ_MODEL_ROUTES.filter((path) => !deps.isAdminRoute(path));
  if (uncovered.length > 0) {
    console.error(`[user-spend-read-model] NOT REGISTERED: admin guard does not cover ${uncovered.join(', ')}.`);
    return;
  }
  const clock = deps.now ?? Date.now;
  const sourceFor = (req: Request) => deps.sourceForRequest?.(req) ?? deps.source ?? null;
  const enqueueIfStale = (page: UserSpendReadModelPage, source: UserSpendRefreshSource | null) => {
    if (!source || (!page.freshness.isStale && page.available)) return;
    void runUserSpendReadModelRefresh(appkit.lakebase, source).catch((error: Error) => {
      console.warn(`[user-spend-read-model] asynchronous refresh failed (${error.name}); serving the last good rows.`);
    });
  };
  const readDaily = (
    req: Request,
    range: ReturnType<typeof opsDayRange>,
    principal: string,
    allowBrowse: boolean,
    limit = pageSize(req),
    offset = pageOffset(req),
    rosterOnly = allowBrowse,
    organizationDomains: readonly string[] = []
  ) =>
    readUserSpendReadModelPage(appkit.lakebase, {
      range,
      principal,
      allowBrowse,
      search: queryText(req, 'q'),
      role: queryText(req, 'role'),
      persona: queryText(req, 'persona'),
      unit: queryText(req, 'unit') === 'DBU' ? 'DBU' : 'USD',
      limit,
      organizationDomains,
      offset,
      now: clock(),
      rosterOnly,
    });
  const readHourly = (
    req: Request,
    window: RollingHourWindow,
    principal: string,
    allowBrowse: boolean,
    limit = pageSize(req),
    offset = pageOffset(req),
    rosterOnly = allowBrowse,
    organizationDomains: readonly string[] = []
  ) =>
    readUserSpendHourlyPage(appkit.lakebase, {
      window,
      principal,
      allowBrowse,
      search: queryText(req, 'q'),
      role: queryText(req, 'role'),
      persona: queryText(req, 'persona'),
      unit: queryText(req, 'unit') === 'DBU' ? 'DBU' : 'USD',
      limit,
      offset,
      organizationDomains,
      now: clock(),
      rosterOnly,
    });

  appkit.server.extend((app: Application) => {
    app.get(USER_SPEND_SELF_ROUTE, async (req: Request, res: Response) => {
      const email = userEmail(req).trim().toLowerCase();
      if (invalidAdminEmail(email)) {
        res.status(401).json({ error: 'identity_required' });
        return;
      }
      const hourly = wantsRollingHours(req);
      const window = rollingCompleteHours(queryText(req, 'from'), queryText(req, 'to'), clock());
      const range = hourly
        ? dayRangeForHours(window)
        : opsDayRange(queryText(req, 'from'), queryText(req, 'to'), clock());
      const [current, components] = await Promise.all([
        hourly ? readHourly(req, window, email, false, 1, 0, false) : readDaily(req, range, email, false, 1, 0, false),
        hourly
          ? readUserSpendHourlyComponents(appkit.lakebase, { email, window })
          : readUserSpendReadModelComponents(appkit.lakebase, { email, range }),
      ]);
      if (hourly) {
        if (current.freshness.isStale) {
          void runUserSpendHourlyRefresh(appkit.lakebase, { now: clock() }).catch((error: Error) => {
            console.warn(
              `[user-spend-hourly] asynchronous refresh failed (${error.name}); serving the last good rows.`
            );
          });
        }
      } else {
        enqueueIfStale(current, sourceFor(req));
      }
      const selected = current.rows.find((row) => row.email.toLowerCase() === email);
      const payload: SpendByUserPayload = {
        dataRevision: USER_SPEND_RESPONSE_REVISION,
        readAt: current.freshness.computedAt ?? new Date(clock()).toISOString(),
        requestedRange: range,
        range,
        state: current.available ? (selected?.billingComplete ? 'ready' : 'partial') : 'unavailable',
        reason: current.available ? '' : 'The user spend read model has not completed its first refresh.',
        identityRevision: '',
        users: selected
          ? [
              {
                email,
                total: {
                  usd: amount(selected.spendUsd, selected.spendUsdQuality),
                  dbu: amount(selected.spendDbu, selected.spendDbuQuality),
                },
                components,
              },
            ]
          : [],
        unattributed: [],
        reconciliation: {
          usd: reconciliation('USD', selected?.appSpendUsd ?? null, current.rows),
          dbu: reconciliation('DBU', selected?.appSpendDbu ?? null, current.rows),
        },
        freshness: current.freshness,
      };
      res.json(payload);
    });

    app.get('/api/monitoring/user-spend', async (req: Request, res: Response) => {
      const principal = userEmail(req);
      const limit = pageSize(req);
      const offset = pageOffset(req);
      const hourly = wantsRollingHours(req);
      const window = rollingCompleteHours(queryText(req, 'from'), queryText(req, 'to'), clock());
      const range = hourly
        ? dayRangeForHours(window)
        : opsDayRange(queryText(req, 'from'), queryText(req, 'to'), clock());
      const source = sourceFor(req);
      const manifest = parseOrganizationMappings(process.env.PLAYER_INSIGHTS_ORGANIZATIONS);
      let organizations: OrganizationFilterOption[];
      try {
        const personaFilter = queryText(req, 'persona');
        const [roster, assignments] = await Promise.all([
          readRosterForRequest(appkit.lakebase, req),
          personaFilter ? listSpAssignments(appkit) : Promise.resolve([]),
        ]);
        const entries = everyKnownUser({ seed: seedRoles(), stored: roster.rows });
        const assignmentByEmail = new Map(
          assignments.map((assignment) => [assignment.email.trim().toLowerCase(), assignment.personaId])
        );
        const search = queryText(req, 'q').toLowerCase();
        const role = queryText(req, 'role');
        const representedEmails = entries.map((entry) => entry.email);
        const countedEmails = entries
          .filter(
            (entry) =>
              (!search || entry.email.toLowerCase().includes(search)) &&
              (!role || entry.role === role) &&
              (!personaFilter || assignmentByEmail.get(entry.email.toLowerCase()) === personaFilter)
          )
          .map((entry) => entry.email);
        organizations = organizationOptionsForEmails(representedEmails, countedEmails, manifest);
      } catch {
        res.status(503).json({
          error: 'identity_roster_unavailable',
          detail: 'User Monitoring could not read the authoritative Identity settings roster.',
        });
        return;
      }
      const organizationDomains = organizationSuffixesForSelection(organizationSelection(req), organizations);
      const readRosterPage = () =>
        hourly
          ? readHourly(req, window, principal, true, limit, offset, true, organizationDomains)
          : readDaily(req, range, principal, true, limit, offset, true, organizationDomains);
      let recovery: UserSpendRecoveryResult;
      try {
        recovery = await recoverInitialUserSpendRead({
          read: readRosterPage,
          refresh: hourly
            ? () => runUserSpendHourlyRefresh(appkit.lakebase, { from: window.from, to: window.to, now: clock() })
            : source
              ? () =>
                  runUserSpendReadModelRefresh(appkit.lakebase, source, {
                    fromDay: range.from,
                    throughDay: range.to,
                  })
              : null,
        });
      } catch {
        res.status(503).json({
          error: 'identity_roster_unavailable',
          detail: 'User Monitoring could not read the authoritative Identity settings roster.',
        });
        return;
      }
      if (writeRecoveryFailure(res, recovery.diagnosis)) return;
      const page = recoveredPage(recovery);
      if (hourly) {
        if (page.freshness.isStale) {
          void runUserSpendHourlyRefresh(appkit.lakebase, { now: clock() }).catch((error: Error) => {
            console.warn(
              `[user-spend-hourly] asynchronous refresh failed (${error.name}); serving the last good rows.`
            );
          });
        }
      } else {
        enqueueIfStale(page, source);
      }
      res.json(
        listPayload(
          page,
          range,
          queryText(req, 'unit') === 'DBU' ? 'DBU' : 'USD',
          offset,
          limit,
          organizations,
          manifest
        )
      );
    });

    app.get('/api/monitoring/user-spend/:email', async (req: Request, res: Response) => {
      const email = decodeURIComponent(String(req.params.email)).trim().toLowerCase();
      if (invalidAdminEmail(email)) {
        res.status(400).json({ error: 'invalid_monitoring_user' });
        return;
      }
      const hourly = wantsRollingHours(req);
      const window = rollingCompleteHours(queryText(req, 'from'), queryText(req, 'to'), clock());
      const range = hourly
        ? dayRangeForHours(window)
        : opsDayRange(queryText(req, 'from'), queryText(req, 'to'), clock());
      const unit = queryText(req, 'unit') === 'DBU' ? 'DBU' : 'USD';
      const source = sourceFor(req);
      let recovery: UserSpendRecoveryResult;
      try {
        const readProfile = () =>
          hourly ? readHourly(req, window, email, false, 1, 0, true) : readDaily(req, range, email, false, 1, 0, true);
        recovery = await recoverInitialUserSpendRead({
          read: readProfile,
          isRostered: async () => {
            const roster = await readRosterForRequest(appkit.lakebase, req);
            return everyKnownUser({ seed: seedRoles(), stored: roster.rows }).some(
              (entry) => entry.email.toLowerCase() === email
            );
          },
          refresh: hourly
            ? () => runUserSpendHourlyRefresh(appkit.lakebase, { from: window.from, to: window.to, now: clock() })
            : source
              ? () =>
                  runUserSpendReadModelRefresh(appkit.lakebase, source, {
                    fromDay: range.from,
                    throughDay: range.to,
                  })
              : null,
        });
      } catch {
        res.status(503).json({
          error: 'identity_roster_unavailable',
          detail: 'This profile could not be checked against the authoritative Identity settings roster.',
        });
        return;
      }
      if (writeRecoveryFailure(res, recovery.diagnosis)) return;
      const current = recoveredPage(recovery);
      const components = await (
        hourly
          ? readUserSpendHourlyComponents(appkit.lakebase, { email, window })
          : readUserSpendReadModelComponents(appkit.lakebase, { email, range })
      ).catch(() => []);
      if (hourly) {
        if (current.freshness.isStale) {
          void runUserSpendHourlyRefresh(appkit.lakebase, { now: clock() }).catch((error: Error) => {
            console.warn(
              `[user-spend-hourly] asynchronous refresh failed (${error.name}); serving the last good rows.`
            );
          });
        }
      } else {
        enqueueIfStale(current, source);
      }
      const selected = selectedAmount(current, email, unit);
      if (!selected.row) {
        res.status(404).json({ error: 'monitoring_user_not_rostered' });
        return;
      }
      const appTotal = unit === 'USD' ? selected.row?.appSpendUsd : selected.row?.appSpendDbu;
      const profile = selected.row
        ? {
            email,
            total: {
              usd: amount(selected.row.spendUsd, selected.row.spendUsdQuality),
              dbu: amount(selected.row.spendDbu, selected.row.spendDbuQuality),
            },
            metrics: buildUserSpendMetrics({
              unit,
              current: {
                amount: selected.amount,
                comparable: selected.comparable,
                estimated: selected.estimated,
                questions: selected.row.questions,
                coveredDays: selected.coveredDays,
                appTotal: appTotal ?? null,
                appComparable: appTotal !== null && appTotal !== undefined,
                totalTokens: selected.row.totalTokens,
                tokenCoveredRuns: selected.row.tokenCoveredRuns,
                tokenCoveredQuestions: selected.row.tokenCoveredQuestions,
              },
            }),
            components,
          }
        : null;
      const payload: SpendByUserPayload = {
        dataRevision: USER_SPEND_RESPONSE_REVISION,
        readAt: current.freshness.computedAt ?? new Date(clock()).toISOString(),
        requestedRange: range,
        range,
        state: current.available ? (selected.row?.billingComplete ? 'ready' : 'partial') : 'unavailable',
        reason: current.available ? '' : 'The user spend read model has not completed its first refresh.',
        identityRevision: identityRevision(current),
        users: profile ? [profile] : [],
        unattributed: [],
        reconciliation: {
          usd: reconciliation('USD', selected.row?.appSpendUsd ?? null, current.rows),
          dbu: reconciliation('DBU', selected.row?.appSpendDbu ?? null, current.rows),
        },
        freshness: current.freshness,
      };
      res.json(payload);
    });
  });
}
