import { activeDiagnosisCountSql } from "@shared/sql/patientDiagnosisSql";
import type { PoolClient } from "pg";
import type { RecruitmentReadinessInput, ServiceRecruitmentFields } from "../domain/PatientCompleteness";
import { slotVigenteSql } from "@shared/sql/serviceScheduleSql";
import { servicePayerLinkedSql } from "@shared/sql/servicePayerSql";
import { operationDateOf } from "@shared/locale/operationDate";

/** Paciente inexistente (ou soft-deletado). O controller mapeia para 404. */
export class PatientNotFoundForRecruitmentError extends Error {
  constructor(patientId: string) {
    super(`Patient not found: ${patientId}`);
    this.name = "PatientNotFoundForRecruitmentError";
  }
}

/** Serviço inexistente, de OUTRO paciente, ou inativo. O controller mapeia para 404. */
export class ServiceNotFoundForRecruitmentError extends Error {
  constructor(patientId: string, serviceId: string) {
    super(
      `Contracted service not found: ${serviceId} (patientId=${patientId})`,
    );
    this.name = "ServiceNotFoundForRecruitmentError";
  }
}

/**
 * O serviço já tem vaga viva (`job_postings.contracted_service_id = :sid AND deleted_at IS
 * NULL`). O controller mapeia para 409 com `{ code: 'SERVICE_ALREADY_RECRUITING', vacancyId }`.
 */
export class ServiceAlreadyRecruitingError extends Error {
  constructor(readonly vacancyId: string) {
    super(`Contracted service already has a live vacancy: ${vacancyId}`);
    this.name = "ServiceAlreadyRecruitingError";
  }
}

/** Linha do paciente travada (`FOR UPDATE`) — só o que o portão e a cópia da vaga usam. */
export interface LockedRecruitmentPatient {
  id: string;
  status: string;
  case_number: number | null;
  /** País do paciente: dele sai o `asOf` (dia de operação) da vigência do vínculo do serviço. */
  country: string;
  /** Contagem (nunca valor) de diagnósticos ativos; vem como string do `pg`. */
  active_dx_count: string;
}

/** Linha do serviço travada (`FOR UPDATE OF pcs`), com `has_schedule` e o endereço vivo. */
export interface LockedRecruitmentService {
  id: string;
  providers_needed: number | null;
  has_schedule: boolean;
  /** Spec 087: o serviço tem vínculo (contrato ou Particular) vigente em `asOf` — `servicePayerLinkedSql`. */
  payer_linked: boolean;
  live_address_id: string | null;
  required_professions: string[] | null;
  required_sex: string | null;
  required_experience: string | null;
  work_schedule: string | null;
  payment_day: string | null;
}

export interface RecruitmentContext {
  patient: LockedRecruitmentPatient;
  service: LockedRecruitmentService;
}

/**
 * Trava (paciente, depois serviço) e lê o contexto do portão de recrutamento. Lança
 * `PatientNotFoundForRecruitmentError`, `ServiceNotFoundForRecruitmentError` ou
 * `ServiceAlreadyRecruitingError` (vaga viva do serviço). NÃO avalia o portão: quem chama
 * passa o resultado a `computeRecruitmentReadiness`. Extraído do foguete (spec 079 T003)
 * sem mudar ordem de lock, queries nem erros.
 */
