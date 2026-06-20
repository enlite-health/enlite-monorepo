/**
 * WorkerTagMultiSelect
 *
 * Multi-select de tags para o filtro de prestadores.
 * Exibe um botão que abre um dropdown com checkboxes.
 * As tags selecionadas aparecem como chips abaixo.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, X } from 'lucide-react';
import type { WorkerTag } from '@domain/entities/WorkerTag';
import { Text } from '@presentation/components/atoms/Text';

interface WorkerTagMultiSelectProps {
  tags: WorkerTag[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

/** Calcula luminância relativa para decidir cor de texto (claro/escuro). */
function getTextColor(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? '#1a1a1a' : '#ffffff';
}

export function WorkerTagMultiSelect({
  tags,
  selectedIds,
  onChange,
  disabled = false,
}: WorkerTagMultiSelectProps): JSX.Element {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedSet = new Set(selectedIds);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearchText('');
      }
    }
    if (isOpen) document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [isOpen]);

  function handleOpen() {
    if (disabled) return;
    setIsOpen(true);
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  function toggleTag(id: string) {
    const next = selectedSet.has(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
    onChange(next);
  }

  function removeTag(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  const filtered = searchText
    ? tags.filter((t) => t.name.toLowerCase().includes(searchText.toLowerCase()))
    : tags;

  const selectedTags = tags.filter((t) => selectedSet.has(t.id));
  const buttonLabel =
    selectedIds.length === 0
      ? t('admin.workers.filters.tagsAll')
      : t('common.multiSelect.selectedCount', { count: selectedIds.length });

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      {/* Trigger button */}
      <div className="relative">
        <button
          type="button"
          onClick={handleOpen}
          disabled={disabled}
          className="w-full h-[42px] px-3 rounded-lg border border-[#E5E7EB] bg-[#F9FAFB] text-sm font-lexend text-[#374151] flex items-center justify-between gap-2 focus:outline-none focus:ring-2 focus:ring-[#6B21A8]/20 focus:border-[#6B21A8] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          <span className={selectedIds.length === 0 ? 'text-[#9CA3AF]' : 'text-[#374151]'}>
            {buttonLabel}
          </span>
          <ChevronDown
            className={`w-4 h-4 text-[#9CA3AF] flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {isOpen && (
          <div className="absolute z-30 mt-1 w-full bg-white border border-[#D9D9D9] rounded-lg shadow-lg max-h-52 overflow-auto">
            <div className="sticky top-0 bg-white border-b border-[#D9D9D9] px-2 py-1.5">
              <input
                ref={searchRef}
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={t('admin.workers.filters.tagsPlaceholder')}
                className="w-full text-xs outline-none text-[#374151] placeholder:text-[#9CA3AF] font-lexend"
              />
            </div>
            {filtered.length === 0 ? (
              <div className="px-3 py-2">
                <Text as="span" size="xs" color="muted">{t('common.noResults')}</Text>
              </div>
            ) : (
              <ul>
                {filtered.map((tag) => (
                  <li
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#F3E8FF] transition-colors"
                  >
                    <input
                      type="checkbox"
                      readOnly
                      checked={selectedSet.has(tag.id)}
                      className="accent-[#6B21A8] cursor-pointer"
                    />
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: tag.color }}
                    />
                    <Text as="span" size="xs" color="inherit">{tag.name}</Text>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Selected tag chips */}
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedTags.map((tag) => {
            const textColor = getTextColor(tag.color);
            return (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                style={{ backgroundColor: tag.color, color: textColor }}
              >
                {tag.name}
                <button
                  type="button"
                  onClick={() => removeTag(tag.id)}
                  className="ml-0.5 hover:opacity-70 transition-opacity cursor-pointer"
                  style={{ color: textColor }}
                  aria-label={`${t('admin.workerDetail.tags.removeTag')} ${tag.name}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
