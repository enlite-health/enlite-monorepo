import { z } from 'zod';
import { containsLikelyPersonalData } from '@modules/identity/permissions';
import { THERAPEUTIC_CATALOG_KINDS } from '../../domain/TherapeuticProject';

/** Teto dos textos clínicos — espelha `ptp_clinical_context_len`/`ptp_general_objective_len` (migration 416, lex C6). */
export const THERAPEUTIC_TEXT_MAX = 4000;
/** Teto do rótulo de catálogo — espelha `<tabela>_label_len` (migration 415). */
export const CATALOG_LABEL_MAX = 200;
/** Teto do motivo de anulação — espelha `ptp_annul_reason_len` (416). Rótulo, nunca dado do titular. */
export const ANNUL_REASON_MAX = 200;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * O que o operador ESCOLHEU no combobox de CID-11 — snapshot (lex C19: `.strict()`, nada além
 * dos três campos entra congelado na versão). Só CID, sem texto livre (Gabriel, 08/09, Q5).
 */
const diagnosisSchema = z
  .object({
    uri: z.string().min(1).max(500),
    // O painel NÃO conhece o código (REQ-21: a projeção pública do CID esconde `code`); fica opcional.
    code: z.string().max(50).optional(),
    title: z.string().min(1).max(500),
  })
  .strict();

/**
 * O corpo do "Novo" e do "Editar": só IDs dos catálogos — o snapshot `{ id, label }` é montado no
 * SERVIDOR a partir da tabela (lex C19), nunca vem do cliente. Sem `major`/`minor`: a numeração
 * é do domínio (`nextMajor`/`nextMinorOf`).
 */
const versionBodySchema = z
  .object({
    contractedServiceId: z.string().uuid(),
    diagnoses: z.array(diagnosisSchema).min(1).max(20),
    clinicalContext: z.string().trim().min(1).max(THERAPEUTIC_TEXT_MAX),
    generalObjective: z.string().trim().min(1).max(THERAPEUTIC_TEXT_MAX),
    specificObjectiveIds: z.array(z.string().uuid()).min(1).max(50),
    activityIds: z.array(z.string().uuid()).min(1).max(50),
    pathologyTypeIds: z.array(z.string().uuid()).min(1).max(20),
    startDate: z.string().regex(ISO_DATE),
    endDate: z.string().regex(ISO_DATE),
  })
  .strict()
  .refine((b) => b.endDate >= b.startDate, { message: 'endDate must be on or after startDate', path: ['endDate'] });

/** `mode: 'new'` → major seguinte; `mode: 'edit'` → minor seguinte da versão de origem. */
export const createTherapeuticProjectSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('new'), version: versionBodySchema }).strict(),
  z.object({ mode: z.literal('edit'), fromVersionId: z.string().uuid(), version: versionBodySchema }).strict(),
]);
export type CreateTherapeuticProjectBody = z.infer<typeof createTherapeuticProjectSchema>;
export type TherapeuticProjectVersionBody = z.infer<typeof versionBodySchema>;

/** Anulação (lex C5): motivo curto, sem dado de pessoa — é rótulo administrativo, não texto clínico. */
export const annulTherapeuticProjectSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(ANNUL_REASON_MAX)
      .refine((r) => !containsLikelyPersonalData(r), { message: 'reason must not contain personal data' }),
  })
  .strict();

// ── Catálogos ─────────────────────────────────────────────────────────────────────────────

export const catalogKindSchema = z.enum(THERAPEUTIC_CATALOG_KINDS as unknown as [string, ...string[]]);

/**
 * Rótulo de catálogo: texto livre do operador que vira lista GLOBAL (AR e BR). A guarda de dado
 * pessoal (lex C18) é a mesma do motivo de concessão de país — e-mail ou sequência longa de
 * dígitos não passam; o teto espelha o CHECK da 415.
 */
const catalogLabel = z
  .string()
  .trim()
  .min(1)
  .max(CATALOG_LABEL_MAX)
  .refine((l) => !containsLikelyPersonalData(l), { message: 'label must not contain personal data' });

export const createCatalogItemSchema = z
  .object({
    label: catalogLabel,
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

/** PATCH parcial: rótulo, ordem, e `active:false` para desativar (reativar também é permitido). */
export const updateCatalogItemSchema = z
  .object({
    label: catalogLabel.optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'empty patch' });
export type CreateCatalogItemBody = z.infer<typeof createCatalogItemSchema>;
export type UpdateCatalogItemBody = z.infer<typeof updateCatalogItemSchema>;
