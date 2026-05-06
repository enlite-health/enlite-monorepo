import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { SearchInput } from '@presentation/components/molecules/SearchBar/SearchInput';
import { SelectField, SelectOption } from '@presentation/components/molecules/SelectField';

interface VacancyFiltersProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  selectedClient: string;
  onClientChange: (value: string) => void;
  selectedStatus: string;
  onStatusChange: (value: string) => void;
  selectedPriority: string;
  onPriorityChange: (value: string) => void;
  clientOptions: SelectOption[];
  statusOptions: SelectOption[];
  priorityOptions: SelectOption[];
}

export function VacancyFilters({
  searchQuery,
  onSearchChange,
  selectedClient,
  onClientChange,
  selectedStatus,
  onStatusChange,
  selectedPriority,
  onPriorityChange,
  clientOptions,
  statusOptions,
  priorityOptions,
}: VacancyFiltersProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="bg-white rounded-b-[20px] border-r-2 border-b-2 border-l-2 border-[#D9D9D9] flex items-center px-7 py-6 gap-4 flex-wrap">
      <SearchInput
        value={searchQuery}
        onChange={onSearchChange}
        placeholder={t('admin.vacancies.searchPlaceholder')}
        className="w-full sm:w-[400px]"
      />
      <div className="flex items-end gap-4 flex-wrap ml-auto">
        <div className="w-full sm:w-[200px]">
          <Text size="base" weight="semibold" color="secondary" className="mb-1">
            {t('admin.vacancies.clients')}
          </Text>
          <SelectField
            options={clientOptions}
            value={selectedClient}
            onChange={onClientChange}
            placeholder={t('admin.vacancies.clientPlaceholder')}
          />
        </div>
        <div className="w-full sm:w-[200px]">
          <Text size="base" weight="semibold" color="secondary" className="mb-1">
            {t('admin.vacancies.statusLabel')}
          </Text>
          <SelectField
            options={statusOptions}
            value={selectedStatus}
            onChange={onStatusChange}
            placeholder={t('admin.vacancies.statusPlaceholder')}
          />
        </div>
        <div className="w-full sm:w-[200px]">
          <Text size="base" weight="semibold" color="secondary" className="mb-1">
            {t('admin.vacancies.priorityLabel')}
          </Text>
          <SelectField
            options={priorityOptions}
            value={selectedPriority}
            onChange={onPriorityChange}
            placeholder={t('admin.vacancies.priorityOptions.all')}
          />
        </div>
      </div>
    </div>
  );
}
