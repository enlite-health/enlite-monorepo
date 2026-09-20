import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { SearchInput } from '@presentation/components/molecules/SearchBar/SearchInput';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import { Select, SelectOption } from '@presentation/components/atoms/Select';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { TimeRangeFilter } from './TimeRangeFilter';
import { useContainerAccess } from '@presentation/hooks/useCellAccess';

export interface VacancyAdvancedFilters {
  workerType: string;
  state: string;
  city: string;
  requiredSex: string;
  days: string[];
  timeFrom: string;
  timeTo: string;
}

interface VacancyFiltersProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  selectedStatus: string;
  onStatusChange: (value: string) => void;
  selectedPriority: string;
  onPriorityChange: (value: string) => void;
  statusOptions: SelectOption[];
  priorityOptions: SelectOption[];
  // advanced filters
  advancedFilters: VacancyAdvancedFilters;
  onAdvancedChange: (updates: Partial<VacancyAdvancedFilters>) => void;
  stateOptions: SelectOption[];
  cityOptions: SelectOption[];
}

export function VacancyFilters({
  searchQuery,
  onSearchChange,
  selectedStatus,
  onStatusChange,
  selectedPriority,
  onPriorityChange,
  statusOptions,
  priorityOptions,
  advancedFilters,
  onAdvancedChange,
  stateOptions,
  cityOptions,
}: VacancyFiltersProps): JSX.Element {
  const { t } = useTranslation();
  const podeBuscarPorNome = useContainerAccess('patient_identity').visible;

  const typeOptions: SelectOption[] = [
    { value: 'AT', label: t('admin.vacancies.filters.type.at') },
    { value: 'CAREGIVER', label: t('admin.vacancies.filters.type.caregiver') },
  ];

  const sexOptions: SelectOption[] = [
    { value: 'F', label: t('admin.vacancies.filters.sex.f') },
    { value: 'M', label: t('admin.vacancies.filters.sex.m') },
    { value: 'BOTH', label: t('admin.vacancies.filters.sex.both') },
  ];

  // 0=domingo,1=lunes,...,6=sábado — order: lun..dom to match UX convention
  const dayOptions: SelectOption[] = [
    { value: '1', label: t('admin.vacancyDetail.vacancyForm.days.lun') },
    { value: '2', label: t('admin.vacancyDetail.vacancyForm.days.mar') },
    { value: '3', label: t('admin.vacancyDetail.vacancyForm.days.mie') },
    { value: '4', label: t('admin.vacancyDetail.vacancyForm.days.jue') },
    { value: '5', label: t('admin.vacancyDetail.vacancyForm.days.vie') },
    { value: '6', label: t('admin.vacancyDetail.vacancyForm.days.sab') },
    { value: '0', label: t('admin.vacancyDetail.vacancyForm.days.dom') },
  ];

  const hasAnyFilter =
    searchQuery !== '' ||
    selectedStatus !== '' ||
    selectedPriority !== '' ||
    advancedFilters.workerType !== '' ||
    advancedFilters.state !== '' ||
    advancedFilters.city !== '' ||
    advancedFilters.requiredSex !== '' ||
    advancedFilters.days.length > 0 ||
    advancedFilters.timeFrom !== '' ||
    advancedFilters.timeTo !== '';

  const handleClearAll = () => {
    onSearchChange('');
    onStatusChange('');
    onPriorityChange('');
    onAdvancedChange({
      workerType: '',
      state: '',
      city: '',
      requiredSex: '',
      days: [],
      timeFrom: '',
      timeTo: '',
    });
  };

  return (
    <div className="bg-white rounded-b-[20px] border-r-2 border-b-2 border-l-2 border-[#D9D9D9] px-7 py-6">
      {/* Row 1: search + status + priority */}
      <div className="flex items-end gap-4 flex-wrap">
        <SearchInput
          value={searchQuery}
          onChange={onSearchChange}
          // D286 fase 2 / lex P5: sem patient_identity:read a busca não casa nome de paciente — o
          // placeholder diz o que ela faz de verdade.
          placeholder={t(podeBuscarPorNome ? 'admin.vacancies.searchPlaceholder' : 'admin.vacancies.searchPlaceholderSemNome')}
          className="w-full sm:w-[400px]"
        />
        <div className="flex items-end gap-4 flex-wrap ml-auto">
          <div className="w-full sm:w-[200px]">
            <Text size="sm" weight="semibold" color="secondary" className="mb-1">
              {t('admin.vacancies.statusLabel')}
            </Text>
            <Select
              inputSize="compact"
              options={statusOptions}
              value={selectedStatus}
              onValueChange={onStatusChange}
              placeholder={t('admin.vacancies.statusOptions.all')}
            />
          </div>
          <div className="w-full sm:w-[200px]">
            <Text size="sm" weight="semibold" color="secondary" className="mb-1">
              {t('admin.vacancies.priorityLabel')}
            </Text>
            <Select
              inputSize="compact"
              options={priorityOptions}
              value={selectedPriority}
              onValueChange={onPriorityChange}
              placeholder={t('admin.vacancies.priorityOptions.all')}
            />
          </div>
        </div>
      </div>

      {/* Row 2: advanced filters */}
      <div className="flex items-end gap-4 flex-wrap mt-4">
        <div className="w-full sm:w-[160px]">
          <Text size="sm" weight="semibold" color="secondary" className="mb-1">
            {t('admin.vacancies.filters.type.label')}
          </Text>
          <Select
            inputSize="compact"
            options={typeOptions}
            value={advancedFilters.workerType}
            onValueChange={(v) => onAdvancedChange({ workerType: v })}
            placeholder={t('admin.vacancies.filters.allOption')}
          />
        </div>

        <div className="w-full sm:w-[160px]">
          <Text size="sm" weight="semibold" color="secondary" className="mb-1">
            {t('admin.vacancies.filters.province.label')}
          </Text>
          {/* Lista longa (catálogo do banco): combobox com busca — REQ-06, planning 26/08 */}
          <SearchableSelect
            inputSize="compact"
            options={stateOptions}
            value={advancedFilters.state}
            onChange={(v) => onAdvancedChange({ state: v })}
            placeholder={t('admin.vacancies.filters.allOption')}
            searchPlaceholder={t('common.search', 'Buscar...')}
            data-testid="vacancy-filter-province"
          />
        </div>

        <div className="w-full sm:w-[160px]">
          <Text size="sm" weight="semibold" color="secondary" className="mb-1">
            {t('admin.vacancies.filters.locality.label')}
          </Text>
          <SearchableSelect
            inputSize="compact"
            options={cityOptions}
            value={advancedFilters.city}
            onChange={(v) => onAdvancedChange({ city: v })}
            placeholder={t('admin.vacancies.filters.allOption')}
            searchPlaceholder={t('common.search', 'Buscar...')}
            data-testid="vacancy-filter-locality"
          />
        </div>

        <div className="w-full sm:w-[160px]">
          <Text size="sm" weight="semibold" color="secondary" className="mb-1">
            {t('admin.vacancies.filters.sex.label')}
          </Text>
          <Select
            inputSize="compact"
            options={sexOptions}
            value={advancedFilters.requiredSex}
            onValueChange={(v) => onAdvancedChange({ requiredSex: v })}
            placeholder={t('admin.vacancies.filters.allOption')}
          />
        </div>

        <div className="w-full sm:w-[220px]">
          <Text size="sm" weight="semibold" color="secondary" className="mb-1">
            {t('admin.vacancies.filters.days.label')}
          </Text>
          <MultiSelect
            options={dayOptions}
            value={advancedFilters.days}
            onChange={(v) => onAdvancedChange({ days: v })}
            placeholder={t('admin.vacancies.filters.allOption')}
            inputSize="compact"
          />
        </div>

        <div className="w-full sm:w-[280px]">
          <TimeRangeFilter
            from={advancedFilters.timeFrom}
            to={advancedFilters.timeTo}
            onFromChange={(v) => onAdvancedChange({ timeFrom: v })}
            onToChange={(v) => onAdvancedChange({ timeTo: v })}
          />
        </div>

        {hasAnyFilter && (
          <button
            type="button"
            onClick={handleClearAll}
            className="h-12 px-4 rounded-[10px] border-[1.5px] border-[#D9D9D9] bg-white hover:bg-gray-50 transition-colors self-end"
          >
            <Text as="span" size="sm" weight="medium" color="muted">
              {t('admin.vacancies.filters.clear')}
            </Text>
          </button>
        )}
      </div>
    </div>
  );
}
