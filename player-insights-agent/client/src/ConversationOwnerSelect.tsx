import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { RailOwner } from './conversation-rail';
import { identityName } from './user-identity';
import { moveOwnerFocus, ownerSelectionSummary, toggleOwnerSelection } from './conversation-owner-selection';
import { Popover, PopoverContent, PopoverTrigger } from './ui';

export function ConversationOwnerOptions({
  owners,
  total,
  selected,
  onChange,
  onFocus,
  onOptionRef,
}: {
  owners: readonly RailOwner[];
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
        className="conversation-owner-option"
        onFocus={() => onFocus(0)}
        onClick={() => onChange([])}
      >
        <span className="conversation-owner-check" aria-hidden="true">
          <Check />
        </span>
        <span className="conversation-owner-option-label">All users</span>
        <span className="conversation-owner-option-count">{total}</span>
      </button>
      {owners.map((owner, index) => {
        const optionIndex = index + 1;
        const isSelected = selected.includes(owner.key);
        const displayName = identityName(owner.email);
        return (
          <button
            key={owner.key}
            ref={(element) => onOptionRef(optionIndex, element)}
            type="button"
            role="option"
            aria-selected={isSelected}
            aria-label={`${owner.you ? `You, ${displayName}` : displayName}, ${owner.count} conversation${
              owner.count === 1 ? '' : 's'
            }`}
            title={owner.email}
            className="conversation-owner-option"
            onFocus={() => onFocus(optionIndex)}
            onClick={() => onChange(toggleOwnerSelection(selected, owner.key))}
          >
            <span className="conversation-owner-check" aria-hidden="true">
              <Check />
            </span>
            <span className="conversation-owner-option-label">
              {owner.you ? (
                <>
                  <strong>You</strong>
                  <span className="conversation-owner-option-detail"> · {displayName}</span>
                </>
              ) : (
                displayName
              )}
            </span>
            <span className="conversation-owner-option-count">{owner.count}</span>
          </button>
        );
      })}
    </>
  );
}

export function ConversationOwnerSelect({
  owners,
  total,
  selected,
  onChange,
}: {
  owners: readonly RailOwner[];
  total: number;
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const optionCount = owners.length + 1;
  const summary = ownerSelectionSummary(selected, owners);

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
          const selectedIndex = owners.findIndex((owner) => selected.includes(owner.key));
          setFocused(selectedIndex < 0 ? 0 : selectedIndex + 1);
        }
        setOpen(nextOpen);
      }}
    >
      <div className="conversation-owner-select">
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="conversation-owner-trigger"
            aria-label={`Filter conversations by owner: ${summary}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={menuId}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              const selectedIndex = owners.findIndex((owner) => selected.includes(owner.key));
              setFocused(selectedIndex < 0 ? 0 : selectedIndex + 1);
              setOpen(true);
            }}
          >
            <span className="conversation-owner-summary">{summary}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          id={menuId}
          className="conversation-owner-menu"
          role="listbox"
          aria-label="Conversation owners"
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
          <ConversationOwnerOptions
            owners={owners}
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
