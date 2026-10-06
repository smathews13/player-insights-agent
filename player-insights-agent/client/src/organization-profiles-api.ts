import type { OrganizationProfileRow, OrganizationProfilesPayload } from '../../shared/organization-contract';

export class OrganizationProfilesError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'OrganizationProfilesError';
    this.status = status;
  }
}

function describe(status: number, detail: string): string {
  if (detail) return detail;
  if (status === 401) return 'Your session expired. Sign in again, then retry.';
  if (status === 403) return 'Only administrators can edit organizations.';
  if (status === 503) return 'Lakebase could not save the organization. Try again.';
  return `Organizations answered ${status}.`;
}

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<OrganizationProfileRow[]> {
  let response: Response;
  try {
    response = await fetch(input, { credentials: 'same-origin', ...init });
  } catch {
    throw new OrganizationProfilesError('The network request failed. Check your connection and try again.');
  }
  const body = (await response.json().catch(() => null)) as
    | (Partial<OrganizationProfilesPayload> & { detail?: string })
    | null;
  if (!response.ok) throw new OrganizationProfilesError(describe(response.status, body?.detail ?? ''), response.status);
  if (!body || !Array.isArray(body.organizations)) {
    throw new OrganizationProfilesError('Organizations returned an unreadable response.', response.status);
  }
  return body.organizations;
}

export function loadOrganizationProfiles(): Promise<OrganizationProfileRow[]> {
  return request('/api/admin/organizations');
}

export function saveOrganizationProfile(input: {
  domain: string;
  name: string;
  monogram?: string;
}): Promise<OrganizationProfileRow[]> {
  return request('/api/admin/organizations', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function resetOrganizationProfile(domain: string): Promise<OrganizationProfileRow[]> {
  return request(`/api/admin/organizations/${encodeURIComponent(domain)}`, { method: 'DELETE' });
}
