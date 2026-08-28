import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { EgressPanel, EGRESS_SETTINGS_FORM_ID } from './EgressPanel';
import { EnvironmentPanel } from './EnvironmentPanel';
import { ExperimentalFeatureName, ExperimentalStatus } from './ExperimentalBadge';
import { ResourceTagsPanel } from './ResourceTagsPanel';
import {
  NO_EXPERIMENTS,
  showsBenchmarkLab,
  showsEgressControls,
  showsForecasting,
  withExperimentalFeature,
  type ExperimentalFeatures,
} from './experimental-features';
import { BenchmarkSettingsPanel, BENCHMARK_SETTINGS_FORM_ID } from './BenchmarkSettingsPanel';
import { RuntimeSettingsPanel, RUNTIME_SETTINGS_FORM_ID } from './RuntimeSettingsPanel';
import { loadSpIdentityAdmin, persistSpIdentityMode } from './identity-settings-api';
import { spIdentityEnabledFromPayload } from './sp-identity-mode';
import { showsUserRoster, type RoleResolution } from './role';
import {
  SAVE_PRESS_MS,
  SETTINGS_SAVE_IDLE,
  changedSettingKeys,
  navigateSettingsSection,
  saveButtonLabel,
  saveInFlight,
  saveNotice,
  settingsSaveDisabled,
  unsavedChangesLabel,
  type SettingsSaveState,
} from './settings-save-state';
import {
  BASE_SETTINGS_SECTIONS,
  availableSettingsSections,
  normalizeSettingsSection,
  type SettingsSection,
} from './settings-sections';
import { UserRoleEditor } from './UserRoleEditor';
import { Button, Switch } from './ui';

