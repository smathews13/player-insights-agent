import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { RailOwner } from './conversation-rail';
import { identityName } from './user-identity';
import { moveOwnerFocus, ownerSelectionSummary, toggleOwnerSelection } from './conversation-owner-selection';

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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const optionCount = owners.length + 1;
  const summary = ownerSelectionSummary(selected, owners);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

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
    <div className="conversation-owner-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="conversation-owner-trigger"
        aria-label={`Filter conversations by owner: ${summary}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          if (!open) {
            const selectedIndex = owners.findIndex((owner) => selected.includes(owner.key));
            setFocused(selectedIndex < 0 ? 0 : selectedIndex + 1);
          }
          setOpen((value) => !value);
        }}
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
      {open ? (
        <div
          id={menuId}
          className="conversation-owner-menu"
          role="listbox"
          aria-label="Conversation owners"
          aria-multiselectable="true"
          onKeyDown={handleMenuKey}
        >
          <button
            ref={(element) => {
              optionRefs.current[0] = element;
            }}
            type="button"
            role="option"
            aria-selected={selected.length === 0}
            className="conversation-owner-option"
            onFocus={() => setFocused(0)}
            onClick={() => onChange([])}
          >
            <span className="conversation-owner-check" aria-hidden="true">
              <Check />
            </span>
            <span className="conversation-owner-option-label">All users</span>
            <span className="conversation-owner-option-count">{total}</span>
          </button>
          {owners.map((owner, index) => {
            const isSelected = selected.includes(owner.key);
            const displayName = identityName(owner.email);
            return (
              <button
                key={owner.key}
                ref={(element) => {
                  optionRefs.current[index + 1] = element;
                }}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-label={`${owner.you ? `You, ${displayName}` : displayName}, ${owner.count} conversation${
                  owner.count === 1 ? '' : 's'
                }`}
                title={owner.email}
                className="conversation-owner-option"
                onFocus={() => setFocused(index + 1)}
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
        </div>
      ) : null}
    </div>
  );
}
