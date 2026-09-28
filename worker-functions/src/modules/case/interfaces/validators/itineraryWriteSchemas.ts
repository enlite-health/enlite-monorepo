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
