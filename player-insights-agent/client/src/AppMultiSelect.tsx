import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Popover, PopoverTrigger } from './ui';

const AppMultiSelectMenu = lazy(() =>
  import('./AppMultiSelectMenu').then(({ AppMultiSelectMenu: menu }) => ({ default: menu }))
) as typeof import('./AppMultiSelectMenu').AppMultiSelectMenu;

export interface AppMultiSelectOption<T extends string = string> {
  value: T;
  label: string;
  ariaLabel?: string;
  title?: string;
  count?: number;
  content?: ReactNode;
}

export interface AppMultiSelectProps<T extends string> {
  label: string;
  ariaLabel: string;
  summary: string;
  allLabel: string;
  total?: number;
  options: readonly AppMultiSelectOption<T>[];
  selected: readonly T[];
  onChange: (selected: readonly T[]) => void;
  toggleValue: (selected: readonly T[], value: T) => readonly T[];
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  description?: string;
}

/**
 * Shared non-modal multiselect for compact app filters.
 *
 * The Popover owns viewport collision and click-away behavior without locking
 * document scrolling. This component owns listbox semantics, focus return,
 * arrows, Home/End, typeahead, and persistent checkmarks.
 */
export function AppMultiSelect<T extends string>({
  label,
  ariaLabel,
  summary,
  allLabel,
  total,
  options,
  selected,
  onChange,
  toggleValue,
  className = '',
  triggerClassName = '',
  contentClassName = '',
  description,
}: AppMultiSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeaheadRef = useRef('');
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const optionId = useId();
  const descriptionId = useId();
  const optionCount = options.length + 1;

  useEffect(
    () => () => {
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    },
    []
  );

  const matchTypeahead = (key: string) => {
    if (key.length !== 1 || key.trim() === '') return null;
    typeaheadRef.current += key.toLocaleLowerCase();
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = setTimeout(() => {
      typeaheadRef.current = '';
    }, 700);
    const labels = [allLabel, ...options.map((option) => option.label)];
    const match = labels.findIndex((option) => option.toLocaleLowerCase().startsWith(typeaheadRef.current));
    return match < 0 ? null : match;
  };

  const firstSelectedIndex = options.findIndex((option) => selected.includes(option.value));
  const openIndex = firstSelectedIndex < 0 ? 0 : firstSelectedIndex + 1;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setFocusedIndex(openIndex);
        setOpen(nextOpen);
      }}
    >
      <div className={`app-multiselect ${className}`.trim()}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className={`app-select-trigger app-menu-trigger app-multiselect-trigger ${triggerClassName}`.trim()}
            role="combobox"
            aria-label={`${ariaLabel}: ${summary}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={menuId}
            aria-activedescendant={open ? `${optionId}-${focusedIndex}` : undefined}
            aria-describedby={description ? descriptionId : undefined}
            title={description}
            onKeyDown={(event) => {
              const typeaheadIndex = matchTypeahead(event.key);
              if (typeaheadIndex !== null) {
                event.preventDefault();
                setFocusedIndex(typeaheadIndex);
                setOpen(true);
                return;
              }
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const nextIndex =
                event.key === 'End' ? optionCount - 1 : event.key === 'ArrowUp' ? optionCount - 1 : openIndex;
              setFocusedIndex(nextIndex);
              setOpen(true);
            }}
          >
            <span className="app-select-value">{summary}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </PopoverTrigger>
        {description ? (
          <span id={descriptionId} className="sr-only">
            {description}
          </span>
        ) : null}
        {open ? (
          <Suspense fallback={null}>
            <AppMultiSelectMenu
              label={label}
              allLabel={allLabel}
              total={total}
              options={options}
              selected={selected}
              onChange={onChange}
              toggleValue={toggleValue}
              contentClassName={contentClassName}
              menuId={menuId}
              optionId={optionId}
              focusedIndex={focusedIndex}
              setFocusedIndex={setFocusedIndex}
              matchTypeahead={matchTypeahead}
              close={() => setOpen(false)}
              triggerRef={triggerRef}
            />
          </Suspense>
        ) : null}
      </div>
    </Popover>
  );
}
