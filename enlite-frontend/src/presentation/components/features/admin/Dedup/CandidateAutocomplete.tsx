/**
 * CandidateAutocomplete
 *
 * Input + dropdown for searching worker accounts by name or phone.
 * Used in ManualMergeModal for the "Primera cuenta" / "Segunda cuenta" slots.
 *
 * Behaviour:
 * - Debounces the typed text ~300ms before calling onSearch.
 * - When a candidate is selected it renders a chip (name · phone) with a
 *   "Cambiar" link to clear the selection.
 * - Keyboard: Enter on a highlighted option selects it; Escape closes dropdown.
 * - Shows accessible dropdown with role="listbox" / role="option".
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import type { CandidateItem } from '@domain/entities/DedupGroup';

export interface CandidateAutocompleteProps {
  id: string;
  label: string;
  /** Currently selected candidate (controlled). */
  selected: CandidateItem | null;
  /** Called with typed text (already debounced internally). */
  onSearch: (q: string) => Promise<CandidateItem[]>;
  /** Called when user picks a candidate. */
  onSelect: (candidate: CandidateItem) => void;
  /** Called when user clears the selection. */
  onClear: () => void;
  /** Ids that are already selected elsewhere (to prevent duplicate selection). */
  disabledIds?: string[];
}

const DEBOUNCE_MS = 300;

export function CandidateAutocomplete({
  id,
  label,
  selected,
  onSearch,
  onSelect,
  onClear,
  disabledIds = [],
}: CandidateAutocompleteProps) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const [options, setOptions] = useState<CandidateItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = `${id}-listbox`;

  // ── Debounced search ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = inputValue.trim();
    if (q.length < 2) {
      setOptions([]);
      setIsOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        const results = await onSearch(q);
        setOptions(results);
        setIsOpen(true);
        setActiveIndex(-1);
      } catch {
        setOptions([]);
      } finally {
        setIsLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputValue, onSearch]);

  // ── Close on outside click ────────────────────────────────────────────────────

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────────

  function handleSelect(candidate: CandidateItem) {
    onSelect(candidate);
    setInputValue('');
    setOptions([]);
    setIsOpen(false);
    setActiveIndex(-1);
  }

  function handleClear() {
    onClear();
    setInputValue('');
    setOptions([]);
    setIsOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!isOpen) return;
    const available = options.filter((o) => !disabledIds.includes(o.id));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, available.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      handleSelect(available[activeIndex]);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  }

  // ── Selected chip ─────────────────────────────────────────────────────────────

  if (selected) {
    return (
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>
          {label}
        </Label>
        <div
          className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-primary bg-primary/5"
          data-testid={`${id}-chip`}
        >
          <div className="flex flex-col min-w-0">
            <Text as="span" size="sm" weight="semibold" color="primary" className="truncate">
              {selected.name}
            </Text>
            {selected.phone && (
              <Text as="span" size="xs" color="muted">
                {selected.phone}
              </Text>
            )}
          </div>
          <button
            type="button"
            onClick={handleClear}
            className="shrink-0 text-slate-500 hover:text-primary transition-colors"
            aria-label={t('admin.dedup.manualMerge.changeAccount', 'Cambiar')}
            data-testid={`${id}-clear-btn`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <Text as="span" size="xs" color="muted">
          {t('admin.dedup.manualMerge.changeHint', 'Cambiá para elegir otra cuenta.')}
        </Text>
      </div>
    );
  }

  // ── Input + dropdown ──────────────────────────────────────────────────────────

  const availableOptions = options.filter((o) => !disabledIds.includes(o.id));

  return (
    <div className="flex flex-col gap-1" ref={containerRef}>
      <Label htmlFor={id}>
        {label}
      </Label>

      <div className="relative">
        <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
          <Search className="w-4 h-4 text-slate-400" />
        </div>
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t(
            'admin.dedup.manualMerge.searchPlaceholder',
            'Buscá por nombre o teléfono...',
          )}
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-primary text-sm transition-colors"
          autoComplete="off"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listboxId : undefined}
          aria-activedescendant={
            activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined
          }
          data-testid={`${id}-input`}
        />
        {isLoading && (
          <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
            <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        )}

        {/* Dropdown — anchored inside the relative wrapper so it floats below the input */}
        {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 top-full left-0 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto"
          data-testid={`${id}-dropdown`}
        >
          {availableOptions.length === 0 && !isLoading && (
            <li className="px-3 py-3 text-center">
              <Text as="span" size="sm" color="muted">
                {t('admin.dedup.manualMerge.noResults', 'Sin resultados para la búsqueda.')}
              </Text>
            </li>
          )}

          {availableOptions.map((candidate, idx) => {
            const isActive = idx === activeIndex;
            return (
              <li
                key={candidate.id}
                id={`${id}-option-${idx}`}
                role="option"
                aria-selected={isActive}
                onClick={() => handleSelect(candidate)}
                className={`px-3 py-2.5 cursor-pointer flex items-start justify-between gap-2 transition-colors ${
                  isActive ? 'bg-primary/10' : 'hover:bg-slate-50'
                }`}
                data-testid={`${id}-option-${idx}`}
              >
                <div className="flex flex-col min-w-0">
                  <Text as="span" size="sm" weight="semibold" className="truncate">
                    {candidate.name}
                  </Text>
                  {candidate.phone && (
                    <Text as="span" size="xs" color="muted">
                      {candidate.phone}
                    </Text>
                  )}
                </div>
                <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                  {candidate.login_real && (
                    <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">
                      <Text as="span" size="xs" weight="medium" color="inherit">
                        {t('admin.dedup.manualMerge.badge.withAccess', 'Con acceso')}
                      </Text>
                    </span>
                  )}
                  {candidate.is_imported && (
                    <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full">
                      <Text as="span" size="xs" weight="medium" color="inherit">
                        {t('admin.dedup.manualMerge.badge.imported', 'Importado')}
                      </Text>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        )}
      </div>
    </div>
  );
}
