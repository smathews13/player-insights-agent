/**
 * The banner family that keeps growing back, held down in one place.
 *
 * Every one of these lines sat directly under a page title and told the reader
 * something the page already showed them: that a check was old, that a range
 * was a range, that an admin page is for admins. They were removed once per
 * screen and came back one screen at a time, so the guard is a single list
 * asserted against every screen that has ever carried one.
 *
 * Rendered where the page can be rendered, and read out of the source with the
 * comments stripped where it cannot -- a comment explaining why a sentence was
 * deleted must not be mistaken for the sentence.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ArchitecturePage } from './ArchitecturePage';
import { ConnectionsPage } from './ConnectionsPage';
import { OpsPage } from './OpsPage';
import { SettingsPage } from './SettingsPage';

/** Sentences no screen may print. Nothing replaces them. */
const BANNED = [
  'These are the results of the last check',
  'not a new one',
  'Nothing has been re-checked',
  'over an hour old',
  'Refresh to ask again',
  'not by hiding this page',
  'Admin only',
  'Enforced on the server',
  'prior half',
];

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Source with its commentary removed, so only shippable strings are read. */
function code(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** A page under the app's outlet, which is where these pages read their role. */
function inApp(page: React.ReactElement): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                features: { benchmarkLab: false, egressControls: true },
                setFeature: () => {},
                role: { state: 'admin', addedAdminsReadable: true },
              }}
            />
          }
        >
          <Route path="/" element={page} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function settingsMarkup(): string {
  return inApp(<SettingsPage />);
}

const SCREENS: readonly { name: string; markup: () => string; source: string }[] = [
  {
    name: 'Connections',
    markup: () => inApp(<ConnectionsPage />),
    source: 'ConnectionsPage.tsx',
  },
  {
    name: 'Architecture',
    markup: () => renderToStaticMarkup(<MemoryRouter><ArchitecturePage /></MemoryRouter>),
    source: 'ArchitecturePage.tsx',
  },
  {
    name: 'Ops',
    markup: () => renderToStaticMarkup(<MemoryRouter><OpsPage /></MemoryRouter>),
    source: 'OpsPage.tsx',
  },
  { name: 'Settings', markup: settingsMarkup, source: 'SettingsPage.tsx' },
];

describe('no screen narrates under its own title', () => {
  for (const screen of SCREENS) {
    it(`draws none of the banner family on ${screen.name}`, () => {
      const shown = text(screen.markup());
      for (const line of BANNED) {
        expect(shown, `${screen.name} still prints "${line}"`).not.toContain(line);
      }
    });

    it(`has no render path that could print one on ${screen.name}`, () => {
      // The rendered pass only sees the states these pages open in. The source
      // pass catches the branch that needs a payload, a stale clock or an error
      // before it would draw.
      const source = code(screen.source);
      for (const line of BANNED) {
        expect(source, `${screen.source} still carries "${line}"`).not.toContain(line);
      }
    });
  }

  it('keeps Settings down to the one word', () => {
    // The modal header is the title and the close button. Roles and the server
    // enforce who may be here; the header does not announce it.
    const markup = settingsMarkup();
    expect(markup).toContain('<h2 id="settings-title">Settings</h2>');
    expect(markup).not.toMatch(/<h2 id="settings-title">Settings<\/h2>\s*<p>/);
  });

  it('gives Ops a bare title and the latency caption no window', () => {
    // "By route, vs each route's prior half · [dates]" was three facts stacked
    // over a table that states all three itself.
    const source = code('OpsPage.tsx');
    expect(source).toContain('<PageHeading title="Ops" />');
    expect(source).toContain("<span className=\"ops-block-meta\">By route</span>");
    expect(source).not.toContain('vs each route');
  });

  it('leaves the shared heading with no description prop to grow back into', () => {
    // The prop was removed rather than made optional. A page cannot pass one.
    const source = code('page-chrome.tsx');
    expect(source).toContain('export function PageHeading({ title, actions }');
    expect(source).not.toMatch(/description\??:/);
  });
});
