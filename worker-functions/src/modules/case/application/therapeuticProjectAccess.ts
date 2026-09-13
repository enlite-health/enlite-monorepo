/**
 * therapeuticProjectAccess — o ÚNICO ponto que decide o que de uma versão do projeto terapêutico
 * um ator recebe (spec 017; lex 08/09 C7/C8; D286 "célula por DADO").
 *
 * Duas células, cumulativas:
 *   · `patient_therapeutic_project:read`  — a rota abre: versões, números, datas, autor, serviço,
 *                                            os catálogos escolhidos (objetivos, atividades — texto
 *                                            genérico de cuidado).
 *   · `patient_clinical:read`             — o que é TEXTO CLÍNICO ou diagnóstico: `clinicalContext`,
 *                                            `generalObjective`, `diagnoses` e `pathologyTypes` (o
 *                                            tipo de patologia é o CAPÍTULO CID-11 derivado dos
 *                                            diagnósticos — `06` sozinho revela saúde mental, OP-18).
 *                                            Sem ela, esses quatro saem `null` e o marcador
 *                                            `redacted.clinical = true` sai SEMPRE (constante).
 * Escrita: `patient_therapeutic_project:write` E `patient_clinical:write` (o corpo carrega texto
 * clínico) — o middleware exige a primeira; a segunda é conferida aqui, com 403 nomeando a célula.
 *
 * `cells = null` é "o engine não decidiu" (D113): tudo passa, como a rota devolvia antes.
 */
import type { ContactRef, TherapeuticCatalogSnapshotItem, TherapeuticProjectVersion } from '../domain/TherapeuticProject';
import { patientContainerCell, canReadPatientContainer } from './patientContainerAccess';

export const THERAPEUTIC_PROJECT_RESOURCE = 'patient_therapeutic_project';
export const PATIENT_CLINICAL_READ_CELL = patientContainerCell('clinical', 'read');
export const PATIENT_CLINICAL_WRITE_CELL = patientContainerCell('clinical', 'write');
/** lex 08/09 (A1): o TIPO do serviço congelado na versão é dado do container `services` (D286: célula é por dado). */
export const PATIENT_SERVICES_READ_CELL = patientContainerCell('services', 'read');
/** lex-pr7 §alterado: célula de LEITURA da origem — quem não vê o container não pode SELECIONAR o contato. */
export const PATIENT_FAMILY_READ_CELL = patientContainerCell('family', 'read');
export const PATIENT_COVERAGE_READ_CELL = patientContainerCell('coverage', 'read');
export const PATIENT_CARE_TEAM_READ_CELL = patientContainerCell('careTeam', 'read');

const CLINICAL_FIELDS = ['clinicalContext', 'generalObjective', 'diagnoses', 'pathologyTypes'] as const;

export type ProjectedTherapeuticVersion = Omit<TherapeuticProjectVersion, 'clinicalContext' | 'generalObjective' | 'diagnoses' | 'pathologyTypes' | 'contractedServiceCode' | 'createdBy' | 'annulledBy'> & {
  clinicalContext: string | null;
  generalObjective: string | null;
  diagnoses: TherapeuticProjectVersion['diagnoses'] | null;
  /** Capítulos CID-11 derivados — dado clínico como os `diagnoses` de que vem. */
  pathologyTypes: TherapeuticProjectVersion['pathologyTypes'] | null;
  /** `null` sem `patient_services:read` (lex A1) — e o marcador `redacted.services` é CONSTANTE, nunca "tem valor?". */
  contractedServiceCode: string | null;
  redacted?: { clinical?: true; services?: true };
};

/** Predicados nomeados do projeto — a régua é a de `patientContainerAccess` (um só lugar decide `null → tudo`, D113). */
export function canReadTherapeuticClinical(cells: readonly string[] | null | undefined): boolean {
  return canReadPatientContainer(cells, 'clinical');
}

export function canWriteTherapeuticClinical(cells: readonly string[] | null | undefined): boolean {
  if (cells === null || cells === undefined) return true;
  return cells.includes(PATIENT_CLINICAL_WRITE_CELL);
}

export function canReadTherapeuticServices(cells: readonly string[] | null | undefined): boolean {
  return canReadPatientContainer(cells, 'services');
}

/**
 * A versão projetada pelas células do ator. Os uids (autor e quem anulou) NUNCA saem — só os
 * nomes resolvidos (molde da autoria das observações, lex 29/08 item 3).
 */
