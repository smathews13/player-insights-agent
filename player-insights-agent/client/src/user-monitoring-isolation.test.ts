import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { partial } from './styles/stylesheet';

const SOURCE = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');
const DIALOG = readFileSync(new URL('./Dialog.tsx', import.meta.url), 'utf8');
const SELECT = readFileSync(new URL('./AppSelect.tsx', import.meta.url), 'utf8');
const CSS = partial('monitoring.css');
const BASE = partial('base.css');

describe('User Monitoring modal filter isolation', () => {
  it('owns range, role, persona, search, unit, and paging without rewriting the parent URL', () => {
    expect(SOURCE).toContain('const [userControls, setUserControls]');
    expect(SOURCE).toContain('<TimeRangeSegments page="User Monitoring"');
    expect(SOURCE).toContain('from: userWindow.from');
    expect(SOURCE).toContain('to: userWindow.to');
    expect(SOURCE).toContain('onSearch={(search) => updateUserBrowser({ search })}');
    expect(SOURCE).toContain('onRole={(role) => updateUserBrowser({ role })}');
    expect(SOURCE).toContain('onPersona={(persona) => updateUserBrowser({ persona })}');
    expect(SOURCE).toContain('onRange={(range) => updateUserBrowser({ range })}');
    expect(SOURCE).toContain('onUnit={(unit) => updateUserBrowser({ unit })}');
    expect(SOURCE).not.toMatch(/updateUserBrowser\('user(?:Search|Role|Persona|Unit|Cursor)'/);
  });

  it('retains the previous result while a rapid modal-local filter request is fenced', () => {
    expect(SOURCE).toContain('retainAcrossKeys ? lastReady.current : null');
    expect(SOURCE).toContain('const controller = new AbortController()');
    expect(SOURCE).toContain('return () => controller.abort()');
    expect(SOURCE).toContain('retainAcrossKeys,');
  });
});

describe('User Monitoring filter menus', () => {
  it('uses the shared body-level non-modal popover without fighting the dialog focus trap', () => {
    expect(SELECT).toContain('<PopoverContent');
    expect(SELECT).toContain('avoidCollisions');
    expect(SOURCE.match(/contentClassName="monitoring-users-filter-menu"/g)).toHaveLength(2);
    expect(DIALOG).toContain('isDialogFloatingPortal(event.target)');
    expect(DIALOG).toContain('[data-radix-popper-content-wrapper]');
  });

  it('paints an opaque, viewport-constrained menu above the modal without joining its flow', () => {
    expect(CSS).toMatch(
      /\[data-radix-popper-content-wrapper\]:has\(\.monitoring-users-filter-menu\)\s*\{[^}]*z-index:\s*1100/
    );
    expect(CSS).toMatch(
      /\.monitoring-users-filter-menu\s*\{[^}]*max-height:[^;}]*var\(--radix-popover-content-available-height\)[^}]*overflow-y:\s*auto[^}]*scrollbar-gutter:\s*stable[^}]*background:\s*var\(--popover\)[^}]*opacity:\s*1/
    );
    expect(BASE).toMatch(/\.app-menu-content\s*\{[^}]*background:\s*var\(--ast-surface-menu\)[^}]*opacity:\s*1/s);
    expect(CSS).toMatch(/\.user-profile-modal-overlay,[\s\S]*?z-index:\s*1000/);
  });
});
