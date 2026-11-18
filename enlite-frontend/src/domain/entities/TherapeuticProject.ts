/**
 * Projeto Terapêutico do paciente — o que a API devolve e o que o painel manda (spec 017, D299).
 *
 * Uma linha por VERSÃO `major.minor`, imutável: "Novo" cria a major seguinte, "Editar" cria a minor
 * seguinte da versão de origem. O painel nunca manda `major`/`minor`: a numeração é do servidor.
 * `clinicalContext`, `generalObjective` e `diagnoses` chegam `null` com `redacted.clinical` quando o
 * ator não tem `patient_clinical:read` (lex C7) — a tela mostra o rótulo de redigido, nunca vazio.
 */

export interface TherapeuticDiagnosis {
  uri: string;
  /** Opcional: o combobox do painel não expõe o código (REQ-21). */
  code?: string;
  title: string;
}

export interface CatalogSnapshotItem {
  id: string;
  label: string;
}

/**
 * Item de objetivo/atividade no snapshot da versão FLAT (formato antigo) — espelho de
 * `TherapeuticCatalogSnapshotItem` do backend. `segmentId`/`segmentLabel` são LEGADO (migration 430):
 * versão antiga pode trazê-los congelados; versão nova (091) não grava segmento.
 */
export interface TherapeuticCatalogSnapshotItem extends CatalogSnapshotItem {
  segmentId?: string | null;
  segmentLabel?: string | null;
  /** Só o catálogo de motivos de saída tem: identificador estável que as marcas referenciam. */
  code?: string;
  /** Spec 061: descrição congelada com a versão; ausente em versão antiga ou item sem descrição. */
  description?: string | null;
}

export const THERAPEUTIC_MODALITIES = ['IN_PERSON', 'ONLINE', 'HYBRID'] as const;
export type TherapeuticModality = (typeof THERAPEUTIC_MODALITIES)[number];

/** Contato por SELEÇÃO (PR-7, lex #7 C1-C6) — espelho de `ContactRef` do backend. */
export const CONTACT_REF_KINDS = ['RESPONSIBLE', 'EXTERNAL', 'COVERAGE'] as const;
export type ContactRefKind = (typeof CONTACT_REF_KINDS)[number];
export interface ContactRef {
  kind: ContactRefKind;
  id: string;
}

export type ResolvedTherapeuticContactKind = ContactRefKind | 'CARE_TEAM';

/**
 * O que a LEITURA devolve por contato (lex #7 C5): resolvido (nome/telefone) | inativo (contato
 * desativado, nunca resolve nome/telefone) | redigido (sem a célula de origem). Espelho de
 * `ResolvedTherapeuticContact` do backend — a tela nunca inventa nome/telefone fora daqui.
 */
export type ResolvedTherapeuticContact =
  | { kind: ResolvedTherapeuticContactKind; id: string; name: string; phone: string | null; relation?: string; specialty?: string }
  | { kind: ResolvedTherapeuticContactKind; id: string; inactive: true }
  | { kind: ResolvedTherapeuticContactKind; id: string; redacted: true };

/**
 * Estado explícito dos 4 campos de contato (spec 048): `PENDING` = "Todavía no hay registro" (prazo de 15 dias),
 * `NOT_NEEDED` = "No necesita" (só o Acesso Master escolhe). Campo sem entrada = tem contatos ou nada informado.
 */
export const CONTACT_STATUS_KINDS = ['RESPONSIBLE', 'EXTERNAL', 'COVERAGE', 'CARE_TEAM'] as const;
export type ContactStatusKind = (typeof CONTACT_STATUS_KINDS)[number];
export type ContactStatusValue = 'PENDING' | 'NOT_NEEDED';
export type ContactStatusMap = Partial<Record<ContactStatusKind, ContactStatusValue>>;

/** Como a API devolve (sem uid de quem marcou). `deadlineDate`: `YYYY-MM-DD` = dia local de `pendingSince` + 15. */
export interface ContactStatusEntry {
  kind: ContactStatusKind;
  status: ContactStatusValue;
  pendingSince: string | null;
  deadlineDate: string | null;
}

/** Dias de prazo do campo pendente e dos lembretes — espelho de `TherapeuticContactStatus.ts` do backend. */
export const CONTACT_PENDING_DEADLINE_DAYS = 15;
export const CONTACT_REMINDER_DAY_OFFSETS = [2, 5, 12] as const;

