/**
 * A dashboard is a complete agent-authored HTML document.
 *
 * Unlike a Report, nothing in the app restructures its contents. The client
 * renders the document in a fully sandboxed iframe and downloads the exact same
 * bytes. This contract therefore validates the envelope only; the HTML remains
 * opaque and untrusted.
 */

export const DASHBOARD_SCHEMA_VERSION = 'pia.dashboard/1';

export interface Dashboard {
  schemaVersion?: string;
  title: string;
  html: string;
  generatedAt?: string;
  truncated?: boolean;
  caveats?: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isDashboardPayload(value: Record<string, unknown>): boolean {
  return value.type === 'dashboard' || (typeof value.title === 'string' && typeof value.html === 'string');
}

/**
 * Fold an open wire value onto the dashboard contract.
 *
 * Malformed dashboards are logged without echoing their HTML. A silent null
 * here would make a backend contract failure indistinguishable from a response
 * the endpoint never sent.
 */
export function normalizeDashboard(value: unknown): Dashboard | null {
  const record = asRecord(value);
  const schemaVersion = optionalString(record.schemaVersion) ?? optionalString(record.schema_version);
  if (schemaVersion && schemaVersion !== DASHBOARD_SCHEMA_VERSION) {
    console.warn('[dashboard] Unsupported dashboard schema version.', {
      expected: DASHBOARD_SCHEMA_VERSION,
      received: schemaVersion,
    });
    return null;
  }
  const title = optionalString(record.title);
  const html = typeof record.html === 'string' ? record.html : '';
  if (!title || !html.trim()) {
    console.warn('[dashboard] Dropped malformed dashboard payload.', {
      hasTitle: Boolean(title),
      hasHtml: Boolean(html),
      receivedType: typeof value,
    });
    return null;
  }

  const dashboard: Dashboard = { title, html, schemaVersion: DASHBOARD_SCHEMA_VERSION };
  const generatedAt = optionalString(record.generatedAt) ?? optionalString(record.generated_at);
  if (generatedAt) dashboard.generatedAt = generatedAt;
  if (typeof record.truncated === 'boolean') dashboard.truncated = record.truncated;
  const caveats = Array.isArray(record.caveats)
    ? record.caveats
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  if (caveats.length) dashboard.caveats = caveats;
  return dashboard;
}
