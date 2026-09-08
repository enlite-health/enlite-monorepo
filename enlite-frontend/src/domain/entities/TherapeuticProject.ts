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
  code: string;
  title: string;
}

export interface CatalogSnapshotItem {
  id: string;
  label: string;
}

export interface TherapeuticProjectVersion {
  id: string;
  patientId: string;
  major: number;
  minor: number;
  /** `V.M.m` — o rótulo da tela e do PDF. */
  version: string;
  editedFromVersionId: string | null;
  contractedServiceId: string;
  diagnoses: TherapeuticDiagnosis[] | null;
  clinicalContext: string | null;
  generalObjective: string | null;
  specificObjectives: CatalogSnapshotItem[];
  activities: CatalogSnapshotItem[];
  pathologyTypes: CatalogSnapshotItem[];
  startDate: string;
  endDate: string;
  annulledAt: string | null;
  annulledBy: string | null;
  annulReason: string | null;
  createdByName: string | null;
  createdAt: string;
  country: string;
  redacted?: { clinical: true };
}

export interface TherapeuticProjectVersionBody {
  contractedServiceId: string;
  diagnoses: TherapeuticDiagnosis[];
  clinicalContext: string;
  generalObjective: string;
  specificObjectiveIds: string[];
  activityIds: string[];
  pathologyTypeIds: string[];
  startDate: string;
  endDate: string;
}

export type CreateTherapeuticProjectBody =
  | { mode: 'new'; version: TherapeuticProjectVersionBody }
  | { mode: 'edit'; fromVersionId: string; version: TherapeuticProjectVersionBody };

export type TherapeuticCatalogKind = 'specific-objectives' | 'activities' | 'pathology-types';

export const THERAPEUTIC_CATALOG_KINDS: readonly TherapeuticCatalogKind[] = ['specific-objectives', 'activities', 'pathology-types'];

/** Recurso da célula ABAC de cada catálogo — espelho do backend (`THERAPEUTIC_CATALOG_RESOURCE`). */
export const THERAPEUTIC_CATALOG_RESOURCE: Readonly<Record<TherapeuticCatalogKind, string>> = {
  'specific-objectives': 'catalog_therapeutic_objectives',
  activities: 'catalog_therapeutic_activities',
  'pathology-types': 'catalog_pathology_types',
};

export interface TherapeuticCatalogItem {
  id: string;
  label: string;
  sortOrder: number;
  active: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
