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
 * Zona, cidade e bairro do paciente seguem a MESMA célula de endereço (`lex` fase 2, condição 7:
 * na ficha eles já são `patient_address`; 1 serviço = 1 endereço = 1 vaga, D283 — o lugar da vaga
 * É o endereço do paciente). Efeito visível: recrutadora sem `patient_address:read` não vê zona na
 * lista de vagas. O nível de dependência é dado de SAÚDE (`patient_clinical`, P3) — sai da vaga só
 * com a célula clínica.
 */

import { NOME_REDIGIDO } from '@modules/identity/permissions';
import { canReadPatientContainer } from '@modules/case/application/patientContainerAccess';

export interface PatientInVacancyRow {
  patient_first_name?: string | null;
  patient_last_name?: string | null;
  patient_address_formatted?: string | null;
  patient_address_raw?: string | null;
  patient_zone?: string | null;
  patient_city?: string | null;
  patient_neighborhood?: string | null;
  dependency_level?: string | null;
}

const CAMPOS_DE_ENDERECO = ['patient_address_formatted', 'patient_address_raw', 'patient_zone', 'patient_city', 'patient_neighborhood'] as const;

/** Iniciais que a lista mostra quando o nome está redigido — nunca as do rótulo. */
export const INICIAIS_REDIGIDAS = '—';

export function projectPatientInVacancy<T extends PatientInVacancyRow>(row: T, cells: readonly string[] | null | undefined): T {
  const identity = canReadPatientContainer(cells, 'identity');
  const address = canReadPatientContainer(cells, 'address');
  const clinical = canReadPatientContainer(cells, 'clinical');
  if (identity && address && clinical) return row;
  const out: T = { ...row };
  if (!identity) {
    // Trava, não rótulo (D181): vazio some da tela e a vaga parece estar sem paciente.
    if ('patient_first_name' in out) out.patient_first_name = NOME_REDIGIDO;
    if ('patient_last_name' in out) out.patient_last_name = null;
  }
  if (!address) for (const f of CAMPOS_DE_ENDERECO) if (f in out) out[f] = null;
  if (!clinical && 'dependency_level' in out) out.dependency_level = null;
  return out;
}

/** A lista de vagas só pode FILTRAR por nome de paciente quem pode LÊ-LO (`lex` P5: senão a busca é oráculo). */
export function canSearchVacanciesByPatientName(cells: readonly string[] | null | undefined): boolean {
  return canReadPatientContainer(cells, 'identity');
}

export function patientNameIsRedacted(row: PatientInVacancyRow): boolean {
  return row.patient_first_name === NOME_REDIGIDO && (row.patient_last_name ?? null) === null;
}
