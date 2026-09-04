/**
 * The notebook row: what it published, against what the model is running.
 *
 * Built to the Connections spec in the current design handoff: bordered card,
 * banded header, label/value grid, mono status badges, no explanatory paragraph.
 * The one line of copy per row comes from `declared-connection-view.ts`, and only
 * for rows where something is not in use.
 *
 * THE PALETTE IS NO LONGER IN THIS FILE. It arrived as inline style objects with
 * four tones written out hex by hex, which is how the card came to be a fifth
 * independent status recipe on a page that had just converged on one. The tones
 * are now `.ast-pill` families and the geometry is `.plane-*` in
 * `connections.css`, so this component names meanings and the stylesheet decides
 * how they render. Nothing about what the card SAYS moved: every string still
 * comes from `declared-connection-view.ts`.
 */
import { useEffect, useState } from 'react';
import { comparisonBadge, comparisonNote, EMPTY_SCOPES_LABEL, emptyScopesNote } from './declared-connection-view';
import { astValueBadge, type AstPillFamily } from './pia-pill';
import type { NotebookPanel } from './connection-model';
import { AssetPicker } from './AssetPicker';
import type { AssetPickerSpec } from './asset-picker';
import { Button } from './ui';
import { PiaBusyButtonContent } from './PiaLoader';
import { notebookPathView, persistNotebookPath } from './notebook-card-state';

const NOTEBOOK_PICKER: AssetPickerSpec = {
  field: 'notebook-path',
  levels: ['notebooks'],
  pickAt: 'last',
  multi: false,
  title: 'Workspace notebooks your sign-in can see',
  typeLabel: 'Workspace notebook path',
  typeNote: '',
};

/**
 * The comparison tones, in the palette's own families.
 *
 * `comparisonBadge` names a colour, because it predates the one recipe and is
 * shared with tests that assert on the word. Translating here rather than there
 * keeps that contract and still leaves exactly one place in this component that
 * knows which family a tone takes.
 *
 * Neutral is the OUTLINED form deliberately. These badges sit in rows on white,
 * and an unfilled chip is what the recipe asks for where a tint would read as a
 * verdict about a value nothing checked.
 */
const BADGE_FAMILY: Record<'green' | 'amber' | 'neutral' | 'red', AstPillFamily> = {
  green: 'pos',
  amber: 'warn',
  neutral: 'neutral-outline',
  red: 'neg',
};

/**
 * A published value's verdict: the word inside the family's chip, in mono.
 *
 * Mono because what these badges carry is a setting's state rather than a
 * sentence, and the values beside them are mono identifiers.
 */
function Badge({ tone, children }: { tone: keyof typeof BADGE_FAMILY; children: React.ReactNode }) {
  return <span className={astValueBadge(BADGE_FAMILY[tone], 'plane-badge')}>{children}</span>;
}

/**
 * The card, or nothing at all when no server on the other end knows about
 * notebooks.
 *
 * Absent is different from unconfigured: a build serving an older payload should
 * draw no card rather than one saying a notebook is not connected, which would be a
 * claim about a deployment this page cannot see.
 */
export function NotebookCard({
  panel,
  allowMutations = false,
  onSaved,
}: {
  panel?: NotebookPanel;
  allowMutations?: boolean;
  onSaved?: () => unknown;
}) {
  if (!panel) return null;
  return <NotebookCardContent panel={panel} allowMutations={allowMutations} onSaved={onSaved} />;
}

