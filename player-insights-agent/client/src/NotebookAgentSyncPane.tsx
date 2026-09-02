import type { NotebookPanel } from './connection-model';
import { ApplyDeclarationCard } from './ApplyDeclarationCard';
import { NotebookCard } from './NotebookCard';

/** The complete notebook-selection and staged-release workflow behind one flag. */
export function NotebookAgentSyncPane({
  notebook,
  allowMutations,
  onSaved,
  onRefresh,
}: {
  notebook?: NotebookPanel;
  allowMutations: boolean;
  onSaved: () => unknown;
  onRefresh: () => void;
}) {
  return (
    <div className="configuration-plane-row" data-testid="notebook-agent-sync">
      <NotebookCard panel={notebook} allowMutations={allowMutations} onSaved={onSaved} />
      <ApplyDeclarationCard notebook={notebook} onRefresh={onRefresh} />
    </div>
  );
}
