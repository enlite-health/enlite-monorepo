import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { Typography } from '@presentation/components/atoms/Typography';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Select } from '@presentation/components/atoms/Select';
import { WorkerFilters } from '@presentation/components/features/admin/WorkerFilters';
import { WorkerStatsCards } from '@presentation/components/features/admin/WorkerStatsCards';
import { WorkersTable } from '@presentation/components/features/admin/WorkersTable';
import { KanbanCardPresentationInvite, type PresentationInviteState } from '@presentation/components/features/admin/Kanban/KanbanCardPresentationInvite';
import { AdminPresentationInviteApiService } from '@infrastructure/http/AdminPresentationInviteApiService';
import { usePresentationInviteLast } from '@hooks/admin/usePresentationInviteLast';
import { WorkerExportModal } from '@presentation/components/features/admin/WorkerExport/WorkerExportModal';
import { useWorkersData } from '@hooks/admin/useWorkersData';
import { useCaseOptions } from '@hooks/admin/useCaseOptions';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import type { WorkerTag } from '@domain/entities/WorkerTag';
import type { SelectOption } from '@presentation/components/atoms/Select';
import {
  INITIAL_PROFILE_FILTERS,
  type WorkerProfileFilters,
} from '@presentation/components/features/admin/workerProfileFiltersConfig';
import { getDocsStatusOptions, getValidationStatusOptions } from './workersData';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';

