import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PANEL = readFileSync(new URL('./RuntimeSettingsPanel.tsx', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const RESPONSIVE = readFileSync(new URL('./styles/responsive-settings.css', import.meta.url), 'utf8');
const NARROW = RESPONSIVE.slice(
  RESPONSIVE.indexOf('@media (max-width: 800px)'),
  RESPONSIVE.indexOf('@media (max-width: 480px)')
);

describe('Settings narrow geometry', () => {
  it('stacks entity colors into complete Text, Highlight, and Sample rows below 800px', () => {
    expect(PANEL).toContain("{property === 'foreground' ? 'Text' : 'Highlight'}");
    expect(PANEL).toContain('<span className="appearance-mobile-label">Sample</span>');
    expect(SETTINGS).toMatch(/\.appearance-mobile-label \{[^}]*display:\s*none/);
    expect(NARROW).toMatch(/\.appearance-grid-row \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(NARROW).toMatch(/\.appearance-mobile-label \{[^}]*display:\s*block/);
    expect(NARROW).toMatch(
      /\.appearance-grid-row \.appearance-color \{[^}]*grid-template-columns:\s*64px 24px minmax\(82px,\s*1fr\)/
    );
    expect(NARROW).toMatch(/\.appearance-sample-plaque \{[^}]*grid-template-columns:\s*64px minmax\(0,\s*1fr\)/);
  });

  it('stacks each Experimental feature, status, and control without a leftover feature track', () => {
    const selector = '.settings-pane > .exp-feature-table:not(.judge-settings-table)';
    expect(NARROW).toContain(`${selector} colgroup`);
    expect(NARROW).toMatch(
      /\.settings-pane > \.exp-feature-table:not\(\.judge-settings-table\) tbody,[\s\S]*?display:\s*block/
    );
    expect(NARROW).toContain("content: 'Feature'");
    expect(NARROW).toContain("content: 'Status'");
    expect(NARROW).toContain("content: 'Control'");
    expect(NARROW).toMatch(
      /\.settings-pane > \.exp-feature-table:not\(\.judge-settings-table\) \.exp-feature-status,[\s\S]*?width:\s*100%/
    );
    expect(NARROW).toMatch(/\.exp-feature-control-inner \{[^}]*justify-content:\s*flex-start/);
    expect(NARROW).not.toContain('44px');
  });

  it('leaves the fixed actions and independently scrolling modal body intact', () => {
    expect(SETTINGS).toMatch(
      /\.settings-page\.settings-modal \{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto[^}]*overflow:\s*hidden/s
    );
    expect(SETTINGS).toMatch(
      /\.settings-modal-content \{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s
    );
    expect(PAGE).toMatch(
      /<Button[\s\S]{0,180}className="settings-cancel"[\s\S]{0,80}type="button"[\s\S]{0,80}onClick=\{(?:close|requestClose)\}/
    );
    expect(PAGE).toContain('type="submit"');
    expect(PAGE.indexOf('settings-modal-content')).toBeLessThan(PAGE.indexOf('settings-modal-footer'));
  });
});
