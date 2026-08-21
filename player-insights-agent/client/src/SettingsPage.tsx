import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { AdminListEditor } from './AdminListEditor';
import { EgressPanel, EGRESS_SETTINGS_FORM_ID } from './EgressPanel';
import { EnvironmentPanel } from './EnvironmentPanel';
import { showsBenchmarkLab, showsEgressControls, type ExperimentalFeatures } from './experimental-features';
import { RuntimeSettingsPanel, RUNTIME_SETTINGS_FORM_ID } from './RuntimeSettingsPanel';
import { ResourceTagsPanel } from './ResourceTagsPanel';
import { showsUserRoster, type RoleResolution } from './role';
import {
  SAVE_PRESS_MS,
  SETTINGS_SAVE_IDLE,
  saveButtonLabel,
  saveInFlight,
  saveLanded,
  saveNotice,
  type SettingsSaveState,
} from './settings-save-state';
import { UserRoleEditor } from './UserRoleEditor';
import { Button, Switch } from './ui';

type SettingsSection = 'roles' | 'runtime' | 'environment' | 'appearance' | 'egress' | 'experimental';

const noopClose = () => {};
const noopSetFeature = () => {};

const BASE_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'roles', label: 'Roles' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'environment', label: 'Environment' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'egress', label: 'Egress controls' },
  { id: 'experimental', label: 'Experimental' },
];

const DEFAULT_FEATURES: ExperimentalFeatures = { benchmarkLab: false, egressControls: false };
const DEFAULT_ROLE: RoleResolution = { state: 'failed', addedAdminsReadable: false };

interface SettingsPaneBoundaryProps {
  section: SettingsSection;
  children: ReactNode;
}

interface SettingsPaneBoundaryState {
  failed: boolean;
}

/**
 * Keep a bad response or a single panel regression inside that panel.
 *
 * Settings used to rely only on the route boundary. A render exception in one
 * pane therefore replaced the entire application with "This view could not be
 * displayed", including the close button and every unaffected Settings pane.
 */
export class SettingsPaneBoundary extends Component<SettingsPaneBoundaryProps, SettingsPaneBoundaryState> {
  state: SettingsPaneBoundaryState = { failed: false };

