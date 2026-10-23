import { useRef, useEffect, useCallback, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text/Text';
import { inputWrapperClasses, type InputSize } from '../Input/inputClasses';
import type { SelectOption } from '../Select/Select';
import { normalizeText } from '@presentation/utils/normalizeText';

export interface MultiSelectProps {
  options: SelectOption[];
  value: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  inputSize?: InputSize;
  disabled?: boolean;
  id?: string;
  /** Opt-in (spec 060): campo de busca dentro do painel. Default false = DOM de sempre. */
  searchable?: boolean;
  searchPlaceholder?: string;
  noResultsLabel?: string;
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  inputSize = 'compact',
  disabled = false,
  id,
  searchable = false,
  searchPlaceholder,
  noResultsLabel,
}: MultiSelectProps): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const toggleOpen = useCallback(() => {
    if (open) close();
    else setOpen(true);
  }, [open, close]);

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

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
        toggleOpen();
      } else if (e.key === 'Escape') {
        close();
      }
    },
    [close, toggleOpen],
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

  const needle = normalizeText(query.trim());
  const visible =
    searchable && needle ? options.filter((o) => normalizeText(o.label).includes(needle)) : options;

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        containerRef.current?.querySelector<HTMLButtonElement>('[role="option"] button')?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
      }
    },
    [close],
  );

  const buttonLabel =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? options.find((o) => o.value === value[0])?.label ?? value[0]
        : t('common.multiSelect.selectedCount', { count: value.length });

  const wrapperClasses = inputWrapperClasses({ size: inputSize, disabled });

  const panelClasses = 'absolute z-50 w-full mt-1 bg-white border border-[#D9D9D9] rounded-[10px] shadow-lg py-1';
  const scrollClasses = 'overflow-y-auto max-h-60';

  const list = (cls: string) => (
    <ul role="listbox" aria-multiselectable="true" className={cls}>
      {visible.map((opt) => {
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
  );

  return (
    <div ref={containerRef} className="relative w-full" id={id}>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onKeyDown={handleKeyDown}
        onClick={toggleOpen}
        className={[
          wrapperClasses,
          'flex items-center justify-between cursor-pointer select-none text-left',
          disabled ? 'cursor-not-allowed border-dashed' : '',
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
            'shrink-0 transition-transform ml-2',
            disabled ? 'text-[#D9D9D9]' : 'text-[#737373]',
            open ? 'rotate-180' : '',
          ].join(' ')}
        />
      </button>

      {open && !searchable && list(`${panelClasses} ${scrollClasses}`)}
      {open && searchable && (
        <div className={`${panelClasses} flex flex-col`}>
          <input
            ref={searchRef}
            type="text"
            data-testid={`${id}-search`}
            aria-label={t('common.multiSelect.searchAriaLabel')}
            placeholder={searchPlaceholder ?? t('common.multiSelect.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="mx-2 mb-1 px-3 py-2 text-sm border border-[#D9D9D9] rounded-[8px] outline-none focus:border-primary"
          />
          {visible.length === 0 ? (
            <Text as="p" size="sm" color="muted" className="px-4 py-2" data-testid={`${id}-no-results`}>
              {noResultsLabel ?? t('common.multiSelect.noResults')}
            </Text>
          ) : (
            list(scrollClasses)
          )}
        </div>
      )}
    </div>
  );
}