export async function lockRecruitmentContext(
  client: PoolClient,
  patientId: string,
  serviceId: string,
  /** `false` na prévia do vínculo (spec 079 plan §3.4): lê sem travar linha. Default `true` = foguete. `now`  = instante da requisição (dele sai o `asOf`); default = agora, capturado UMA vez aqui. */
  opts: { forUpdate: boolean; now?: Date } = { forUpdate: true },
): Promise<RecruitmentContext> {
  const patientRes = await client.query<{
    id: string;
    status: string;
    case_number: number | null;
    country: string;
    active_dx_count: string;
  }>(
    `SELECT id, status, case_number, country,
              -- CID-11 (pedido do Javier): só a CONTAGEM de linhas ATIVAS (qualquer source), nunca o valor. Alias dx: a guarda S.5 do teste barra o termo por extenso no SQL.
              ${activeDiagnosisCountSql('patients.id')} AS active_dx_count
         FROM patients
        WHERE id = $1 AND deleted_at IS NULL${opts.forUpdate ? '\n        FOR UPDATE' : ''}`,
    [patientId],
  );
  if ((patientRes.rowCount ?? 0) === 0) {
    throw new PatientNotFoundForRecruitmentError(patientId);
  }
  const patient = patientRes.rows[0];
  // Spec 087: `COVERAGE` = o serviço tem vínculo vigente no dia de operação do país do paciente (D-43: o dia vem de `operationDateOf`).
  const asOf = operationDateOf(patient.country, opts.now ?? new Date());

  const serviceRes = await client.query<{
    id: string;
    providers_needed: number | null;
    has_schedule: boolean;
    payer_linked: boolean;
    live_address_id: string | null;
    required_professions: string[] | null;
    required_sex: string | null;
    required_experience: string | null;
    work_schedule: string | null;
    payment_day: string | null;
  }>(
    // Spec 027 Fase 3 (D508): SÓ os 5 campos que a vaga copia. `worker_attributes`/`daily_obs` ficam na
    // ficha e NÃO são lidos aqui (não são usados: nem pelo portão, nem pela cópia).
    `SELECT pcs.id, pcs.providers_needed,
              EXISTS (SELECT 1 FROM patient_itinerary_slot s
                       WHERE s.contracted_service_id = pcs.id AND ${slotVigenteSql('s')}) AS has_schedule,
              ${servicePayerLinkedSql('pcs', '$3::date')} AS payer_linked,
              pcs.required_professions, pcs.required_sex, pcs.required_experience,
              pcs.work_schedule, pcs.payment_day,
              pa.id AS live_address_id
         FROM patient_contracted_services pcs
         LEFT JOIN patient_addresses pa
                ON pa.id = pcs.address_id AND pa.archived_at IS NULL
        WHERE pcs.id = $1 AND pcs.patient_id = $2 AND pcs.active${opts.forUpdate ? '\n        FOR UPDATE OF pcs' : ''}`,
    [serviceId, patientId, asOf],
  );
  if ((serviceRes.rowCount ?? 0) === 0) {
    throw new ServiceNotFoundForRecruitmentError(patientId, serviceId);
  }
  const service = serviceRes.rows[0];

  const liveVacancyRes = await client.query<{ id: string }>(
    `SELECT id FROM job_postings WHERE contracted_service_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [serviceId],
  );
  if ((liveVacancyRes.rowCount ?? 0) > 0) {
    throw new ServiceAlreadyRecruitingError(liveVacancyRes.rows[0].id);
  }

  return { patient, service };
}

/**
 * Monta a entrada do portão (`computeRecruitmentReadiness`) a partir do contexto travado. `overrides`
 * substitui só endereço/campos de recrutamento do serviço (o vínculo passa o serviço "já alimentado em memória").
 * "Tem horário" = ≥ 1 faixa vigente hoje (spec 056; o serviço não carrega mais `schedule`).
 */
export function readinessInputFromContext(
  ctx: RecruitmentContext,
  overrides?: { serviceHasAddress?: boolean; serviceRecruitmentFields?: ServiceRecruitmentFields },
): RecruitmentReadinessInput {
  const { patient, service } = ctx;
  return {
    serviceHasAddress: overrides?.serviceHasAddress ?? service.live_address_id != null,
    serviceHasSchedule: service.has_schedule,
    servicePayerLinked: service.payer_linked,
    patientStatus: patient.status,
    activeDiagnosisCount: Number(patient.active_dx_count),
    serviceRecruitmentFields: overrides?.serviceRecruitmentFields ?? {
      requiredProfessions: service.required_professions,
      requiredSex: service.required_sex,
      requiredExperience: service.required_experience,
      workSchedule: service.work_schedule,
      paymentDay: service.payment_day,
    },
  };
}
