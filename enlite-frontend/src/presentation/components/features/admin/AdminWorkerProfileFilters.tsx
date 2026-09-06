/**
 * AdminWorkerProfileFilters
 *
 * Row of advanced profile filters for the worker listing:
 * profession, preferred_age_range, experience_type, preferred_type,
 * language, sex, state, city, days.
 *
 * Extracted from WorkerFilters to keep each file under the 400-line limit.
 * Types/constants live in workerProfileFiltersConfig.ts to satisfy
 * react-refresh/only-export-components.
 */
import { useTranslation } from 'react-i18next';
import { Select, type SelectOption } from '@presentation/components/atoms/Select';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { Text } from '@presentation/components/atoms/Text';
import type { WorkerProfileFilters } from './workerProfileFiltersConfig';

interface AdminWorkerProfileFiltersProps {
  filters: WorkerProfileFilters;
  onChange: (updates: Partial<WorkerProfileFilters>) => void;
  stateOptions: SelectOption[];
  cityOptions: SelectOption[];
  experienceTypeOptions: SelectOption[];
  preferredTypeOptions: SelectOption[];
}

export function AdminWorkerProfileFilters({
  filters,
  onChange,
  stateOptions,
  cityOptions,
  experienceTypeOptions,
  preferredTypeOptions,
}: AdminWorkerProfileFiltersProps): JSX.Element {
  const { t } = useTranslation();

  const professionOptions: SelectOption[] = [
    {
      value: 'AT',
      label: t('admin.workers.filters.profile.profession.AT', { defaultValue: 'AT' }),
    },
    {
      value: 'CAREGIVER',
      label: t('admin.workers.filters.profile.profession.CAREGIVER', { defaultValue: 'Cuidador' }),
    },
    {
      value: 'AT,CAREGIVER',
      label: t('admin.workers.filters.profile.profession.AMBOS', { defaultValue: 'Ambos' }),
    },
  ];

  const ageRangeOptions: SelectOption[] = [
    {
      value: 'children',
      label: t('admin.workers.filters.profile.ageRange.children', { defaultValue: 'Niños' }),
    },
    {
      value: 'adults',
      label: t('admin.workers.filters.profile.ageRange.adults', { defaultValue: 'Adultos' }),
    },
    {
      value: 'elderly',
      label: t('admin.workers.filters.profile.ageRange.elderly', { defaultValue: 'Adultos mayores' }),
    },
  ];

  const languageOptions: SelectOption[] = [
    {
      value: 'es',
      label: t('admin.workers.filters.profile.language.es', { defaultValue: 'Español' }),
    },
    {
      value: 'pt',
      label: t('admin.workers.filters.profile.language.pt', { defaultValue: 'Portugués' }),
    },
    {
      value: 'en',
      label: t('admin.workers.filters.profile.language.en', { defaultValue: 'Inglés' }),
    },
  ];

  const sexOptions: SelectOption[] = [
    {
      value: 'male',
      label: t('admin.workers.filters.profile.sex.male', { defaultValue: 'Masculino' }),
    },
    {
      value: 'female',
      label: t('admin.workers.filters.profile.sex.female', { defaultValue: 'Femenino' }),
    },
  ];

  // 0=domingo … 6=sábado — display lun→dom to match UX convention
  const dayOptions: SelectOption[] = [
    { value: '1', label: t('admin.vacancyDetail.vacancyForm.days.lun') },
    { value: '2', label: t('admin.vacancyDetail.vacancyForm.days.mar') },
    { value: '3', label: t('admin.vacancyDetail.vacancyForm.days.mie') },
    { value: '4', label: t('admin.vacancyDetail.vacancyForm.days.jue') },
    { value: '5', label: t('admin.vacancyDetail.vacancyForm.days.vie') },
    { value: '6', label: t('admin.vacancyDetail.vacancyForm.days.sab') },
    { value: '0', label: t('admin.vacancyDetail.vacancyForm.days.dom') },
  ];

  const allOption = t('admin.workers.filters.profile.allOption', { defaultValue: 'Todos' });
  const searchPh = t('common.search', { defaultValue: 'Buscar...' });

  return (
    <div
      className="flex items-end gap-4 flex-wrap mt-4 pt-4 border-t border-[#E5E7EB]"
      data-testid="worker-profile-filters"
    >
      {/* Profesión */}
      <div className="w-full sm:w-[150px]">
        <Text size="sm" weight="semibold" color="secondary" className="mb-1">
          {t('admin.workers.filters.profile.profession.label', { defaultValue: 'Profesión' })}
        </Text>
        <Select
          inputSize="compact"
          options={professionOptions}
          value={filters.profession}
          onValueChange={(v) => onChange({ profession: v })}
          placeholder={allOption}
        />
      </div>

      {/* Rango etario preferido */}
      <div className="w-full sm:w-[170px]">
        <Text size="sm" weight="semibold" color="secondary" className="mb-1">
          {t('admin.workers.filters.profile.ageRange.label', { defaultValue: 'Rango etario' })}
        </Text>
        <Select
          inputSize="compact"
          options={ageRangeOptions}
          value={filters.preferredAgeRange}
          onValueChange={(v) => onChange({ preferredAgeRange: v })}
          placeholder={allOption}
        />
      </div>

      {/* Tipos de experiencia */}
      <div className="w-full sm:w-[170px]">
        <Text size="sm" weight="semibold" color="secondary" className="mb-1">
          {t('admin.workers.filters.profile.experienceType.label', { defaultValue: 'Tipo experiencia' })}
        </Text>
        <Select
          inputSize="compact"
          options={experienceTypeOptions}
          value={filters.experienceType}
          onValueChange={(v) => onChange({ experienceType: v })}
          placeholder={allOption}
        />
      </div>

      {/* Tipos preferidos */}
      <div className="w-full sm:w-[170px]">
        <Text size="sm" weight="semibold" color="secondary" className="mb-1">
          {t('admin.workers.filters.profile.preferredType.label', { defaultValue: 'Tipo preferido' })}
        </Text>
        <Select
          inputSize="compact"
          options={preferredTypeOptions}
          value={filters.preferredType}
          onValueChange={(v) => onChange({ preferredType: v })}
          placeholder={allOption}
        />
      </div>

      {/* Idiomas */}
      <div className="w-full sm:w-[140px]">
        <Text size="sm" weight="semibold" color="secondary" className="mb-1">
          {t('admin.workers.filters.profile.language.label', { defaultValue: 'Idioma' })}
        </Text>
        <Select
          inputSize="compact"
          options={languageOptions}
          value={filters.language}
          onValueChange={(v) => onChange({ language: v })}
          placeholder={allOption}
        />
      </div>

      {/* Sexo */}
      <div className="w-full sm:w-[140px]">
        <Text size="sm" weight="semibold" color="secondary" className="mb-1">
          {t('admin.workers.filters.profile.sex.label', { defaultValue: 'Sexo' })}
        </Text>
        <Select
          inputSize="compact"
          options={sexOptions}
          value={filters.sex}
          onValueChange={(v) => onChange({ sex: v })}
          placeholder={allOption}
        />
      </div>

      {/* Provincia */}
      <div className="w-full sm:w-[160px]">
        <Text size="sm" weight="semibold" color="secondary" className="mb-1">
          {t('admin.workers.filters.profile.province.label', { defaultValue: 'Provincia' })}
        </Text>
        {/* Lista longa (catálogo do banco): combobox com busca — REQ-06, planning 26/08 */}
        <SearchableSelect
          inputSize="compact"
          options={stateOptions}
          value={filters.state}
          onChange={(v) => onChange({ state: v })}
          placeholder={allOption}
          searchPlaceholder={searchPh}
          data-testid="filter-province"
        />
      </div>

      {/* Localidad */}
      <div className="w-full sm:w-[160px]">
        <Text size="sm" weight="semibold" color="secondary" className="mb-1">
          {t('admin.workers.filters.profile.locality.label', { defaultValue: 'Localidad' })}
        </Text>
        <SearchableSelect
          inputSize="compact"
          options={cityOptions}
          value={filters.city}
          onChange={(v) => onChange({ city: v })}
          placeholder={allOption}
          searchPlaceholder={searchPh}
          data-testid="filter-locality"
        />
      </div>

      {/* Días */}
      <div className="w-full sm:w-[220px]">
        <Text size="sm" weight="semibold" color="secondary" className="mb-1">
          {t('admin.workers.filters.profile.days.label', { defaultValue: 'Días' })}
        </Text>
        <MultiSelect
          options={dayOptions}
          value={filters.days}
          onChange={(v) => onChange({ days: v })}
          placeholder={allOption}
          inputSize="compact"
        />
      </div>
    </div>
  );
}
