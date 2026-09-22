/**
 * A backend-authored renderable artifact.
 *
 * The declared format is the only frontend dispatch decision. HTML remains an
 * opaque document. JSON remains a JSON value. Neither is a source format for
 * rebuilding the dashboard as app-owned components.
 */

export interface HtmlRenderable {
  format: 'html';
  content: string;
}

export interface JsonRenderable {
  format: 'json';
  content: unknown;
}

export type DashboardRenderable = HtmlRenderable | JsonRenderable;

export interface DashboardResponse {
  type: 'dashboard';
  mode: 'live';
  id: string;
  renderable: DashboardRenderable;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/**
 * Read the backend-selected renderable without interpreting its content.
 *
 * `dashboard_html` is accepted only as a rolling-deploy compatibility shape and
 * converted to the equivalent declared HTML format.
 */
export function dashboardRenderableFrom(value: unknown): DashboardRenderable | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== 'dashboard') return null;
  const renderable = record.renderable;
  if (renderable && typeof renderable === 'object' && !Array.isArray(renderable)) {
    const candidate = renderable as Record<string, unknown>;
    if (candidate.format === 'html' && typeof candidate.content === 'string' && candidate.content.trim()) {
      return renderable as HtmlRenderable;
    }
    if (candidate.format === 'json' && isJsonValue(candidate.content)) {
      return renderable as JsonRenderable;
    }
  }
  return typeof record.dashboard_html === 'string' && record.dashboard_html.trim()
    ? { format: 'html', content: record.dashboard_html }
    : null;
}
