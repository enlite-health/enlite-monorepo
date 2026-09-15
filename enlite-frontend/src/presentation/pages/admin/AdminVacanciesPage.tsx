import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { Typography } from '@presentation/components/atoms/Typography';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Select } from '@presentation/components/atoms/Select';
import { VacancyStatsCards } from '@presentation/components/features/admin/VacancyStatsCards';
import { VacancyFilters, type VacancyAdvancedFilters } from '@presentation/components/features/admin/VacancyFilters';
import { VacanciesTable, VacancyPriority } from '@presentation/components/features/admin/VacanciesTable';
import { VacancyModal } from '@presentation/components/features/admin/VacancyModal/VacancyModal';
import { useVacanciesData } from '@hooks/admin/useVacanciesData';
import { getStatusOptions, getPriorityOptions } from './vacanciesData';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import type { SelectOption } from '@presentation/components/atoms/Select';

interface ModalState {
  isOpen: boolean;
  mode: 'create' | 'edit';
  vacancyId?: string;
}

const PRIORITY_SET: ReadonlySet<string> = new Set(['URGENT', 'HIGH', 'NORMAL', 'LOW']);

function toPriority(value: unknown): VacancyPriority | null {
  return typeof value === 'string' && PRIORITY_SET.has(value)
    ? (value as VacancyPriority)
    : null;
}

const INITIAL_ADVANCED: VacancyAdvancedFilters = {
  workerType: '',
  state: '',
  city: '',
  requiredSex: '',
  days: [],
  timeFrom: '',
  timeTo: '',
};

