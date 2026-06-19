import { useRef, useEffect, useCallback, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text/Text';
import { inputWrapperClasses, type InputSize } from '../Input/inputClasses';
import type { SelectOption } from '../Select/Select';

export interface MultiSelectProps {
  options: SelectOption[];
  value: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  inputSize?: InputSize;
  disabled?: boolean;
  id?: string;
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  inputSize = 'compact',
  disabled = false,
  id,
}: MultiSelectProps): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  const toggle = useCallback(
    (optValue: string) => {
      if (value.includes(optValue)) {
        onChange(value.filter((v) => v !== optValue));
      } else {
        onChange([...value, optValue]);
      }
    },
    [value, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === 'Escape') {
        close();
      }
    },
    [close],
  );

  const handleOptionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, optValue: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(optValue);
      } else if (e.key === 'Escape') {
        close();
      }
    },
    [toggle, close],
  );

  const buttonLabel =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? options.find((o) => o.value === value[0])?.label ?? value[0]
        : t('common.multiSelect.selectedCount', { count: value.length });

  const wrapperClasses = inputWrapperClasses({ size: inputSize, disabled });

  return (
    <div ref={containerRef} className="relative w-full" id={id}>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onKeyDown={handleKeyDown}
        onClick={() => setOpen((prev) => !prev)}
        className={[
          wrapperClasses,
          'flex items-center justify-between cursor-pointer select-none text-left',
          disabled ? 'cursor-not-allowed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <Text
          as="span"
          size="sm"
          weight="medium"
          color={value.length > 0 ? 'secondary' : 'muted'}
          className="truncate"
        >
          {buttonLabel ?? ''}
        </Text>
        <ChevronDown
          size={20}
          className={[
            'shrink-0 text-[#737373] transition-transform ml-2',
            open ? 'rotate-180' : '',
          ].join(' ')}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-multiselectable="true"
          className="absolute z-50 w-full mt-1 bg-white border border-[#D9D9D9] rounded-[10px] shadow-lg py-1 overflow-y-auto max-h-60"
        >
          {options.map((opt) => {
            const checked = value.includes(opt.value);
            return (
              <li key={opt.value} role="option" aria-selected={checked}>
                <button
                  type="button"
                  onKeyDown={(e) => handleOptionKeyDown(e, opt.value)}
                  onClick={() => toggle(opt.value)}
                  className="w-full flex items-center gap-2 px-4 py-2 hover:bg-gray-50 transition-colors text-left"
                >
                  <input
                    type="checkbox"
                    readOnly
                    checked={checked}
                    tabIndex={-1}
                    className="pointer-events-none accent-primary w-4 h-4 shrink-0"
                  />
                  <Text as="span" size="sm" weight="medium" color="secondary">
                    {opt.label}
                  </Text>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
