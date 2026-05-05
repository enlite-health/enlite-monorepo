import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { Typography } from '@presentation/components/atoms/Typography';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { SelectField } from '@presentation/components/molecules/SelectField';
import { WorkerFilters } from '@presentation/components/features/admin/WorkerFilters';
import { WorkerStatsCards } from '@presentation/components/features/admin/WorkerStatsCards';
import { WorkersTable } from '@presentation/components/features/admin/WorkersTable';
import { WorkerExportModal } from '@presentation/components/features/admin/WorkerExport/WorkerExportModal';
import { useWorkersData } from '@hooks/admin/useWorkersData';
import { useCaseOptions } from '@hooks/admin/useCaseOptions';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { getDocsStatusOptions, getValidationStatusOptions } from './workersData';

export function AdminWorkersPage(): JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { adminProfile } = useAdminAuth();
  const isAdmin = adminProfile?.role === EnliteRole.ADMIN;

  const docsStatusOptions = getDocsStatusOptions(t);
  const validationStatusOptions = getValidationStatusOptions(t);

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedDocsStatus, setSelectedDocsStatus] = useState('');
  const [selectedValidationStatus, setSelectedValidationStatus] = useState('');
  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [itemsPerPage, setItemsPerPage] = useState('20');
  const [currentPage, setCurrentPage] = useState(1);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const { options: caseOptions, isLoading: isCaseOptionsLoading } = useCaseOptions();

  const handleSearchChange = (v: string) => {
    setSearchInput(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setDebouncedSearch(v); setCurrentPage(1); }, 400);
  };
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const handleDocsStatusChange = (v: string) => { setSelectedDocsStatus(v); setCurrentPage(1); };
  const handleValidationStatusChange = (v: string) => { setSelectedValidationStatus(v); setCurrentPage(1); };
  const handleItemsPerPageChange = (v: string) => { setItemsPerPage(v); setCurrentPage(1); };
  const handleCaseChange = (v: string) => { setSelectedCaseId(v); setCurrentPage(1); };

  const filters = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      docs_complete: selectedDocsStatus || undefined,
      docs_validated: selectedValidationStatus as 'all_validated' | 'pending_validation' | undefined || undefined,
      case_id: selectedCaseId || undefined,
      limit: itemsPerPage,
      offset: String((currentPage - 1) * parseInt(itemsPerPage)),
    }),
    [debouncedSearch, selectedDocsStatus, selectedValidationStatus, selectedCaseId, itemsPerPage, currentPage],
  );

  const { workers: rawWorkers, total, stats, isLoading, error, refetch } = useWorkersData(filters);

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSyncTalentum = useCallback(async () => {
    try {
      setIsSyncing(true);
      setSyncMessage(null);
      const report = await AdminApiService.syncTalentumWorkers();
      const parts: string[] = [];
      if (report.created > 0) parts.push(`${report.created} creados`);
      if (report.updated > 0) parts.push(`${report.updated} actualizados`);
      if (report.linked > 0) parts.push(`${report.linked} vinculados a casos`);
      if (report.skipped > 0) parts.push(`${report.skipped} sin cambios`);
      if (report.errors.length > 0) parts.push(`${report.errors.length} errores`);
      setSyncMessage({
        type: report.errors.length > 0 ? 'error' : 'success',
        text: parts.length > 0 ? `${report.total} perfiles: ${parts.join(', ')}` : 'Sin cambios',
      });
      refetch();
    } catch (err: any) {
      setSyncMessage({ type: 'error', text: err.message || 'Error al sincronizar' });
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncMessage(null), 10000);
    }
  }, [refetch]);

  const workers = useMemo(
    () =>
      (rawWorkers ?? []).map((w: any) => ({
        id: w.id,
        name: w.name ?? w.email ?? '—',
        email: w.email ?? '',
        casesCount: w.casesCount ?? 0,
        documentsComplete: w.documentsComplete ?? false,
        documentsStatus: w.documentsStatus ?? 'pending',
        platform: w.platform ?? '',
        createdAt: w.createdAt ?? '',
      })),
    [rawWorkers],
  );

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between mb-10">
        <Typography variant="h1" weight="semibold" color="primary" className="font-poppins text-2xl">
          {t('admin.workers.title', 'Prestadores')}
        </Typography>
        <div className="flex items-center gap-2">
          <img
            className="w-7 h-5"
            alt="Argentina"
            src="https://c.animaapp.com/UVSSEdVv/img/group-237688.svg"
          />
          <Typography variant="body" weight="medium" className="text-[#737373]">
            {t('common.country')}
          </Typography>
        </div>
      </div>

      <WorkerStatsCards stats={stats} />

      {/* Table section */}
      <div className="flex flex-col">
        {/* Section header */}
        <div className="bg-white rounded-t-[20px] border-2 border-b-0 border-[#D9D9D9] h-24 flex items-center justify-between px-7">
          <Typography variant="h1" weight="semibold" className="text-[#737373] font-poppins text-2xl">
            {t('admin.workers.listTitle', 'Lista de Prestadores')}
          </Typography>
          <div className="flex items-center gap-3">
            {syncMessage && (
              <Typography
                variant="body"
                className={`text-sm ${syncMessage.type === 'success' ? 'text-green-600' : 'text-red-600'}`}
              >
                {syncMessage.text}
              </Typography>
            )}
            {isAdmin && (
              <Button
                variant="outline"
                size="md"
                data-testid="worker-export-btn"
                className="h-10 border-primary text-primary flex items-center justify-center gap-2"
                onClick={() => setIsExportModalOpen(true)}
              >
                <Download className="w-4 h-4" />
                {t('admin.workers.export.button')}
              </Button>
            )}
            <Button
              variant="outline"
              size="md"
              className="h-10 border-primary text-primary flex items-center justify-center gap-2"
              onClick={handleSyncTalentum}
              disabled={isSyncing}
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
              {isSyncing
                ? t('admin.workers.syncing', 'Sincronizando...')
                : t('admin.workers.syncTalentum', 'Sincronizar Talentum')}
            </Button>
          </div>
        </div>

        <WorkerFilters
          searchValue={searchInput}
          onSearchChange={handleSearchChange}
          selectedDocsStatus={selectedDocsStatus}
          onDocsStatusChange={handleDocsStatusChange}
          docsStatusOptions={docsStatusOptions}
          selectedValidationStatus={selectedValidationStatus}
          onValidationStatusChange={handleValidationStatusChange}
          validationStatusOptions={validationStatusOptions}
          caseOptions={caseOptions}
          selectedCaseId={selectedCaseId}
          onCaseChange={handleCaseChange}
          isCaseOptionsLoading={isCaseOptionsLoading}
        />

        {error ? (
          <div className="mt-6 py-8 text-center">
            <Typography variant="h3" className="text-red-600 mb-2">
              {t('admin.workers.errorLoading')}
            </Typography>
            <Typography variant="body" className="text-slate-600">{error}</Typography>
          </div>
        ) : isLoading ? (
          <div className="mt-6"><TableSkeleton /></div>
        ) : (
          <div className="mt-6">
            <WorkersTable workers={workers} onRowClick={(id) => navigate(`/admin/workers/${id}`)} />
          </div>
        )}

        {/* Export modal */}
        <WorkerExportModal
          isOpen={isExportModalOpen}
          onClose={() => setIsExportModalOpen(false)}
          activeFilters={{
            docs_complete: selectedDocsStatus || undefined,
            docs_validated: selectedValidationStatus as 'all_validated' | 'pending_validation' | undefined || undefined,
            search: debouncedSearch || undefined,
            case_id: selectedCaseId || undefined,
          }}
          activeStatus={
            selectedDocsStatus === 'complete'
              ? 'REGISTERED'
              : selectedDocsStatus === 'incomplete'
                ? 'INCOMPLETE_REGISTER'
                : undefined
          }
        />

        {/* Pagination */}
        <div className="flex flex-wrap items-center justify-end gap-4 mt-6">
          <div className="w-full sm:w-[164px]">
            <SelectField
              options={[
                { value: '10', label: '10' },
                { value: '20', label: '20' },
                { value: '50', label: '50' },
              ]}
              value={itemsPerPage}
              onChange={handleItemsPerPageChange}
              placeholder="20"
            />
          </div>
          <Typography variant="body" weight="medium" className="text-[#737373] font-lexend text-base">
            {total === 0
              ? t('admin.workers.pagination', { start: 0, end: 0, total: 0 })
              : t('admin.workers.pagination', {
                  start: (currentPage - 1) * parseInt(itemsPerPage) + 1,
                  end: Math.min(currentPage * parseInt(itemsPerPage), total),
                  total,
                })}
          </Typography>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="p-1 rounded disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer hover:bg-gray-100 transition-colors"
              aria-label={t('admin.workers.previousPage')}
            >
              <ChevronLeft className="w-4 h-4 text-[#737373]" />
            </button>
            <button
              onClick={() => setCurrentPage((p) => Math.min(Math.ceil(total / parseInt(itemsPerPage)), p + 1))}
              disabled={currentPage >= Math.ceil(total / parseInt(itemsPerPage))}
              className="p-1 rounded disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer hover:bg-gray-100 transition-colors"
              aria-label={t('admin.workers.nextPage')}
            >
              <ChevronRight className="w-4 h-4 text-[#737373]" />
            </button>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
