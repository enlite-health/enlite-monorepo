import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  label,
  searchPlaceholder,
  disabled = false,
}: SearchableSelectProps): JSX.Element {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const allPlaceholder = placeholder ?? t('common.all', 'Todos');
  const searchPh = searchPlaceholder ?? t('common.search', 'Buscar...');

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? allPlaceholder;

  const filteredOptions = searchText
    ? options.filter((o) =>
        normalizeText(o.label).includes(normalizeText(searchText))
      )
    : options;

  function handleOpen(): void {
    if (disabled) return;
    setIsOpen(true);
    setSearchText('');
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  function handleSelect(optionValue: string): void {
    onChange(optionValue);
    setIsOpen(false);
    setSearchText('');
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearchText('');
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div className="flex flex-col gap-1 w-full" ref={containerRef}>
      {label && (
        <span className="font-lexend font-semibold text-[#737373] text-base">
          {label}
        </span>
      )}
      <div className="relative">
        <button
          type="button"
          onClick={handleOpen}
          disabled={disabled}
          className="w-full h-12 px-4 rounded-[10px] border-[1.5px] border-[#D9D9D9] bg-white font-lexend font-medium text-[#374151] text-sm flex items-center justify-between gap-2 focus:outline-none focus:border-[#180149] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
        >
          <span
            className={
              selectedOption
                ? 'text-[#374151]'
                : 'text-[#B3B3B3]'
            }
          >
            {displayLabel}
          </span>
          <ChevronDown
            className={`w-4 h-4 text-[#737373] flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {isOpen && (
          <div className="absolute z-20 mt-1 w-full bg-white border border-[#D9D9D9] rounded-lg shadow-lg max-h-60 overflow-auto">
            <div className="sticky top-0 bg-white border-b border-[#D9D9D9]">
              <input
                ref={searchRef}
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={searchPh}
                className="w-full px-3 py-2 text-sm font-lexend outline-none text-[#374151] placeholder:text-[#B3B3B3]"
              />
            </div>
            <ul role="listbox">
              <li
                role="option"
                aria-selected={value === ''}
                onClick={() => handleSelect('')}
                className={`px-3 py-2 cursor-pointer text-sm font-lexend ${
                  value === ''
                    ? 'bg-[#F3E8FF] text-[#6B21A8]'
                    : 'hover:bg-[#F3E8FF] text-[#374151]'
                }`}
              >
                {allPlaceholder}
              </li>
              {filteredOptions.map((option) => (
                <li
                  key={option.value}
                  role="option"
                  aria-selected={option.value === value}
                  onClick={() => handleSelect(option.value)}
                  className={`px-3 py-2 cursor-pointer text-sm font-lexend ${
                    option.value === value
                      ? 'bg-[#F3E8FF] text-[#6B21A8]'
                      : 'hover:bg-[#F3E8FF] text-[#374151]'
                  }`}
                >
                  {option.label}
                </li>
              ))}
              {filteredOptions.length === 0 && (
                <li className="px-3 py-2 text-sm font-lexend text-[#B3B3B3]">
                  {t('common.noResults', 'Sin resultados')}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