export interface TherapeuticProjectVersion {
  id: string;
  patientId: string;
  major: number;
  minor: number;
  /** `V.M.m` — o rótulo da tela e do PDF. */
  version: string;
  editedFromVersionId: string | null;
  contractedServiceId: string;
  /** `service_code` CONGELADO na versão (417). `null` sem `patient_services:read` (lex A1: é dado do container de serviços). */
  contractedServiceCode: string | null;
  /** Modalidade (D301, Ana 08/09): presencial, on-line ou híbrida. `null` só em versão anterior à 417. */
  modality: TherapeuticModality | null;
  diagnoses: TherapeuticDiagnosis[] | null;
  clinicalContext: string | null;
  generalObjective: string | null;
  specificObjectives: TherapeuticCatalogSnapshotItem[];
  activities: TherapeuticCatalogSnapshotItem[];
  /**
   * "Tipo de patología (segmento)" — DERIVADO no servidor dos `diagnoses` (capítulos CID-11 distintos:
   * `id` = código do capítulo, `label` = título). Não se escolhe (Gabriel 08/09; D163/D164). Dado
   * clínico como os diagnósticos: `null` sem `patient_clinical:read`. Máscara para o Ana Care
   * (DEC-09): sai no PDF, não é campo da tela.
   */
  pathologyTypes: CatalogSnapshotItem[] | null;
  /**
   * LEGADO (migration 496, spec 030): segmento congelado em versão antiga. Spec 091 tirou o segmento do
   * "Nuevo"/"Editar"; a tela só o lê se vier, nunca o manda.
   */
  segment?: CatalogSnapshotItem | null;
  /**
   * Formato da versão (DD-21): é a ÚNICA fonte para escolher o renderizador. `diagnosisPlans === null`
   * nunca é lido sozinho (null também é "redigido"). `'flat'` = lista plana antiga; `'byDiagnosis'` = blocos por CID.
   */
  objectivesLayout: ObjectivesLayoutName;
  /** Blocos congelados por diagnóstico (091); `null` em versão `flat` ou sem `patient_clinical:read` (`redacted.clinical`). */
  diagnosisPlans: DiagnosisPlanSnapshot[] | null;
  startDate: string;
  endDate: string;
  annulledAt: string | null;
  /** Nome de quem anulou, resolvido no servidor (o uid nunca sai — como `createdByName`). */
  annulledByName: string | null;
  annulReason: string | null;
  createdByName: string | null;
  createdAt: string;
  country: string;
  redacted?: { clinical?: true; services?: true };
  /** Ids selecionados (PR-7) — a versão só guarda ids, nunca nome/telefone. */
  contactRefs: ContactRef[];
  careTeamIds: string[];
  /** Os mesmos contatos RESOLVIDOS pela célula de origem (lex #7 C5) — a tela lê daqui, nunca da versão bruta. */
  contacts: ResolvedTherapeuticContact[];
  /** spec 048: "Todavía no hay registro" / "No necesita" por campo. `[]` = nenhum campo com estado. */
  contactStatus: ContactStatusEntry[];
}

/** Campos comuns da versão, nos dois formatos. */
export interface TherapeuticProjectVersionBaseBody {
  contractedServiceId: string;
  modality: TherapeuticModality;
  diagnoses: TherapeuticDiagnosis[];
  clinicalContext: string;
  generalObjective: string;
  startDate: string;
  endDate: string;
  contactRefs: ContactRef[];
  careTeamIds: string[];
  /** spec 048: SEMPRE no corpo (`{}` = nenhum) — o servidor recusa corpo sem a chave, para cliente velho não apagar pendência. */
  contactStatus: ContactStatusMap;
}

/** O que foi marcado num bloco por diagnóstico (091, §9.4): ids de objetivos e de atividades daquele CID. */
export interface DiagnosisPlanInput {
  diagnosisUri: string;
  specificObjectiveIds: string[];
  activityIds: string[];
}

/** Formato antigo (lista plana). Só o `mode:'edit'` de versão `flat` ainda o manda. Sem `segmentId` (091: strict → 400). */
export interface FlatVersionBody extends TherapeuticProjectVersionBaseBody {
  specificObjectiveIds: string[];
  activityIds: string[];
}

/** Formato novo (091): um bloco por diagnóstico; o conjunto de `diagnosisUri` é o de `diagnoses[].uri`, sem repetição. */
export interface ByDiagnosisVersionBody extends TherapeuticProjectVersionBaseBody {
  diagnosisPlans: DiagnosisPlanInput[];
}

export type TherapeuticProjectVersionBody = FlatVersionBody | ByDiagnosisVersionBody;

