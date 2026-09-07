import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { SelectField } from '@presentation/components/molecules/SelectField';
import { WorkersExportApiService } from '@infrastructure/http/WorkersExportApiService';
import {
  ALL_EXPORT_COLUMNS,
  COLUMN_LABEL_KEY,
  type WorkerExportColumnKey,
} from './workerExportColumns';

export interface WorkerExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Active filters from the workers list — used to pre-fill the modal */
  activeFilters?: {
    docs_complete?: string;
    docs_validated?: 'all_validated' | 'pending_validation';
    search?: string;
    case_id?: string;
    platform?: string;
  };
  /** Active status filter from the workers list */
  activeStatus?: string;
}

const WORKER_STATUSES = ['REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED'] as const;
const FORMAT_OPTIONS = [
  { value: 'csv',  label: 'CSV' },
  { value: 'xlsx', label: 'XLSX' },
];

// TODO: future — per-column PII permissions (sexual_orientation, race, religion,
// document_number, birth_date, etc.). Hoje: a célula `worker:export` é o único controle de acesso.
export function WorkerExportModal({
  isOpen,
  onClose,
  activeFilters,
  activeStatus,
}: WorkerExportModalProps): JSX.Element | null {
  const { t } = useTranslation();

  const [format, setFormat]           = useState<'csv' | 'xlsx'>('csv');
  const [status, setStatus]           = useState(activeStatus ?? '');
  const [selected, setSelected]       = useState<Set<WorkerExportColumnKey>>(new Set(ALL_EXPORT_COLUMNS));
  const [isExporting, setIsExporting] = useState(false);
  const [apiError, setApiError]       = useState<string | null>(null);

  // Sync status filter when prop changes (e.g. user changes filter then opens modal)
  useEffect(() => { setStatus(activeStatus ?? ''); }, [activeStatus]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const statusOptions = [
    ...WORKER_STATUSES.map((s) => ({
      value: s,
      label: t(`admin.workers.export.statusOptions.${s}`, s),
    })),
  ];

  const toggleColumn = (key: WorkerExportColumnKey) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const selectAll   = () => setSelected(new Set(ALL_EXPORT_COLUMNS));
  const deselectAll = () => setSelected(new Set());

  const handleExport = async () => {
    if (selected.size === 0) return;
    setIsExporting(true);
    setApiError(null);
    try {
      await WorkersExportApiService.exportWorkers({
        format,
        columns: ALL_EXPORT_COLUMNS.filter((c) => selected.has(c)),
        status:         status        || undefined,
        platform:       activeFilters?.platform       || undefined,
        docs_complete:  activeFilters?.docs_complete  || undefined,
        docs_validated: activeFilters?.docs_validated || undefined,
        search:         activeFilters?.search         || undefined,
        case_id:        activeFilters?.case_id        || undefined,
      });
      onClose();
    } catch {
      setApiError(t('admin.workers.export.apiError'));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      data-testid="worker-export-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worker-export-title"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-[20px] p-6 w-full max-w-lg mx-4 shadow-xl flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <h2
          id="worker-export-title"
          className="font-lexend text-lg font-semibold text-primary"
        >
          {t('admin.workers.export.title')}
        </h2>

        {/* Format select */}
        <div className="flex flex-col gap-1">
          <label className="font-lexend text-sm font-medium text-[#374151]">
            {t('admin.workers.export.formatLabel')}
          </label>
          <SelectField
            options={FORMAT_OPTIONS}
            value={format}
            onChange={(v) => setFormat(v as 'csv' | 'xlsx')}
            placeholder={t('admin.workers.export.formatPlaceholder')}
          />
        </div>

        {/* Status select */}
        <div className="flex flex-col gap-1">
          <label className="font-lexend text-sm font-medium text-[#374151]">
            {t('admin.workers.export.statusLabel')}
          </label>
          <SelectField
            options={statusOptions}
            value={status}
            onChange={setStatus}
            placeholder={t('admin.workers.export.statusAllPlaceholder')}
          />
        </div>

        {/* Columns section */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-lexend text-sm font-medium text-[#374151]">
              {t('admin.workers.export.columnsTitle')}
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={selectAll}
                className="text-xs font-lexend text-primary hover:underline"
              >
                {t('admin.workers.export.selectAll')}
              </button>
              <button
                type="button"
                onClick={deselectAll}
                className="text-xs font-lexend text-gray-500 hover:underline"
              >
                {t('admin.workers.export.deselectAll')}
              </button>
            </div>
          </div>

          <div
            className="max-h-[300px] overflow-y-auto border border-[#D9D9D9] rounded-[10px] p-3 grid grid-cols-2 gap-x-4 gap-y-2"
            data-testid="export-columns-list"
          >
            {ALL_EXPORT_COLUMNS.map((col) => (
              <Checkbox
                key={col}
                id={`export-col-${col}`}
                label={t(COLUMN_LABEL_KEY[col], col)}
                checked={selected.has(col)}
                onChange={() => toggleColumn(col)}
              />
            ))}
          </div>

          {selected.size === 0 && (
            <p className="text-xs font-lexend text-red-500" data-testid="export-no-columns-error">
              {t('admin.workers.export.noColumnsError')}
            </p>
          )}
        </div>

        {/* API error */}
        {apiError && (
          <p className="text-xs font-lexend text-red-600" data-testid="export-api-error">
            {apiError}
          </p>
        )}

        {/* Actions */}
        <div className="flex flex-col-reverse sm:flex-row gap-3 mt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="flex-1 px-4 py-2.5 rounded-full border-2 border-primary text-primary text-sm font-medium hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-lexend"
          >
            {t('admin.workers.export.cancel')}
          </button>

          <button
            type="button"
            data-testid="worker-export-submit-btn"
            disabled={isExporting || selected.size === 0}
            onClick={handleExport}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-lexend"
          >
            {isExporting ? (
              <>
                <span
                  className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
                  aria-hidden="true"
                />
                {t('admin.workers.export.exporting')}
              </>
            ) : (
              t('admin.workers.export.export')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
