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
 * Item de objetivo/atividade no snapshot da versão, com o segmento (migration 430, PR-7) do
 * momento do congelamento — espelho de `TherapeuticCatalogSnapshotItem` do backend.
 * `segmentId`/`segmentLabel` são dado CLÍNICO (lex-pr7 C3(b)): `undefined`/`null` numa versão sem
 * `patient_clinical:read`, e a tela não mostra segmento nesse caso (mesma régua do CID-11).
 */
export interface TherapeuticCatalogSnapshotItem extends CatalogSnapshotItem {
  segmentId?: string | null;
  segmentLabel?: string | null;
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
}

export interface TherapeuticProjectVersionBody {
  contractedServiceId: string;
  modality: TherapeuticModality;
  diagnoses: TherapeuticDiagnosis[];
  clinicalContext: string;
  generalObjective: string;
  specificObjectiveIds: string[];
  activityIds: string[];
  startDate: string;
  endDate: string;
  contactRefs: ContactRef[];
  careTeamIds: string[];
}

/** `data.fieldClass` da LISTA (task 7.7) — espelho de `THERAPEUTIC_FIELD_CLASS` do backend (dono
 * único: `worker-functions/.../domain/TherapeuticProject.ts`). O front NÃO copia a lista de nomes. */
export interface TherapeuticFieldClass {
  macro: string[];
  micro: string[];
}

export type CreateTherapeuticProjectBody =
  | { mode: 'new'; version: TherapeuticProjectVersionBody }
  | { mode: 'edit'; fromVersionId: string; version: TherapeuticProjectVersionBody };

/**
 * `segments` (migration 430, US-17, PR-7): catálogo GLOBAL dos segmentos da Ana Care — filtro dos
 * objetivos/atividades, não recorte do que pode ser gravado (#REQ-16). Tipo de patología continua
 * fora (deriva do CID-11, sem tela/célula/menu).
 */
export type TherapeuticCatalogKind = 'specific-objectives' | 'activities' | 'segments';

export const THERAPEUTIC_CATALOG_KINDS: readonly TherapeuticCatalogKind[] = ['specific-objectives', 'activities', 'segments'];

/** Recurso da célula ABAC de cada catálogo — espelho do backend (`THERAPEUTIC_CATALOG_RESOURCE`). */
export const THERAPEUTIC_CATALOG_RESOURCE: Readonly<Record<TherapeuticCatalogKind, string>> = {
  'specific-objectives': 'catalog_therapeutic_objectives',
  activities: 'catalog_therapeutic_activities',
  segments: 'catalog_therapeutic_segments',
};

export interface TherapeuticCatalogItem {
  id: string;
  label: string;
  sortOrder: number;
  active: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Só objetivos/atividades têm (migration 430, US-17); `segments` não referencia a si mesmo. */
  segmentId?: string | null;
  segmentLabel?: string | null;
}

/** Teto do rótulo — espelha o CHECK da migration 415 e o zod do servidor. */
export const CATALOG_LABEL_MAX = 200;
/** Teto dos textos clínicos — espelha o CHECK da 416 (lex C6). */
export const THERAPEUTIC_TEXT_MAX = 4000;

/** A versão "em andamento" do card: a mais recente por data de criação (Gabriel, 08/09), anuladas fora. */
export function currentVersion(versions: readonly TherapeuticProjectVersion[]): TherapeuticProjectVersion | null {
  const vivas = versions.filter((v) => v.annulledAt === null);
  if (vivas.length === 0) return null;
  return [...vivas].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
