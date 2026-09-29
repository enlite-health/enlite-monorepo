import { z } from 'zod';
import { HHMM } from '../../domain/ItinerarySchedule';

/**
 * itineraryWriteSchemas — a borda dos 7 escritores do itinerário (Fase 11, DX-11.10). Zod valida
 * só FORMA (uuid, `HH:MM`, dia 0-6, fim > início); toda regra de negócio (endereço, chave já
 * ativa, Selecionado (C), sobreposição) é do caso de uso — nunca duplicada aqui. O regex `HHMM` é
 * IMPORTADO de `ItinerarySchedule.ts` (a mesma trava da 2ª camada, DX-7.x) — nunca copiado.
 */

export const itineraryPatientParamsSchema = z.object({ id: z.string().uuid() });

export const itineraryServiceParamsSchema = z.object({ id: z.string().uuid(), sid: z.string().uuid() });

export const itinerarySlotParamsSchema = itineraryServiceParamsSchema.extend({ slotId: z.string().uuid() });

export const itineraryAllocationParamsSchema = itineraryServiceParamsSchema.extend({ allocationId: z.string().uuid() });

// NÃO reusa `scheduleSlotSchema` (`contractedServiceSchemas.ts:19-26`): a forma NÃO é idêntica — o
// campo do dia aqui é `weekday` (nome do body desta rota, DX-11.10), lá é `dayOfWeek`; e lá é
// `.strict()`, aqui não. Gate parcial #10 (D2): renomear um dos dois mudaria contrato externo já
// publicado (OpenAPI desta rota ou do form de serviço) — fora do escopo deste achado.
export const itinerarySlotBodySchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startTime: z.string().regex(HHMM),
    endTime: z.string().regex(HHMM),
  })
  .refine((body) => body.endTime > body.startTime, { message: 'endTime must be after startTime' });

export type ItinerarySlotBody = z.infer<typeof itinerarySlotBodySchema>;

export const itineraryAllocationBodySchema = z.object({ workerId: z.string().uuid() });

export type ItineraryAllocationBody = z.infer<typeof itineraryAllocationBodySchema>;

// ── Substituição pontual (Fase 13, DX-13.8) ──────────────────────────────────────────────────

export const itineraryAbsenceParamsSchema = itineraryServiceParamsSchema.extend({ absenceId: z.string().uuid() });

// Achado C2 (veredito parcial-1): `date` só com regex deixava passar calendário inexistente
// (ex.: `2026-02-31`) — o `$2::date` do Postgres rejeitava (22008) e virava 500 genérico em vez de
// 400. Round-trip em `Date.UTC` (mesmo padrão de `isValidIsoBirthDate.ts:25-32`, sem a restrição
// "não-futura" — ausência é sempre futura ou passada, controlada pelo caso de uso, nunca aqui).
function isRealCalendarDate(value: string): boolean {
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const itineraryAbsenceBodySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealCalendarDate, { message: 'date must be a real calendar date' }),
  substituteWorkerId: z.string().uuid().optional(),
});

export type ItineraryAbsenceBody = z.infer<typeof itineraryAbsenceBodySchema>;

// A chave é OBRIGATÓRIA e o `null` é explícito — corpo sem a chave é 400 (memória
// `vazio-ambiguo-nao-e-informacao-de-ausencia`: "tirar o substituto" ≠ "não mexi no substituto").
export const itinerarySubstituteBodySchema = z.object({ substituteWorkerId: z.union([z.string().uuid(), z.null()]) });

export type ItinerarySubstituteBody = z.infer<typeof itinerarySubstituteBodySchema>;

// ── Reemplazo permanente (D445.5) ────────────────────────────────────────────────────────────

export const itineraryReplaceBodySchema = z.object({
  newWorkerId: z.string().uuid(),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealCalendarDate, { message: 'fromDate must be a real calendar date' }),
});

export type ItineraryReplaceBody = z.infer<typeof itineraryReplaceBodySchema>;