/** `data.fieldClass` da LISTA (task 7.7) — espelho de `THERAPEUTIC_FIELD_CLASS` do backend (dono
 * único: `worker-functions/.../domain/TherapeuticProject.ts`). O front NÃO copia a lista de nomes. */
export interface TherapeuticFieldClass {
  macro: string[];
  micro: string[];
}

/** `mode:'new'` é sempre por diagnóstico; `mode:'edit'` segue o formato da origem (formato diferente → 422 `ptp_format_mismatch`). */
export type CreateTherapeuticProjectBody =
  | { mode: 'new'; version: ByDiagnosisVersionBody }
  | { mode: 'edit'; fromVersionId: string; version: TherapeuticProjectVersionBody };

/** Os 2 catálogos terapêuticos (091: `segments` saiu — a rota responde 404). Tipo de patología deriva do CID-11, sem tela. */
export type TherapeuticCatalogKind = 'specific-objectives' | 'activities';

export const THERAPEUTIC_CATALOG_KINDS: readonly TherapeuticCatalogKind[] = ['specific-objectives', 'activities'];

/** Recurso da célula ABAC de cada catálogo — espelho do backend (`THERAPEUTIC_CATALOG_RESOURCE`). */
export const THERAPEUTIC_CATALOG_RESOURCE: Readonly<Record<TherapeuticCatalogKind, string>> = {
  'specific-objectives': 'catalog_therapeutic_objectives',
  activities: 'catalog_therapeutic_activities',
};

/**
 * Catálogo de motivos de saída do serviço (change itinerario-trocas-motivos-e-figma, D1): usa o mesmo
 * mecanismo dos catálogos, mas FICA FORA de `TherapeuticCatalogKind`/`THERAPEUTIC_CATALOG_KINDS` — o projeto
 * terapêutico e a tela dele nunca o veem.
 */
export const SERVICE_EXIT_REASON_KIND = 'service-exit-reasons';
export const SERVICE_EXIT_REASON_RESOURCE = 'catalog_service_exit_reasons';
export type AdminCatalogKind = TherapeuticCatalogKind | typeof SERVICE_EXIT_REASON_KIND;

/**
 * Spec 061: só estes kinds têm descrição (migration 547) e lista A–Z sem Ordem. O catálogo de
 * motivos de saída fica como era: Ordem, sem descrição. Espelho de `catalogHasDescription` do backend
 * (checagem POSITIVA — kind novo nasce sem descrição).
 */
export const CATALOG_KINDS_WITH_DESCRIPTION: readonly string[] = ['activities', 'specific-objectives'];
export const catalogHasDescription = (kind: string): boolean => CATALOG_KINDS_WITH_DESCRIPTION.includes(kind);

/**
 * Guardias predefinidas (spec 074): catálogo global de modelos de turnos. FICA FORA de `AdminCatalogKind` — não
 * tem Ordem nem descrição, e tem o seu próprio contrato (`items`).
 */
export const SERVICE_SHIFT_TEMPLATE_KIND = 'service-shift-templates';
export const SERVICE_SHIFT_TEMPLATE_RESOURCE = 'catalog_service_shift_templates';

export interface ShiftTemplateItem {
  startTime: string;
  durationMinutes: number;
}

export interface ShiftTemplate {
  id: string;
  code: string;
  label: string;
  active: boolean;
  items: ShiftTemplateItem[];
}

/** Opção de motivo para quem registra uma troca (GET …/service-exit-reasons/options). */
export interface ServiceExitReasonOption {
  code: string;
  label: string;
}

export interface TherapeuticCatalogItem {
  id: string;
  label: string;
  sortOrder: number;
  active: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Spec 061: só objetivos/atividades; `null`/ausente = sem descrição. */
  description?: string | null;
  /** 091, só objetivo: serviço dono (`null`/ausente = sem dono). */
  serviceCode?: string | null;
  /** 091, objetivo e atividade: quantas categorias CID-11 estão vinculadas. */
  categoryCount?: number;
  /** 091, só atividade: objetivo dono e o estado dele. */
  objectiveId?: string | null;
  objectiveLabel?: string | null;
  objectiveActive?: boolean | null;
  /** 091, só atividade: texto livre 1..100; `null`/ausente = sem frequência sugerida. */
  suggestedFrequency?: string | null;
}

// ---- 091: catálogo por CID-11 e serviço -------------------------------------------------------------------------------

