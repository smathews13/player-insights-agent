export const ACCESS_GUIDE_DOWNLOAD_PATH = '/api/admin/access-guide';
export const ACCESS_GUIDE_META_PATH = '/api/admin/access-guide/meta';
export const ACCESS_GUIDE_FILENAME = 'Astrolabe_Access_Patterns_v2.pdf';

export async function loadAccessGuideAvailability(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(ACCESS_GUIDE_META_PATH);
    if (!response.ok) return false;
    const body = (await response.json()) as unknown;
    return Boolean(body && typeof body === 'object' && 'available' in body && body.available === true);
  } catch {
    return false;
  }
}
