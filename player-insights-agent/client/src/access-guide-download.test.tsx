import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCESS_GUIDE_DOWNLOAD_PATH,
  ACCESS_GUIDE_FILENAME,
  ACCESS_GUIDE_META_PATH,
  loadAccessGuideAvailability,
} from './access-guide-api';
import { AccessGuideDownloadRow } from './AccessGuideDownload';

const CSS = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const RESPONSIVE = readFileSync(new URL('./styles/responsive-settings.css', import.meta.url), 'utf8');

describe('Settings → Identity access guide', () => {
  it('renders a real PDF download only after availability is confirmed', () => {
    const hidden = renderToStaticMarkup(<AccessGuideDownloadRow available={false} />);
    const shown = renderToStaticMarkup(<AccessGuideDownloadRow available={true} />);

    expect(hidden).toBe('');
    expect(shown).toContain('Access points and operating guide');
    expect(shown).toContain('Download PDF');
    expect(shown).toContain('lucide-download');
    expect(shown).toContain(`href="${ACCESS_GUIDE_DOWNLOAD_PATH}"`);
    expect(shown).toContain(`download="${ACCESS_GUIDE_FILENAME}"`);
    expect(shown).not.toMatch(/filesystem|internal path|Databricks Confidential/i);
  });

  it('treats missing, refused, malformed, and failed availability reads as unavailable', async () => {
    const available = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(await loadAccessGuideAvailability(available)).toBe(true);
    expect(available).toHaveBeenCalledWith(ACCESS_GUIDE_META_PATH);

    for (const response of [
      new Response(JSON.stringify({ available: false }), { status: 200 }),
      new Response(JSON.stringify({}), { status: 200 }),
      new Response(JSON.stringify({ available: true }), { status: 403 }),
      new Response(null, { status: 404 }),
    ]) {
      expect(await loadAccessGuideAvailability(vi.fn().mockResolvedValue(response))).toBe(false);
    }
    expect(await loadAccessGuideAvailability(vi.fn().mockRejectedValue(new Error('offline')))).toBe(false);
  });

  it('places the availability-gated row directly under the access and role heading', () => {
    const source = readFileSync(new URL('UserRoleEditor.tsx', import.meta.url), 'utf8');
    const heading = source.indexOf('Human roles and admins');
    const guide = source.indexOf('<AccessGuideDownload />');
    const roster = source.indexOf('<RosterRows');

    expect(heading).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(heading);
    expect(guide).toBeLessThan(roster);
  });

  it('right-aligns a bounded half-width pane and stacks it at tablet widths', () => {
    expect(CSS).toMatch(
      /\.access-guide-download-row \{[^}]*width:\s*clamp\(360px,\s*50%,\s*520px\)[^}]*max-width:\s*100%[^}]*justify-self:\s*end/s
    );
    expect(CSS).toMatch(
      /\.access-guide-download-row \{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*justify-content:\s*space-between/s
    );
    expect(CSS).toMatch(/\.access-guide-download-button \{[^}]*flex:\s*none[^}]*align-items:\s*center/s);
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*800px\)[\s\S]*\.access-guide-download-row \{[^}]*width:\s*100%[^}]*max-width:\s*none[^}]*justify-self:\s*stretch[^}]*flex-direction:\s*column/s
    );
    expect(RESPONSIVE).toMatch(/\.access-guide-download-button \{[^}]*width:\s*100%/s);
  });
});