function NotebookCardContent({
  panel,
  allowMutations,
  onSaved,
}: {
  panel: NotebookPanel;
  allowMutations: boolean;
  onSaved?: () => unknown;
}) {
  const declaration = panel.read.declaration;
  const emptyScopes = emptyScopesNote(panel);
  const { configured: configuredPath, observed: observedPath, shown: shownPath } = notebookPathView(panel);
  const [browsing, setBrowsing] = useState(false);
  const [draft, setDraft] = useState(shownPath);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => setDraft(shownPath), [shownPath]);

  async function saveNotebookPath() {
    setSaving(true);
    setSaveError('');
    try {
      const result = await persistNotebookPath(draft);
      if (!result.ok) {
        setSaveError(result.detail);
        return;
      }
      setBrowsing(false);
      await onSaved?.();
    } catch {
      setSaveError('The notebook path could not be saved just now.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="notebook-agent-sync-notebook" className="plane-card" aria-label="Notebook">
      <div className="plane-card-head">
        <span className="plane-card-title">Notebook</span>
        <span className="plane-card-purpose">
          Connecting one shows the settings it published beside what the running agent uses.
        </span>
      </div>
      <div className="plane-card-body">
        <div className="plane-facts">
          <span className="plane-label">Published to</span>
          <span className="plane-value ast-mono" title={shownPath}>
            {shownPath || 'not set'}
          </span>
          {shownPath ? (
            <>
              <span className="plane-label">Path source</span>
              <span className="plane-value">{configuredPath ? 'Saved configuration' : 'Latest published run'}</span>
            </>
          ) : null}
          {configuredPath && observedPath && configuredPath !== observedPath ? (
            <>
              <span className="plane-label">Last published by</span>
              <span className="plane-value ast-mono" title={observedPath}>
                {observedPath}
              </span>
            </>
          ) : null}
          {panel.location ? (
            <>
              <span className="plane-label">Declarations table</span>
              <span className="plane-value ast-mono" title={panel.location}>
                {panel.location}
              </span>
            </>
          ) : null}
          {declaration?.revision ? (
            <>
              <span className="plane-label">Revision</span>
              {/* A revision is a number in a cell, so it is `.ast-num` rather
                  than `.ast-mono`: the two differ only in tabular figures, and a
                  revision is the one value in this grid that is counted. */}
              <span className="plane-value ast-num">{declaration.revision}</span>
            </>
          ) : null}
          {declaration?.publishedBy ? (
            <>
              <span className="plane-label">Published by</span>
              <span className="plane-value">{declaration.publishedBy}</span>
            </>
          ) : null}
        </div>

        {allowMutations ? (
          <div className="plane-stack notebook-path-editor">
            <Button type="button" variant="default" size="sm" onClick={() => setBrowsing((open) => !open)}>
              {browsing ? 'Cancel notebook selection' : 'Browse workspace notebooks'}
            </Button>
            {browsing ? (
              <>
                <AssetPicker spec={NOTEBOOK_PICKER} current={draft} onPick={setDraft} />
                {draft ? (
                  <div className="plane-row">
                    <span className="plane-row-name">Review selection</span>
                    <span className="plane-row-value ast-mono" title={draft}>
                      {draft}
                    </span>
                    <button
                      type="button"
                      className="plane-button-primary"
                      disabled={saving || draft === configuredPath}
                      aria-busy={saving || undefined}
                      onClick={() => void saveNotebookPath()}
                    >
                      <PiaBusyButtonContent busy={saving} label="Save notebook" busyLabel="Saving" />
                    </button>
                  </div>
                ) : null}
                {saveError ? <span className="plane-error">{saveError}</span> : null}
              </>
            ) : null}
          </div>
        ) : null}

        {panel.comparison.length > 0 ? (
          <div className="plane-rows">
            {panel.comparison.map((row) => {
              const badge = comparisonBadge(row);
              const note = comparisonNote(row);
              return (
                <div key={row.key} className="plane-stack">
                  <div className="plane-row">
                    <span className="plane-row-name">{row.label}</span>
                    <span className="plane-row-value ast-mono" title={`published ${row.declared}`}>
                      {row.declared}
                    </span>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </div>
                  {note ? <span className="plane-note">{note}</span> : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {/* The one grey line on this card, and the reason it is grey rather than
            a chip: it says what an empty allowlist means HERE, which is the
            opposite of what the notebook means by it. A pill would make a
            standing warning out of a deployment's ordinary configuration. */}
        {emptyScopes ? (
          <div className="plane-row plane-row--note">
            <span className="plane-row-name">{EMPTY_SCOPES_LABEL}</span>
            <span className="plane-note">{emptyScopes}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
