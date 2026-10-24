import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Combobox, type ComboboxOption } from '@presentation/components/atoms/Combobox';

export interface TimeRangeFilterProps {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}

/** Generates HH:MM options from 00:00 to 23:30 in 30-minute steps. */
function generateTimeOptions(): ComboboxOption[] {
  const options: ComboboxOption[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const label = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      options.push({ value: label, label });
    }
  }
  return options;
}

const TIME_OPTIONS: ComboboxOption[] = generateTimeOptions();

export function TimeRangeFilter({
  from,
  to,
  onFromChange,
  onToChange,
}: TimeRangeFilterProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div>
      <Text size="sm" weight="semibold" color="secondary" className="mb-1">
        {t('admin.vacancies.filters.time.label')}
      </Text>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          {/* 48 horários: combobox com busca ("14" filtra) — REQ-06 */}
          <Combobox
            inputSize="compact"
            options={TIME_OPTIONS}
            value={from}
            onChange={onFromChange}
            placeholder={t('admin.vacancies.filters.time.from')} clearLabel={t('admin.vacancies.filters.time.from')}
            searchPlaceholder={t('common.search', 'Buscar...')}
            data-testid="time-from"
          />
        </div>
        <Text as="span" size="sm" color="muted">
          –
        </Text>
        <div className="flex-1">
          <Combobox
            inputSize="compact"
            options={TIME_OPTIONS}
            value={to}
            onChange={onToChange}
            placeholder={t('admin.vacancies.filters.time.to')} clearLabel={t('admin.vacancies.filters.time.to')}
            searchPlaceholder={t('common.search', 'Buscar...')}
            data-testid="time-to"
          />
        </div>
      </div>
    </div>
  );
}