const noopClose = () => {};
const noopSetFeature = () => {};

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
            <h3>{BASE_SETTINGS_SECTIONS.find((section) => section.id === this.props.section)?.label ?? 'Settings'}</h3>
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
  const features = featuresProp ?? NO_EXPERIMENTS;
  const [active, setActive] = useState<SettingsSection>(() => normalizeSettingsSection(initialSection, features));
  // Held here rather than in the panel because the footer is what stays on
  // screen: `.settings-modal-content` scrolls, so an outcome drawn at the end of
  // the Runtime form was a thousand pixels below the button that caused it.
  const [saveState, setSaveState] = useState<SettingsSaveState>(SETTINGS_SAVE_IDLE);
  const [paneDirtyCount, setPaneDirtyCount] = useState(0);
  const paneDirtyCountRef = useRef(0);
  // The press paint, held for a beat so the click is visible before the modal
  // goes. See SAVE_PRESS_MS.
  const [pressed, setPressed] = useState(false);
  const seededSpMode = spIdentityEnabledProp !== undefined;
  const [spIdentityEnabled, setSpIdentityEnabled] = useState(spIdentityEnabledProp ?? false);
  const [savedSpIdentityEnabled, setSavedSpIdentityEnabled] = useState(spIdentityEnabledProp ?? false);
  const [spModeError, setSpModeError] = useState<string | null>(null);
  const [spModeBusy, setSpModeBusy] = useState(!seededSpMode);
  const close = onClose ?? noopClose;
  // `?? ` rather than a default parameter, because a default parameter only
  // covers `undefined`. A caller handing down a value it fetched can hand down
  // null, and `null.state` a few lines below is read while THIS component
  // renders -- outside the pane boundary, so it would take the page down rather
  // than one section of it.
  const [draftFeatures, setDraftFeatures] = useState<ExperimentalFeatures>(() => ({ ...features }));
  const [savedFeatures, setSavedFeatures] = useState<ExperimentalFeatures>(() => ({ ...features }));
  const role = roleProp ?? DEFAULT_ROLE;
  const setFeature = setFeatureProp ?? noopSetFeature;
  const sections = availableSettingsSections(savedFeatures);

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
        if (live) {
          const enabled = spIdentityEnabledFromPayload(payload);
          setSpIdentityEnabled(enabled);
          setSavedSpIdentityEnabled(enabled);
        }
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

  const handlePaneDirty = useCallback((count: number) => {
    if (paneDirtyCountRef.current === count) return;
    paneDirtyCountRef.current = count;
    setPaneDirtyCount(count);
    setSaveState((current) => (current.kind === 'saving' ? current : SETTINGS_SAVE_IDLE));
  }, []);

  const featureChanges = useMemo(
    () => changedSettingKeys(savedFeatures, draftFeatures),
    [draftFeatures, savedFeatures]
  );
  const experimentalShellDirtyCount = featureChanges.length + (spIdentityEnabled === savedSpIdentityEnabled ? 0 : 1);
  const dirtyCount = paneDirtyCount + (active === 'experimental' ? experimentalShellDirtyCount : 0);

  const commitExperimental = useCallback(async () => {
    let committedSpMode = spIdentityEnabled;
    if (spIdentityEnabled !== savedSpIdentityEnabled) {
      setSpModeBusy(true);
      try {
        const payload = await persistSpIdentityMode(spIdentityEnabled);
        committedSpMode = spIdentityEnabledFromPayload(payload);
        if (committedSpMode !== spIdentityEnabled) {
          throw new Error('The service-principal identity setting was not saved as requested.');
        }
      } finally {
        setSpModeBusy(false);
      }
    }
    for (const key of featureChanges) {
      const name = key as keyof ExperimentalFeatures;
      setFeature(name, draftFeatures[name]);
    }
    setSavedFeatures({ ...draftFeatures });
    setSavedSpIdentityEnabled(committedSpMode);
    setSpIdentityEnabled(committedSpMode);
  }, [draftFeatures, featureChanges, savedSpIdentityEnabled, setFeature, spIdentityEnabled]);

  const form =
    active === 'runtime' || active === 'appearance'
      ? RUNTIME_SETTINGS_FORM_ID
      : active === 'egress'
        ? EGRESS_SETTINGS_FORM_ID
        : active === 'experimental'
          ? BENCHMARK_SETTINGS_FORM_ID
          : undefined;
  const notice = saveNotice(saveState);
  const saving = saveInFlight(saveState);
  /*
   * Identity writes are deliberately immediate because each row has its own
   * server-authorized mutation. Environment is read-only. Their disabled Save
   * controls preserve the modal's stable action geometry without pretending
   * there is a form to submit or a change that Cancel could roll back.
   */
  const saveDisabled = settingsSaveDisabled(saving, dirtyCount, Boolean(form));
  const dirtyLabel = unsavedChangesLabel(dirtyCount);

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
                disabled={section.id !== active && dirtyCount > 0}
                title={section.id !== active && dirtyCount > 0 ? 'Save or Cancel the current changes first' : undefined}
                onClick={() => {
                  navigateSettingsSection(active, section.id, dirtyCount, {
                    select: setActive,
                    clearPaneDirty: () => {
                      paneDirtyCountRef.current = 0;
                      setPaneDirtyCount(0);
                    },
                    // A "Saved" from the pane being left must not be read as an
                    // outcome for the one being opened.
                    resetSaveState: () => setSaveState(SETTINGS_SAVE_IDLE),
                  });
                }}
              >
                {section.label}
              </button>
            ))}
          </nav>
          <div className="settings-modal-content">
            <SettingsPaneBoundary key={active} section={active}>
              {active === 'identity' ? (
                <div className="settings-pane settings-identity">
                  <div className="settings-pane-heading">
                    <h3>Identity</h3>
                  </div>
                  <UserRoleEditor
                    spIdentityEnabled={spIdentityEnabled}
                    canManageHumanRoles={showsUserRoster(role.state)}
                  />
                </div>
              ) : null}
              {active === 'runtime' || active === 'appearance' ? (
                <RuntimeSettingsPanel section={active} onSaveState={setSaveState} onDirtyChange={handlePaneDirty} />
              ) : null}
              {active === 'environment' ? <EnvironmentPanel /> : null}
              {active === 'egress' ? <EgressPanel onSaveState={setSaveState} onDirtyChange={handlePaneDirty} /> : null}
              {active === 'experimental' ? (
                <div className="settings-pane">
                  <div className="settings-pane-heading">
                    <h3>Experimental</h3>
                  </div>
                  <table className="exp-feature-table">
                    <colgroup>
                      <col className="exp-feature-name-column" />
                      <col className="exp-feature-status-column" />
                      <col className="exp-feature-control-column" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">Feature</th>
                        <th scope="col">Status</th>
                        <th scope="col">Control</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>
                          <ExperimentalFeatureName>PII egress judge</ExperimentalFeatureName>
                        </td>
                        <td className="exp-feature-status">
                          <ExperimentalStatus on={showsEgressControls(draftFeatures)} />
                        </td>
                        <td className="exp-feature-control">
                          <div className="exp-feature-control-inner">
                            <Switch
                              checked={showsEgressControls(draftFeatures)}
                              onCheckedChange={(enabled) => {
                                setDraftFeatures((current) =>
                                  withExperimentalFeature(current, 'egressControls', enabled)
                                );
                                setSaveState(SETTINGS_SAVE_IDLE);
                              }}
                              aria-label="Show the egress controls on this page"
                            />
                          </div>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <ExperimentalFeatureName>SP identities</ExperimentalFeatureName>
                          {spModeError ? (
                            <p className="settings-status settings-error" role="alert">
                              {spModeError}
                            </p>
                          ) : null}
                        </td>
                        <td className="exp-feature-status">
                          <ExperimentalStatus on={spIdentityEnabled} />
                        </td>
                        <td className="exp-feature-control">
                          <div className="exp-feature-control-inner">
                            {spIdentityEnabled ? (
                              <button
                                type="button"
                                className="settings-identity-link"
                                data-testid="sp-identity-settings-link"
                                disabled={dirtyCount > 0}
                                title={dirtyCount > 0 ? 'Save or Cancel the current changes first' : undefined}
                                onClick={() => {
                                  setActive('identity');
                                  setSaveState(SETTINGS_SAVE_IDLE);
                                }}
                              >
                                Identity
                              </button>
                            ) : null}
                            <Switch
                              checked={spIdentityEnabled}
                              disabled={spModeBusy}
                              onCheckedChange={(enabled) => {
                                setSpModeError(null);
                                setSpIdentityEnabled(enabled);
                                setSaveState(SETTINGS_SAVE_IDLE);
                              }}
                              aria-label="Run assigned people as their service principal"
                            />
                          </div>
                        </td>
                      </tr>
                      <ResourceTagsPanel />
                      <tr>
                        <td>
                          <ExperimentalFeatureName>Forecasting</ExperimentalFeatureName>
                        </td>
                        <td className="exp-feature-status">
                          <ExperimentalStatus on={showsForecasting(draftFeatures)} />
                        </td>
                        <td className="exp-feature-control">
                          <div className="exp-feature-control-inner">
                            <Switch
                              checked={showsForecasting(draftFeatures)}
                              onCheckedChange={(enabled) => {
                                setDraftFeatures((current) => withExperimentalFeature(current, 'forecasting', enabled));
                                setSaveState(SETTINGS_SAVE_IDLE);
                              }}
                              aria-label="Show Ops forecasting"
                            />
                          </div>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <ExperimentalFeatureName>Benchmarking</ExperimentalFeatureName>
                        </td>
                        <td className="exp-feature-status">
                          <ExperimentalStatus on={showsBenchmarkLab(draftFeatures)} />
                        </td>
                        <td className="exp-feature-control">
                          <div className="exp-feature-control-inner">
                            <Switch
                              checked={showsBenchmarkLab(draftFeatures)}
                              onCheckedChange={(enabled) => {
                                setDraftFeatures((current) =>
                                  withExperimentalFeature(current, 'benchmarkLab', enabled)
                                );
                                setSaveState(SETTINGS_SAVE_IDLE);
                              }}
                              aria-label="Show Benchmarking tab"
                            />
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <BenchmarkSettingsPanel
                    enabled={showsBenchmarkLab(draftFeatures)}
                    onSaveState={setSaveState}
                    onDirtyChange={handlePaneDirty}
                    additionalChangeCount={experimentalShellDirtyCount}
                    onCommitStaged={commitExperimental}
                  />
                </div>
              ) : null}
            </SettingsPaneBoundary>
          </div>
        </div>

        <footer className="settings-modal-footer">
          {dirtyLabel ? (
            <p className="settings-dirty-indicator" role="status">
              {dirtyLabel} <span className="ast-num">{dirtyCount}</span>
            </p>
          ) : (
            <span aria-hidden="true" />
          )}
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
            <Button
              type="submit"
              data-variant="primary"
              className="settings-save"
              form={form}
              disabled={saveDisabled}
              aria-busy={saving}
              data-pressed={pressed ? 'true' : undefined}
              title={
                active === 'identity'
                  ? 'Identity changes save immediately'
                  : active === 'environment'
                    ? 'Environment details are read-only'
                    : undefined
              }
              onClick={() => setPressed(true)}
            >
              {saveButtonLabel(saveState)}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}
