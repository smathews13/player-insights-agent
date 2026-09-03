import type { Application, Request, Response } from 'express';

import { APP_SCHEMA } from '../../shared/app-schema';
import {
  MONITORING_FEEDBACK_SCHEMA_REVISION,
  type MonitoringFeedbackOption,
  type MonitoringFeedbackPayload,
  type MonitoringFeedbackRow,
} from '../../shared/monitoring-feedback-contract';
import { isRole, type Role } from '../../shared/user-roster-contract';
import { organizationForEmail, parseOrganizationMappings } from '../../shared/organization-mapping';
import { ADDED_ADMINS_TABLE } from '../lib/admin-roles-schema';
import { readStored, markResponse, noSubstitution } from '../lib/lakebase-store';
import { ROLE_COLUMN } from '../lib/user-roster';
import { SP_ASSIGNMENTS_TABLE, SP_PERSONAS_TABLE } from '../lib/sp-identity-store';
import { feedbackDirectionSql, PLAN_APPROVAL_MESSAGE, type InsightsAppKit } from './insights-routes';

export const MONITORING_FEEDBACK_PAGE_SIZE = 25;
export const MONITORING_FEEDBACK_PAGE_MAX = 100;
export const MONITORING_FEEDBACK_SEARCH_MAX = 200;
export const MONITORING_FEEDBACK_ROUTE = '/api/monitoring/feedback';

interface FeedbackCursor {
  feedbackAt: string;
  id: string;
}

export interface MonitoringFeedbackFilters {
  search: string;
  feedback: '' | 'up' | 'down';
  user: string;
  role: '' | Role;
  persona: string;
  organization: string;
}

function stringParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(text(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function stamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
  }
  if (typeof value !== 'string') return [];
  try {
    return records(JSON.parse(value));
  } catch {
    return [];
  }
}

function encodeCursor(cursor: FeedbackCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): FeedbackCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<FeedbackCursor>;
    const feedbackAt = typeof parsed.feedbackAt === 'string' ? new Date(parsed.feedbackAt).toISOString() : '';
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
    return feedbackAt && id ? { feedbackAt, id } : null;
  } catch {
    return null;
  }
}

export function monitoringFeedbackCursor(feedbackAt: string, id: string): string {
  return encodeCursor({ feedbackAt: new Date(feedbackAt).toISOString(), id });
}

export function monitoringFeedbackRequest(
  req: Pick<Request, 'query'>,
  now = Date.now()
): {
  from: string;
  to: string;
  limit: number;
  cursor: FeedbackCursor | null;
  filters: MonitoringFeedbackFilters;
  error: string;
} {
  const rawFrom = Date.parse(stringParam(req.query.from));
  const rawTo = Date.parse(stringParam(req.query.to));
  const from = Number.isFinite(rawFrom)
    ? new Date(rawFrom).toISOString()
    : new Date(now - 7 * 86_400_000).toISOString();
  const to =
    Number.isFinite(rawTo) && rawTo > Date.parse(from) ? new Date(rawTo).toISOString() : new Date(now).toISOString();
  const rawLimit = Number.parseInt(stringParam(req.query.limit), 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MONITORING_FEEDBACK_PAGE_MAX)
      : MONITORING_FEEDBACK_PAGE_SIZE;
  const rawCursor = stringParam(req.query.cursor).trim();
  const cursor = decodeCursor(rawCursor);
  const search = stringParam(req.query.q).trim();
  const feedback = stringParam(req.query.feedback).trim();
  const role = stringParam(req.query.role).trim();
  const user = stringParam(req.query.user).trim().toLowerCase();
  const persona = stringParam(req.query.persona).trim();
  const organization = stringParam(req.query.organization).trim().toLowerCase();
  let error = '';
  if (search.length > MONITORING_FEEDBACK_SEARCH_MAX) {
    error = `Search is limited to ${MONITORING_FEEDBACK_SEARCH_MAX} characters.`;
  } else if (rawCursor && !cursor) {
    error = 'The feedback cursor is invalid. Start again without a cursor.';
  } else if (Number.parseInt(stringParam(req.query.offset), 10) > 0) {
    error = 'Use the opaque cursor from pagination.nextCursor instead of an offset.';
  } else if (feedback && feedback !== 'up' && feedback !== 'down') {
    error = 'Feedback must be up or down.';
  } else if (role && !isRole(role)) {
    error = 'Role must be super_admin, admin, or consumer.';
  } else if (user.length > 320 || persona.length > 160 || organization.length > 253) {
    error = 'One or more feedback filters are too long.';
  }
  return {
    from,
    to,
    limit,
    cursor,
    filters: {
      search,
      feedback: feedback === 'up' || feedback === 'down' ? feedback : '',
      user,
      role: isRole(role) ? role : '',
      persona,
      organization,
    },
    error,
  };
}

