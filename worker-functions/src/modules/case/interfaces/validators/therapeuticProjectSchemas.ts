import { z } from 'zod';
import { containsLikelyPersonalData } from '@modules/identity/permissions';
import { CONTACT_REF_KINDS, THERAPEUTIC_CATALOG_KINDS, THERAPEUTIC_MODALITIES } from '../../domain/TherapeuticProject';
import { ICD_CATEGORY_CODE_PATTERN } from '../../domain/icdCategory';
import type { AdminCatalogKind } from '../../domain/serviceExitReason';
import { SHIFT_TEMPLATE_MAX_ITEMS } from '../../domain/serviceShiftTemplate';
import { CONTACT_STATUS_VALUES } from '../../domain/TherapeuticContactStatus';

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

/**
 * Estado explícito dos 4 campos de contato (spec 048): "Todavía no hay registro" (`PENDING`) / "No necesita"
 * (`NOT_NEEDED`). OBRIGATÓRIO no corpo, sem `.default`: `{}` explícito = "nenhum status"; ausente = 400 — lista
 * vazia já é ambígua ("nenhum" × "não veio", vazio ambíguo), então cliente antigo não apaga pendência em silêncio.
 */
const contactStatusSchema = z
  .object({
    RESPONSIBLE: z.enum(CONTACT_STATUS_VALUES).optional(),
    EXTERNAL: z.enum(CONTACT_STATUS_VALUES).optional(),
    COVERAGE: z.enum(CONTACT_STATUS_VALUES).optional(),
    CARE_TEAM: z.enum(CONTACT_STATUS_VALUES).optional(),
  })
  .strict();

/** Teto dos textos clínicos — espelha `ptp_clinical_context_len`/`ptp_general_objective_len` (migration 416, lex C6). */
export const THERAPEUTIC_TEXT_MAX = 4000;
/** Teto do rótulo de catálogo — espelha `<tabela>_label_len` (migration 415). */
export const CATALOG_LABEL_MAX = 200;
/** Teto do título de objetivos/atividades (spec 061) — só o zod; o CHECK do banco segue 200 (títulos antigos). */
export const CATALOG_TITLE_MAX = 150;
/** Teto da descrição de objetivos/atividades (spec 061) — espelha `<tabela>_description_len` (migration 547). */
export const CATALOG_DESCRIPTION_MAX = 1000;
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
const versionBodyShape = {
  contractedServiceId: z.string().uuid(),
  modality: z.enum(THERAPEUTIC_MODALITIES),
  diagnoses: z.array(diagnosisSchema).min(1).max(20),
  clinicalContext: z.string().trim().min(1).max(THERAPEUTIC_TEXT_MAX),
  generalObjective: z.string().trim().min(1).max(THERAPEUTIC_TEXT_MAX),
  // Sem `pathologyTypeIds`: o tipo de patologia deriva dos `diagnoses` no servidor (D163/D164).
  startDate: z.string().regex(ISO_DATE),
  endDate: z.string().regex(ISO_DATE),
  // MICRO (D328/SUP-24): trocar a seleção de contato não pede versão nova nem trava em `mode:'edit'`.
  contactRefs: z.array(contactRefSchema).max(THERAPEUTIC_CONTACT_REFS_MAX).optional().default([]),
  careTeamIds: z.array(z.string().uuid()).max(THERAPEUTIC_CARE_TEAM_IDS_MAX).optional().default([]),
  contactStatus: contactStatusSchema,
};

/** Um campo ou tem contatos escolhidos ou tem status — nunca os dois (spec 048). */
const noStatusWithContacts = (b: {
  contactRefs: { kind: string }[];
  careTeamIds: string[];
  contactStatus: Partial<Record<string, string>>;
}): boolean =>
  Object.keys(b.contactStatus).every((kind) =>
    b.contactStatus[kind] === undefined
      ? true
      : kind === 'CARE_TEAM'
        ? b.careTeamIds.length === 0
        : !b.contactRefs.some((r) => r.kind === kind),
  );
const STATUS_WITH_CONTACTS = { message: 'a contact field cannot have both contacts and a status', path: ['contactStatus'] };

const endNotBeforeStart = (b: { startDate: string; endDate: string }): boolean => b.endDate >= b.startDate;
const END_NOT_BEFORE_START = { message: 'endDate must be on or after startDate', path: ['endDate'] };

/** Objetivos/atividades do formato plano (versão antiga, só na edição): ids de catálogo, 1..50 (§9.4). */
const flatObjectivesShape = {
  specificObjectiveIds: z.array(z.string().uuid()).min(1).max(50),
  activityIds: z.array(z.string().uuid()).min(1).max(50),
};

/** Bloco de um diagnóstico (091): 0..50 ids — "vazio" só é válido sem catálogo (conferido no domínio, 422 nomeado). */
const diagnosisPlanSchema = z
  .object({
    diagnosisUri: z.string().min(1).max(500),
    specificObjectiveIds: z.array(z.string().uuid()).max(50),
    activityIds: z.array(z.string().uuid()).max(50),
  })
  .strict();
const diagnosisPlansField = z.array(diagnosisPlanSchema).min(1).max(20);

