import { TFunction } from 'i18next';
import { SelectOption } from '@presentation/components/atoms/Select';

export const getStatsData = (t: TFunction) => [
  { label: t('admin.vacancies.stats.moreThan7Days'), value: '2', icon: 'clock' as const },
  { label: t('admin.vacancies.stats.moreThan24Days'), value: '20', icon: 'clock' as const },
  { label: t('admin.vacancies.stats.inSelection'), value: '44', icon: 'user-check' as const },
  { label: t('admin.vacancies.stats.totalVacancies'), value: '4,5h', icon: 'user-search' as const },
];

export const getStatusOptions = (t: TFunction): SelectOption[] => [
  { value: 'SEARCHING',             label: t('admin.vacancies.statusOptions.searching') },
  { value: 'SEARCHING_REPLACEMENT', label: t('admin.vacancies.statusOptions.searchingReplacement') },
  { value: 'RAPID_RESPONSE',        label: t('admin.vacancies.statusOptions.rapidResponse') },
  { value: 'PENDING_ACTIVATION',    label: t('admin.vacancies.statusOptions.pendingActivation') },
  { value: 'ACTIVE',                label: t('admin.vacancies.statusOptions.active') },
  { value: 'ON_HOLD',               label: t('admin.vacancies.statusOptions.onHold') },
  { value: 'SUSPENDED',             label: t('admin.vacancies.statusOptions.suspended') },
  { value: 'CLOSED',                label: t('admin.vacancies.statusOptions.closed') },
];

export const getPriorityOptions = (t: TFunction): SelectOption[] => [
  { value: 'URGENT', label: t('admin.vacancies.priorityOptions.urgent') },
  { value: 'HIGH',   label: t('admin.vacancies.priorityOptions.high') },
  { value: 'NORMAL', label: t('admin.vacancies.priorityOptions.normal') },
  { value: 'LOW',    label: t('admin.vacancies.priorityOptions.low') },
];