export function AdminWorkersPage(): JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { adminProfile } = useAdminAuth();
  const isAdmin = adminProfile?.role === EnliteRole.ADMIN;

  /** REQ-09: convite à reunión de presentación por linha — inclusive quem NÃO terminou o registro (REQ-04). */
  const [inviteByWorker, setInviteByWorker] = useState<Record<string, PresentationInviteState>>({});

  const docsStatusOptions = getDocsStatusOptions(t);
  const validationStatusOptions = getValidationStatusOptions(t);

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedDocsStatus, setSelectedDocsStatus] = useState('');
  const [selectedValidationStatus, setSelectedValidationStatus] = useState('');
  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<WorkerTag[]>([]);
  const [isTagsLoading, setIsTagsLoading] = useState(false);
  const [itemsPerPage, setItemsPerPage] = useState('20');
  const [currentPage, setCurrentPage] = useState(1);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Profile filters state
  const [profileFilters, setProfileFilters] = useState<WorkerProfileFilters>(INITIAL_PROFILE_FILTERS);

  // Filter-options for dropdowns populated from the API
  const [stateOptions, setStateOptions] = useState<SelectOption[]>([]);
  const [cityOptions, setCityOptions] = useState<SelectOption[]>([]);
  const [experienceTypeOptions, setExperienceTypeOptions] = useState<SelectOption[]>([]);
  const [preferredTypeOptions, setPreferredTypeOptions] = useState<SelectOption[]>([]);

  const { options: caseOptions, isLoading: isCaseOptionsLoading } = useCaseOptions();

  // Load tags once
  useEffect(() => {
    setIsTagsLoading(true);
    AdminApiService.listWorkerTags()
      .then(setTagOptions)
      .catch(() => {/* silently fail — filter shows empty */})
      .finally(() => setIsTagsLoading(false));
  }, []);

  // Load worker filter-options once
  useEffect(() => {
    AdminApiService.getWorkerFilterOptions()
      .then(({ states, cities, experienceTypes, preferredTypes }) => {
        setStateOptions(states.map((s) => ({ value: s, label: s })));
        setCityOptions(cities.map((c) => ({ value: c, label: c })));
        setExperienceTypeOptions(experienceTypes.map((e) => ({ value: e, label: e })));
        setPreferredTypeOptions(preferredTypes.map((p) => ({ value: p, label: p })));
      })
      .catch(() => {
        // silent — dropdowns stay empty
      });
  }, []);

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
  const handleTagIdsChange = (ids: string[]) => { setSelectedTagIds(ids); setCurrentPage(1); };
  const handleProfileFiltersChange = useCallback((updates: Partial<WorkerProfileFilters>) => {
    setProfileFilters((prev) => ({ ...prev, ...updates }));
    setCurrentPage(1);
  }, []);

  const filters = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      docs_complete: selectedDocsStatus || undefined,
      docs_validated: selectedValidationStatus as 'all_validated' | 'pending_validation' | undefined || undefined,
      case_id: selectedCaseId || undefined,
      tag_ids: selectedTagIds.length > 0 ? selectedTagIds.join(',') : undefined,
      limit: itemsPerPage,
      offset: String((currentPage - 1) * parseInt(itemsPerPage)),
      // profile filters — omit when empty
      profession: profileFilters.profession || undefined,
      preferred_age_range: profileFilters.preferredAgeRange || undefined,
      experience_type: profileFilters.experienceType || undefined,
      preferred_type: profileFilters.preferredType || undefined,
      language: profileFilters.language || undefined,
      sex: profileFilters.sex || undefined,
      state: profileFilters.state || undefined,
      city: profileFilters.city || undefined,
      days: profileFilters.days.length > 0 ? profileFilters.days.join(',') : undefined,
    }),
    [
      debouncedSearch, selectedDocsStatus, selectedValidationStatus,
      selectedCaseId, selectedTagIds, itemsPerPage, currentPage,
      profileFilters,
    ],
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al sincronizar';
      setSyncMessage({ type: 'error', text: msg });
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncMessage(null), 10000);
    }
  }, [refetch]);

  const workers = useMemo(
    () =>
      (rawWorkers ?? []).map((w) => {
        const row = w as Record<string, unknown>;
        return {
          id: row.id as string,
          name: (row.name ?? row.email ?? '—') as string,
          email: (row.email ?? '') as string,
          casesCount: (row.casesCount ?? 0) as number,
          documentsComplete: (row.documentsComplete ?? false) as boolean,
          documentsStatus: (row.documentsStatus ?? 'pending') as string,
          platform: (row.platform ?? '') as string,
          createdAt: (row.createdAt ?? '') as string,
        };
      }),
    [rawWorkers],
  );
  // REQ-09: o mesmo /last do Kanban — a página mostra quem já foi convidada, não só quem clicou agora.
  // D286 fase 2: o "último convite" é GET /presentation-invite/last (messaging:read) e o convite é
  // POST …/presentation-invite (messaging:send). Sem a célula, nem consulta nem botão.
  const inviteSendGate = useActionGate('messaging', 'send');
  const inviteLastGate = useActionGate('messaging', 'read');
  const [lastInviteByWorker, setLastInviteByWorker] = usePresentationInviteLast(workers.map((w) => w.id), inviteLastGate.allowed);
  const handlePresentationInvite = useCallback(async (workerId: string) => {
    setInviteByWorker((prev) => ({ ...prev, [workerId]: { status: 'sending' } }));
    try {
      const r = await AdminPresentationInviteApiService.invite(workerId, 'workers_list');
      if (r.status === 'queued') {
        setLastInviteByWorker((prev) => ({ ...prev, [workerId]: { at: new Date().toISOString(), by: null } }));
        setInviteByWorker((prev) => ({ ...prev, [workerId]: { status: 'queued' } }));
      } else {
        setInviteByWorker((prev) => ({ ...prev, [workerId]: { status: 'skipped', detail: r.skipReason } }));
      }
    } catch (err) {
      setInviteByWorker((prev) => ({ ...prev, [workerId]: { status: 'error', detail: err instanceof Error ? err.message : null } }));
    }
  }, [setLastInviteByWorker]);

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
            {/* GET /workers/export → worker:export (o export já redige coluna por célula no back);
                POST /workers/sync-talentum → talentum:write. D286 fase 2: célula, não papel —
                o `isAdmin` continua como freio de papel enquanto o engine estiver desligado. */}
            {isAdmin && (
              <ActionButton
                resource="worker"
                action="export"
                variant="outline"
                size="md"
                data-testid="worker-export-btn"
                className="h-10 border-primary text-primary flex items-center justify-center gap-2"
                onClick={() => setIsExportModalOpen(true)}
              >
                <Download className="w-4 h-4" />
                {t('admin.workers.export.button')}
              </ActionButton>
            )}
            <ActionButton
              resource="talentum"
              action="write"
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
            </ActionButton>
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
          tagOptions={tagOptions}
          selectedTagIds={selectedTagIds}
          onTagIdsChange={handleTagIdsChange}
          isTagsLoading={isTagsLoading}
          profileFilters={profileFilters}
          onProfileFiltersChange={handleProfileFiltersChange}
          stateOptions={stateOptions}
          cityOptions={cityOptions}
          experienceTypeOptions={experienceTypeOptions}
          preferredTypeOptions={preferredTypeOptions}
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
            <WorkersTable
              workers={workers}
              onRowClick={(id) => navigate(`/admin/workers/${id}`)}
              renderAction={(row) => (
                inviteSendGate.allowed
                  ? <KanbanCardPresentationInvite compact onInvite={() => handlePresentationInvite(row.id)} state={inviteByWorker[row.id]} lastInvitedAt={lastInviteByWorker[row.id]?.at ?? null} />
                  : null
              )}
            />
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
            <Select
              inputSize="compact"
              options={[
                { value: '10', label: '10' },
                { value: '20', label: '20' },
                { value: '50', label: '50' },
              ]}
              value={itemsPerPage}
              onValueChange={handleItemsPerPageChange}
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
