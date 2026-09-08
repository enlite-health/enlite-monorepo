import type { ContractedServiceScheduleSlot } from '@domain/entities/PatientContractedService';
import { jsonbToSchedule } from '@presentation/components/features/admin/vacancy-form-schema';
import { serializeSchedule } from '@presentation/components/features/admin/vacancyScheduleUtils';

/**
 * Horário do encuadre em texto ("Lunes, Miércoles 08:00-12:00 | Viernes 14:00-18:00") — a MESMA
 * serialização que a vaga usa (`jsonbToSchedule` + `serializeSchedule`), porque o serviço guarda o
 * mesmo array que `job_postings.schedule` (migration 330). `null` quando não há horário — quem
 * chama decide o rótulo ("Sin horario") por i18n.
 */
export function contractedServiceScheduleText(schedule: ContractedServiceScheduleSlot[] | null): string | null {
  if (!schedule || schedule.length === 0) return null;
  const text = serializeSchedule(jsonbToSchedule(schedule));
  return text.length > 0 ? text : null;
}
