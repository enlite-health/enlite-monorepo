/** Data e hora de um instante no relógio de parede do fuso (sem depender do navegador). */
import { wallClockIn } from '../../PatientDetail/admission/admissionTime';
import { OPERATION_TIME_ZONE } from '@presentation/utils/dateTimeFormat';

/** "2026-10-16T14:00" → ["16/10", "14:00"]. Instante inválido → [iso, '']. */
export function dateAndTime(iso: string, timeZone: string): [string, string] {
  const wall = wallClockIn(iso, timeZone);
  if (!wall) return [iso, ''];
  const [date, time] = wall.split('T');
  const [, month, day] = date.split('-');
  return [`${day}/${month}`, time];
}

/** "16/10 14:00" — a etiqueta "Convocado · …" do card, no fuso do operador (Argentina). */
export function convocationLabel(iso: string): string {
  const [date, time] = dateAndTime(iso, OPERATION_TIME_ZONE);
  return `${date} ${time}`;
}
