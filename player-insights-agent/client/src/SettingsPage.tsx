import { useEffect, useState } from 'react';
import { Lock, X } from 'lucide-react';
import { useOutletContext } from 'react-router';
import type { ExperimentalFeaturesHandle } from './app-types';
import { AdminListEditor } from './AdminListEditor';
import { EgressPanel, EGRESS_SETTINGS_FORM_ID } from './EgressPanel';
import { showsBenchmarkLab, showsEgressControls } from './experimental-features';
import { RuntimeSettingsPanel, RUNTIME_SETTINGS_FORM_ID } from './RuntimeSettingsPanel';
import { ResourceTagsPanel } from './ResourceTagsPanel';
import { showsUserRoster, useRole } from './role';
import { UserRoleEditor } from './UserRoleEditor';
import { Button, Switch } from './ui';

type SettingsSection = 'roles' | 'runtime' | 'appearance' | 'egress' | 'experimental';

const noopClose = () => {};

const BASE_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'roles', label: 'Roles' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'egress', label: 'Egress controls' },
  { id: 'experimental', label: 'Experimental' },
];

export function SettingsPage({
  onClose,
  initialSection = 'runtime',
}: {
  onClose?: () => void;
  initialSection?: SettingsSection;
}) {
  const { features, setFeature } = useOutletContext<ExperimentalFeaturesHandle>();
  const role = useRole();
  const [active, setActive] = useState<SettingsSection>(initialSection);
  const close = onClose ?? noopClose;
  const sections = BASE_SECTIONS.filter((section) => section.id !== 'egress' || showsEgressControls(features));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const form =
    active === 'runtime' || active === 'appearance'
      ? RUNTIME_SETTINGS_FORM_ID
      : active === 'egress'
        ? EGRESS_SETTINGS_FORM_ID
        : undefined;

  return (
    <div className="settings-overlay" data-testid="settings-modal-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section className="settings-modal settings-page" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-modal-header">
          <div>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button className="settings-close" type="button" onClick={close} aria-label="Close settings">
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="settings-modal-body">
          <nav className="settings-rail" aria-label="Settings sections">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={active === section.id ? 'active' : ''}
                aria-current={active === section.id ? 'page' : undefined}
                onClick={() => setActive(section.id)}
              >
                {section.label}
              </button>
            ))}
          </nav>
          <div className="settings-modal-content">
            {active === 'roles' ? (
              <div className="settings-pane settings-roles">
                <div className="settings-pane-heading">
                  <h3>Roles</h3>
                  <p>Identity and deployment roles. Changes save immediately.</p>
                </div>
                {showsUserRoster(role.state) ? <UserRoleEditor /> : <AdminListEditor />}
              </div>
            ) : null}
            {active === 'runtime' || active === 'appearance' ? <RuntimeSettingsPanel section={active} /> : null}
            {active === 'egress' ? <EgressPanel /> : null}
            {active === 'experimental' ? (
              <div className="settings-pane">
                <div className="settings-pane-heading">
                  <h3>Experimental</h3>
                  <p>Unfinished or internal surfaces, off by default.</p>
                </div>
                <div className="settings-row">
                  <div>
                    <p className="settings-row-label">
                      Benchmarking, scorers and judge · {showsBenchmarkLab(features) ? 'Shown' : 'Hidden'}
                    </p>
                    <p className="settings-row-note">Shows the Benchmarking tab, scorers and judge details.</p>
                  </div>
                  <Switch
                    checked={showsBenchmarkLab(features)}
                    onCheckedChange={(enabled) => setFeature('benchmarkLab', enabled)}
                    aria-label="Show Benchmarking, scorers and judge details"
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <p className="settings-row-label">
                      PII egress judge · {showsEgressControls(features) ? 'Shown' : 'Hidden'}
                    </p>
                    <p className="settings-row-note">
                      Shows the Egress controls section. Hiding it does not change what is permitted.
                    </p>
                  </div>
                  <Switch
                    checked={showsEgressControls(features)}
                    onCheckedChange={(enabled) => {
                      setFeature('egressControls', enabled);
                    }}
                    aria-label="Show the egress controls on this page"
                  />
                </div>
                <ResourceTagsPanel />
              </div>
            ) : null}
          </div>
        </div>

        <footer className="settings-modal-footer">
          <div className="settings-footer-note">
            {active === 'runtime' ? (
              <>
                <Lock aria-hidden="true" />
                <span>Dictionary-first field binding and never-invent-figures are mandatory safeguards, not switches.</span>
              </>
            ) : null}
          </div>
          <div className="settings-footer-actions">
            <Button variant="outline" type="button" onClick={close}>Cancel</Button>
            {form ? <Button type="submit" form={form}>Save</Button> : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
