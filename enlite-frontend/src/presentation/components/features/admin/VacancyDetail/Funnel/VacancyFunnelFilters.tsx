import { useTranslation } from 'react-i18next';
import { Input } from '@presentation/components/atoms/Input';
import { Select } from '@presentation/components/atoms/Select';
import type { FunnelRowFilters, RegistrationFilter } from './funnelRowFilter';

interface VacancyFunnelFiltersProps {
  filters: FunnelRowFilters;
  onChange: (filters: FunnelRowFilters) => void;
}

export function VacancyFunnelFilters({
  filters,
  onChange,
}: VacancyFunnelFiltersProps): JSX.Element {
  const { t } = useTranslation();
  const prefix = 'admin.vacancyDetail.funnelTable';

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-[220px] max-w-md">
        <Input
          type="search"
          inputSize="dense"
          data-testid="funnel-filter-search"
          aria-label={t(`${prefix}.filters.searchLabel`)}
          placeholder={t(`${prefix}.filters.searchPlaceholder`)}
          value={filters.query}
          onChange={(e) => onChange({ ...filters, query: e.target.value })}
        />
      </div>
      <div className="w-full sm:w-52">
        <Select
          inputSize="dense"
          data-testid="funnel-filter-registration"
          aria-label={t(`${prefix}.filters.registrationLabel`)}
          value={filters.registration}
          onValueChange={(value) =>
            onChange({ ...filters, registration: value as RegistrationFilter })
          }
          options={[
            { value: 'ALL', label: t(`${prefix}.filters.registrationAll`) },
            { value: 'COMPLETE', label: t(`${prefix}.registration.complete`) },
            { value: 'INCOMPLETE', label: t(`${prefix}.registration.incomplete`) },
          ]}
        />
      </div>
    </div>
  );
}