  static getDerivedStateFromError(): SettingsPaneBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Settings ${this.props.section} pane failed to render`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="settings-pane">
          <div className="settings-pane-heading">
            <h3>{BASE_SECTIONS.find((section) => section.id === this.props.section)?.label ?? 'Settings'}</h3>
          </div>
          <p className="settings-status settings-error" role="alert">
            This section could not be displayed. The other Settings sections are still available.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function SettingsPage({
  onClose,
  initialSection = 'runtime',
  features: featuresProp,
  setFeature: setFeatureProp,
  role: roleProp,
}: {
  onClose?: () => void;
  initialSection?: SettingsSection;
  features?: ExperimentalFeatures | null;
  setFeature?: (name: keyof ExperimentalFeatures, enabled: boolean) => void;
  role?: RoleResolution | null;
}) {
  const [active, setActive] = useState<SettingsSection>(initialSection);
  // Held here rather than in the panel because the footer is what stays on
  // screen: `.settings-modal-content` scrolls, so an outcome drawn at the end of
  // the Runtime form was a thousand pixels below the button that caused it.
  const [saveState, setSaveState] = useState<SettingsSaveState>(SETTINGS_SAVE_IDLE);
  // The press paint, held for a beat so the click is visible before the modal
  // goes. See SAVE_PRESS_MS.
  const [pressed, setPressed] = useState(false);
  const close = onClose ?? noopClose;
  // `?? ` rather than a default parameter, because a default parameter only
  // covers `undefined`. A caller handing down a value it fetched can hand down
  // null, and `null.state` a few lines below is read while THIS component
  // renders -- outside the pane boundary, so it would take the page down rather
  // than one section of it.
  const features = featuresProp ?? DEFAULT_FEATURES;
  const role = roleProp ?? DEFAULT_ROLE;
  const setFeature = setFeatureProp ?? noopSetFeature;
  const sections = BASE_SECTIONS.filter((section) => section.id !== 'egress' || showsEgressControls(features));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  /** Let go of the press paint whether or not the save ever comes back. */
  useEffect(() => {
    if (!pressed) return;
    const timer = window.setTimeout(() => setPressed(false), SAVE_PRESS_MS);
    return () => window.clearTimeout(timer);
  }, [pressed]);

  /**
   * Close once the save has landed.
   *
   * ON `saved` AND NOT ON THE CLICK, and the difference only shows when the server
   * refuses: the refusal is drawn in this footer, so closing on the click would
   * take the message off screen at the moment it was written and a refused save
   * would look exactly like a successful one. A save that works is fast enough
   * that the two are the same gesture to a reader.
   */
  useEffect(() => {
    if (!saveLanded(saveState)) return;
    const timer = window.setTimeout(() => close(), SAVE_PRESS_MS);
    return () => window.clearTimeout(timer);
  }, [saveState, close]);

  const form =
    active === 'runtime' || active === 'appearance'
      ? RUNTIME_SETTINGS_FORM_ID
      : active === 'egress'
        ? EGRESS_SETTINGS_FORM_ID
        : undefined;
  const notice = saveNotice(saveState);
  const saving = saveInFlight(saveState);

  return (
    <div
      className="settings-overlay"
      data-testid="settings-modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="settings-modal settings-page"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
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
                onClick={() => {
                  setActive(section.id);
                  // A "Saved" from the pane being left must not be read as an
                  // outcome for the one being opened.
                  setSaveState(SETTINGS_SAVE_IDLE);
                }}
              >
                {section.label}
              </button>
            ))}
          </nav>
          <div className="settings-modal-content">
            <SettingsPaneBoundary key={active} section={active}>
              {active === 'roles' ? (
                <div className="settings-pane settings-roles">
                  <div className="settings-pane-heading">
                    <h3>Roles</h3>
                    <p>Identity and deployment roles. Changes save immediately.</p>
                  </div>
                  {showsUserRoster(role.state) ? <UserRoleEditor /> : <AdminListEditor />}
                </div>
              ) : null}
              {active === 'runtime' || active === 'appearance' ? (
                <RuntimeSettingsPanel section={active} onSaveState={setSaveState} />
              ) : null}
              {active === 'environment' ? <EnvironmentPanel /> : null}
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
            </SettingsPaneBoundary>
          </div>
        </div>

        {/* NO NOTE ON THE LEFT. The Runtime pane used to carry a locked line here
            reading "Dictionary-first field binding and never-invent-figures are
            mandatory safeguards, not switches." It is gone at Sam's request, in
            every state and on every pane -- the two safeguards it described are
            still mandatory and still not switches, which is why there is no
            control for them to sit beside and nothing on this screen it was
            qualifying. The footer is the actions now, and settings.css ends the
            `space-between` that used to need a left-hand child. */}
        <footer className="settings-modal-footer">
          <div className="settings-footer-actions">
            {/* THE OUTCOME GOES BESIDE THE BUTTON THAT CAUSED IT. Drawn in the
                footer, which does not scroll, so a save that worked, a save the
                server refused, and a pane that never loaded are three visibly
                different things instead of one motionless button. */}
            {notice ? (
              <p
                className={`settings-save-notice${notice.tone === 'error' ? ' settings-error' : ''}`}
                role={notice.tone === 'error' ? 'alert' : 'status'}
              >
                {notice.text}
              </p>
            ) : null}
            <Button variant="outline" type="button" onClick={close}>
              Cancel
            </Button>
            {form ? (
              <Button
                type="submit"
                form={form}
                disabled={saving}
                aria-busy={saving}
                data-pressed={pressed ? 'true' : undefined}
                onClick={() => setPressed(true)}
              >
                {saveButtonLabel(saveState)}
              </Button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
