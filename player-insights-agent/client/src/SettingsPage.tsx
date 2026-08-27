import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { AdminListEditor } from './AdminListEditor';
import { EgressPanel, EGRESS_SETTINGS_FORM_ID } from './EgressPanel';
import { EnvironmentPanel } from './EnvironmentPanel';
import { ResourceTagsPanel } from './ResourceTagsPanel';
import { showsBenchmarkLab, showsEgressControls, type ExperimentalFeatures } from './experimental-features';
import { BenchmarkSettingsPanel, BENCHMARK_SETTINGS_FORM_ID } from './BenchmarkSettingsPanel';
import { RuntimeSettingsPanel, RUNTIME_SETTINGS_FORM_ID } from './RuntimeSettingsPanel';
import { loadSpIdentityAdmin, persistSpIdentityMode, SpIdentityPanel } from './SpIdentityPanel';
import { spIdentityEnabledFromPayload } from './sp-identity-mode';
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

type SettingsSection = 'roles' | 'identity' | 'runtime' | 'environment' | 'appearance' | 'egress' | 'experimental';

const noopClose = () => {};
const noopSetFeature = () => {};

const BASE_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'roles', label: 'Roles' },
  { id: 'identity', label: 'Identity' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'environment', label: 'Environment' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'egress', label: 'Egress controls' },
  { id: 'experimental', label: 'Experimental' },
];

const DEFAULT_FEATURES: ExperimentalFeatures = {
  benchmarkLab: false,
  egressControls: false,
};
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
  spIdentityEnabled: spIdentityEnabledProp,
}: {
  onClose?: () => void;
  initialSection?: SettingsSection;
  features?: ExperimentalFeatures | null;
  setFeature?: (name: keyof ExperimentalFeatures, enabled: boolean) => void;
  role?: RoleResolution | null;
  /**
   * The deployment-wide pivot (`sp-identity-enabled`). Live Settings loads this
   * from the admin API. Passing it seeds the first paint — tests, and never a
   * browser preference.
   */
  spIdentityEnabled?: boolean;
}) {
  const [active, setActive] = useState<SettingsSection>(initialSection);
  // Held here rather than in the panel because the footer is what stays on
  // screen: `.settings-modal-content` scrolls, so an outcome drawn at the end of
  // the Runtime form was a thousand pixels below the button that caused it.
  const [saveState, setSaveState] = useState<SettingsSaveState>(SETTINGS_SAVE_IDLE);
  // The press paint, held for a beat so the click is visible before the modal
  // goes. See SAVE_PRESS_MS.
  const [pressed, setPressed] = useState(false);
  const seededSpMode = spIdentityEnabledProp !== undefined;
  const [spIdentityEnabled, setSpIdentityEnabled] = useState(spIdentityEnabledProp ?? false);
  const [spModeError, setSpModeError] = useState<string | null>(null);
  const [spModeBusy, setSpModeBusy] = useState(!seededSpMode);
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

  /**
   * The Experimental switch and the Identity pane both follow the server flag.
   *
   * A seed skips the read so a test can paint On without waiting for fetch.
   * Failure stays off: OAuth remains the default until the server says otherwise.
   */
  useEffect(() => {
    if (seededSpMode) return;
    let live = true;
    void loadSpIdentityAdmin()
      .then((payload) => {
        if (live) setSpIdentityEnabled(spIdentityEnabledFromPayload(payload));
      })
      .catch(() => {
        /* Keep OAuth. A failed read must not flip the pivot on. */
      })
      .finally(() => {
        if (live) setSpModeBusy(false);
      });
    return () => {
      live = false;
    };
  }, [seededSpMode]);

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
        : active === 'experimental' && showsBenchmarkLab(features)
          ? BENCHMARK_SETTINGS_FORM_ID
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
                  </div>
                  {showsUserRoster(role.state) ? <UserRoleEditor /> : <AdminListEditor />}
                </div>
              ) : null}
              {active === 'identity' ? (
                <div className="settings-pane">
                  <div className="settings-pane-heading">
                    <h3>Identity</h3>
                  </div>
                  <SpIdentityPanel enabled={spIdentityEnabled} />
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
                  <div className="settings-row">
                    <div>
                      <p className="settings-row-label">SP identities · {spIdentityEnabled ? 'On' : 'Off'}</p>
                      <p className="settings-row-note">
                        Assigned people run warehouse, Genie, and agent calls as the service principal an administrator
                        named for them. People without an assignment still use OAuth. This is for the whole deployment,
                        not this browser.
                      </p>
                      {spModeError ? (
                        <p className="settings-status settings-error" role="alert">
                          {spModeError}
                        </p>
                      ) : null}
                    </div>
                    <Switch
                      checked={spIdentityEnabled}
                      disabled={spModeBusy}
                      onCheckedChange={(enabled) => {
                        const previous = spIdentityEnabled;
                        setSpModeError(null);
                        setSpIdentityEnabled(enabled);
                        setSpModeBusy(true);
                        void persistSpIdentityMode(enabled)
                          .then((payload) => setSpIdentityEnabled(spIdentityEnabledFromPayload(payload)))
                          .catch((caught: unknown) => {
                            setSpIdentityEnabled(previous);
                            setSpModeError(
                              caught instanceof Error
                                ? caught.message
                                : 'The experimental pivot could not be saved. Questions still use OAuth.'
                            );
                          })
                          .finally(() => setSpModeBusy(false));
                      }}
                      aria-label="Run assigned people as their service principal"
                    />
                  </div>
                  <ResourceTagsPanel />
                  <div className="settings-row">
                    <div>
                      <p className="settings-row-label">
                        Benchmarking · {showsBenchmarkLab(features) ? 'Shown' : 'Hidden'}
                      </p>
                    </div>
                    <Switch
                      checked={showsBenchmarkLab(features)}
                      onCheckedChange={(enabled) => setFeature('benchmarkLab', enabled)}
                      aria-label="Show Benchmarking tab"
                    />
                  </div>
                  <BenchmarkSettingsPanel enabled={showsBenchmarkLab(features)} onSaveState={setSaveState} />
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
            <Button variant="outline" data-variant="outline" className="settings-cancel" type="button" onClick={close}>
              Cancel
            </Button>
            {form ? (
              <Button
                type="submit"
                data-variant="primary"
                className="settings-save"
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