/** `serviceCode` do objetivo: `/^[A-Z][A-Z0-9_]*$/`, até 40 (espelha o zod do servidor, §9.4). */
export const SERVICE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const SERVICE_CODE_MAX = 40;
/** Teto da frequência sugerida da atividade (§9.4: 1..100). */
export const SUGGESTED_FREQUENCY_MAX = 100;
/** Quantos diagnósticos a cascata aceita por chamada (§9.4: 1..20). */
export const CASCADE_MAX_DIAGNOSES = 20;
/** Tamanho do `q` da busca de categoria (§9.4: 2..100). */
export const ICD_CATEGORY_QUERY_MIN = 2;
export const ICD_CATEGORY_QUERY_MAX = 100;

export type ObjectivesLayoutName = 'flat' | 'byDiagnosis';

/** Categoria CID-11 de 4 caracteres do release corrente (resposta de `icd-categories?q=`). */
export interface IcdCategory {
  code: string;
  title: string;
}

/** Status de um bloco da cascata — o front habilita o "salvar" por ele (DD-21). */
export type CascadeBlockStatus = 'ok' | 'no_category' | 'no_catalog';

export interface CascadeActivity {
  id: string;
  label: string;
  description: string | null;
  suggestedFrequency: string | null;
}

export interface CascadeObjective {
  id: string;
  label: string;
  description: string | null;
  activities: CascadeActivity[];
}

export interface CascadeBlock {
  diagnosisUri: string;
  categoryCode: string | null;
  status: CascadeBlockStatus;
  objectives: CascadeObjective[];
}

/** Corpo de `POST /therapeutic-catalogs/cascade`. */
export interface CascadeRequestBody {
  serviceCode: string;
  diagnosisUris: string[];
}

/** Resposta da cascata: blocos na ORDEM das URIs enviadas. */
export interface CascadeResponse {
  serviceCode: string;
  serviceHasCatalog: boolean;
  blocks: CascadeBlock[];
}

/** Bloco CONGELADO na versão `byDiagnosis` (espelho de `DiagnosisPlanSnapshot` do backend). */
export interface DiagnosisPlanSnapshot {
  diagnosisUri: string;
  categoryCode: string | null;
  objectives: Array<{ id: string; label: string; description: string | null }>;
  activities: Array<{ id: string; label: string; description: string | null; suggestedFrequency: string | null }>;
}

/** Item de `…/:itemId/categories` — `title: null` = código ausente do release corrente. */
export interface CategoryLink {
  code: string;
  title: string | null;
  /** Só objetivo: quantas atividades dele também têm esta categoria. */
  activityLinks?: number;
}

export interface CategoryLinkList {
  total: number;
  items: CategoryLink[];
}

export interface AddedCategoryLink {
  code: string;
  title: string;
}

/** DELETE de categoria do OBJETIVO leva junto os vínculos das atividades dele. */
export interface RemovedObjectiveCategory {
  removedActivityLinks: number;
}

/** DELETE de categoria da ATIVIDADE; categoria ausente = 200 idempotente. */
export interface RemovedActivityCategory {
  removed: boolean;
}

export interface CatalogListOptions {
  includeInactive?: boolean;
  /** 4 chars. */
  categoryCode?: string;
  /** Só `activities`. */
  objectiveId?: string;
}

/**
 * Corpo de criar/editar item. DD-24: campo vazio no modal = `null` EXPLÍCITO (limpa); campo não alterado = chave
 * AUSENTE. Sem `segmentId` (091: strict → 400).
 */
export interface CatalogItemBody {
  label?: string;
  sortOrder?: number;
  active?: boolean;
  description?: string | null;
  /** Só objetivo; obrigatório no POST. */
  serviceCode?: string | null;
  /** Só atividade; obrigatório no POST. */
  objectiveId?: string;
  /** Só atividade; `null` limpa. */
  suggestedFrequency?: string | null;
}

/** Teto do rótulo — espelha o CHECK da migration 415 e o zod do servidor (`segments`). */
export const CATALOG_LABEL_MAX = 200;
/** Teto do título de objetivo/atividade (spec 061) — só barra criar/renomear; espelha o zod do servidor. */
export const CATALOG_TITLE_MAX = 150;
/** Teto da descrição de objetivo/atividade (spec 061) — espelha o CHECK da migration 547. */
export const CATALOG_DESCRIPTION_MAX = 1000;
/** Teto dos textos clínicos — espelha o CHECK da 416 (lex C6). */
export const THERAPEUTIC_TEXT_MAX = 4000;

/** A versão "em andamento" do card: a mais recente por data de criação (Gabriel, 08/09), anuladas fora. */
export function currentVersion(versions: readonly TherapeuticProjectVersion[]): TherapeuticProjectVersion | null {
  const vivas = versions.filter((v) => v.annulledAt === null);
  if (vivas.length === 0) return null;
  return [...vivas].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
