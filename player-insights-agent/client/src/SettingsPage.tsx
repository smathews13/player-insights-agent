import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import './styles/routes/settings.css';
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
  showsNotebookAgentSync,
  withExperimentalFeature,
  type ExperimentalFeatures,
} from './experimental-features';
import { BenchmarkSettingsPanel, BENCHMARK_SETTINGS_FORM_ID } from './BenchmarkSettingsPanel';
import { RuntimeSettingsPanel, RUNTIME_SETTINGS_FORM_ID } from './RuntimeSettingsPanel';
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
import { Dialog } from './Dialog';
import { settingsDismissalAction } from './settings-dismissal';
import { saveExperimentalSettings, type ExperimentalSettingsDocument } from './experimental-settings-api';

const noopClose = () => {};

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

export function SettingsDiscardDialog({
  onKeepEditing,
  onDiscard,
}: {
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  return (
    <Dialog
      overlayClassName="settings-discard-overlay"
      contentClassName="settings-discard"
      labelledBy="settings-discard-title"
      describedBy="settings-discard-description"
      onDismiss={onKeepEditing}
    >
      <h3 id="settings-discard-title">Discard changes?</h3>
      <p id="settings-discard-description">Your staged changes have not been saved.</p>
      <div className="settings-discard-actions">
        <Button variant="outline" type="button" onClick={onKeepEditing}>
          Keep editing
        </Button>
        <Button type="button" onClick={onDiscard}>
          Discard changes
        </Button>
      </div>
    </Dialog>
  );
}

export function SettingsPage({
  onClose,
  initialSection = 'runtime',
  features: featuresProp,
  role: roleProp,
  experimentalRevision: experimentalRevisionProp = 0,
  experimentalLoaded = true,
  experimentalFailure = '',
  onExperimentalSaved = () => {},
}: {
  onClose?: () => void;
  initialSection?: SettingsSection;
  features?: ExperimentalFeatures | null;
  setFeature?: (name: keyof ExperimentalFeatures, enabled: boolean) => void;
  role?: RoleResolution | null;
  experimentalRevision?: number;
  experimentalLoaded?: boolean;
  experimentalFailure?: string;
  onExperimentalSaved?: (document: ExperimentalSettingsDocument) => void;
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
  const [discardOpen, setDiscardOpen] = useState(false);
  const close = onClose ?? noopClose;
  // `?? ` rather than a default parameter, because a default parameter only
  // covers `undefined`. A caller handing down a value it fetched can hand down
  // null, and `null.state` a few lines below is read while THIS component
  // renders -- outside the pane boundary, so it would take the page down rather
  // than one section of it.
  const [draftFeatures, setDraftFeatures] = useState<ExperimentalFeatures>(() => ({ ...features }));
  const [savedFeatures, setSavedFeatures] = useState<ExperimentalFeatures>(() => ({ ...features }));
  const [experimentalRevision, setExperimentalRevision] = useState(experimentalRevisionProp);
  const role = roleProp ?? DEFAULT_ROLE;
  const sections = availableSettingsSections(savedFeatures);

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
  const experimentalShellDirtyCount = featureChanges.length;
  const dirtyCount = paneDirtyCount + (active === 'experimental' ? experimentalShellDirtyCount : 0);

  const commitExperimental = useCallback(async () => {
    if (featureChanges.length > 0) {
      const patch = Object.fromEntries(
        featureChanges.map((key) => [key, draftFeatures[key as keyof ExperimentalFeatures]])
      ) as Partial<ExperimentalFeatures>;
      let document: ExperimentalSettingsDocument;
      try {
        document = await saveExperimentalSettings(experimentalRevision, patch);
      } catch (error) {
        setDraftFeatures({ ...savedFeatures });
        throw error;
      }
      setDraftFeatures({ ...document.settings });
      setSavedFeatures({ ...document.settings });
      setExperimentalRevision(document.revision);
      onExperimentalSaved(document);
    }
  }, [draftFeatures, experimentalRevision, featureChanges, onExperimentalSaved, savedFeatures]);

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
  const requestClose = useCallback(() => {
    switch (settingsDismissalAction(dirtyCount, saving)) {
      case 'ignore':
        return;
      case 'confirm':
        setDiscardOpen(true);
        return;
      case 'close':
        close();
    }
  }, [close, dirtyCount, saving]);
  const discardChanges = useCallback(() => {
    setDiscardOpen(false);
    close();
  }, [close]);

  return (
    <Dialog
      overlayClassName="settings-overlay"
      contentClassName="settings-modal settings-page"
      contentAs="section"
      overlayTestId="settings-modal-overlay"
      labelledBy="settings-title"
      onDismiss={requestClose}
    >
      <header className="settings-modal-header">
        <div>
          <h2 id="settings-title">Settings</h2>
        </div>
        <button
          className="settings-close"
          type="button"
          onClick={requestClose}
          aria-label="Close settings"
          disabled={saving}
        >
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
                <UserRoleEditor canManageHumanRoles={showsUserRoster(role.state)} />
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
                {!experimentalLoaded ? (
                  <p className="settings-status settings-error" role="alert">
                    {experimentalFailure || 'Experimental settings are still loading from Lakebase.'}
                  </p>
                ) : null}
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
                        <ExperimentalFeatureName>Egress controls panel</ExperimentalFeatureName>
                        <p className="settings-row-note">
                          Configures approved outbound network destinations for app requests.
                        </p>
                      </td>
                      <td className="exp-feature-status">
                        <ExperimentalStatus on={showsEgressControls(draftFeatures)} />
                      </td>
                      <td className="exp-feature-control">
                        <div className="exp-feature-control-inner">
                          <Switch
                            checked={showsEgressControls(draftFeatures)}
                            disabled={!experimentalLoaded}
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
                        <ExperimentalFeatureName>Notebook agent sync</ExperimentalFeatureName>
                        <p className="settings-row-note">
                          Selects the agent notebook and applies staged agent versions.
                        </p>
                      </td>
                      <td className="exp-feature-status">
                        <ExperimentalStatus on={showsNotebookAgentSync(draftFeatures)} />
                      </td>
                      <td className="exp-feature-control">
                        <div className="exp-feature-control-inner">
                          <Switch
                            checked={showsNotebookAgentSync(draftFeatures)}
                            disabled={!experimentalLoaded}
                            onCheckedChange={(enabled) => {
                              setDraftFeatures((current) =>
                                withExperimentalFeature(current, 'notebookAgentSync', enabled)
                              );
                              setSaveState(SETTINGS_SAVE_IDLE);
                            }}
                            aria-label="Enable Notebook agent sync"
                          />
                        </div>
                      </td>
                    </tr>
                    <ResourceTagsPanel />
                    <tr>
                      <td>
                        <ExperimentalFeatureName>Forecasting</ExperimentalFeatureName>
                        <p className="settings-row-note">
                          Projects 7- and 30-day costs from configurable usage assumptions.
                        </p>
                      </td>
                      <td className="exp-feature-status">
                        <ExperimentalStatus on={showsForecasting(draftFeatures)} />
                      </td>
                      <td className="exp-feature-control">
                        <div className="exp-feature-control-inner">
                          <Switch
                            checked={showsForecasting(draftFeatures)}
                            disabled={!experimentalLoaded}
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
                        <p className="settings-row-note">
                          Runs repeatable evaluation suites against saved test questions.
                        </p>
                      </td>
                      <td className="exp-feature-status">
                        <ExperimentalStatus on={showsBenchmarkLab(draftFeatures)} />
                      </td>
                      <td className="exp-feature-control">
                        <div className="exp-feature-control-inner">
                          <Switch
                            checked={showsBenchmarkLab(draftFeatures)}
                            disabled={!experimentalLoaded}
                            onCheckedChange={(enabled) => {
                              setDraftFeatures((current) => withExperimentalFeature(current, 'benchmarkLab', enabled));
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
          <Button
            variant="outline"
            data-variant="outline"
            className="settings-cancel"
            type="button"
            onClick={requestClose}
            disabled={saving}
          >
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
      {discardOpen ? (
        <SettingsDiscardDialog onKeepEditing={() => setDiscardOpen(false)} onDiscard={discardChanges} />
      ) : null}
    </Dialog>
  );
}
