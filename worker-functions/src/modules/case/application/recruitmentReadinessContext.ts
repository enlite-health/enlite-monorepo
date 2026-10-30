import { activeDiagnosisCountSql } from "@shared/sql/patientDiagnosisSql";
import type { PoolClient } from "pg";
import type { RecruitmentReadinessInput, ServiceRecruitmentFields } from "../domain/PatientCompleteness";
import { slotVigenteSql } from "@shared/sql/serviceScheduleSql";

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
  insurance_informed: string | null;
  has_verified_active_coverage: boolean;
  /** Contagem (nunca valor) de diagnósticos ativos; vem como string do `pg`. */
  active_dx_count: string;
}

/** Linha do serviço travada (`FOR UPDATE OF pcs`), com `has_schedule` e o endereço vivo. */
export interface LockedRecruitmentService {
  id: string;
  providers_needed: number | null;
  has_schedule: boolean;
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
): Promise<RecruitmentContext> {
  const patientRes = await client.query<{
    id: string;
    status: string;
    case_number: number | null;
    insurance_informed: string | null;
    has_verified_active_coverage: boolean;
    active_dx_count: string;
  }>(
    `SELECT id, status, case_number,
              insurance_informed,
              -- Hotfix gate-cobertura-verificada-vacante (28/09): caminho NOVO da cobertura
              -- (patient_insurance_verified, migration 305/312) — o gate deixa de conhecer só
              -- o escalar insurance_informed. Mesmo critério "provider
              -- ativo" medido em produção antes deste hotfix.
              EXISTS (
                SELECT 1 FROM patient_insurance_verified piv
                JOIN insurance_providers ip ON ip.code = piv.provider_code AND ip.active
                WHERE piv.patient_id = patients.id
              ) AS has_verified_active_coverage,
              -- CID-11 (pedido do Javier): só a CONTAGEM de linhas ATIVAS (qualquer source), nunca o valor. Alias dx: a guarda S.5 do teste barra o termo por extenso no SQL.
              ${activeDiagnosisCountSql('patients.id')} AS active_dx_count
         FROM patients
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
    [patientId],
  );
  if ((patientRes.rowCount ?? 0) === 0) {
    throw new PatientNotFoundForRecruitmentError(patientId);
  }
  const patient = patientRes.rows[0];

  const serviceRes = await client.query<{
    id: string;
    providers_needed: number | null;
    has_schedule: boolean;
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
              pcs.required_professions, pcs.required_sex, pcs.required_experience,
              pcs.work_schedule, pcs.payment_day,
              pa.id AS live_address_id
         FROM patient_contracted_services pcs
         LEFT JOIN patient_addresses pa
                ON pa.id = pcs.address_id AND pa.archived_at IS NULL
        WHERE pcs.id = $1 AND pcs.patient_id = $2 AND pcs.active
        FOR UPDATE OF pcs`,
    [serviceId, patientId],
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
    insuranceInformed: patient.insurance_informed,
    hasVerifiedActiveCoverage: patient.has_verified_active_coverage,
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
