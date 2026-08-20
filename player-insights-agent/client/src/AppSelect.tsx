import type { ComponentProps } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui';

export interface AppSelectOption<T extends string = string> {
  value: T;
  label: string;
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
  contentProps?: Pick<ComponentProps<typeof SelectContent>, 'align' | 'position' | 'sideOffset'>;
}

/**
 * The app-wide dropdown recipe.
 *
 * It keeps the visible value in the trigger so the closed control always reads
 * "Label · Value", while Radix preserves keyboard navigation, typeahead and the
 * selected-item announcement in the open menu.
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
  contentProps,
}: AppSelectProps<T>) {
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onValueChange(next as T)}>
      <SelectTrigger
        className={`app-select-trigger ${className}`.trim()}
        aria-label={`${ariaLabel}: ${selected?.label ?? ''}`}
      >
        <span className="app-select-label">{label}</span>
        <span className="app-select-separator" aria-hidden="true">
          ·
        </span>
        <span className="app-select-value">{selected?.label ?? ''}</span>
      </SelectTrigger>
      <SelectContent
        className={`app-select-content ${contentClassName}`.trim()}
        position={contentProps?.position ?? 'popper'}
        align={contentProps?.align ?? 'start'}
        sideOffset={contentProps?.sideOffset ?? 4}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
