import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { Select, SelectOption } from '@presentation/components/atoms/Select';
import { SearchableSelect, SearchableSelectOption } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import { WorkerTagMultiSelect } from './WorkerTagMultiSelect';
import { AdminWorkerProfileFilters } from './AdminWorkerProfileFilters';
import type { WorkerProfileFilters } from './workerProfileFiltersConfig';
import type { WorkerTag } from '@domain/entities/WorkerTag';

export type { WorkerProfileFilters };

interface WorkerFiltersProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  selectedDocsStatus: string;
  onDocsStatusChange: (value: string) => void;
  docsStatusOptions: SelectOption[];
  selectedValidationStatus: string;
  onValidationStatusChange: (value: string) => void;
  validationStatusOptions: SelectOption[];
  caseOptions: SearchableSelectOption[];
  selectedCaseId: string;
  onCaseChange: (value: string) => void;
  isCaseOptionsLoading?: boolean;
  tagOptions: WorkerTag[];
  selectedTagIds: string[];
  onTagIdsChange: (ids: string[]) => void;
  isTagsLoading?: boolean;
  // profile filters
  profileFilters: WorkerProfileFilters;
  onProfileFiltersChange: (updates: Partial<WorkerProfileFilters>) => void;
  stateOptions: SelectOption[];
  cityOptions: SelectOption[];
  experienceTypeOptions: SelectOption[];
  preferredTypeOptions: SelectOption[];
}

export function WorkerFilters({
  searchValue,
  onSearchChange,
  selectedDocsStatus,
  onDocsStatusChange,
  docsStatusOptions,
  selectedValidationStatus,
  onValidationStatusChange,
  validationStatusOptions,
  caseOptions,
  selectedCaseId,
  onCaseChange,
  isCaseOptionsLoading = false,
  tagOptions,
  selectedTagIds,
  onTagIdsChange,
  isTagsLoading = false,
  profileFilters,
  onProfileFiltersChange,
  stateOptions,
  cityOptions,
  experienceTypeOptions,
  preferredTypeOptions,
}: WorkerFiltersProps): JSX.Element {
  const { t } = useTranslation();

  const hasProfileFilter =
    profileFilters.profession !== '' ||
    profileFilters.preferredAgeRange !== '' ||
    profileFilters.experienceType !== '' ||
    profileFilters.preferredType !== '' ||
    profileFilters.language !== '' ||
    profileFilters.sex !== '' ||
    profileFilters.state !== '' ||
    profileFilters.city !== '' ||
    profileFilters.days.length > 0;

  const hasActiveFilters =
    searchValue ||
    selectedDocsStatus ||
    selectedValidationStatus ||
    selectedCaseId ||
    selectedTagIds.length > 0 ||
    hasProfileFilter;

  const handleClearAll = () => {
    onSearchChange('');
    onDocsStatusChange('');
    onValidationStatusChange('');
    onCaseChange('');
    onTagIdsChange([]);
    onProfileFiltersChange({
      profession: '',
      preferredAgeRange: '',
      experienceType: '',
      preferredType: '',
      language: '',
      sex: '',
      state: '',
      city: '',
      days: [],
    });
  };

  return (
    <div className="bg-white rounded-b-[20px] border-r-2 border-b-2 border-l-2 border-[#D9D9D9] px-7 py-5">
      {/* Row 1: search + status filters + clear button */}
      <div className="flex items-end gap-3 flex-wrap">
        {/* Search */}
        <div className="flex-1 min-w-[200px] max-w-[320px]">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.workers.searchLabel', 'Buscar')}
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9CA3AF]" />
            <input
              type="text"
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={t('admin.workers.searchPlaceholder', 'Nombre, email o teléfono')}
              className="w-full h-[42px] pl-10 pr-3 rounded-lg border border-[#E5E7EB] bg-[#F9FAFB] text-sm font-lexend text-[#374151] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#6B21A8]/20 focus:border-[#6B21A8] focus:bg-white transition-all"
            />
          </div>
        </div>

        {/* Case filter */}
        <div className="w-[220px]">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.workers.caseLabel', 'Caso')}
          </label>
          <SearchableSelect
            options={caseOptions}
            value={selectedCaseId}
            onChange={onCaseChange}
            placeholder={t('admin.workers.caseOptions.all', 'Todos')}
            searchPlaceholder={t('admin.workers.caseSearchPlaceholder', 'Buscar caso...')}
            disabled={isCaseOptionsLoading}
          />
        </div>

        {/* Docs status filter */}
        <div className="w-[200px]" data-testid="filter-docs-status">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.workers.docsLabel', 'Documentación')}
          </label>
          <Select
            inputSize="compact"
            options={docsStatusOptions}
            value={selectedDocsStatus}
            onValueChange={onDocsStatusChange}
            placeholder={t('admin.workers.docsOptions.all', 'Todos')}
          />
        </div>

        {/* Validation status filter */}
        <div className="w-[200px]" data-testid="filter-validation-status">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.workers.filters.validation', 'Validación')}
          </label>
          <Select
            inputSize="compact"
            options={validationStatusOptions}
            value={selectedValidationStatus}
            onValueChange={onValidationStatusChange}
            placeholder={t('admin.workers.docsOptions.all', 'Todos')}
          />
        </div>

        {/* Tags multi-select filter */}
        <div className="w-[200px]" data-testid="filter-tags">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.workers.filters.tags', 'Etiquetas')}
          </label>
          <WorkerTagMultiSelect
            tags={tagOptions}
            selectedIds={selectedTagIds}
            onChange={onTagIdsChange}
            disabled={isTagsLoading}
          />
        </div>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            onClick={handleClearAll}
            className="h-[42px] px-3 flex items-center gap-1.5 text-sm font-lexend font-medium text-[#6B21A8] hover:bg-[#F3E8FF] rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            {t('admin.workers.clearFilters', 'Limpiar')}
          </button>
        )}
      </div>

      {/* Row 2: advanced profile filters */}
      <AdminWorkerProfileFilters
        filters={profileFilters}
        onChange={onProfileFiltersChange}
        stateOptions={stateOptions}
        cityOptions={cityOptions}
        experienceTypeOptions={experienceTypeOptions}
        preferredTypeOptions={preferredTypeOptions}
      />
    </div>
  );
}
