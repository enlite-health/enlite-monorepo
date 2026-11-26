import { TFunction } from 'i18next';
import type { ComboboxOption } from '@presentation/components/atoms/Combobox';
import { SEMAPHORE_COLORS } from '@domain/value-objects/vacancySemaphore';
import { PATIENT_STATUSES } from '@domain/entities/patientEnums';

export const getStatsData = (t: TFunction) => [
  { label: t('admin.vacancies.stats.moreThan7Days'), value: '2', icon: 'clock' as const },
  { label: t('admin.vacancies.stats.moreThan24Days'), value: '20', icon: 'clock' as const },
  { label: t('admin.vacancies.stats.inSelection'), value: '44', icon: 'user-check' as const },
  { label: t('admin.vacancies.stats.totalVacancies'), value: '4,5h', icon: 'user-search' as const },
];

/** E7: filtro "Estado del paciente" — os estados do paciente, com os rótulos das colunas do Kanban de pacientes. */
export const getPatientStatusOptions = (t: TFunction): ComboboxOption[] =>
  PATIENT_STATUSES.map((s) => ({ value: s, label: t(`admin.patients.kanban.columns.${s}`) }));

/** semaforo-da-vaga F3: filtro "Semáforo" (lista de vagas e Kanban de pacientes) — as 3 cores do contrato, rótulo por i18n. */
export const getSemaphoreOptions = (t: TFunction): ComboboxOption[] =>
  SEMAPHORE_COLORS.map((c) => ({ value: c, label: t(`admin.semaphore.colors.${c}`) }));
