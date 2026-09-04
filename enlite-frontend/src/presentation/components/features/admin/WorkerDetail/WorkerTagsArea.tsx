/**
 * WorkerTagsArea
 *
 * Exibe chips de tags atribuídas ao worker e permite adicionar/remover tags.
 * Gerencia estado local de tags com atualização otimista.
 * Add/remove é liberado pra qualquer staff (sem gate por admin).
 *
 * POST/DELETE /admin/workers/:id/tags/:tagId → worker:write (mesma célula
 * pras duas ações — não existe `worker:delete` na rota de tag). D269 — nem
 * o "X" de remover nem o dropdown de adicionar são `<Button>`, então usam
 * `useActionGate` direto: sem a célula, os dois SOMEM.
 */
import { useEffect, useRef, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { WorkerTagSummary } from '@domain/entities/WorkerTag';
import type { WorkerTag } from '@domain/entities/WorkerTag';
import { Text } from '@presentation/components/atoms/Text';
import { useActionGate } from '@presentation/hooks/useCellAccess';

/** Calcula luminância relativa para decidir cor de texto (claro/escuro). */
function getTextColor(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? '#1a1a1a' : '#ffffff';
}

interface WorkerTagsAreaProps {
  workerId: string;
  initialTags: WorkerTagSummary[];
}

export function WorkerTagsArea({ workerId, initialTags }: WorkerTagsAreaProps): JSX.Element {
  const { t } = useTranslation();
  const workerWriteGate = useActionGate('worker', 'write');
  const [tags, setTags] = useState<WorkerTagSummary[]>(initialTags);
  const [catalog, setCatalog] = useState<WorkerTag[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Sync tags when parent re-renders with new initialTags
  useEffect(() => {
    setTags(initialTags);
  }, [initialTags]);

  // Load catalog once on mount
  useEffect(() => {
    AdminApiService.listWorkerTags()
      .then(setCatalog)
      .catch(() => {/* silently fail — dropdown shows empty */});
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
        setSearchText('');
      }
    }
    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleOutside);
    }
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [isDropdownOpen]);

  const assignedIds = new Set(tags.map((t) => t.id));
  const availableOptions = catalog.filter(
    (c) =>
      !assignedIds.has(c.id) &&
      (searchText === '' || c.name.toLowerCase().includes(searchText.toLowerCase())),
  );

  async function handleAssign(tag: WorkerTag) {
    // Optimistic update
    const summary: WorkerTagSummary = { id: tag.id, name: tag.name, color: tag.color, description: tag.description };
    setTags((prev) => [...prev, summary]);
    setIsDropdownOpen(false);
    setSearchText('');
    try {
      await AdminApiService.assignTagToWorker(workerId, tag.id);
    } catch {
      // Rollback
      setTags((prev) => prev.filter((t) => t.id !== tag.id));
      setError(t('admin.workerDetail.tags.assignError'));
      setTimeout(() => setError(null), 4000);
    }
  }

  async function handleRemove(tagId: string) {
    const removed = tags.find((t) => t.id === tagId);
    // Optimistic update
    setTags((prev) => prev.filter((t) => t.id !== tagId));
    try {
      await AdminApiService.removeTagFromWorker(workerId, tagId);
    } catch {
      // Rollback
      if (removed) setTags((prev) => [...prev, removed]);
      setError(t('admin.workerDetail.tags.removeError'));
      setTimeout(() => setError(null), 4000);
    }
  }

  function handleOpenDropdown() {
    setIsDropdownOpen(true);
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  return (
    <div className="flex flex-col gap-2">
      <Text as="span" size="sm" weight="medium" color="secondary">
        {t('admin.workerDetail.tags.label')}
      </Text>

      <div className="flex flex-wrap gap-1.5 items-center">
        {tags.length === 0 && (
          <Text as="span" size="sm" color="muted">
            {t('admin.workerDetail.tags.noTags')}
          </Text>
        )}
        {tags.map((tag) => {
          const textColor = getTextColor(tag.color);
          return (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium leading-5"
              style={{ backgroundColor: tag.color, color: textColor }}
            >
              {tag.name}
              {/* D269 — sem worker:write, o "X" de remover SOME. */}
              {!workerWriteGate.denied && (
                <button
                  type="button"
                  aria-label={t('admin.workerDetail.tags.removeTag')}
                  onClick={() => handleRemove(tag.id)}
                  className="ml-0.5 hover:opacity-70 transition-opacity cursor-pointer"
                  style={{ color: textColor }}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          );
        })}

        {/* Dropdown for adding a tag — D269: sem worker:write, SOME inteiro. */}
        {!workerWriteGate.denied && (
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={handleOpenDropdown}
            className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full border border-primary text-xs font-medium text-primary hover:bg-primary hover:text-white transition-colors cursor-pointer"
          >
            {t('admin.workerDetail.tags.addTag')}
            <ChevronDown className={`w-3 h-3 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {isDropdownOpen && (
            <div className="absolute z-30 mt-1 left-0 bg-white border border-gray-200 rounded-lg shadow-lg w-52 max-h-48 overflow-auto">
              <div className="sticky top-0 bg-white border-b border-gray-200 px-2 py-1.5">
                <input
                  ref={searchRef}
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={t('admin.workerDetail.tags.addTagPlaceholder')}
                  className="w-full text-xs outline-none text-gray-700 placeholder:text-gray-400 font-lexend"
                />
              </div>
              {availableOptions.length === 0 ? (
                <div className="px-3 py-2">
                  <Text as="span" size="xs" color="muted">
                    {t('admin.workerDetail.tags.noOptions')}
                  </Text>
                </div>
              ) : (
                <ul>
                  {availableOptions.map((opt) => (
                    <li
                      key={opt.id}
                      onClick={() => handleAssign(opt)}
                      className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-50"
                    >
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: opt.color }}
                      />
                      <Text as="span" size="xs" color="inherit">{opt.name}</Text>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        )}
      </div>

      {error && (
        <Text as="span" size="xs" color="inherit" className="text-red-600">
          {error}
        </Text>
      )}
    </div>
  );
}
