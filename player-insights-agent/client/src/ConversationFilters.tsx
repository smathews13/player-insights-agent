import type { RailOwner } from './conversation-rail';
import type { RailPersona } from './conversation-persona-selection';
import { ConversationOwnerSelect } from './ConversationOwnerSelect';
import { ConversationPersonaSelect } from './ConversationPersonaSelect';

export function ConversationFilters({
  owners,
  personas,
  total,
  selectedOwners,
  selectedPersonas,
  onOwnersChange,
  onPersonasChange,
}: {
  owners: readonly RailOwner[];
  personas: readonly RailPersona[];
  total: number;
  selectedOwners: readonly string[];
  selectedPersonas: readonly string[];
  onOwnersChange: (selected: readonly string[]) => void;
  onPersonasChange: (selected: readonly string[]) => void;
}) {
  return (
    <>
      <ConversationOwnerSelect owners={owners} total={total} selected={selectedOwners} onChange={onOwnersChange} />
      <ConversationPersonaSelect
        personas={personas}
        total={total}
        selected={selectedPersonas}
        onChange={onPersonasChange}
      />
    </>
  );
}
