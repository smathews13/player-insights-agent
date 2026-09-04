import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AI_ANALYSIS_CAVEAT } from './AIAnalysisCaveat';
import { SessionTimedOut, SessionUnavailable } from './AppSessionRecovery';
import { HeaderBrand } from './Layout';
import { StartupLoadingSurface } from './StartupBoundary';

const CLIENT = new URL('../', import.meta.url);
const SOURCE = new URL('./', import.meta.url);

/**
 * Compatibility names are data contracts, not product branding. They remain
 * fixed until their owning migration phases can version them safely.
 */
export const LEGACY_COMPATIBILITY_ALLOWLIST = {
  appSchema: 'astrolabe',
  billingTag: 'system_billing=astrolabe',
  queryTag: 'application=Astrolabe',
  appResourcePath: '/apps/astrolabe',
  sessionHeader: 'x-astrolabe-session-action',
  localStoragePrefix: 'astrolabe.',
  browserEventPrefix: 'astrolabe:',
} as const;

function source(name: string): string {
  return readFileSync(new URL(name, SOURCE), 'utf8');
}

describe('Player Insights Agent visible brand surfaces', () => {
  it('uses the locked product name in title, manifest, header, startup, and AI caveat', () => {
    const index = readFileSync(new URL('index.html', CLIENT), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('public/site.webmanifest', CLIENT), 'utf8')) as {
      name: string;
      short_name: string;
    };
    const header = renderToStaticMarkup(
      <MemoryRouter>
        <HeaderBrand />
      </MemoryRouter>
    );
    const startup = renderToStaticMarkup(<StartupLoadingSurface phase="application-bootstrap" />);

    expect(index).toContain('<title>Player Insights Agent</title>');
    expect(manifest).toMatchObject({ name: 'Player Insights Agent', short_name: 'PIA' });
    expect(header).toContain('Player Insights');
    expect(header).toContain('Agent');
    expect(header).toContain('data-pia-cut="simplified"');
    expect(startup).toContain('Player Insights Agent');
    expect(startup).toContain('data-startup-loader="pia-primary"');
    expect(AI_ANALYSIS_CAVEAT).toBe('Player Insights Agent analysis. AI can make mistakes.');
  });

  it('uses Player Insights Agent on session recovery surfaces', () => {
    const markup = `${renderToStaticMarkup(<SessionTimedOut />)}${renderToStaticMarkup(<SessionUnavailable />)}`;
    expect(markup).toContain('Player Insights Agent');
    expect(markup).not.toMatch(/Astrolabe/i);
  });

  it('has no retired mark, loader shim, or artwork path', () => {
    for (const path of [
      'AstrolabeMark.tsx',
      'AstrolabeLoadingLabel.tsx',
      'ConceptFlicker.tsx',
      'astrolabe-mark.ts',
      'astrolabe-pill.ts',
      'styles/astrolabe-mark.css',
      'assets/logo/astrolabe-dpad.svg',
      'assets/logo/astrolabe-dpad-white.svg',
      'assets/logo/astrolabe-rete.svg',
      'assets/logo/astrolabe-rete-white.svg',
      'assets/logo/astrolabe-reticle.svg',
      'assets/logo/astrolabe-reticle-white.svg',
      'assets/logo/astrolabe-horizon.svg',
      'assets/logo/astrolabe-horizon-white.svg',
    ]) {
      expect(existsSync(new URL(path, SOURCE)), path).toBe(false);
    }
  });

  it('keeps old branding out of the primary UI source strings', () => {
    const surfaces = [
      'Layout.tsx',
      'FirstOpenGate.tsx',
      'StartupBoundary.tsx',
      'HomePage.tsx',
      'AIAnalysisCaveat.tsx',
      'AccountMenuPanel.tsx',
      'AppSessionRecovery.tsx',
      'ConnectionsPage.tsx',
      'OpsPage.tsx',
      'IdentityPanel.tsx',
      'MonitoringPage.tsx',
      'ForecastingPanel.tsx',
    ];
    for (const path of surfaces) {
      const executable = source(path).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
      expect(executable, path).not.toMatch(/(['"`])[^'"`\n]*Astrolabe[^'"`\n]*\1/);
    }
  });
});