export function projectTherapeuticVersionForActor(
  version: TherapeuticProjectVersion,
  cells: readonly string[] | null | undefined,
): ProjectedTherapeuticVersion {
  // Nenhum uid de colaborador sai: nem o autor, nem quem anulou (só os nomes resolvidos).
  const { createdBy: _uid, annulledBy: _uidAnulou, ...rest } = version;
  const clinica = canReadTherapeuticClinical(cells);
  const servicos = canReadTherapeuticServices(cells);
  if (clinica && servicos) return rest;
  const redacted: { clinical?: true; services?: true } = {};
  // Os QUATRO campos clínicos zerados num literal só — `CLINICAL_FIELDS` é a lista que o teste confere
  // contra este literal, para campo novo não entrar em um lado e não no outro.
  const clinico = clinica
    ? {}
    : {
        clinicalContext: null,
        generalObjective: null,
        diagnoses: null,
        pathologyTypes: null,
        // lex-pr7 C3(b)/D303: segmento (430) dentro de cada item de objetivo/atividade é dado
        // clínico — mesma régua de `pathologyTypes`. Só o segmento some; o item (id/label) fica.
        specificObjectives: redactSegmentOf(rest.specificObjectives),
        activities: redactSegmentOf(rest.activities),
      };
  if (!clinica) redacted.clinical = true;
  // lex A1 (08/09): o tipo do serviço é dado de `services` — mesma régua da ficha (`DETAIL_FIELDS.services`).
  const servico = servicos ? {} : { contractedServiceCode: null };
  if (!servicos) redacted.services = true;
  return { ...rest, ...clinico, ...servico, redacted };
}

/** Os campos que a projeção redige — exportado para o teste conferir a paridade com o literal acima. */
export const THERAPEUTIC_CLINICAL_FIELDS = CLINICAL_FIELDS;

/**
 * `segmentId`/`segmentLabel` zerados por item — nunca o item inteiro (id/label do objetivo ou
 * atividade continuam visíveis com só `patient_therapeutic_project:read`; só o segmento é clínico).
 */
function redactSegmentOf(items: readonly TherapeuticCatalogSnapshotItem[]): TherapeuticCatalogSnapshotItem[] {
  return items.map((item) => ({ ...item, segmentId: null, segmentLabel: null }));
}

/**
 * Célula de leitura da ORIGEM que falta para escrever os `contactRefs`/`careTeamIds` pedidos —
 * `null` = pode escrever todos (lex-pr7 §alterado: "quem não vê não seleciona"). `cells = null`
 * (engine não decidiu, D113) deixa passar, como o resto do módulo.
 */
export function missingContactOriginCell(
  refs: readonly ContactRef[],
  careTeamIds: readonly string[],
  cells: readonly string[] | null | undefined,
): string | null {
  if (cells === null || cells === undefined) return null;
  if (refs.some((r) => r.kind === 'RESPONSIBLE' || r.kind === 'EXTERNAL') && !cells.includes(PATIENT_FAMILY_READ_CELL)) {
    return PATIENT_FAMILY_READ_CELL;
  }
  if (refs.some((r) => r.kind === 'COVERAGE') && !cells.includes(PATIENT_COVERAGE_READ_CELL)) {
    return PATIENT_COVERAGE_READ_CELL;
  }
  if (careTeamIds.length > 0 && !cells.includes(PATIENT_CARE_TEAM_READ_CELL)) {
    return PATIENT_CARE_TEAM_READ_CELL;
  }
  return null;
}

/** Container (`family`/`coverage`/`care_team`) de cada tipo de contato — para a trilha (lex C6/C9). */
export function containerOfContactKind(kind: 'RESPONSIBLE' | 'EXTERNAL' | 'COVERAGE' | 'CARE_TEAM'): 'family' | 'coverage' | 'care_team' {
  if (kind === 'COVERAGE') return 'coverage';
  if (kind === 'CARE_TEAM') return 'care_team';
  return 'family';
}

/**
 * O `action` da trilha (`resource_access_log`) — só nomes de container, nunca valor (lex C9/C13).
 * `contactContainersServed` (lex C6): os containers de contato EFETIVAMENTE resolvidos nesta
 * resposta (não redigidos) — computados pelo controller a partir dos contatos resolvidos, nunca
 * derivados só das células (uma versão sem `contactRefs` não "serve" `family` mesmo com a célula).
 */
export function therapeuticTrailAction(
  prefix: 'read_project' | 'write_project' | 'export_pdf',
  cells: readonly string[] | null | undefined,
  contactContainersServed: readonly string[] = [],
): string {
  const served = [
    'therapeuticProject',
    ...(canReadTherapeuticClinical(cells) ? ['clinical'] : []),
    ...(canReadTherapeuticServices(cells) ? ['services'] : []),
    ...Array.from(new Set(contactContainersServed)),
  ];
  return `${prefix}:${served.join('+')}`;
}
