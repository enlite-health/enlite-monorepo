/**
 * patientInVacancyProjection — o dado do PACIENTE que viaja dentro de uma vaga (D286 fase 2).
 *
 * `GET /vacancies` e `GET /vacancies/:id` carregam nome e endereço do paciente sob `vacancy:read`
 * — a célula de quem opera a vaga, que toda recrutadora tem. A D286 diz que a célula é por DADO,
 * não por tela: nome do paciente é `patient_identity:read`, endereço é `patient_address:read`
 * (a MESMA célula que vale na ficha do paciente e no mapa — `lex` A/C7), onde quer que apareçam.
 *
 * Aqui não há KMS a economizar: `patients.first_name` sai do SQL em texto claro. A prova é a
 * fronteira HTTP (o nome não aparece no corpo), não o espião. `cells === null` = engine não
 * decidiu → devolve como antes (D113).
 *
 * Zona, cidade e bairro FICAM sob `vacancy:read`: são o requisito operacional da vaga (o
 * prestador se candidata por zona), não o endereço da pessoa.
 */

import { NOME_REDIGIDO } from '@modules/identity/permissions/application/projectWorkerFields';
import { canReadPatientContainer } from '@modules/case/application/patientContainerAccess';

export interface PatientInVacancyRow {
  patient_first_name?: string | null;
  patient_last_name?: string | null;
  patient_address_formatted?: string | null;
  patient_address_raw?: string | null;
}

/** Iniciais que a lista mostra quando o nome está redigido — nunca as do rótulo. */
export const INICIAIS_REDIGIDAS = '—';

export function projectPatientInVacancy<T extends PatientInVacancyRow>(row: T, cells: readonly string[] | null | undefined): T {
  const identity = canReadPatientContainer(cells, 'identity');
  const address = canReadPatientContainer(cells, 'address');
  if (identity && address) return row;
  const out: T = { ...row };
  if (!identity) {
    // Trava, não rótulo (D181): vazio some da tela e a vaga parece estar sem paciente.
    if ('patient_first_name' in out) out.patient_first_name = NOME_REDIGIDO;
    if ('patient_last_name' in out) out.patient_last_name = null;
  }
  if (!address) {
    if ('patient_address_formatted' in out) out.patient_address_formatted = null;
    if ('patient_address_raw' in out) out.patient_address_raw = null;
  }
  return out;
}

export function patientNameIsRedacted(row: PatientInVacancyRow): boolean {
  return row.patient_first_name === NOME_REDIGIDO && (row.patient_last_name ?? null) === null;
}
