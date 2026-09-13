import { z } from 'zod';
import { containsLikelyPersonalData } from '@modules/identity/permissions';
import { CONTACT_REF_KINDS, THERAPEUTIC_CATALOG_KINDS, THERAPEUTIC_MODALITIES, type TherapeuticCatalogKind } from '../../domain/TherapeuticProject';

/** Teto de contatos/equipe por versão — espelha o `.max(20)` do contrato (lex #7, migration 429). */
export const THERAPEUTIC_CONTACT_REFS_MAX = 20;
export const THERAPEUTIC_CARE_TEAM_IDS_MAX = 20;

/**
 * `contactRefs`/`careTeamIds` (PR-7, contract `therapeutic-project.md` §alterado): só ids de linhas
 * ATIVAS do mesmo paciente — texto livre de contato não existe aqui (`.strict()` → 400). A
 * ativação/existência real é conferida no repositório (trigger 429), nunca no zod.
 */
const contactRefSchema = z
  .object({
    kind: z.enum(CONTACT_REF_KINDS),
    id: z.string().uuid(),
  })
  .strict();

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
    modality: z.enum(THERAPEUTIC_MODALITIES),
    diagnoses: z.array(diagnosisSchema).min(1).max(20),
    clinicalContext: z.string().trim().min(1).max(THERAPEUTIC_TEXT_MAX),
    generalObjective: z.string().trim().min(1).max(THERAPEUTIC_TEXT_MAX),
    specificObjectiveIds: z.array(z.string().uuid()).min(1).max(50),
    activityIds: z.array(z.string().uuid()).min(1).max(50),
    // Sem `pathologyTypeIds`: o tipo de patologia deriva dos `diagnoses` no servidor (D163/D164).
    startDate: z.string().regex(ISO_DATE),
    endDate: z.string().regex(ISO_DATE),
    // MICRO (D328/SUP-24): trocar a seleção de contato não pede versão nova nem trava em `mode:'edit'`.
    contactRefs: z.array(contactRefSchema).max(THERAPEUTIC_CONTACT_REFS_MAX).optional().default([]),
    careTeamIds: z.array(z.string().uuid()).max(THERAPEUTIC_CARE_TEAM_IDS_MAX).optional().default([]),
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

/**
 * `segmentId` (migration 430, US-17): filtro por segmento da Ana Care — só em `specific-objectives`/
 * `activities` (contract `therapeutic-project.md` §Catálogo de segmentos). O catálogo `segments`
 * NÃO recebe `segmentId` de si mesmo — por isso o campo entra por schema À PARTE, escolhido pelo
 * `kind` da ROTA (nunca do corpo), e `.strict()` recusa (400) quem mandar `segmentId` para `segments`.
 * `null` explícito limpa o vínculo; ausente não toca a coluna (Merge Patch, molde do resto do PATCH).
 */
const segmentIdField = z.string().uuid().nullable();

const createCatalogItemBase = {
  label: catalogLabel,
  sortOrder: z.number().int().min(0).max(100000).optional(),
};
export const createCatalogItemSchema = z.object(createCatalogItemBase).strict();
const createCatalogItemWithSegmentSchema = z.object({ ...createCatalogItemBase, segmentId: segmentIdField.optional() }).strict();

/** PATCH parcial: rótulo, ordem, e `active:false` para desativar (reativar também é permitido). */
const updateCatalogItemBase = {
  label: catalogLabel.optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
};
export const updateCatalogItemSchema = z.object(updateCatalogItemBase).strict().refine((b) => Object.keys(b).length > 0, { message: 'empty patch' });
const updateCatalogItemWithSegmentSchema = z
  .object({ ...updateCatalogItemBase, segmentId: segmentIdField.optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'empty patch' });

export type CreateCatalogItemBody = z.infer<typeof createCatalogItemWithSegmentSchema>;
export type UpdateCatalogItemBody = z.infer<typeof updateCatalogItemWithSegmentSchema>;

/** Schema de CRIAÇÃO pelo `kind` da rota (célula literal, D299.3) — só objetivos/atividades aceitam `segmentId`. */
export function createCatalogItemSchemaFor(kind: TherapeuticCatalogKind): typeof createCatalogItemSchema | typeof createCatalogItemWithSegmentSchema {
  return kind === 'segments' ? createCatalogItemSchema : createCatalogItemWithSegmentSchema;
}

/** Schema de PATCH pelo `kind` da rota — mesma régua do de criação. */
export function updateCatalogItemSchemaFor(kind: TherapeuticCatalogKind): typeof updateCatalogItemSchema | typeof updateCatalogItemWithSegmentSchema {
  return kind === 'segments' ? updateCatalogItemSchema : updateCatalogItemWithSegmentSchema;
}
