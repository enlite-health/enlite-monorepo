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
 *
 * `patient_status` (estado-automatico-do-paciente, F2, E6): o estado do paciente na vaga é `patients.status` lido por join
 * na hora (nunca coluna cópia) e pertence ao container `patient` (o operacional — célula `patient:read`, a da lista/Kanban).
 * Sem a célula → `null` + `redacted.patient = true` (marcador constante, com ou sem dado). Vaga sem paciente (ou paciente
 * sem estado) → SEM a chave: `null` aqui significa "o ator não lê o container `patient`" e só isso. `on_hold_note` (clínico)
 * nunca entra na vaga: nenhuma query de vaga o seleciona (teste em `patientInVacancyProjection.test.ts`).
 */

import { NOME_REDIGIDO } from '@modules/identity/permissions';
import {
  PATIENT_OPERATIONAL_READ_CELL, canReadPatientContainer, canReadPatientOperational,
} from '@modules/case/application/patientContainerAccess';

export interface PatientInVacancyRow {
  patient_first_name?: string | null;
  patient_last_name?: string | null;
  patient_address_formatted?: string | null;
  patient_address_raw?: string | null;
  patient_zone?: string | null;
  patient_city?: string | null;
  patient_neighborhood?: string | null;
  dependency_level?: string | null;
  patient_id?: string | null;
  /** `patients.status` por join (E6). Não é coluna de `job_postings`. */
  patient_status?: string | null;
  redacted?: { patient?: true };
}

/** O estado do paciente na vaga segue o container `patient` (`patient:read`) — o dono da regra é `patientContainerAccess`. */
export const PATIENT_CONTAINER_CELL = PATIENT_OPERATIONAL_READ_CELL;
export const canReadPatientStatus = canReadPatientOperational;

const CAMPOS_DE_ENDERECO = ['patient_address_formatted', 'patient_address_raw', 'patient_zone', 'patient_city', 'patient_neighborhood'] as const;

/** Iniciais que a lista mostra quando o nome está redigido — nunca as do rótulo. */
export const INICIAIS_REDIGIDAS = '—';

/** E6: ver o JSDoc do arquivo. Mexe só em `patient_status`/`redacted`; o resto da linha passa intacto. */
export function projectPatientStatus<T extends PatientInVacancyRow>(row: T, cells: readonly string[] | null | undefined): T {
  if (!('patient_status' in row)) return row;
  const semEstadoParaMostrar = row.patient_id == null || (canReadPatientStatus(cells) && row.patient_status == null);
  if (semEstadoParaMostrar) {
    // Vaga sem paciente, ou paciente legado sem estado: a chave some (nunca `null`, que só significa "sem célula").
    const { patient_status: _fora, ...resto } = row;
    return resto as T;
  }
  if (canReadPatientStatus(cells)) return row;
  return { ...row, patient_status: null, redacted: { ...row.redacted, patient: true } };
}

export function projectPatientInVacancy<T extends PatientInVacancyRow>(row: T, cells: readonly string[] | null | undefined): T {
  const comEstado = projectPatientStatus(row, cells);
  const identity = canReadPatientContainer(cells, 'identity');
  const address = canReadPatientContainer(cells, 'address');
  const clinical = canReadPatientContainer(cells, 'clinical');
  if (identity && address && clinical) return comEstado;
  const out: T = comEstado === row ? { ...row } : comEstado;
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
