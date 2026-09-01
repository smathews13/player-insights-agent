import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { CONVERSATION_PERSONA_FILTER_RULE } from '../../shared/conversation-filters';
import { personaSelectionSummary, togglePersonaSelection, type RailPersona } from './conversation-persona-selection';
import { moveOwnerFocus } from './conversation-owner-selection';
import { Popover, PopoverContent, PopoverTrigger } from './ui';

export function ConversationPersonaOptions({
  personas,
  total,
  selected,
  onChange,
  onFocus,
  onOptionRef,
}: {
  personas: readonly RailPersona[];
  total: number;
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
  onFocus: (index: number) => void;
  onOptionRef: (index: number, element: HTMLButtonElement | null) => void;
}) {
  return (
    <>
      <button
        ref={(element) => onOptionRef(0, element)}
        type="button"
        role="option"
        aria-selected={selected.length === 0}
        className="conversation-owner-option conversation-persona-option"
        onFocus={() => onFocus(0)}
        onClick={() => onChange([])}
      >
        <span className="conversation-owner-check" aria-hidden="true">
          <Check />
        </span>
        <span className="conversation-owner-option-label">All personas</span>
        <span className="conversation-owner-option-count">{total}</span>
      </button>
      {personas.map((persona, index) => {
        const optionIndex = index + 1;
        const isSelected = selected.includes(persona.key);
        return (
          <button
            key={persona.key}
            ref={(element) => onOptionRef(optionIndex, element)}
            type="button"
            role="option"
            aria-selected={isSelected}
            aria-label={`${persona.name}, ${persona.count} conversation${persona.count === 1 ? '' : 's'}`}
            title={persona.name}
            className="conversation-owner-option conversation-persona-option"
            onFocus={() => onFocus(optionIndex)}
            onClick={() => onChange(togglePersonaSelection(selected, persona.key))}
          >
            <span className="conversation-owner-check" aria-hidden="true">
              <Check />
            </span>
            <span className="conversation-owner-option-label">{persona.name}</span>
            <span className="conversation-owner-option-count">{persona.count}</span>
          </button>
        );
      })}
    </>
  );
}

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
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const descriptionId = useId();
  const optionCount = personas.length + 1;
  const summary = personaSelectionSummary(selected, personas);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => optionRefs.current[focused]?.focus());
  }, [focused, open]);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = moveOwnerFocus(focused, event.key, optionCount);
    setFocused(next);
    optionRefs.current[next]?.focus();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          const selectedIndex = personas.findIndex((persona) => selected.includes(persona.key));
          setFocused(selectedIndex < 0 ? 0 : selectedIndex + 1);
        }
        setOpen(nextOpen);
      }}
    >
      <div className="conversation-owner-select conversation-persona-select">
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="conversation-owner-trigger conversation-persona-trigger"
            aria-label={`Filter conversations by persona: ${summary}`}
            aria-describedby={descriptionId}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={menuId}
            title={CONVERSATION_PERSONA_FILTER_RULE}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              const selectedIndex = personas.findIndex((persona) => selected.includes(persona.key));
              setFocused(selectedIndex < 0 ? 0 : selectedIndex + 1);
              setOpen(true);
            }}
          >
            <span className="conversation-owner-summary">{summary}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <span id={descriptionId} className="sr-only">
          {CONVERSATION_PERSONA_FILTER_RULE}
        </span>
        <PopoverContent
          id={menuId}
          className="conversation-owner-menu conversation-persona-menu"
          role="listbox"
          aria-label="Conversation personas"
          aria-multiselectable="true"
          align="start"
          side="bottom"
          sideOffset={4}
          avoidCollisions
          collisionPadding={8}
          sticky="always"
          hideWhenDetached
          updatePositionStrategy="always"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            optionRefs.current[focused]?.focus();
          }}
          onKeyDown={handleMenuKey}
        >
          <ConversationPersonaOptions
            personas={personas}
            total={total}
            selected={selected}
            onChange={onChange}
            onFocus={setFocused}
            onOptionRef={(index, element) => {
              optionRefs.current[index] = element;
            }}
          />
        </PopoverContent>
      </div>
    </Popover>
  );
}
