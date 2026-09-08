/**
 * therapeuticProjectAccess — o ÚNICO ponto que decide o que de uma versão do projeto terapêutico
 * um ator recebe (spec 017; lex 08/09 C7/C8; D286 "célula por DADO").
 *
 * Duas células, cumulativas:
 *   · `patient_therapeutic_project:read`  — a rota abre: versões, números, datas, autor, serviço,
 *                                            os catálogos escolhidos (objetivos, atividades, tipo de
 *                                            patologia — texto genérico de cuidado).
 *   · `patient_clinical:read`             — o que é TEXTO CLÍNICO ou diagnóstico: `clinicalContext`,
 *                                            `generalObjective`, `diagnoses`. Sem ela, esses três
 *                                            saem `null` e o marcador `redacted.clinical = true` sai
 *                                            SEMPRE (constante — não depende de haver conteúdo).
 * Escrita: `patient_therapeutic_project:write` E `patient_clinical:write` (o corpo carrega texto
 * clínico) — o middleware exige a primeira; a segunda é conferida aqui, com 403 nomeando a célula.
 *
 * `cells = null` é "o engine não decidiu" (D113): tudo passa, como a rota devolvia antes.
 */
import type { TherapeuticProjectVersion } from '../domain/TherapeuticProject';
import { patientContainerCell } from './patientContainerAccess';

export const THERAPEUTIC_PROJECT_RESOURCE = 'patient_therapeutic_project';
export const PATIENT_CLINICAL_READ_CELL = patientContainerCell('clinical', 'read');
export const PATIENT_CLINICAL_WRITE_CELL = patientContainerCell('clinical', 'write');

const CLINICAL_FIELDS = ['clinicalContext', 'generalObjective', 'diagnoses'] as const;

export type ProjectedTherapeuticVersion = Omit<TherapeuticProjectVersion, 'clinicalContext' | 'generalObjective' | 'diagnoses' | 'createdBy' | 'annulledBy'> & {
  clinicalContext: string | null;
  generalObjective: string | null;
  diagnoses: TherapeuticProjectVersion['diagnoses'] | null;
  redacted?: { clinical: true };
};

export function canReadTherapeuticClinical(cells: readonly string[] | null | undefined): boolean {
  if (cells === null || cells === undefined) return true;
  return cells.includes(PATIENT_CLINICAL_READ_CELL);
}

export function canWriteTherapeuticClinical(cells: readonly string[] | null | undefined): boolean {
  if (cells === null || cells === undefined) return true;
  return cells.includes(PATIENT_CLINICAL_WRITE_CELL);
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
  if (canReadTherapeuticClinical(cells)) return rest;
  // Os TRÊS campos clínicos zerados num literal só — `CLINICAL_FIELDS` é a lista que o teste confere
  // contra este literal, para campo novo não entrar em um lado e não no outro.
  return { ...rest, clinicalContext: null, generalObjective: null, diagnoses: null, redacted: { clinical: true } };
}

/** Os campos que a projeção redige — exportado para o teste conferir a paridade com o literal acima. */
export const THERAPEUTIC_CLINICAL_FIELDS = CLINICAL_FIELDS;

/** O `action` da trilha (`resource_access_log`) — só nomes de container, nunca valor (lex C9/C13). */
export function therapeuticTrailAction(prefix: 'read_project' | 'write_project' | 'export_pdf', cells: readonly string[] | null | undefined): string {
  const served = ['therapeuticProject', ...(canReadTherapeuticClinical(cells) ? ['clinical'] : [])];
  return `${prefix}:${served.join('+')}`;
}