/**
 * One feedback submission per row. The period and cursor are deliberately on
 * feedback.created_at; a question can be rated later than it was asked.
 */
export const MONITORING_FEEDBACK_QUERY = `
  WITH joined AS (
    SELECT f.id AS feedback_id,
           f.message_id AS answer_id,
           f.user_email AS feedback_user,
           f.created_at AS feedback_at,
           ${feedbackDirectionSql('f')} AS direction,
           f.comment,
           answer.conversation_id,
           question.id AS question_id,
           question.content AS question,
           question.created_at AS asked_at,
           CASE
             WHEN lower(roster.${ROLE_COLUMN}) IN ('super_admin', 'admin', 'consumer')
               THEN lower(roster.${ROLE_COLUMN})
             WHEN roster.email IS NOT NULL THEN 'admin'
             ELSE 'consumer'
           END AS user_role,
           assignment.persona_id,
           persona.display_name AS persona_name,
           lower(split_part(f.user_email, '@', 2)) AS organization_domain,
           GREATEST(
             COALESCE(roster.added_at, 'epoch'::timestamptz),
             COALESCE(assignment.updated_at, 'epoch'::timestamptz),
             COALESCE(persona.updated_at, 'epoch'::timestamptz)
           ) AS identity_updated_at
      FROM ${APP_SCHEMA}.feedback f
      JOIN ${APP_SCHEMA}.messages answer
        ON answer.id = f.message_id AND answer.role = 'assistant'
      JOIN LATERAL (
        SELECT q.id, q.content, q.created_at
          FROM ${APP_SCHEMA}.messages q
         WHERE q.conversation_id = answer.conversation_id
           AND q.role = 'user'
           AND q.content <> $12
           AND q.created_at <= answer.created_at
         ORDER BY q.created_at DESC, q.id DESC
         LIMIT 1
      ) question ON TRUE
      LEFT JOIN ${ADDED_ADMINS_TABLE} roster
        ON lower(roster.email) = lower(f.user_email)
      LEFT JOIN ${SP_ASSIGNMENTS_TABLE} assignment
        ON lower(assignment.email) = lower(f.user_email)
      LEFT JOIN ${SP_PERSONAS_TABLE} persona
        ON persona.id = assignment.persona_id
     WHERE f.created_at >= $1::timestamptz
       AND f.created_at < $2::timestamptz
  ),
  submitted AS (
    SELECT *
      FROM joined
     WHERE direction IN ('up', 'down')
  ),
  filtered AS (
    SELECT *
      FROM submitted
     WHERE ($6 = '' OR
            lower(question) LIKE ('%' || lower($6) || '%') OR
            lower(feedback_user) LIKE ('%' || lower($6) || '%') OR
            lower(split_part(feedback_user, '@', 1)) LIKE ('%' || lower($6) || '%') OR
            lower(CASE WHEN direction = 'down' THEN COALESCE(comment, '') ELSE '' END)
              LIKE ('%' || lower($6) || '%'))
       AND ($7 = '' OR direction = $7)
       AND ($8 = '' OR lower(feedback_user) = lower($8))
       AND ($9 = '' OR user_role = $9)
       AND ($10 = '' OR persona_id = $10)
       AND ($11 = '' OR organization_domain = $11 OR organization_domain LIKE ('%.' || $11))
  ),
  totals AS (
    SELECT COUNT(*)::int AS total_feedback,
           COUNT(*) FILTER (WHERE direction = 'up')::int AS helpful_feedback,
           COUNT(*) FILTER (WHERE direction = 'down')::int AS not_helpful_feedback,
           COALESCE(MAX(feedback_at)::text, '') || ':' || COUNT(*)::text AS data_revision
      FROM filtered
  ),
  options AS (
    SELECT
      COALESCE((SELECT jsonb_agg(item ORDER BY item->>'label') FROM (
        SELECT jsonb_build_object('value', lower(feedback_user), 'label', lower(feedback_user), 'count', COUNT(*)) item
          FROM submitted GROUP BY lower(feedback_user)
      ) users), '[]'::jsonb) AS user_options,
      COALESCE((SELECT jsonb_agg(item ORDER BY item->>'label') FROM (
        SELECT jsonb_build_object('value', user_role, 'label', user_role, 'count', COUNT(*)) item
          FROM submitted GROUP BY user_role
      ) roles), '[]'::jsonb) AS role_options,
      COALESCE((SELECT jsonb_agg(item ORDER BY item->>'label') FROM (
        SELECT jsonb_build_object('value', persona_id, 'label', persona_name, 'count', COUNT(*)) item
          FROM submitted
         WHERE persona_id IS NOT NULL AND persona_name IS NOT NULL AND btrim(persona_name) <> ''
         GROUP BY persona_id, persona_name
      ) personas), '[]'::jsonb) AS persona_options,
      COALESCE((SELECT jsonb_agg(item ORDER BY item->>'label') FROM (
        SELECT jsonb_build_object('value', organization_domain, 'label', organization_domain, 'count', COUNT(*)) item
          FROM submitted
         WHERE organization_domain <> ''
         GROUP BY organization_domain
      ) organizations), '[]'::jsonb) AS organization_options,
      COALESCE(MAX(identity_updated_at)::text, '') AS identity_revision
      FROM submitted
  ),
  page AS (
    SELECT *
      FROM filtered
     WHERE ($4 = '' OR (feedback_at, feedback_id) < ($4::timestamptz, $5))
     ORDER BY feedback_at DESC, feedback_id DESC
     LIMIT $3
  )
  SELECT totals.*, options.*,
         page.feedback_id, page.answer_id, page.feedback_user, page.feedback_at,
         page.direction, page.comment, page.conversation_id, page.question_id,
         page.question, page.asked_at, page.user_role, page.persona_id,
         page.persona_name, page.organization_domain
    FROM totals
    CROSS JOIN options
    LEFT JOIN page ON TRUE
   ORDER BY page.feedback_at DESC, page.feedback_id DESC
`;

