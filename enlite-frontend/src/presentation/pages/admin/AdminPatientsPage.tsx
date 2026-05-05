import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { SelectField } from '@presentation/components/molecules/SelectField';
import { PatientFilters } from '@presentation/components/features/admin/PatientFilters';
import { PatientStatsCards } from '@presentation/components/features/admin/PatientStatsCards';
import { PatientsTable } from '@presentation/components/features/admin/PatientsTable';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { usePatientsData } from '@hooks/admin/usePatientsData';
import {
  getAttentionOptions,
  getReasonOptions,
  getSpecialtyOptions,
  getDependencyOptions,
  attentionToApiParam,
} from './patientsData';

export function AdminPatientsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const attentionOptions = getAttentionOptions(t);
  const reasonOptions = getReasonOptions(t);
  const specialtyOptions = getSpecialtyOptions(t);
  const dependencyOptions = getDependencyOptions(t);

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedAttention, setSelectedAttention] = useState('');
  const [selectedReason, setSelectedReason] = useState('');
  const [selectedSpecialty, setSelectedSpecialty] = useState('');
  const [selectedDependency, setSelectedDependency] = useState('');
  const [itemsPerPage, setItemsPerPage] = useState('20');
  const [currentPage, setCurrentPage] = useState(1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const handleSearchChange = (v: string) => {
    setSearchInput(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setDebouncedSearch(v); setCurrentPage(1); }, 400);
  };
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const handleAttentionChange = (v: string) => {
    setSelectedAttention(v);
    setSelectedReason('');
    setCurrentPage(1);
  };
  const handleReasonChange = (v: string) => { setSelectedReason(v); setCurrentPage(1); };
  const handleSpecialtyChange = (v: string) => { setSelectedSpecialty(v); setCurrentPage(1); };
  const handleDependencyChange = (v: string) => { setSelectedDependency(v); setCurrentPage(1); };
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
      limit: itemsPerPage,
      offset: String((currentPage - 1) * parseInt(itemsPerPage)),
    };
  }, [
    debouncedSearch,
    selectedAttention,
    selectedReason,
    selectedSpecialty,
    selectedDependency,
    itemsPerPage,
    currentPage,
  ]);

  const { patients: rawPatients, total, stats, isLoading, error } = usePatientsData(filters);

  const patients = useMemo(
    () =>
      (rawPatients ?? []).map((p: any) => ({
        id: p.id,
        firstName: p.firstName ?? '',
        lastName: p.lastName ?? '',
        documentType: p.documentType ?? null,
        documentNumber: p.documentNumber ?? null,
        dependencyLevel: p.dependencyLevel ?? null,
        clinicalSpecialty: p.clinicalSpecialty ?? null,
        serviceType: p.serviceType ?? [],
        needsAttention: p.needsAttention ?? false,
        attentionReasons: p.attentionReasons ?? [],
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

      <PatientStatsCards stats={stats} />

      {/* Table section */}
      <div className="flex flex-col">
        {/* Section header */}
        <div className="bg-white rounded-t-[20px] border-2 border-b-0 border-[#D9D9D9] h-24 flex items-center justify-between px-7">
          <Typography variant="h1" weight="semibold" className="text-[#737373] font-poppins text-2xl">
            {t('admin.patients.listTitle')}
          </Typography>
        </div>

        <PatientFilters
          searchValue={searchInput}
          onSearchChange={handleSearchChange}
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
    </PageContainer>
  );
}
