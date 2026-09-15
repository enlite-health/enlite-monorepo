/**
 * Combobox local (sem rede) do filtro de prestador da LISTA — digitar parte do nome filtra a
 * lista de opções, sem acento/maiúscula importar. Segue o MOLDE visual/interativo de
 * `PatientDetail/edit/IcdSearchCombobox.tsx` (input com ícone, listbox com roles ARIA, teclado,
 * clique fora fecha) simplificado pra filtro em memória — sem debounce, sem rede, sem estados de
 * falha. Fica na feature (não é atom compartilhado novo).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { inputWrapperClasses, INPUT_INNER_CLASSES, INPUT_SIZE_CONFIG } from '@presentation/components/atoms/Input/inputClasses';
import { Text } from '@presentation/components/atoms/Text';

export interface ProviderFilterOption {
  value: string;
  label: string;
}

interface ProviderFilterComboboxProps {
  id: string;
  options: ProviderFilterOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}

/** Ignora acento e maiúscula/minúscula — "garcía" casa "Garcia", "GARCÍA", etc. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function ProviderFilterCombobox({
  id,
  options,
  value,
  onValueChange,
  placeholder,
  ariaLabel,
}: ProviderFilterComboboxProps): JSX.Element {
  const { t } = useTranslation();
  const selectedOption = options.find((o) => o.value === value) ?? null;
  const [query, setQuery] = useState(selectedOption?.label ?? '');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = `${id}-listbox`;

  // Sincroniza o texto exibido com o valor selecionado vindo de fora (ex.: limpar o filtro).
  useEffect(() => {
    const opt = options.find((o) => o.value === value) ?? null;
    setQuery(opt?.label ?? '');
  }, [value, options]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        // Ao fechar sem escolher, volta a mostrar o rótulo do valor já selecionado.
        const opt = options.find((o) => o.value === value) ?? null;
        setQuery(opt?.label ?? '');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [options, value]);

  const filteredOptions = query.trim()
    ? options.filter((o) => normalize(o.label).includes(normalize(query.trim())))
    : options;

  function handleSelect(option: ProviderFilterOption | null): void {
    onValueChange(option?.value ?? '');
    setQuery(option?.label ?? '');
    setIsOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filteredOptions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < filteredOptions.length) {
      e.preventDefault();
      handleSelect(filteredOptions[activeIndex]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setIsOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative flex flex-col gap-1.5">
      <div className={`${inputWrapperClasses({ size: 'compact' })} gap-2`}>
        <label htmlFor={id} className="flex items-center shrink-0 cursor-text" aria-hidden="true">
          <Search className="w-4 h-4 text-gray-800" />
        </label>
        <input
          id={id}
          type="text"
          role="combobox"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          aria-label={ariaLabel}
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-haspopup="listbox"
          aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          className={`${INPUT_INNER_CLASSES} ${INPUT_SIZE_CONFIG.compact.fontSize} ${INPUT_SIZE_CONFIG.compact.lineHeight}`}
          data-testid={id}
        />
      </div>

      {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 top-full mt-1 w-full border-[1.5px] border-gray-600 rounded-[10px] shadow-sm max-h-64 overflow-y-auto overscroll-contain bg-white"
          data-testid={`${id}-listbox`}
        >
          <li
            role="option"
            aria-selected={value === ''}
            onMouseEnter={() => setActiveIndex(-1)}
            onClick={() => handleSelect(null)}
            className="px-4 py-2.5 cursor-pointer transition-colors hover:bg-slate-50"
            data-testid={`${id}-option-all`}
          >
            <Text as="span" size="sm" color="tertiary">
              {placeholder}
            </Text>
          </li>
          {filteredOptions.length === 0 ? (
            <li className="px-4 py-2.5" data-testid={`${id}-no-match`}>
              <Text as="span" size="sm" color="secondary">
                {t('admin.anacareHours.list.providerFilterNoMatch')}
              </Text>
            </li>
          ) : (
            filteredOptions.map((option, idx) => (
              <li
                key={option.value}
                id={`${id}-option-${idx}`}
                role="option"
                aria-selected={idx === activeIndex}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => handleSelect(option)}
                className={`px-4 py-2.5 cursor-pointer transition-colors ${idx === activeIndex ? 'bg-primary/10' : 'hover:bg-slate-50'}`}
                data-testid={`${id}-option-${option.value}`}
              >
                <Text as="span" size="sm" color="tertiary">
                  {option.label}
                </Text>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