export function monitoringFeedbackRow(
  row: Record<string, unknown>,
  organizations = parseOrganizationMappings(process.env.PLAYER_INSIGHTS_ORGANIZATIONS)
): MonitoringFeedbackRow | null {
  const id = text(row.feedback_id);
  const direction = text(row.direction);
  if (!id || (direction !== 'up' && direction !== 'down')) return null;
  const email = text(row.feedback_user).trim().toLowerCase();
  const organization = organizationForEmail(email, organizations);
  const rawRole = text(row.user_role).trim().toLowerCase();
  const personaId = text(row.persona_id).trim();
  const personaName = text(row.persona_name).trim();
  return {
    id,
    questionId: text(row.question_id),
    conversationId: text(row.conversation_id),
    runId: text(row.answer_id),
    question: text(row.question),
    askedAt: stamp(row.asked_at),
    userEmail: email,
    role: isRole(rawRole) ? rawRole : 'consumer',
    persona: personaId && personaName ? { id: personaId, name: personaName } : null,
    organization: { domain: organization.domain, name: organization.name },
    feedback: direction,
    comment: direction === 'down' ? text(row.comment).trim() || null : null,
    submittedAt: stamp(row.feedback_at),
  };
}

function optionsFrom(
  value: unknown,
  label: (rawValue: string, rawLabel: string) => { value: string; label: string }
): MonitoringFeedbackOption[] {
  return records(value)
    .map((entry) => {
      const normalized = label(text(entry.value), text(entry.label));
      return normalized.value && normalized.label ? { ...normalized, count: integer(entry.count) } : null;
    })
    .filter((entry): entry is MonitoringFeedbackOption => entry !== null);
}

