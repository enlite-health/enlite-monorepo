import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Plus, LayoutGrid, Globe } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Select } from '@presentation/components/atoms/Select';
import { Button } from '@presentation/components/atoms/Button';
import { ActionButton } from '@presentation/components/features/access';
import { PatientCreateModal } from '@presentation/components/features/admin/PatientCreateModal';
import { PatientFilters } from '@presentation/components/features/admin/PatientFilters';
import { PatientsTable } from '@presentation/components/features/admin/PatientsTable';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { usePatientsData } from '@hooks/admin/usePatientsData';
import {
  getAttentionOptions,
  getReasonOptions,
  getSpecialtyOptions,
  getDependencyOptions,
  getCountryOptions,
  attentionToApiParam,
} from './patientsData';

export function AdminPatientsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const attentionOptions = getAttentionOptions(t);
  const reasonOptions = getReasonOptions(t);
  const specialtyOptions = getSpecialtyOptions(t);
  const dependencyOptions = getDependencyOptions(t);
  const countryOptions = getCountryOptions(t);

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [debouncedCode, setDebouncedCode] = useState('');
  const [selectedAttention, setSelectedAttention] = useState('');
  const [selectedReason, setSelectedReason] = useState('');
  const [selectedSpecialty, setSelectedSpecialty] = useState('');
  const [selectedDependency, setSelectedDependency] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('');
  const [itemsPerPage, setItemsPerPage] = useState('20');
  const [currentPage, setCurrentPage] = useState(1);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const codeDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  const handleSearchChange = (v: string) => {
    setSearchInput(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setDebouncedSearch(v); setCurrentPage(1); }, 400);
  };
  const handleCodeChange = (v: string) => {
    setCodeInput(v);
    clearTimeout(codeDebounceRef.current);
    codeDebounceRef.current = setTimeout(() => { setDebouncedCode(v); setCurrentPage(1); }, 400);
  };
  useEffect(() => () => {
    clearTimeout(debounceRef.current);
    clearTimeout(codeDebounceRef.current);
  }, []);

  const handleAttentionChange = (v: string) => {
    setSelectedAttention(v);
    setSelectedReason('');
    setCurrentPage(1);
  };
  const handleReasonChange = (v: string) => { setSelectedReason(v); setCurrentPage(1); };
  const handleSpecialtyChange = (v: string) => { setSelectedSpecialty(v); setCurrentPage(1); };
  const handleDependencyChange = (v: string) => { setSelectedDependency(v); setCurrentPage(1); };
  const handleCountryChange = (v: string) => { setSelectedCountry(v); setCurrentPage(1); };
  const handleItemsPerPageChange = (v: string) => { setItemsPerPage(v); setCurrentPage(1); };

  const filters = useMemo(() => {
    const needsAttentionParam = attentionToApiParam(selectedAttention);
    return {
      search: debouncedSearch || undefined,
      needs_attention: needsAttentionParam,
      attention_reason:
        selectedAttention === 'needs_attention' && selectedReason ? selectedReason : undefined,
      clinical_specialty: selectedSpecialty || undefined,
      dependency_level: selectedDependency || undefined,
      case_number: debouncedCode || undefined,
      country: selectedCountry || undefined,
      limit: itemsPerPage,
      offset: String((currentPage - 1) * parseInt(itemsPerPage)),
    };
  }, [
    debouncedSearch,
    debouncedCode,
    selectedAttention,
    selectedReason,
    selectedSpecialty,
    selectedDependency,
    selectedCountry,
    itemsPerPage,
    currentPage,
  ]);

  const { patients: rawPatients, total, isLoading, error } = usePatientsData(filters);

  const patients = useMemo(
    () =>
      (rawPatients ?? []).map((p: any) => ({
        id: p.id,
        firstName: p.firstName ?? '',
        lastName: p.lastName ?? '',
        responsibleName: p.responsibleName ?? null,
        documentType: p.documentType ?? null,
        documentNumber: p.documentNumber ?? null,
        caseNumber: p.caseNumber ?? null,
        dependencyLevel: p.dependencyLevel ?? null,
        clinicalSpecialty: p.clinicalSpecialty ?? null,
        serviceType: p.serviceType ?? [],
        needsAttention: p.needsAttention ?? false,
        attentionReasons: p.attentionReasons ?? [],
        createdAt: p.createdAt ?? null,
      })),
    [rawPatients],
  );

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between mb-10">
        <Typography variant="h1" weight="semibold" color="primary" className="font-poppins text-2xl">
          {t('admin.patients.title')}
        </Typography>
        <div className="flex items-center gap-2">
          {/* Era um <img> do CDN do Anima (c.animaapp.com) que responde 403 —
              renderizava ícone de imagem quebrada em todo carregamento. */}
          <Globe className="w-5 h-5 text-[#737373]" strokeWidth={1.5} aria-hidden="true" />
          <Typography variant="body" weight="medium" className="text-[#737373]">
            {t('common.country')}
          </Typography>
        </div>
      </div>

      {/*
        Os big numbers (estado dos pacientes + embudo) vivem em "Gestión a la
        vista" (/admin/dashboard) — esta tela é operação: lista, filtros, kanban.
      */}

      {/* Table section */}
      <div className="flex flex-col">
        {/* Section header */}
        <div className="bg-white rounded-t-[20px] border-2 border-b-0 border-[#D9D9D9] h-24 flex items-center justify-between px-7">
          <Typography variant="h1" weight="semibold" className="text-[#737373] font-poppins text-2xl">
            {t('admin.patients.listTitle')}
          </Typography>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="md"
              className="h-10 flex items-center justify-center gap-2"
              onClick={() => navigate('/admin/patients/kanban')}
              data-testid="patients-kanban-link"
            >
              <LayoutGrid className="w-4 h-4" />
              <Typography variant="h3" weight="semibold" className="font-poppins text-base">
                {t('admin.patients.kanban.toggleKanban')}
              </Typography>
            </Button>
            {/* D269 — criação chama POST /patients → patient:create (PR-8b); sem a
                célula, o botão SOME (mode='hide', default do ActionButton). */}
            <ActionButton
              resource="patient"
              action="create"
              variant="outline"
              size="md"
              className="h-10 px-5 border-primary text-primary flex items-center justify-center gap-2"
              onClick={() => setIsCreateOpen(true)}
              data-testid="new-patient-btn"
            >
              {/* rótulo curto de propósito: com "Crear nuevo" a largura fixa
                  quebrava em duas linhas dentro do botão */}
              <Typography variant="h3" weight="semibold" className="text-primary font-poppins text-base whitespace-nowrap">
                {t('admin.patients.create.new')}
              </Typography>
              <Plus className="w-3.5 h-3.5 text-primary" />
            </ActionButton>
          </div>
        </div>

        <PatientFilters
          searchValue={searchInput}
          onSearchChange={handleSearchChange}
          codeValue={codeInput}
          onCodeChange={handleCodeChange}
          selectedAttention={selectedAttention}
          onAttentionChange={handleAttentionChange}
          selectedReason={selectedReason}
          onReasonChange={handleReasonChange}
          selectedSpecialty={selectedSpecialty}
          onSpecialtyChange={handleSpecialtyChange}
          selectedDependency={selectedDependency}
          onDependencyChange={handleDependencyChange}
          attentionOptions={attentionOptions}
          reasonOptions={reasonOptions}
          specialtyOptions={specialtyOptions}
          dependencyOptions={dependencyOptions}
          selectedCountry={selectedCountry}
          onCountryChange={handleCountryChange}
          countryOptions={countryOptions}
        />

        {error ? (
          <div className="mt-6 py-8 text-center">
            <Typography variant="h3" className="text-red-600 mb-2">
              {t('admin.patients.errorLoading')}
            </Typography>
            <Typography variant="body" className="text-slate-600">{error}</Typography>
          </div>
        ) : isLoading ? (
          <div className="mt-6"><TableSkeleton /></div>
        ) : (
          <div className="mt-6">
            <PatientsTable patients={patients} onRowClick={(id) => navigate(`/admin/patients/${id}`)} />
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
              ? t('admin.patients.pagination', { start: 0, end: 0, total: 0 })
              : t('admin.patients.pagination', {
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
              aria-label={t('admin.patients.previousPage')}
            >
              <ChevronLeft className="w-4 h-4 text-[#737373]" />
            </button>
            <button
              onClick={() => setCurrentPage((p) => Math.min(Math.ceil(total / parseInt(itemsPerPage)), p + 1))}
              disabled={currentPage >= Math.ceil(total / parseInt(itemsPerPage))}
              className="p-1 rounded disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer hover:bg-gray-100 transition-colors"
              aria-label={t('admin.patients.nextPage')}
            >
              <ChevronRight className="w-4 h-4 text-[#737373]" />
            </button>
          </div>
        </div>
      </div>

      {isCreateOpen && (
        <PatientCreateModal
          onClose={() => setIsCreateOpen(false)}
          // Spec 014 US-D5: criar paciente ABRE A FICHA — antes só fechava o modal e refazia o
          // fetch da lista, e a operadora tinha que achar o paciente recém-criado na tabela.
          onCreated={(id) => navigate(`/admin/patients/${id}`)}
        />
      )}
    </PageContainer>
  );
}
