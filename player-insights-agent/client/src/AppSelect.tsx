import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui';

export interface AppSelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Canonical machine value shown with code typography after the friendly label. */
  code?: string;
  /** Optional visual treatment; label remains the typeahead and accessible value. */
  content?: ReactNode;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

interface AppSelectProps<T extends string> {
  label: string;
  ariaLabel: string;
  value: T;
  options: readonly AppSelectOption<T>[];
  disabled?: boolean;
  onValueChange: (value: T) => void;
  className?: string;
  contentClassName?: string;
}

/**
 * The app-wide dropdown recipe.
 *
 * The trigger contains one concise current value. Its category stays in the
 * accessible name or the external field label, so readers do not have to parse
 * "Category · Value" in every compact toolbar.
 *
 * This is deliberately built on non-modal Popover rather than Radix Select.
 * Select globally locks document scrolling while open; a normal dropdown must
 * not change the document scrollbar or move the page. The shared primitive
 * preserves the Select behavior we need: arrows, Home/End, typeahead, Escape,
 * click-away, focus return, and a checked selected row.
 */
export function AppSelect<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  disabled = false,
  onValueChange,
  className = '',
  contentClassName = '',
}: AppSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusOnOpenRef = useRef<number | null>(null);
  const typeaheadRef = useRef('');
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const optionId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === selected?.value)
  );
  const optionAccessibleValue = (option: AppSelectOption<T> | undefined) =>
    option ? (option.ariaLabel ?? `${option.label}${option.code ? ` — ${option.code}` : ''}`) : '';
  const optionTitle = (option: AppSelectOption<T> | undefined) =>
    option ? (option.title ?? `${option.label}${option.code ? ` — ${option.code}` : ''}`) : '';
  const optionTextContent = (option: AppSelectOption<T> | undefined) =>
    option ? (
      <>
        <span>{option.label}</span>
        {option.code ? (
          <>
            <span aria-hidden="true"> — </span>
            <code>{option.code}</code>
          </>
        ) : null}
      </>
    ) : null;
  const optionContent = (option: AppSelectOption<T> | undefined) => option?.content ?? optionTextContent(option);
  const accessibleValue = optionAccessibleValue(selected);

  useEffect(
    () => () => {
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    },
    []
  );

  const focusOption = (index: number) => {
    if (options.length === 0) return;
    let next = (index + options.length) % options.length;
    for (let attempts = 0; attempts < options.length && options[next]?.disabled; attempts += 1) {
      next = (next + 1) % options.length;
    }
    setFocusedIndex(next);
    optionRefs.current[next]?.focus();
  };

  const closeAndRestoreFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (option: AppSelectOption<T>) => {
    if (option.disabled) return;
    onValueChange(option.value);
    closeAndRestoreFocus();
  };

  const matchTypeahead = (key: string) => {
    if (key.length !== 1 || key.trim() === '') return false;
    typeaheadRef.current += key.toLocaleLowerCase();
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = setTimeout(() => {
      typeaheadRef.current = '';
    }, 700);
    const query = typeaheadRef.current;
    const match = options.findIndex(
      (option) => !option.disabled && `${option.label} ${option.code ?? ''}`.toLocaleLowerCase().startsWith(query)
    );
    if (match < 0) return false;
    if (!open) {
      focusOnOpenRef.current = match;
      setOpen(true);
    }
    requestAnimationFrame(() => focusOption(match));
    return true;
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[focusedIndex];
      if (option) choose(option);
      return;
    }
    if (matchTypeahead(event.key)) {
      event.preventDefault();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') focusOption(0);
    else if (event.key === 'End') focusOption(options.length - 1);
    else focusOption(focusedIndex + (event.key === 'ArrowDown' ? 1 : -1));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setFocusedIndex(focusOnOpenRef.current ?? selectedIndex);
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          data-slot="select-trigger"
          data-state={open ? 'open' : 'closed'}
          className={`app-select-trigger app-menu-trigger ${className}`.trim()}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={menuId}
          aria-activedescendant={open ? `${optionId}-${focusedIndex}` : undefined}
          aria-label={`${ariaLabel}: ${accessibleValue}`}
          title={optionTitle(selected)}
          onKeyDown={(event) => {
            if (matchTypeahead(event.key)) {
              event.preventDefault();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const nextIndex =
              event.key === 'End'
                ? options.length - 1
                : event.key === 'ArrowUp'
                  ? Math.max(0, selectedIndex - 1)
                  : selectedIndex;
            focusOnOpenRef.current = nextIndex;
            setFocusedIndex(nextIndex);
            setOpen(true);
          }}
        >
          <span className="app-select-value">{optionTextContent(selected)}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={menuId}
        data-slot="select-content"
        className={`app-select-content app-menu-content ${contentClassName}`.trim()}
        role="listbox"
        aria-label={label}
        align="start"
        side="bottom"
        sideOffset={4}
        avoidCollisions
        collisionPadding={12}
        sticky="always"
        hideWhenDetached
        updatePositionStrategy="always"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          optionRefs.current[focusOnOpenRef.current ?? selectedIndex]?.focus();
          focusOnOpenRef.current = null;
        }}
        onKeyDown={handleMenuKeyDown}
      >
        {options.map((option, index) => (
          <button
            key={option.value}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            id={`${optionId}-${index}`}
            type="button"
            role="option"
            tabIndex={focusedIndex === index ? 0 : -1}
            data-slot="select-item"
            data-highlighted={focusedIndex === index ? '' : undefined}
            data-state={option.value === selected?.value ? 'checked' : 'unchecked'}
            disabled={option.disabled}
            aria-selected={option.value === selected?.value}
            aria-label={optionAccessibleValue(option)}
            title={optionTitle(option)}
            className="app-menu-option"
            onFocus={() => setFocusedIndex(index)}
            onMouseMove={() => setFocusedIndex(index)}
            onClick={() => choose(option)}
          >
            <span className="app-menu-check" aria-hidden="true">
              <Check />
            </span>
            <span className="app-menu-option-label">{optionContent(option)}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