export function setupMonitoringFeedbackRoutes(
  appkit: InsightsAppKit,
  deps: { isAdminRoute: (path: string) => boolean; now?: () => number }
) {
  if (typeof deps?.isAdminRoute !== 'function' || !deps.isAdminRoute(MONITORING_FEEDBACK_ROUTE)) {
    console.error('[monitoring-feedback] NOT REGISTERED: the admin guard does not cover the feedback corpus route.');
    return;
  }
  const clock = deps.now ?? Date.now;
  appkit.server.extend((app: Application) => {
    app.get(MONITORING_FEEDBACK_ROUTE, async (req: Request, res: Response) => {
      const request = monitoringFeedbackRequest(req, clock());
      if (request.error) {
        res.status(400).json({ error: request.error });
        return;
      }
      let disconnected = false;
      const onDisconnect = () => {
        disconnected = true;
      };
      req.once('aborted', onDisconnect);
      res.once('close', onDisconnect);
      const stored = await readStored(appkit, `GET ${MONITORING_FEEDBACK_ROUTE}`, MONITORING_FEEDBACK_QUERY, [
        request.from,
        request.to,
        request.limit + 1,
        request.cursor?.feedbackAt ?? '',
        request.cursor?.id ?? '',
        request.filters.search,
        request.filters.feedback,
        request.filters.user,
        request.filters.role,
        request.filters.persona,
        request.filters.organization,
        PLAN_APPROVAL_MESSAGE,
      ]);
      req.off('aborted', onDisconnect);
      res.off('close', onDisconnect);
      if (disconnected || res.headersSent) return;
      if (!stored.available) {
        markResponse(res, noSubstitution('storage_unavailable'));
        res.status(503).json({ error: 'feedback_unavailable' });
        return;
      }
      markResponse(res, noSubstitution());
      const first = stored.rows[0] ?? {};
      const rawRows = stored.rows
        .map((row) => monitoringFeedbackRow(row))
        .filter((row): row is MonitoringFeedbackRow => row !== null);
      const hasMore = rawRows.length > request.limit;
      const rows = rawRows.slice(0, request.limit);
      const last = hasMore ? rows[rows.length - 1] : null;
      const organizations = parseOrganizationMappings(process.env.PLAYER_INSIGHTS_ORGANIZATIONS);
      const organizationOptions = new Map<string, MonitoringFeedbackOption>();
      for (const option of optionsFrom(first.organization_options, (value) => {
        const mapped = organizationForEmail(`person@${value}`, organizations);
        return { value: mapped.domain, label: mapped.name };
      })) {
        const current = organizationOptions.get(option.value);
        organizationOptions.set(option.value, {
          ...option,
          count: option.count + (current?.count ?? 0),
        });
      }
      const payload: MonitoringFeedbackPayload = {
        schemaRevision: MONITORING_FEEDBACK_SCHEMA_REVISION,
        readAt: new Date(clock()).toISOString(),
        dataRevision: text(first.data_revision),
        identityRevision: text(first.identity_revision),
        summary: {
          total: integer(first.total_feedback),
          helpful: integer(first.helpful_feedback),
          notHelpful: integer(first.not_helpful_feedback),
        },
        rows,
        filters: {
          users: optionsFrom(first.user_options, (value, rawLabel) => ({
            value: value.toLowerCase(),
            label: rawLabel || value,
          })),
          roles: optionsFrom(first.role_options, (value) => ({
            value,
            label: value === 'super_admin' ? 'Super admin' : value === 'admin' ? 'Admin' : 'Consumer',
          })),
          personas: optionsFrom(first.persona_options, (value, rawLabel) => ({ value, label: rawLabel })),
          organizations: [...organizationOptions.values()].sort((left, right) => left.label.localeCompare(right.label)),
        },
        pagination: {
          pageSize: request.limit,
          total: integer(first.total_feedback),
          hasMore,
          nextCursor: last ? encodeCursor({ feedbackAt: last.submittedAt, id: last.id }) : null,
        },
      };
      res.json(payload);
    });
  });
}
