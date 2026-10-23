import { forwardRef, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text/Text';
import { inputWrapperClasses, type InputSize } from '../Input/inputClasses';
import { normalizeText } from '@presentation/utils/normalizeText';

export interface ComboboxOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Texto extra que a busca casa e a tela não exibe (ex.: CNPJ, sigla). */
  searchText?: string;
}

/**
 * Fonte única da regra "quando há campo de busca": com menos opções que isto
 * (Sí/No, 2 países) não há o que filtrar. A regra mora no componente, não numa
 * lista de campos — ninguém "esquece de ligar" a busca (spec 070, D-2).
 */
export const SEARCH_MIN_OPTIONS = 3;

type Common = {
  options: ComboboxOption[];
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  inputSize?: InputSize;
  error?: string;
  className?: string;
  'data-testid'?: string;
  onBlur?: () => void;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
};

export type ComboboxProps = Common &
  (
    | {
        multiple?: false;
        value: string;
        onChange: (value: string) => void;
        /** 1ª linha que volta o valor a `''` (o placeholder selecionável do SelectField). */
        clearLabel?: string;
      }
    | { multiple: true; value: string[]; onChange: (values: string[]) => void }
  );

const PANEL_CLASSES =
  'absolute z-50 w-full mt-1 bg-white border border-[#D9D9D9] rounded-[10px] shadow-lg py-1';
const SCROLL_CLASSES = 'overflow-y-auto max-h-60';

export const Combobox = forwardRef<HTMLButtonElement, ComboboxProps>(function Combobox(props, ref) {
  const {
    options,
    id,
    name,
    placeholder,
    disabled = false,
    inputSize = 'compact',
    error,
    className = '',
    'data-testid': testId,
    onBlur,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    searchPlaceholder,
    noResultsLabel,
  } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const searchTestId = `${id ?? testId}-search`;
  const noResultsTestId = `${id ?? testId}-no-results`;

  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const searchable = options.length >= SEARCH_MIN_OPTIONS;

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
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

  const select = useCallback(
    (optValue: string) => {
      if (props.multiple) {
        const { value, onChange } = props;
        onChange(value.includes(optValue) ? value.filter((v) => v !== optValue) : [...value, optValue]);
      } else {
        props.onChange(optValue);
        close(true);
      }
    },
    [props, close],
  );

  const optionButtons = (): HTMLButtonElement[] =>
    Array.from(
      (containerRef.current as HTMLDivElement).querySelectorAll<HTMLButtonElement>('[role="option"] button'),
    );

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleOpen();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      else (searchRef.current ?? optionButtons()[0])?.focus();
    } else if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !disabled) {
      e.preventDefault();
      if (searchable) setQuery(open ? query + e.key : e.key);
      setOpen(true);
    }
  };

  const handleOptionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, optValue: string) => {
    const buttons = optionButtons();
    const idx = buttons.indexOf(e.currentTarget);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(optValue);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[Math.min(idx + 1, buttons.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx > 0) buttons[idx - 1].focus();
      else searchRef.current?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      optionButtons()[0]?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
    }
  };

  const needle = normalizeText(query.trim());
  const visible = needle
    ? options.filter((o) => normalizeText(`${o.label} ${o.searchText ?? ''}`).includes(needle))
    : options;

  const clearLabel = props.multiple ? undefined : props.clearLabel;
  const showClearRow = clearLabel !== undefined && !needle;

  const selectedValues = props.multiple ? props.value : props.value === '' ? [] : [props.value];
  const buttonLabel = props.multiple
    ? props.value.length === 0
      ? placeholder
      : props.value.length === 1
        ? (options.find((o) => o.value === props.value[0])?.label ?? props.value[0])
        : t('common.multiSelect.selectedCount', { count: props.value.length })
    : props.value === ''
      ? placeholder
      : (options.find((o) => o.value === props.value)?.label ?? props.value);

  const wrapperClasses = inputWrapperClasses({ size: inputSize, error: !!error, disabled });

  const renderRow = (opt: { value: string; label: string; disabled?: boolean }) => {
    const checked = props.multiple ? props.value.includes(opt.value) : props.value === opt.value;
    return (
      <li key={opt.value} role="option" aria-selected={checked}>
        <button
          type="button"
          disabled={opt.disabled}
          onKeyDown={(e) => handleOptionKeyDown(e, opt.value)}
          onClick={() => select(opt.value)}
          className={[
            'w-full flex items-center gap-2 px-4 py-2 hover:bg-gray-50 transition-colors text-left',
            !props.multiple && checked ? 'bg-gray-50' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {props.multiple && (
            <input
              type="checkbox"
              readOnly
              checked={checked}
              tabIndex={-1}
              className="pointer-events-none accent-primary w-4 h-4 shrink-0"
            />
          )}
          <Text as="span" size="sm" weight="medium" color="secondary">
            {opt.label}
          </Text>
        </button>
      </li>
    );
  };

  const list = (cls: string) => (
    <ul
      id={listboxId}
      role="listbox"
      aria-multiselectable={props.multiple ? 'true' : undefined}
      className={cls}
    >
      {showClearRow && renderRow({ value: '', label: clearLabel })}
      {visible.map(renderRow)}
    </ul>
  );

  return (
    <div ref={containerRef} className={['relative w-full', className].filter(Boolean).join(' ')}>
      <button
        ref={setTriggerRef}
        type="button"
        id={id}
        name={name}
        data-testid={testId}
        role="combobox"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-invalid={error ? true : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onKeyDown={handleTriggerKeyDown}
        onClick={toggleOpen}
        onBlur={onBlur}
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
          color={selectedValues.length > 0 ? 'secondary' : 'muted'}
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

      {error && (
        <Text as="p" size="xs" color="inherit" className="text-red-500 mt-1">
          {error}
        </Text>
      )}

      {open && !searchable && list(`${PANEL_CLASSES} ${SCROLL_CLASSES}`)}
      {open && searchable && (
        <div className={`${PANEL_CLASSES} flex flex-col`}>
          <input
            ref={searchRef}
            type="text"
            data-testid={searchTestId}
            aria-label={t('common.multiSelect.searchAriaLabel')}
            placeholder={searchPlaceholder ?? t('common.multiSelect.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="mx-2 mb-1 px-3 py-2 text-sm border border-[#D9D9D9] rounded-[8px] outline-none focus:border-primary"
          />
          {visible.length === 0 ? (
            <Text as="p" size="sm" color="muted" className="px-4 py-2" data-testid={noResultsTestId}>
              {noResultsLabel ?? t('common.multiSelect.noResults')}
            </Text>
          ) : (
            list(SCROLL_CLASSES)
          )}
        </div>
      )}
    </div>
  );
});