/** O conjunto de `diagnosisUri` dos blocos = o de `diagnoses[].uri`, sem repetição (400, §9.4). */
const plansMatchDiagnoses = (b: { diagnoses: { uri: string }[]; diagnosisPlans: { diagnosisUri: string }[] }): boolean => {
  const planUris = b.diagnosisPlans.map((p) => p.diagnosisUri);
  const diagUris = b.diagnoses.map((d) => d.uri);
  return new Set(planUris).size === planUris.length && new Set(diagUris).size === diagUris.length
    && planUris.length === diagUris.length && planUris.every((u) => diagUris.includes(u));
};
const PLANS_MATCH_DIAGNOSES = { message: 'diagnosisPlans must cover exactly the diagnoses, once each', path: ['diagnosisPlans'] };

const refinedBody = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine(endNotBeforeStart, END_NOT_BEFORE_START).refine(noStatusWithContacts, STATUS_WITH_CONTACTS);

/**
 * Corpo do "Editar": a forma-base + OU os ids planos OU os blocos por diagnóstico (união zod). Qual dos dois vale é do formato da
 * versão de origem (422 `ptp_format_mismatch` no repositório); `segmentId` não existe mais (`.strict()` → 400).
 */
const editFlatBodySchema = refinedBody(z.object({ ...versionBodyShape, ...flatObjectivesShape }).strict());
const editByDiagnosisBodySchema = refinedBody(z.object({ ...versionBodyShape, diagnosisPlans: diagnosisPlansField }).strict())
  .refine(plansMatchDiagnoses as (b: unknown) => boolean, PLANS_MATCH_DIAGNOSES);
const editVersionBodySchema = z.union([editFlatBodySchema, editByDiagnosisBodySchema]);

/** Corpo do "Novo" (091): a forma-base SEM ids planos/`segmentId` + `diagnosisPlans`; os rótulos são congelados no SERVIDOR, do catálogo do serviço. */
const newVersionBodySchema = refinedBody(z.object({ ...versionBodyShape, diagnosisPlans: diagnosisPlansField }).strict())
  .refine(plansMatchDiagnoses as (b: unknown) => boolean, PLANS_MATCH_DIAGNOSES);

/** `mode: 'new'` → major seguinte; `mode: 'edit'` → minor seguinte da versão de origem. */
export const createTherapeuticProjectSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('new'), version: newVersionBodySchema }).strict(),
  z.object({ mode: z.literal('edit'), fromVersionId: z.string().uuid(), version: editVersionBodySchema }).strict(),
]);
export type CreateTherapeuticProjectBody = z.infer<typeof createTherapeuticProjectSchema>;
export type TherapeuticProjectVersionBody = z.infer<typeof editVersionBodySchema>;

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
const catalogLabelWithMax = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((l) => !containsLikelyPersonalData(l), { message: 'label must not contain personal data' });
const catalogLabel = catalogLabelWithMax(CATALOG_LABEL_MAX);
/** Título de objetivos/atividades (spec 061): 150, só quando o corpo traz `label`. */
const catalogTitle = catalogLabelWithMax(CATALOG_TITLE_MAX);

/** Descrição (spec 061): texto livre do operador, mesma guarda de dado pessoal do rótulo. */
const catalogDescription = z
  .string()
  .trim()
  .min(1)
  .max(CATALOG_DESCRIPTION_MAX)
  .refine((d) => !containsLikelyPersonalData(d), { message: 'description must not contain personal data' });
/** PATCH: `''`/espaços = limpar (vira `null`); `null` limpa; ausente não toca. */
const catalogDescriptionPatch = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  catalogDescription.nullable().optional(),
);

/** Código do serviço contratado (spec 091, §9.4): maiúsculas, dígitos e `_`, até 40. */
const SERVICE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const serviceCodeField = z.string().regex(SERVICE_CODE_PATTERN).max(40);
/** Frequência sugerida da atividade (091): texto curto do operador, mesma guarda de dado pessoal; `null` limpa. */
const suggestedFrequencyField = catalogLabelWithMax(100).nullable();

const createCatalogItemBase = {
  label: catalogLabel,
  sortOrder: z.number().int().min(0).max(100000).optional(),
};
export const createCatalogItemSchema = z.object(createCatalogItemBase).strict();
const createObjectiveSchema = z
  .object({ ...createCatalogItemBase, label: catalogTitle, description: catalogDescription.optional(), serviceCode: serviceCodeField })
  .strict();
const createActivitySchema = z
  .object({
    ...createCatalogItemBase,
    label: catalogTitle,
    description: catalogDescription.optional(),
    objectiveId: z.string().uuid(),
    suggestedFrequency: suggestedFrequencyField.optional(),
  })
  .strict();

/** PATCH parcial: rótulo, ordem, e `active:false` para desativar (reativar também é permitido). */
const updateCatalogItemBase = {
  label: catalogLabel.optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
};
const notEmptyPatch = (b: object): boolean => Object.keys(b).length > 0;
const EMPTY_PATCH = { message: 'empty patch' };
export const updateCatalogItemSchema = z.object(updateCatalogItemBase).strict().refine(notEmptyPatch, EMPTY_PATCH);
const updateObjectiveSchema = z
  .object({ ...updateCatalogItemBase, label: catalogTitle.optional(), description: catalogDescriptionPatch, serviceCode: serviceCodeField.optional() })
  .strict()
  .refine(notEmptyPatch, EMPTY_PATCH);
