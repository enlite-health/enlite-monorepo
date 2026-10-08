/**
 * Datas do "Todavía no hay registro" (spec 048) — civis, em `YYYY-MM-DD`, sem fuso próprio: o dia "de hoje" vem de
 * `todayInOperationZone` (a mesma régua do formulário) e o vencimento de um campo JÁ pendente vem do servidor
 * (`deadlineDate`, dia local do país). Aqui só se soma dias e se formata.
 */
import { CONTACT_PENDING_DEADLINE_DAYS, CONTACT_REMINDER_DAY_OFFSETS } from '@domain/entities/TherapeuticProject';
import { formatIsoDateEsAr } from './pdf/therapeuticProjectPdfInput';

/** Soma `days` a uma data civil `YYYY-MM-DD` (aritmética em UTC: sem horário de verão no meio). */
export function addCivilDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Vencimento de um campo que fica pendente HOJE: hoje + 15 dias. */
export function newPendingDeadline(today: string): string {
  return addCivilDays(today, CONTACT_PENDING_DEADLINE_DAYS);
}

/** Datas dos 3 lembretes de um ciclo que abre hoje: hoje + 2, + 5 e + 12. */
export function newCycleReminderDates(today: string): string[] {
  return CONTACT_REMINDER_DAY_OFFSETS.map((n) => addCivilDays(today, n));
}

/** `DD/MM` para o texto curto ("vence el 23/10"). */
export function dayMonth(iso: string): string {
  return (formatIsoDateEsAr(iso) ?? iso).slice(0, 5);
}
