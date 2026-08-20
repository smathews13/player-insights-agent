import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'RuntimeSettingsPanel.tsx'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, 'SettingsPage.tsx'), 'utf8');

describe('Runtime settings in the Settings gear', () => {
  it('mounts the section in Settings, not Connections', () => {
    expect(page).toContain('<RuntimeSettingsPanel />');
    expect(source).toContain('<CardTitle>Runtime settings</CardTitle>');
    expect(page).toContain('<PageHeading title="Settings" />');
    expect(page).toContain('Admin only. Enforced on the server, not by hiding this page.');
  });

  it('draws one Roles card first rather than separate roster and administrator cards', () => {
    const roles = page.indexOf('showsUserRoster(role.state) ? <UserRoleEditor /> : <AdminListEditor />');
    const runtime = page.indexOf('<RuntimeSettingsPanel />');
    const experimental = page.indexOf('<CardTitle>Experimental features</CardTitle>');
    expect(roles).toBeGreaterThan(-1);
    expect(roles).toBeLessThan(runtime);
    expect(runtime).toBeLessThan(experimental);
    expect(page).not.toContain('Deployment and resources');
  });

  it('keeps consumer controls read-only and names every answer variable', () => {
    expect(source).toContain('const editable = showsAdminSurfaces(role.state)');
    expect(source).toContain('disabled={!editable}');
    for (const label of ['Takeaway', 'Narrative', 'Figures', 'Charts', 'Analyst caveats']) {
      expect(source).toContain(`label="${label}"`);
    }
  });

  it('writes only through the admin-gated namespace', () => {
    expect(source).toContain("fetch('/api/admin/runtime-settings'");
  });

  it('shows the server reason and lets a failed load be retried', () => {
    expect(source).toContain("runtimeSettingsFromResponse(response, 'loaded')");
    expect(source).toContain("runtimeSettingsFromResponse(response, 'saved')");
    expect(source).toContain('failure.message');
    expect(source).toContain('Retry runtime settings');
    expect(source).not.toContain('Runtime settings could not be loaded or saved.');
  });

  /**
   * The #24a controls that carry guidance and shape to the agent. These are the
   * fields that make this a live settings surface rather than a set of toggles:
   * a guidance box per prose section, an order for figures, a shape for charts,
   * a character cap for the narrative, and a timezone. They must be wired to the
   * new schema keys, so the source names each one.
   */
  it('carries the guidance, order, type, and timezone controls #24a asks for', () => {
    expect(source).toContain('takeawayGuidance');
    expect(source).toContain('narrativeGuidance');
    expect(source).toContain('figuresOrder');
    expect(source).toContain('chartsTypes');
    expect(source).toContain('As the agent ranks them');
    expect(source).toContain('Auto from the data shape');
    expect(source.match(/<AppSelect/g)).toHaveLength(2);
    expect(source).toContain('aria-label="Timezone (IANA name)"');
    expect(source).toContain('placeholder="Example: America/Los_Angeles"');
    expect(source).toContain('Changes how the agent writes the takeaway.');
  });

  it('gives every entity its own editable style and rendering token', () => {
    for (const kind of ['catalog', 'schema', 'table', 'column', 'quote', 'tag']) {
      expect(source).toContain(`'${kind}'`);
    }
    expect(source).toContain('entityStyles');
    expect(source).toContain('Six-digit hex color.');
    expect(source).toContain('shared CSS variables used by Ask and Run Explorer');
  });

  /**
   * The loop row and the save footer, in the handoff's exact words. The footer
   * button is one primary action, not a full-width bar, and the safeguards line
   * stands beside it.
   */
  it('states the loop bounds and the mandatory safeguards in the handoff words', () => {
    expect(source).toContain('Max DSF steps');
    expect(source).toContain('Run budget (s)');
    expect(source).toContain('Bounds the Data Source Finder loop. The agent boundary does not change.');
    expect(source).toContain('mandatory safeguards, not switches');
    expect(source).toContain('Save runtime settings');
  });

  /**
   * The stray build-time name that used to sit in the loop copy ("Acme") is
   * gone. It is a person's name in a repo that publishes to a customer, and the
   * handoff copy that replaced it names no one.
   */
  it('names no person in the loop copy', () => {
    expect(source).not.toMatch(/Acme/i);
  });
});