export function AdminVacanciesPage(): JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const statusOptions = getStatusOptions(t);
  const priorityOptions = getPriorityOptions(t);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [selectedPriority, setSelectedPriority] = useState('');
  const [itemsPerPage, setItemsPerPage] = useState('20');
  const [currentPage, setCurrentPage] = useState(1);
  const [advancedFilters, setAdvancedFilters] = useState<VacancyAdvancedFilters>(INITIAL_ADVANCED);

  const [stateOptions, setStateOptions] = useState<SelectOption[]>([]);
  const [cityOptions, setCityOptions] = useState<SelectOption[]>([]);

  useEffect(() => {
    AdminApiService.getVacancyFilterOptions()
      .then(({ states, cities }) => {
        setStateOptions(states.map((s) => ({ value: s, label: s })));
        setCityOptions(cities.map((c) => ({ value: c, label: c })));
      })
      .catch(() => {
        // silent — dropdowns stay empty
      });
  }, []);

  const handleSearchChange = (v: string) => { setSearchQuery(v); setCurrentPage(1); };
  const handleStatusChange = (v: string) => { setSelectedStatus(v); setCurrentPage(1); };
  const handlePriorityChange = (v: string) => { setSelectedPriority(v); setCurrentPage(1); };
  const handleItemsPerPageChange = (v: string) => { setItemsPerPage(v); setCurrentPage(1); };
  const handleAdvancedChange = useCallback((updates: Partial<VacancyAdvancedFilters>) => {
    setAdvancedFilters((prev) => ({ ...prev, ...updates }));
    setCurrentPage(1);
  }, []);

  const filters = useMemo(() => {
    const base: Record<string, string> = {
      search: searchQuery,
      status: selectedStatus,
      priority: selectedPriority,
      limit: itemsPerPage,
      offset: String((currentPage - 1) * parseInt(itemsPerPage)),
    };
    if (advancedFilters.workerType) base.worker_type = advancedFilters.workerType;
    if (advancedFilters.state) base.state = advancedFilters.state;
    if (advancedFilters.city) base.city = advancedFilters.city;
    if (advancedFilters.requiredSex) base.required_sex = advancedFilters.requiredSex;
    if (advancedFilters.days.length > 0) base.days = advancedFilters.days.join(',');
    if (advancedFilters.timeFrom && advancedFilters.timeTo) {
      base.time_from = advancedFilters.timeFrom;
      base.time_to = advancedFilters.timeTo;
    }
    return base;
  }, [searchQuery, selectedStatus, selectedPriority, itemsPerPage, currentPage, advancedFilters]);

  const { vacancies: rawVacancies, stats: rawStats, total, isLoading, error, refetch } = useVacanciesData(filters);
  const stats = rawStats as { label: string; value: string | number; icon: string }[] | null;

  // POST /vacancies/sync-talentum é sincronização EM MASSA (sem :id) — pela regra do
  // orquestrador (tasks.md 8b.1, "massa ou incerto") exige talentum:create E talentum:update
  // JUNTAS, conservador: falta uma, ninguém ganha acesso ao botão.
  const podeCriarTalentum = useActionGate('talentum', 'create').allowed;
  const podeAtualizarTalentum = useActionGate('talentum', 'update').allowed;
  const podeSyncTalentum = podeCriarTalentum && podeAtualizarTalentum;

  const [modalState, setModalState] = useState<ModalState>({ isOpen: false, mode: 'create' });

  const openEditModal = useCallback((vacancyId: string, isDraft: boolean) => {
    if (!isDraft) {
      navigate(`/admin/vacancies/${vacancyId}`);
      return;
    }
    setModalState({ isOpen: true, mode: 'edit', vacancyId });
  }, [navigate]);

  const closeModal = useCallback(() => {
    setModalState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const handleModalSuccess = useCallback(() => {
    closeModal();
    refetch();
  }, [closeModal, refetch]);

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isLongPressing, setIsLongPressing] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPressedRef = useRef(false);

  const handleSyncTalentum = useCallback(async (force = false) => {
    try {
      setIsSyncing(true);
      setSyncMessage(null);
      const report = await AdminApiService.syncFromTalentum(force ? { force: true } : undefined);
      const parts: string[] = [];
      if (report.updated > 0) parts.push(`${report.updated} actualizadas`);
      if (report.created > 0) parts.push(`${report.created} creadas`);
      if (report.skipped > 0) parts.push(`${report.skipped} ignoradas`);
      if (report.errors.length > 0) parts.push(`${report.errors.length} errores`);
      setSyncMessage({
        type: report.errors.length > 0 ? 'error' : 'success',
        text: parts.length > 0 ? parts.join(', ') : 'Sin cambios',
      });
      refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al sincronizar';
      setSyncMessage({ type: 'error', text: msg });
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncMessage(null), 6000);
    }
  }, [refetch]);

  const handlePressStart = useCallback(() => {
    if (isSyncing) return;
    isPressedRef.current = true;
    setIsLongPressing(true);
    longPressTimerRef.current = setTimeout(() => {
      if (isPressedRef.current) {
        isPressedRef.current = false;
        setIsLongPressing(false);
        handleSyncTalentum(true);
      }
    }, 3000);
  }, [isSyncing, handleSyncTalentum]);

  const handlePressEnd = useCallback(() => {
    if (!isPressedRef.current) return;
    isPressedRef.current = false;
    setIsLongPressing(false);
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    handleSyncTalentum(false);
  }, [handleSyncTalentum]);

  const handlePressCancel = useCallback(() => {
    if (!isPressedRef.current) return;
    isPressedRef.current = false;
    setIsLongPressing(false);
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const vacancies = useMemo(
    () => (rawVacancies || []).map((v: unknown) => {
      const vac = v as Record<string, unknown>;
      return {
        id: vac.id as string,
        caso: vac.caso ? String(vac.caso) : vac.id as string,
        status: (vac.status as string) || '—',
        priority: toPriority(vac.priority),
        diasAberto: (vac.diasAberto as string) || '—',
        convidados: vac.convidados != null ? String(vac.convidados) : '—',
        postulados: vac.postulados != null ? String(vac.postulados) : '—',
        confirmados: vac.confirmados != null ? String(vac.confirmados) : '—',
        selecionados: vac.selecionados != null ? String(vac.selecionados) : '—',
        faltantes: vac.faltantes != null ? String(vac.faltantes) : '—',
        isDraft: vac.is_draft === true,
      };
    }),
    [rawVacancies],
  );

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between mb-10">
        <Typography variant="h1" weight="semibold" color="primary" className="font-poppins text-2xl">
          {t('admin.vacancies.title')}
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

      <VacancyStatsCards stats={stats} />

      {/* Table section */}
      <div className="flex flex-col">
        {/* Section header */}
        <div className="bg-white rounded-t-[20px] border-2 border-b-0 border-[#D9D9D9] h-24 flex items-center justify-between px-7">
          <Typography variant="h1" weight="semibold" className="text-[#737373] font-poppins text-2xl">
            {t('admin.vacancies.vacanciesTitle')}
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
            {/* D269 — POST /vacancies/sync-talentum é MASSA (sem :id) → talentum:create E
                talentum:update JUNTAS (PR-8b, tasks.md 8b.1 "massa ou incerto"): sem as DUAS o
                botão SOME. `ActionButton` cobre a 2ª (update); `podeSyncTalentum` cobre a 1ª. */}
            {podeSyncTalentum && (
            <ActionButton
              resource="talentum"
              action="update"
              variant="outline"
              size="md"
              className="h-10 border-primary text-primary flex items-center justify-center gap-2 relative select-none"
              onMouseDown={handlePressStart}
              onMouseUp={handlePressEnd}
              onMouseLeave={handlePressCancel}
              onTouchStart={handlePressStart}
              onTouchEnd={handlePressEnd}
              onContextMenu={(e) => e.preventDefault()}
              disabled={isSyncing}
              data-testid="sync-talentum-btn"
            >
              <div
                className="absolute inset-y-0 left-0 bg-primary/15 rounded-full pointer-events-none"
                style={{
                  width: isLongPressing ? '100%' : '0%',
                  transition: isLongPressing ? 'width 3s linear' : 'width 0.15s ease-out',
                }}
              />
              <RefreshCw className={`w-3.5 h-3.5 text-primary relative z-10 ${isSyncing ? 'animate-spin' : ''}`} />
              <Typography variant="h3" weight="semibold" className="text-primary font-poppins text-sm relative z-10">
                {isSyncing ? t('admin.vacancies.syncing') : t('admin.vacancies.syncTalentum')}
              </Typography>
            </ActionButton>
            )}
            {/* POST /vacancies → `createVacancy` → vacancy:create (PR-8b). */}
            <ActionButton
              resource="vacancy"
              action="create"
              variant="outline"
              size="md"
              className="w-40 h-10 border-primary text-primary flex items-center justify-center gap-3"
              onClick={() => navigate('/admin/vacancies/new')}
              data-testid="new-vacancy-btn"
            >
              <Typography variant="h3" weight="semibold" className="text-primary font-poppins text-base">
                {t('admin.vacancies.new')}
              </Typography>
              <Plus className="w-3.5 h-3.5 text-primary" />
            </ActionButton>
          </div>
        </div>

        <VacancyFilters
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          selectedStatus={selectedStatus}
          onStatusChange={handleStatusChange}
          selectedPriority={selectedPriority}
          onPriorityChange={handlePriorityChange}
          statusOptions={statusOptions}
          priorityOptions={priorityOptions}
          advancedFilters={advancedFilters}
          onAdvancedChange={handleAdvancedChange}
          stateOptions={stateOptions}
          cityOptions={cityOptions}
        />

        {error ? (
          <div className="mt-6 py-8 text-center">
            <Typography variant="h3" className="text-red-600 mb-2">
              {t('admin.vacancies.errorLoading')}
            </Typography>
            <Typography variant="body" className="text-slate-600">{error}</Typography>
          </div>
        ) : isLoading ? (
          <div className="mt-6"><TableSkeleton /></div>
        ) : (
          <div className="mt-6">
            <VacanciesTable
              vacancies={vacancies}
              onRowClick={(id) => navigate(`/admin/vacancies/${id}`)}
              onEditClick={openEditModal}
            />
          </div>
        )}

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
              ? t('admin.vacancies.pagination', { start: 0, end: 0, total: 0 })
              : t('admin.vacancies.pagination', {
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
              aria-label={t('admin.vacancies.previousPage')}
            >
              <ChevronLeft className="w-4 h-4 text-[#737373]" />
            </button>
            <button
              onClick={() => setCurrentPage((p) => Math.min(Math.ceil(total / parseInt(itemsPerPage)), p + 1))}
              disabled={currentPage >= Math.ceil(total / parseInt(itemsPerPage))}
              className="p-1 rounded disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer hover:bg-gray-100 transition-colors"
              aria-label={t('admin.vacancies.nextPage')}
            >
              <ChevronRight className="w-4 h-4 text-[#737373]" />
            </button>
          </div>
        </div>
      </div>

      <VacancyModal
        mode={modalState.mode}
        vacancyId={modalState.vacancyId}
        isOpen={modalState.isOpen}
        onClose={closeModal}
        onSuccess={handleModalSuccess}
      />
    </PageContainer>
  );
}
