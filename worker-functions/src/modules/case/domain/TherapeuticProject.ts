/**
 * Projeto Terapêutico do paciente — o DOMÍNIO (spec 017, D299).
 *
 * Uma versão é imutável e se identifica por `major.minor`. As regras de numeração vivem aqui,
 * puras, para o repositório e o controller não as reinventarem:
 *   · "Novo"   → `nextMajor(versions)`  = max(major) + 1, minor 0 (1.0 se não há nenhuma);
 *   · "Editar" a versão M.m → `nextMinorOf(versions, M)` = M . max(minor de M) + 1.
 *     Editar a 1.0 com 1.1 já existente gera 1.2 (SUP-4 do plano), nunca colide.
 *
 * Os snapshots dos catálogos (`{ id, label }`) e do CID-11 (`{ uri, code, title }`) são o que a
 * versão guarda — renomear/desativar uma opção depois não reescreve o passado (lex C19).
 */

export interface TherapeuticDiagnosis {
  uri: string;
  /** Opcional: a projeção pública do CID-11 no painel esconde o código (REQ-21). */
  code?: string;
  title: string;
}

export interface CatalogSnapshotItem {
  id: string;
  label: string;
}

/**
 * Só DOIS catálogos mantidos à mão. "Tipo de patología" NÃO é catálogo (Gabriel, 08/09: "vem do
 * CID-11, não tem motivo para um menu que adiciona isso"; D163/D164): é DERIVADO dos diagnósticos
 * CID-11 da versão — ver `pathologyTypes` abaixo. A tabela `pathology_types` da 415 fica
 * deprecada pela 418; a célula `catalog_pathology_types` sumiu do código e o sync a marca.
 */
export type TherapeuticCatalogKind = 'specific-objectives' | 'activities';

export const THERAPEUTIC_CATALOG_KINDS: readonly TherapeuticCatalogKind[] = ['specific-objectives', 'activities'];

/** Tabela de cada catálogo (migration 415). Fonte única — o repositório monta o SQL por aqui. */
export const THERAPEUTIC_CATALOG_TABLE: Readonly<Record<TherapeuticCatalogKind, string>> = {
  'specific-objectives': 'therapeutic_specific_objectives',
  activities: 'therapeutic_activities',
};

/** Recurso da célula ABAC de cada catálogo (D299.3: uma célula por catálogo, família admin.patients). */
export const THERAPEUTIC_CATALOG_RESOURCE: Readonly<Record<TherapeuticCatalogKind, string>> = {
  'specific-objectives': 'catalog_therapeutic_objectives',
  activities: 'catalog_therapeutic_activities',
};

/**
 * "Tipo de patología (segmento)" — DERIVADO, nunca escolhido. `id` é o código do capítulo CID-11
 * (ex.: `06`), `label` o título do capítulo em espanhol, resolvidos pela `TerminologyPort` no
 * momento do INSERT e congelados na versão (mesma régua de `patient_diagnoses.concept_group`,
 * spec 016). Capítulo, e não bloco, é a suspensão declarada da D164 (D261: bloco não tem código
 * nem está no catálogo local; `2026-08-05a#ABERTO-12` segue no Marcel). Máscara para o padrão do
 * Ana Care (`2026-08-26a#DEC-09`): sai no PDF, não é campo da tela.
 */
export type PathologySegment = CatalogSnapshotItem;

/** Modalidade do acompanhamento — Ana (gestão) 08/09: "presencial, on-line e híbrida" (D301). */
export const THERAPEUTIC_MODALITIES = ['IN_PERSON', 'ONLINE', 'HYBRID'] as const;
export type TherapeuticModality = (typeof THERAPEUTIC_MODALITIES)[number];

export interface TherapeuticProjectVersion {
  id: string;
  patientId: string;
  major: number;
  minor: number;
  /** `V.M.m`, o rótulo que a tela e o PDF mostram. */
  version: string;
  editedFromVersionId: string | null;
  contractedServiceId: string;
  /** `service_code` CONGELADO na versão (417, trigger): decide as seções fixas do PDF sem depender de célula nem do serviço vivo. */
  contractedServiceCode: string;
  /** `null` só em versão anterior à migration 417 (imutável: não se retroalimenta). */
  modality: TherapeuticModality | null;
  diagnoses: TherapeuticDiagnosis[];
  clinicalContext: string;
  generalObjective: string;
  specificObjectives: CatalogSnapshotItem[];
  activities: CatalogSnapshotItem[];
  /** Derivado dos `diagnoses` (capítulos CID-11 distintos, ordenados por código). Ver `PathologySegment`. */
  pathologyTypes: PathologySegment[];
  startDate: string;
  endDate: string;
  annulledAt: string | null;
  annulledBy: string | null;
  /** Nome de quem anulou (`users.display_name`), resolvido na leitura — o uid nunca sai da API. */
  annulledByName: string | null;
  annulReason: string | null;
  createdBy: string;
  /** Nome do autor (`users.display_name`), resolvido na leitura — "Proyecto elaborado por". */
  createdByName: string | null;
  createdAt: string;
  country: string;
}

