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
import { ACCESS_GUIDE_SETTINGS_HREF, ACCESS_GUIDE_SETTINGS_TARGET, settingsDeepLink } from './settings-deep-link';

const CSS = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const RESPONSIVE = readFileSync(new URL('./styles/responsive-settings.css', import.meta.url), 'utf8');

describe('Settings → Environment access guide', () => {
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

  it('places the shared availability-gated row after environment facts, never in Identity', () => {
    const environment = readFileSync(new URL('EnvironmentPanel.tsx', import.meta.url), 'utf8');
    const identity = readFileSync(new URL('UserRoleEditor.tsx', import.meta.url), 'utf8');
    const facts = environment.indexOf('<AgentCodeRow');
    const guide = environment.indexOf('<AccessGuideDownload');
    const runtime = environment.indexOf('className="environment-runtime"');

    expect(facts).toBeGreaterThan(-1);
    expect(guide).toBeGreaterThan(facts);
    expect(guide).toBeLessThan(runtime);
    expect(identity).not.toContain('AccessGuideDownload');
  });

  it('right-aligns a compact bounded pane and stacks it at tablet widths', () => {
    expect(CSS).toMatch(
      /\.access-guide-download-row \{[^}]*width:\s*min\(100%,\s*520px\)[^}]*max-width:\s*100%[^}]*justify-self:\s*end/s
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

  it('uses an Environment URL and canonicalizes guide-specific Identity links', () => {
    expect(ACCESS_GUIDE_SETTINGS_HREF).toBe(`/settings?section=environment#${ACCESS_GUIDE_SETTINGS_TARGET}`);
    expect(settingsDeepLink('?section=environment', `#${ACCESS_GUIDE_SETTINGS_TARGET}`)).toMatchObject({
      section: 'environment',
      focusTarget: ACCESS_GUIDE_SETTINGS_TARGET,
      canonicalSearch: '?section=environment',
    });
    expect(settingsDeepLink('?section=identity', `#${ACCESS_GUIDE_SETTINGS_TARGET}`)).toMatchObject({
      section: 'environment',
      focusTarget: ACCESS_GUIDE_SETTINGS_TARGET,
      canonicalSearch: '?section=environment',
    });
    expect(settingsDeepLink('?section=identity&focus=access-guide', '')).toMatchObject({
      section: 'environment',
      focusTarget: ACCESS_GUIDE_SETTINGS_TARGET,
      canonicalSearch: '?section=environment&focus=access-guide',
    });
    expect(settingsDeepLink('?section=identity', '')).toMatchObject({
      section: 'identity',
      focusTarget: null,
      canonicalSearch: '?section=identity',
    });

    const layout = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('initialSection={settingsDestination.section}');
    expect(layout).toContain('accessGuideFocusTarget={settingsDestination.focusTarget}');
    expect(layout).toContain('settingsDestination.canonicalSearch');
  });
});
