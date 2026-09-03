import { useRef, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from 'react';
import { Check } from 'lucide-react';
import { PopoverContent } from './ui';
import type { AppMultiSelectOption, AppMultiSelectProps } from './AppMultiSelect';

interface AppMultiSelectMenuProps<T extends string>
  extends Pick<
    AppMultiSelectProps<T>,
    'label' | 'allLabel' | 'total' | 'options' | 'selected' | 'onChange' | 'toggleValue' | 'contentClassName'
  > {
  menuId: string;
  optionId: string;
  focusedIndex: number;
  setFocusedIndex: Dispatch<SetStateAction<number>>;
  matchTypeahead: (key: string) => number | null;
  close: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Portalled menu body loaded only after a multiselect opens.
 *
 * The eager Ask shell keeps the trigger and its accessible state; collision
 * positioning, option rows, and focus machinery stay out of the initial route.
 */
export function AppMultiSelectMenu<T extends string>({
  label,
  allLabel,
  total,
  options,
  selected,
  onChange,
  toggleValue,
  contentClassName = '',
  menuId,
  optionId,
  focusedIndex,
  setFocusedIndex,
  matchTypeahead,
  close,
  triggerRef,
}: AppMultiSelectMenuProps<T>) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const optionCount = options.length + 1;

  const focusOption = (index: number) => {
    const next = (index + optionCount) % optionCount;
    setFocusedIndex(next);
    optionRefs.current[next]?.focus();
  };

  const closeAndRestoreFocus = () => {
    close();
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (focusedIndex === 0) onChange([]);
      else {
        const option = options[focusedIndex - 1];
        if (option) onChange(toggleValue(selected, option.value));
      }
      return;
    }
    const typeaheadIndex = matchTypeahead(event.key);
    if (typeaheadIndex !== null) {
      event.preventDefault();
      focusOption(typeaheadIndex);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') focusOption(0);
    else if (event.key === 'End') focusOption(optionCount - 1);
    else focusOption(focusedIndex + (event.key === 'ArrowDown' ? 1 : -1));
  };

  const optionRow = (option: AppMultiSelectOption<T>, itemIndex: number) => {
    const isSelected = selected.includes(option.value);
    return (
      <button
        key={option.value}
        ref={(element) => {
          optionRefs.current[itemIndex] = element;
        }}
        id={`${optionId}-${itemIndex}`}
        type="button"
        role="option"
        tabIndex={focusedIndex === itemIndex ? 0 : -1}
        aria-label={option.ariaLabel}
        aria-selected={isSelected}
        title={option.title}
        data-highlighted={focusedIndex === itemIndex ? '' : undefined}
        data-state={isSelected ? 'checked' : 'unchecked'}
        className="app-menu-option"
        onFocus={() => setFocusedIndex(itemIndex)}
        onMouseMove={() => setFocusedIndex(itemIndex)}
        onClick={() => onChange(toggleValue(selected, option.value))}
      >
        <span className="app-menu-check" aria-hidden="true">
          <Check />
        </span>
        <span className="app-menu-option-label">{option.content ?? option.label}</span>
        {option.count === undefined ? null : <span className="app-menu-option-count">{option.count}</span>}
      </button>
    );
  };

  return (
    <PopoverContent
      id={menuId}
      className={`app-select-content app-menu-content app-multiselect-content ${contentClassName}`.trim()}
      role="listbox"
      aria-label={label}
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
        optionRefs.current[focusedIndex]?.focus();
      }}
      onKeyDown={handleMenuKeyDown}
    >
      <button
        ref={(element) => {
          optionRefs.current[0] = element;
        }}
        id={`${optionId}-0`}
        type="button"
        role="option"
        tabIndex={focusedIndex === 0 ? 0 : -1}
        aria-selected={selected.length === 0}
        data-highlighted={focusedIndex === 0 ? '' : undefined}
        data-state={selected.length === 0 ? 'checked' : 'unchecked'}
        className="app-menu-option"
        onFocus={() => setFocusedIndex(0)}
        onMouseMove={() => setFocusedIndex(0)}
        onClick={() => onChange([])}
      >
        <span className="app-menu-check" aria-hidden="true">
          <Check />
        </span>
        <span className="app-menu-option-label">{allLabel}</span>
        {total === undefined ? null : <span className="app-menu-option-count">{total}</span>}
      </button>
      {options.map((option, index) => optionRow(option, index + 1))}
    </PopoverContent>
  );
}
