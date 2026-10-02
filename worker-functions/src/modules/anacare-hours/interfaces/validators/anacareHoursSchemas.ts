import { z } from 'zod';
import { CONTEST_NOTE_MAX_LENGTH, CONTEST_REASONS, VALIDATE_BATCH_MAX_SHIFTS } from '../../domain/AnaCareShift';

export const monthParamsSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
export const monthPatientParamsSchema = monthParamsSchema.extend({ patientId: z.string().min(1) });
export const shiftParamsSchema = z.object({ shiftId: z.string().min(1) });

// D4 (revisão de conformidade, 15/09): o filtro por paciente/prestador SHALL rodar só no
// CLIENTE (`selectors.ts` `filterPatients`) — nunca como query string pro backend (nome de
// paciente em URL/log é PII, regra dura do brief e do CLAUDE.md). `.strict()`: qualquer query
// (inclusive `patientSearch`/`providerId` de um cliente antigo) é 400 — silenciar o parâmetro em
// vez de rejeitar deixaria alguém achar que o filtro "funciona" no servidor quando nunca rodou lá.
export const monthQuerySchema = z.object({}).strict();

/** Spec 032 (D10): teto do período exportado, em dias corridos INCLUSIVOS (62 ok, 63 → 400). */
export const EXPORT_MAX_DAYS = 62;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` de calendário REAL (rejeita `2026-02-30`, que `Date.parse` aceitaria e rolaria p/ março). */
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });

const daysInclusive = (desde: string, hasta: string): number =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DAY_MS) + 1;

/**
 * Query da exportação do financeiro. `desde`/`hasta` são DATAS (não PII) e entram na trilha.
 * `.strict()` pelo mesmo racional de `monthQuerySchema`: parâmetro desconhecido é 400, nunca
 * ignorado em silêncio (não existe `variante`: a variante é única, "ambos").
 */
export const exportQuerySchema = z
  .object({ desde: isoDateSchema, hasta: isoDateSchema })
  .strict()
  .refine((q) => q.hasta >= q.desde, { message: 'hasta < desde', path: ['hasta'] })
  .refine((q) => q.hasta < q.desde || daysInclusive(q.desde, q.hasta) <= EXPORT_MAX_DAYS, {
    message: `período maior que ${EXPORT_MAX_DAYS} dias`,
    path: ['hasta'],
  });

export const patientParamsSchema = z.object({ patientId: z.string().min(1) });

export const validateBatchBodySchema = z.object({
  shiftIds: z.array(z.string().min(1)).min(1).max(VALIDATE_BATCH_MAX_SHIFTS),
});

export const contestShiftBodySchema = z.object({
  reason: z.enum(CONTEST_REASONS),
  note: z.string().trim().max(CONTEST_NOTE_MAX_LENGTH).optional(),
});

/**
 * Corpo opcional do disparo de sync (F4 continuação) — `month`/`cursor`/`budgetMs` retomam uma
 * rodada parcial.
 *
 * Gate `revisao-pr` (fecho 17/09): `runStartedAt` SAI deste schema de ENTRADA — o carimbo da
 * corrida (`anacare_sync_run`, migration 443) agora é resolvido pelo SERVIDOR
 * (`AnaCareHoursSyncRunner.resolveRunStartedAt`), nunca recebido do cliente. Três buracos medidos
 * no desenho anterior: (1) o Cloud Scheduler posta corpo fixo e nunca lia a resposta para reenviar
 * o campo — a detecção de colisão cross-invocação ficava DESLIGADA em produção; (2)
 * `z.string().datetime()` aceitava qualquer data, inclusive no futuro (desliga o detector) ou no
 * passado remoto (colide com tudo); (3) comparar `fetched_at` (NOW() do Postgres) contra um `Date`
 * calculado no Node sofria deriva de relógio entre processos. `runStartedAt` continua saindo na
 * RESPOSTA (`AnaCareHoursSyncOutcome.runStartedAt`) só para observabilidade.
 */
export const syncTriggerBodySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  cursor: z.number().int().min(0).nullable().optional(),
  budgetMs: z.number().int().positive().optional(),
});
