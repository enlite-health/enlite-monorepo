import { useTranslation } from 'react-i18next';
import { Combobox, type ComboboxOption } from '@presentation/components/atoms/Combobox';

interface JobFiltersProps {
  tipoValue: string;
  localValue: string;
  areaValue: string;
  sexoValue: string;
  onTipoChange: (value: string) => void;
  onLocalChange: (value: string) => void;
  onAreaChange: (value: string) => void;
  onSexoChange: (value: string) => void;
  tipoOptions: ComboboxOption[];
  localOptions: ComboboxOption[];
  areaOptions: ComboboxOption[];
  sexoOptions: ComboboxOption[];
}

export const JobFilters = ({
  tipoValue,
  localValue,
  areaValue,
  sexoValue,
  onTipoChange,
  onLocalChange,
  onAreaChange,
  onSexoChange,
  tipoOptions,
  localOptions,
  areaOptions,
  sexoOptions,
}: JobFiltersProps): JSX.Element => {
  const { t } = useTranslation();
  
  return (
    <div className="grid grid-cols-4 gap-4 w-full">
      <Combobox
        value={tipoValue}
        onChange={onTipoChange}
        options={tipoOptions}
        placeholder={t('jobs.filterLabels.jobTypes')}
        aria-label={t('jobs.filterLabels.jobTypes')}
      />
      <Combobox
        value={localValue}
        onChange={onLocalChange}
        options={localOptions}
        placeholder={t('jobs.filterLabels.workLocations')}
        aria-label={t('jobs.filterLabels.workLocations')}
      />
      <Combobox
        value={areaValue}
        onChange={onAreaChange}
        options={areaOptions}
        placeholder={t('jobs.filterLabels.areas')}
        aria-label={t('jobs.filterLabels.areas')}
      />
      <Combobox
        value={sexoValue}
        onChange={onSexoChange}
        options={sexoOptions}
        placeholder={t('jobs.filterLabels.gender')}
        aria-label={t('jobs.filterLabels.gender')}
      />
    </div>
  );
};