const updateActivitySchema = z
  .object({
    ...updateCatalogItemBase,
    label: catalogTitle.optional(),
    description: catalogDescriptionPatch,
    objectiveId: z.string().uuid().optional(),
    suggestedFrequency: suggestedFrequencyField.optional(),
  })
  .strict()
  .refine(notEmptyPatch, EMPTY_PATCH);

export type CreateCatalogItemBody = z.infer<typeof createObjectiveSchema> | z.infer<typeof createActivitySchema>;
export type UpdateCatalogItemBody = z.infer<typeof updateObjectiveSchema> | z.infer<typeof updateActivitySchema>;

/** Schema por `kind` da rota (Strategy por tabela, sem if): `segmentId` não existe em nenhum (`.strict()` → 400, §9.4). */
const CREATE_SCHEMA_BY_KIND: Readonly<Partial<Record<AdminCatalogKind, z.ZodTypeAny>>> = {
  'specific-objectives': createObjectiveSchema,
  activities: createActivitySchema,
};
const UPDATE_SCHEMA_BY_KIND: Readonly<Partial<Record<AdminCatalogKind, z.ZodTypeAny>>> = {
  'specific-objectives': updateObjectiveSchema,
  activities: updateActivitySchema,
};

/** Schema de CRIAÇÃO pelo `kind` da rota (célula literal, D299.3); kind sem schema próprio (motivos de saída) usa o base. */
export function createCatalogItemSchemaFor(kind: AdminCatalogKind): z.ZodType<CreateCatalogItemBody | z.infer<typeof createCatalogItemSchema>> {
  return CREATE_SCHEMA_BY_KIND[kind] ?? createCatalogItemSchema;
}

/** Schema de PATCH pelo `kind` da rota — mesma régua do de criação. */
export function updateCatalogItemSchemaFor(kind: AdminCatalogKind): z.ZodType<UpdateCatalogItemBody | z.infer<typeof updateCatalogItemSchema>> {
  return UPDATE_SCHEMA_BY_KIND[kind] ?? updateCatalogItemSchema;
}

/** Query das listas (091): `includeInactive` e, por kind, `categoryCode` (4 chars) e `objectiveId`. Chave desconhecida é ignorada (como antes). */
const listQueryShape = {
  includeInactive: z.string().optional().transform((v) => v === 'true'),
  categoryCode: z.string().regex(ICD_CATEGORY_CODE_PATTERN).optional(),
  objectiveId: z.string().uuid().optional(),
};
const listQuerySchema = z.object(listQueryShape);
export type CatalogListQuery = z.infer<typeof listQuerySchema>;
export const parseCatalogListQuery = (query: unknown) => listQuerySchema.safeParse(query);

// ── Cascata e vínculos com categoria CID-11 (091, §9.4) ───────────────────────────────────

/** `POST /therapeutic-catalogs/cascade` (DD-10): URIs no corpo, nunca na query (não vão a log de URL). */
export const cascadeRequestSchema = z
  .object({
    serviceCode: serviceCodeField,
    diagnosisUris: z.array(z.string().min(1).max(500)).min(1).max(20),
  })
  .strict();
export type CascadeRequestBody = z.infer<typeof cascadeRequestSchema>;

/** `GET /therapeutic-catalogs/icd-categories?q=` — 2..100 após o trim. */
export const icdCategorySearchQuerySchema = z.object({ q: z.string().trim().min(2).max(100) });

/** `{ code }` do vínculo: a forma do código (4 chars) é checada pelo domínio → 422 `icd_category_invalid`, não 400. */
const linkCodeField = z.string().min(1).max(20);
export const categoryLinkBodySchema = z.object({ code: linkCodeField }).strict();
export const categoryLinkParamsSchema = z.object({ itemId: z.string().uuid(), code: linkCodeField });

// ── Guardias predefinidas (migration 550, spec 074) ──────────────────────────
/** Turno da guardia: início 'HH:MM' + duração em minutos (1..1440). A sobreposição é barrada no banco (422). */
export const shiftTemplateItemSchema = z
  .object({
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    durationMinutes: z.number().int().min(1).max(1440),
  })
  .strict();

export const createShiftTemplateSchema = z
  .object({
    label: catalogLabel,
    items: z.array(shiftTemplateItemSchema).min(1).max(SHIFT_TEMPLATE_MAX_ITEMS),
  })
  .strict();

export const updateShiftTemplateSchema = z
  .object({
    label: catalogLabel.optional(),
    active: z.boolean().optional(),
    items: z.array(shiftTemplateItemSchema).min(1).max(SHIFT_TEMPLATE_MAX_ITEMS).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'empty patch' });
export type CreateShiftTemplateBody = z.infer<typeof createShiftTemplateSchema>;
export type UpdateShiftTemplateBody = z.infer<typeof updateShiftTemplateSchema>;
