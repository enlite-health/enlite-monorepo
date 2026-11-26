import { TFunction } from 'i18next';
import type { ComboboxOption } from '@presentation/components/atoms/Combobox';
import { CICLOS_DE_VIDA } from '@domain/value-objects/vacancyLifecycle';
import { PATIENT_STATUSES } from '@domain/entities/patientEnums';

export const getStatsData = (t: TFunction) => [
  { label: t('admin.vacancies.stats.moreThan7Days'), value: '2', icon: 'clock' as const },
  { label: t('admin.vacancies.stats.moreThan24Days'), value: '20', icon: 'clock' as const },
  { label: t('admin.vacancies.stats.inSelection'), value: '44', icon: 'user-check' as const },
  { label: t('admin.vacancies.stats.totalVacancies'), value: '4,5h', icon: 'user-search' as const },
];

/** E7: filtro "Ciclo de vida" — os 5 valores do dono (`vacancyLifecycle`); o rótulo é o mesmo do badge. */
export const getLifecycleOptions = (t: TFunction): ComboboxOption[] =>
  CICLOS_DE_VIDA.map((c) => ({ value: c, label: t(`admin.vacancyDetail.lifecycle.${c}`) }));

/** E7: filtro "Estado del paciente" — os estados do paciente, com os rótulos das colunas do Kanban de pacientes. */
export const getPatientStatusOptions = (t: TFunction): ComboboxOption[] =>
  PATIENT_STATUSES.map((s) => ({ value: s, label: t(`admin.patients.kanban.columns.${s}`) }));