export const versionLabel = (major: number, minor: number): string => `V.${major}.${minor}`;

/**
 * ADR-4 / D328 — campo MACRO só muda quando o operador cria uma versão NOVA (`mode:'new'`);
 * `mode:'edit'` recusa alteração de MACRO com 422 `ptp_macro_locked`. `modality` é MICRO
 * (D328/SUP-24: trocar presencial↔online é edição, não pede projeto novo — fecha o que o
 * plano deixava em aberto). `contactRefs`/`careTeamIds` também são MICRO: são só ids, e trocar a
 * seleção de contato não é reescrever o conteúdo clínico da versão.
 */
export const THERAPEUTIC_FIELD_CLASS = {
  MACRO: ['contractedServiceId', 'diagnoses', 'clinicalContext', 'generalObjective', 'specificObjectiveIds', 'activityIds'] as const,
  MICRO: ['startDate', 'endDate', 'modality', 'contactRefs', 'careTeamIds'] as const,
} as const;

export type TherapeuticMacroField = (typeof THERAPEUTIC_FIELD_CLASS.MACRO)[number];

/** Compara ids/uris de um array sem depender de ordem (o cliente pode reenviar a mesma seleção reordenada). */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** O que a versão de ORIGEM tem, na forma comparável com o corpo do PATCH (ids, não snapshots). */
export interface CurrentMacroSnapshot {
  contractedServiceId: string;
  diagnosisUris: readonly string[];
  clinicalContext: string;
  generalObjective: string;
  specificObjectiveIds: readonly string[];
  activityIds: readonly string[];
}

export interface CandidateMacroInput {
  contractedServiceId: string;
  diagnoses: readonly { uri: string }[];
  clinicalContext: string;
  generalObjective: string;
  specificObjectiveIds: readonly string[];
  activityIds: readonly string[];
}

/**
 * Os campos MACRO que MUDARIAM se `candidate` fosse gravado sobre `current` — vazio = pode editar.
 * Usado SÓ em `mode:'edit'` (lex-pr7 contract §alterado); `mode:'new'` nunca chama isto (major
 * nova começa do zero, D328 item 1).
 */
export function macroFieldsChanged(current: CurrentMacroSnapshot, candidate: CandidateMacroInput): TherapeuticMacroField[] {
  const changed: TherapeuticMacroField[] = [];
  if (current.contractedServiceId !== candidate.contractedServiceId) changed.push('contractedServiceId');
  if (!sameIdSet(current.diagnosisUris, candidate.diagnoses.map((d) => d.uri))) changed.push('diagnoses');
  if (current.clinicalContext !== candidate.clinicalContext) changed.push('clinicalContext');
  if (current.generalObjective !== candidate.generalObjective) changed.push('generalObjective');
  if (!sameIdSet(current.specificObjectiveIds, candidate.specificObjectiveIds)) changed.push('specificObjectiveIds');
  if (!sameIdSet(current.activityIds, candidate.activityIds)) changed.push('activityIds');
  return changed;
}

/**
 * A versão VIGENTE entre as não-anuladas: `created_at` mais recente (D328 — "vigente = created_at
 * mais recente"). `null` se todas estiverem anuladas ou a lista vier vazia. Major mais alta nem
 * sempre é a vigente por minor mais alta: "Novo" pode nascer depois de uma edição de major antiga
 * só na teoria (o fluxo real não permite, mas a regra é por DATA, não por número).
 */
export function currentVersionOf<T extends { id: string; createdAt: string; annulledAt: string | null }>(
  existing: readonly T[],
): T | null {
  const alive = existing.filter((v) => v.annulledAt === null);
  if (alive.length === 0) return null;
  return sortByCreatedDesc(alive)[0];
}

type VersionNumber = Pick<TherapeuticProjectVersion, 'major' | 'minor'>;

/** A major seguinte para "Novo": 1 quando o paciente ainda não tem projeto. */
export function nextMajor(existing: readonly VersionNumber[]): VersionNumber {
  const max = existing.reduce((acc, v) => (v.major > acc ? v.major : acc), 0);
  return { major: max + 1, minor: 0 };
}

/** A minor seguinte de UMA major para "Editar" — depois da maior minor já existente dessa major. */
export function nextMinorOf(existing: readonly VersionNumber[], major: number): VersionNumber {
  const max = existing
    .filter((v) => v.major === major)
    .reduce((acc, v) => (v.minor > acc ? v.minor : acc), -1);
  return { major, minor: max + 1 };
}

/** Ordem da lista na ficha (Gabriel, 08/09): data de criação, mais recente primeiro. */
export function sortByCreatedDesc<T extends { createdAt: string }>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
