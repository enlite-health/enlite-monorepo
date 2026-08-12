import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { Select, SelectOption } from '@presentation/components/atoms/Select';

interface PatientFiltersProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  codeValue: string;
  onCodeChange: (value: string) => void;
  selectedAttention: string;
  onAttentionChange: (value: string) => void;
  selectedReason: string;
  onReasonChange: (value: string) => void;
  selectedSpecialty: string;
  onSpecialtyChange: (value: string) => void;
  selectedDependency: string;
  onDependencyChange: (value: string) => void;
  attentionOptions: SelectOption[];
  reasonOptions: SelectOption[];
  specialtyOptions: SelectOption[];
  dependencyOptions: SelectOption[];
  /** Fase 4 — country scope (optional; omit to hide the country filter). */
  selectedCountry?: string;
  onCountryChange?: (value: string) => void;
  countryOptions?: SelectOption[];
}

export function PatientFilters({
  searchValue,
  onSearchChange,
  codeValue,
  onCodeChange,
  selectedAttention,
  onAttentionChange,
  selectedReason,
  onReasonChange,
  selectedSpecialty,
  onSpecialtyChange,
  selectedDependency,
  onDependencyChange,
  attentionOptions,
  reasonOptions,
  specialtyOptions,
  dependencyOptions,
  selectedCountry,
  onCountryChange,
  countryOptions,
}: PatientFiltersProps): JSX.Element {
  const { t } = useTranslation();

  const showCountryFilter = !!countryOptions && !!onCountryChange;
  const showReasonFilter = selectedAttention === 'needs_attention';
  const hasActiveFilters =
    searchValue || codeValue || selectedAttention || selectedSpecialty || selectedDependency
    || selectedCountry;

  const handleClearAll = () => {
    onSearchChange('');
    onCodeChange('');
    onAttentionChange('');
    onReasonChange('');
    onSpecialtyChange('');
    onDependencyChange('');
    onCountryChange?.('');
  };

  return (
    <div className="bg-white rounded-b-[20px] border-r-2 border-b-2 border-l-2 border-[#D9D9D9] px-7 py-5">
      <div className="flex items-end gap-3 flex-wrap">
        {/* Search */}
        <div className="flex-1 min-w-[200px] max-w-[320px]">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.patients.searchLabel')}
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9CA3AF]" />
            <input
              type="text"
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={t('admin.patients.searchPlaceholder')}
              className="w-full h-[42px] pl-10 pr-3 rounded-lg border border-[#E5E7EB] bg-[#F9FAFB] text-sm font-lexend text-[#374151] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#6B21A8]/20 focus:border-[#6B21A8] focus:bg-white transition-all"
            />
          </div>
        </div>

        {/* Code / case number filter */}
        <div className="w-[160px]" data-testid="filter-code">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.patients.codeLabel')}
          </label>
          <input
            type="text"
            value={codeValue}
            onChange={(e) => onCodeChange(e.target.value)}
            placeholder={t('admin.patients.codePlaceholder')}
            className="w-full h-[42px] px-3 rounded-lg border border-[#E5E7EB] bg-[#F9FAFB] text-sm font-lexend text-[#374151] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-2 focus:ring-[#6B21A8]/20 focus:border-[#6B21A8] focus:bg-white transition-all"
          />
        </div>

        {/* Attention status filter */}
        <div className="w-[180px]" data-testid="filter-attention">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.patients.attentionLabel')}
          </label>
          <Select
            inputSize="compact"
            options={attentionOptions}
            value={selectedAttention}
            onValueChange={onAttentionChange}
            placeholder={t('admin.patients.attentionOptions.all')}
          />
        </div>

        {/* Reason filter — only when "needs attention" selected */}
        {showReasonFilter && (
          <div className="w-[200px]" data-testid="filter-reason">
            <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
              {t('admin.patients.reasonLabel')}
            </label>
            <Select
              inputSize="compact"
              options={reasonOptions}
              value={selectedReason}
              onValueChange={onReasonChange}
              placeholder={t('admin.patients.reasonOptions.all')}
            />
          </div>
        )}

        {/* Specialty filter */}
        <div className="w-[210px]" data-testid="filter-specialty">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.patients.specialtyLabel')}
          </label>
          <Select
            inputSize="compact"
            options={specialtyOptions}
            value={selectedSpecialty}
            onValueChange={onSpecialtyChange}
            placeholder={t('admin.patients.specialtyOptions.all')}
          />
        </div>

        {/* Country filter (Fase 4). 210px: cabe o rótulo mais longo ("Todos los
            países") — select nativo trunca sem reticências quando não cabe. */}
        {showCountryFilter && (
          <div className="w-[210px]" data-testid="patient-country-filter">
            <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
              {t('admin.patients.countryLabel')}
            </label>
            <Select
              inputSize="compact"
              options={countryOptions!}
              value={selectedCountry ?? ''}
              onValueChange={onCountryChange!}
              placeholder={t('admin.patients.countryOptions.all')}
            />
          </div>
        )}

        {/* Dependency filter */}
        <div className="w-[180px]" data-testid="filter-dependency">
          <label className="block text-xs font-medium text-[#9CA3AF] mb-1.5 font-lexend uppercase tracking-wide">
            {t('admin.patients.dependencyLabel')}
          </label>
          <Select
            inputSize="compact"
            options={dependencyOptions}
            value={selectedDependency}
            onValueChange={onDependencyChange}
            placeholder={t('admin.patients.dependencyOptions.all')}
          />
        </div>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            onClick={handleClearAll}
            className="h-[42px] px-3 flex items-center gap-1.5 text-sm font-lexend font-medium text-[#6B21A8] hover:bg-[#F3E8FF] rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            {t('admin.patients.clearFilters')}
          </button>
        )}
      </div>
    </div>
  );
}
