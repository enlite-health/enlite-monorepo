import * as functions from "firebase-functions";
import type { PoolClient } from "pg";
import { inPatientTransaction } from "./patientTransaction";
import {
  buildInsertQuery,
  buildInsertParams,
  retryOnCaseOrdinalConflict,
  type VacancyInsertParams,
  type SourceLockedField,
} from "@modules/matching";
import { auditVacancyCreated } from "../../matching/interfaces/controllers/vacancyCrudAuditHelpers";
import {
  computeRecruitmentReadiness,
  type RECRUITMENT_BLOCKING_CODES,
} from "../domain/PatientCompleteness";
import { vacancyRangeForProviderAgeBand } from "../domain/ProviderAgeBandMapping";
import type { ProviderAgeBand } from "../domain/enums/ContractedService";
import { ADMISSION_FUNNEL_STATUSES } from "../domain/enums/PatientStatus";
import { formatCaseTitle } from "@shared/utils/caseNumberFormat";

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

/** Gate `RECRUITMENT_BLOCKING_CODES` recusou. O controller mapeia para 422 `PATIENT_NOT_READY`. */
export class RecruitmentNotReadyError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
    readonly missing: Array<(typeof RECRUITMENT_BLOCKING_CODES)[number]>,
  ) {
    super(
      `No se puede activar el reclutamiento: falta ${missing.join(", ")}. (serviceId=${serviceId})`,
    );
    this.name = "RecruitmentNotReadyError";
  }
}

export interface ActivateRecruitmentResult {
  vacancyId: string;
  patientStatus: string;
  statusChanged: boolean;
}

/**
 * ActivateRecruitmentUseCase — `contracts/activation.md` (spec 018, PR-6, ADR-5).
 *
 * Substitui `ActivatePatientUseCase` (removido neste PR): ativar deixa de ser um botão único no
 * cabeçalho do paciente e passa a ser por SERVIÇO — cada `patient_contracted_services` vira, no
 * máximo, UMA vaga em rascunho. Um paciente pode ter N serviços, cada um ativado (ou não)
 * independente dos demais.
 *
 * Efeitos em UMA transação: `SELECT … FOR UPDATE` do paciente e do serviço (trava a mesma corrida
 * que o antecessor travava); gate `RECRUITMENT_BLOCKING_CODES`; 409 se já há vaga viva do
 * serviço; 1 INSERT em `job_postings` via `buildInsertQuery/buildInsertParams` (mesmo caminho de
 * `POST /api/admin/vacancies` — nunca SQL duplicado); se o paciente está no funil de admissão
 * (SOLICITANTE/ADMISSION/PENDING_ADMISSION), `UPDATE patients SET status='SEARCHING'` sob
 * `app.change_source='activate_recruitment'`. Fora do funil (já ACTIVE, ON_HOLD, etc.) o status
 * do paciente NÃO muda — ativar recrutamento de um 2º serviço de um paciente já ACTIVE não deve
 * regredir o status dele.
 *
 * NÃO emite `vacancy.created` — a vaga nasce rascunho (`is_draft` default true, `status`
 * 'PENDING_ACTIVATION') para a equipe revisar e publicar (fluxo existente), igual ao
 * antecessor.
 */
export class ActivateRecruitmentUseCase {
  async execute(
    patientId: string,
    serviceId: string,
  ): Promise<ActivateRecruitmentResult> {
    const startMs = Date.now();
    try {
      const result = await inPatientTransaction((client) =>
        this.runInTransaction(client, patientId, serviceId),
      );
      functions.logger.info("activate_recruitment.completed", {
        patientId,
        serviceId,
        vacancyId: result.vacancyId,
        statusChanged: result.statusChanged,
        durationMs: Date.now() - startMs,
      });
      return result;
    } catch (err) {
      const expected =
        err instanceof PatientNotFoundForRecruitmentError ||
        err instanceof ServiceNotFoundForRecruitmentError ||
        err instanceof ServiceAlreadyRecruitingError ||
        err instanceof RecruitmentNotReadyError;
      if (!expected) {
        functions.logger.error("activate_recruitment.failed", {
          patientId,
          serviceId,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startMs,
        });
      }
      throw err;
    }
  }

