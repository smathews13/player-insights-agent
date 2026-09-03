import { CONVERSATION_PERSONA_FILTER_RULE } from '../../shared/conversation-filters';
import { AppMultiSelect } from './AppMultiSelect';
import { personaSelectionSummary, togglePersonaSelection, type RailPersona } from './conversation-persona-selection';

export function ConversationPersonaSelect({
  personas,
  total,
  selected,
  onChange,
}: {
  personas: readonly RailPersona[];
  total: number;
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
}) {
  const summary = personaSelectionSummary(selected, personas);

  return (
    <AppMultiSelect
      label="Conversation personas"
      ariaLabel="Filter conversations by persona"
      summary={summary}
      allLabel="All personas"
      total={total}
      selected={selected}
      onChange={onChange}
      toggleValue={togglePersonaSelection}
      className="conversation-owner-select conversation-persona-select"
      contentClassName="conversation-owner-menu conversation-persona-menu"
      description={CONVERSATION_PERSONA_FILTER_RULE}
      options={personas.map((persona) => ({
        value: persona.key,
        label: persona.name,
        ariaLabel: `${persona.name}, ${persona.count} conversation${persona.count === 1 ? '' : 's'}`,
        title: persona.name,
        count: persona.count,
      }))}
    />
  );
}