  private async runInTransaction(
    client: PoolClient,
    patientId: string,
    serviceId: string,
  ): Promise<ActivateRecruitmentResult> {
    const patientRes = await client.query<{
      id: string;
      status: string;
      case_number: number | null;
      insurance_informed: string | null;
    }>(
      `SELECT id, status, case_number,
                COALESCE(insurance_informed, health_insurance_name) AS insurance_informed
           FROM patients
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [patientId],
    );
    if ((patientRes.rowCount ?? 0) === 0) {
      throw new PatientNotFoundForRecruitmentError(patientId);
    }
    const { status, case_number, insurance_informed } = patientRes.rows[0];

    const serviceRes = await client.query<{
      id: string;
      providers_needed: number | null;
      provider_age_band: string | null;
      schedule: unknown;
      live_address_id: string | null;
    }>(
      `SELECT pcs.id, pcs.providers_needed, pcs.provider_age_band, pcs.schedule,
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

    const hasSchedule =
      Array.isArray(service.schedule) &&
      (service.schedule as unknown[]).length > 0;
    const { missing, ready } = computeRecruitmentReadiness({
      serviceHasAddress: service.live_address_id != null,
      serviceHasSchedule: hasSchedule,
      insuranceInformed: insurance_informed,
    });
    if (!ready) {
      throw new RecruitmentNotReadyError(patientId, serviceId, missing);
    }

    const vnRes = await client.query<{ vn: string }>(
      "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
    );
    const vacancyNumber = parseInt(vnRes.rows[0].vn, 10);
    const computedTitle = formatCaseTitle(case_number, vacancyNumber);
    const ageRange = vacancyRangeForProviderAgeBand(
      service.provider_age_band as ProviderAgeBand | null,
    );

    // T054 (achado do gate revisao-pr, fase 1): separado em DOIS objetos —
    // `fromOrigin` (o que o PACIENTE/SERVIÇO manda, tipado EXATAMENTE como
    // `Pick<VacancyInsertParams, SourceLockedField>`) e `fromRecruitment` (o
    // que fica para a equipe de recrutamento preencher depois, F3). O tipo
    // explícito em `fromOrigin` é o que faz o TS recusar propriedade
    // excedente num objeto literal — uma coluna nova que o foguete passe a
    // preencher "por engano" como se fosse da origem (ex.: `daily_obs:
    // service.daily_obs` dentro de `fromOrigin`) NÃO COMPILA sem entrar em
    // `SourceLockedField` (`vacancyCrudHelpers.ts`, `SOURCE_LOCKED_FIELDS`) —
    // o teste de paridade cobre o caminho inverso (a constante lida de
    // volta), este objeto cobre o ÚNICO call site real do foguete.
    const fromOrigin: Pick<VacancyInsertParams, SourceLockedField> = {
      case_number,
      patient_id: patientId,
      patient_address_id: service.live_address_id,
      contracted_service_id: service.id,
      age_range_min: ageRange.min,
      age_range_max: ageRange.max,
      schedule: service.schedule,
      providers_needed: service.providers_needed,
    };
    // Tipado com o MESMO `Omit` que sobra de `fromOrigin` (+`vacancyNumber`/`computedTitle`, que não
    // são nem origem nem recrutamento) — sem isto, uma chave travada repetida aqui (ex.:
    // `schedule: null`) sobrescreveria `fromOrigin` em silêncio se o spread viesse depois dela (achado
    // do gate revisao-pr). A ordem do spread abaixo (`fromOrigin` por ÚLTIMO) é a segunda trava —
    // as duas juntas: o tipo host barra a chave errada AQUI, e a ordem barra a chave certa perdendo
    // se alguém escapar o tipo.
    const fromRecruitment: Omit<VacancyInsertParams, SourceLockedField | 'vacancyNumber' | 'computedTitle'> = {
      required_professions: null,
      required_sex: null,
      worker_profile_sought: null,
      required_experience: null,
      worker_attributes: null,
      work_schedule: null,
      salary_text: null,
      payment_day: null,
      daily_obs: null,
      status: undefined,
      published_at: null,
      closes_at: null,
      is_test: false,
    };
    const params = buildInsertParams({
      vacancyNumber,
      computedTitle,
      ...fromRecruitment,
      ...fromOrigin,
    });
    // case_ordinal (spec 027 Fase 5) é computado dentro do próprio INSERT
    // (buildInsertQuery); a corrida entre dois cliques simultâneos no mesmo
    // caso bate no índice único idx_job_postings_case_ordinal — SAVEPOINT +
    // retry recalcula o ordinal e tenta de novo.
    const insRes = await retryOnCaseOrdinalConflict(
      async () => {
        await client.query("SAVEPOINT case_ordinal_retry");
        const res = await client.query<Record<string, unknown> & { id: string }>(
          buildInsertQuery(),
          params,
        );
        await client.query("RELEASE SAVEPOINT case_ordinal_retry");
        return res;
      },
      async () => {
        await client.query("ROLLBACK TO SAVEPOINT case_ordinal_retry");
      },
    );
    const vacancyId = insRes.rows[0].id;

    // T018 (spec 027, US2) — trilha de auditoria da vaga criada pelo SISTEMA
    // (nenhum humano no painel apertou "criar"). `auditVacancyCreated` grava
    // dentro de um SAVEPOINT (logEventSafe) e NUNCA relança — a mesma garantia
    // best-effort do fluxo manual (VacancyCrudController.createVacancy): falha
    // de auditoria não pode derrubar a vaga que acabou de ser inserida nesta
    // MESMA transação.
    await auditVacancyCreated(client, vacancyId, insRes.rows[0], {
      actorUserId: null,
      actorType: "SYSTEM",
      actorLabel: "activate_recruitment",
    });

    const isFunnel = (ADMISSION_FUNNEL_STATUSES as readonly string[]).includes(
      status,
    );
    let patientStatus = status;
    let statusChanged = false;
    if (isFunnel) {
      await client.query("SELECT set_config('app.change_source', $1, true)", [
        "activate_recruitment",
      ]);
      await client.query(
        `UPDATE patients SET status = 'SEARCHING', updated_at = NOW() WHERE id = $1`,
        [patientId],
      );
      patientStatus = "SEARCHING";
      statusChanged = true;
    }

    return { vacancyId, patientStatus, statusChanged };
  }
}
