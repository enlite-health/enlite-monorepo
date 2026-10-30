import * as functions from "firebase-functions";
import type { PoolClient } from "pg";
import { inPatientTransaction } from "./patientTransaction";
import {
  lockRecruitmentContext,
  readinessInputFromContext,
  PatientNotFoundForRecruitmentError,
  ServiceNotFoundForRecruitmentError,
  ServiceAlreadyRecruitingError,
  type RecruitmentContext,
} from "./recruitmentReadinessContext";
import type { LinkExistingVacancyRepository, VacancyForLinkRow } from "../infrastructure/LinkExistingVacancyRepository";
import type { JobPostingAuditRepository, FieldChange } from "../../matching/infrastructure/JobPostingAuditRepository";
import type { HumanActor } from "../../matching/interfaces/controllers/vacancyCrudAuditHelpers";
import { computeRecruitmentReadiness } from "../domain/PatientCompleteness";
import { vacancyLinkEligibility } from "../domain/VacancyLinkEligibility";
import {
  linkExistingVacancyPlan,
  type AcceptsServiceValue,
  type LinkExistingVacancyPlanResult,
  type ServiceFeed,
  type ServiceLinkTarget,
} from "../domain/LinkExistingVacancyPlan";
import {
  LINK_AUDIT_SERVICE_FIELD_PREFIX,
  type LinkBlockerCode,
  type LinkConfirmResponse,
  type LinkField,
  type LinkPreviewResponse,
  type VacancyNotLinkableReason,
} from "../domain/LinkExistingVacancyContract";

export {
  PatientNotFoundForRecruitmentError,
  ServiceNotFoundForRecruitmentError,
  ServiceAlreadyRecruitingError,
} from "./recruitmentReadinessContext";

/** Vaga não vinculável (inexistente, de outro paciente, já vinculada, apagada, DE_BAJA). Controller: 409 VACANCY_NOT_LINKABLE. */
export class VacancyNotLinkableError extends Error {
  constructor(readonly reason: VacancyNotLinkableReason) {
    super(`Vacancy not linkable: ${reason}`);
    this.name = "VacancyNotLinkableError";
  }
}

/** Endereço diferente ou portão de prontidão falhando. Nada foi gravado. Controller: 422 LINK_BLOCKED. */
export class LinkBlockedError extends Error {
  constructor(readonly blockers: LinkBlockerCode[]) {
    super(`Link blocked: ${blockers.join(", ")}`);
    this.name = "LinkBlockedError";
  }
}

/** FK composta (address_id, patient_id) recusou o endereço. Controller: 422 ADDRESS_NOT_OF_PATIENT. */
export class AddressNotOfPatientError extends Error {
  constructor() {
    super("Address does not belong to the patient");
    this.name = "AddressNotOfPatientError";
  }
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

const FEED_KEY_TO_LINK_FIELD: Record<keyof ServiceFeed, LinkField> = {
  required_professions: "required_professions",
  required_experience: "required_experience",
  work_schedule: "work_schedule",
  payment_day: "payment_day",
  required_sex: "required_sex",
  providers_needed: "providers_needed",
  provider_age_band: "age_range",
  address_id: "address",
};

const pgCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;

/**
 * LinkExistingVacancyUseCase — vincula uma vaga existente a um serviço contratado (spec 079, plan §3.4/§3.5).
 * `preview` nunca grava. `confirm` roda numa transação: lock → re-valida elegibilidade → plano → portão →
 * SÓ ENTÃO grava (alimenta o serviço, vincula e zera a vaga, audita). Não toca status de paciente nem de vaga.
 * `accepts` (domínio de escrita do serviço) é injetado pela composição.
 */
export class LinkExistingVacancyUseCase {
  constructor(
    private readonly repo: LinkExistingVacancyRepository,
    private readonly auditRepo: Pick<JobPostingAuditRepository, "logFieldChangesSafe">,
    private readonly accepts: AcceptsServiceValue,
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  async preview(patientId: string, serviceId: string, vacancyId?: string): Promise<LinkPreviewResponse> {
    try {
      return await this.runInTransaction((client) => this.previewInTx(client, patientId, serviceId, vacancyId));
    } catch (err) {
      this.logFailure("link_existing_vacancy.preview_failed", err, { patientId, serviceId, vacancyId });
      throw err;
    }
  }

  async confirm(
    patientId: string,
    serviceId: string,
    vacancyId: string,
    actor: HumanActor,
  ): Promise<LinkConfirmResponse> {
    const startMs = Date.now();
    try {
      const result = await this.runInTransaction((client) =>
        this.confirmInTx(client, patientId, serviceId, vacancyId, actor),
      );
      functions.logger.info("link_existing_vacancy.completed", {
        patientId,
        serviceId,
        vacancyId,
        fedFields: result.fedFields,
        durationMs: Date.now() - startMs,
      });
      return result;
    } catch (err) {
      this.logFailure("link_existing_vacancy.failed", err, { patientId, serviceId, vacancyId });
      throw err;
    }
  }

  private logFailure(event: string, err: unknown, ids: Record<string, unknown>): void {
    const expected =
      err instanceof PatientNotFoundForRecruitmentError ||
      err instanceof ServiceNotFoundForRecruitmentError ||
      err instanceof ServiceAlreadyRecruitingError ||
      err instanceof VacancyNotLinkableError ||
      err instanceof LinkBlockedError ||
      err instanceof AddressNotOfPatientError;
    if (!expected) {
      functions.logger.error(event, { ...ids, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async buildPlan(
    client: PoolClient,
    patientId: string,
    serviceId: string,
    ctx: RecruitmentContext,
    vacancy: VacancyForLinkRow,
  ): Promise<LinkExistingVacancyPlanResult> {
    const elig = vacancyLinkEligibility(vacancy, { patientId });
    if (!elig.eligible) throw new VacancyNotLinkableError(elig.reason);
    const band = await this.repo.readServiceLinkTarget(client, serviceId);
    if (!band) throw new ServiceNotFoundForRecruitmentError(patientId, serviceId);
    const s = ctx.service;
    const target: ServiceLinkTarget = {
      required_professions: s.required_professions,
      required_experience: s.required_experience,
      work_schedule: s.work_schedule,
      payment_day: s.payment_day,
      required_sex: s.required_sex,
      providers_needed: s.providers_needed,
      provider_age_band: band.provider_age_band,
      address_id: s.live_address_id,
      hasSchedule: s.has_schedule,
    };
    return linkExistingVacancyPlan(vacancy, target, this.accepts);
  }

  private blockersOf(ctx: RecruitmentContext, plan: LinkExistingVacancyPlanResult): LinkBlockerCode[] {
    const gate = computeRecruitmentReadiness(
      readinessInputFromContext(ctx, {
        serviceHasAddress: plan.effective.hasAddress,
        serviceRecruitmentFields: plan.effective.recruitmentFields,
      }),
    ).missing;
    return [...(plan.addressBlocked ? (["ADDRESS_MISMATCH"] as const) : []), ...gate];
  }

  private async previewInTx(
    client: PoolClient,
    patientId: string,
    serviceId: string,
    vacancyId: string | undefined,
  ): Promise<LinkPreviewResponse> {
    const ctx = await lockRecruitmentContext(client, patientId, serviceId);
    const all = await this.repo.listPatientVacanciesForLink(client, patientId);
    const candidates = all
      .filter(
        (v) =>
          vacancyLinkEligibility(
            { patientId, contractedServiceId: v.contractedServiceId, deletedAt: null, status: v.status },
            { patientId },
          ).eligible,
      )
      .map((v) => ({
        id: v.id,
        caseNumber: v.caseNumber,
        caseOrdinal: v.caseOrdinal,
        vacancyNumber: v.vacancyNumber,
        title: v.title,
        status: v.status,
        isDraft: v.isDraft,
        createdAt: v.createdAt,
      }));
    if (!vacancyId) return { candidates, preview: null };

    const vacancy = await this.repo.readVacancyForLink(client, vacancyId, { forUpdate: false });
    if (!vacancy) throw new VacancyNotLinkableError("NOT_FOUND");
    const plan = await this.buildPlan(client, patientId, serviceId, ctx, vacancy);
    const blockers = this.blockersOf(ctx, plan);
    return {
      candidates,
      preview: { vacancyId, rows: plan.rows, warnings: plan.warnings, blockers, canConfirm: blockers.length === 0 },
    };
  }

  private async confirmInTx(
    client: PoolClient,
    patientId: string,
    serviceId: string,
    vacancyId: string,
    actor: HumanActor,
  ): Promise<LinkConfirmResponse> {
    // 1. locks (paciente → serviço) + vaga viva do serviço
    const ctx = await lockRecruitmentContext(client, patientId, serviceId);
    // 2. vaga travada + re-validação da elegibilidade
    const vacancy = await this.repo.readVacancyForLink(client, vacancyId, { forUpdate: true });
    if (!vacancy) throw new VacancyNotLinkableError("NOT_FOUND");
    // 3. plano (a re-validação mora em buildPlan)
    const plan = await this.buildPlan(client, patientId, serviceId, ctx, vacancy);
    if (plan.addressBlocked) throw new LinkBlockedError(["ADDRESS_MISMATCH"]);
    // 4. portão com o serviço já alimentado em memória — até aqui NADA foi gravado
    const blockers = this.blockersOf(ctx, plan);
    if (blockers.length > 0) throw new LinkBlockedError(blockers);

    // 5-6. gravação
    const actorUid = actor.actorUserId ?? actor.actorLabel;
    try {
      await this.repo.feedService(client, serviceId, plan.serviceFeed, actorUid);
      const rowCount = await this.repo.linkVacancyAndClear(client, vacancyId, serviceId);
      if (rowCount === 0) throw new VacancyNotLinkableError("ALREADY_LINKED");
    } catch (err) {
      const code = pgCode(err);
      if (code === "23505") throw new ServiceAlreadyRecruitingError(vacancyId);
      if (code === "23503") throw new AddressNotOfPatientError();
      throw err;
    }

    // 7. auditoria (best-effort, SAVEPOINT por campo)
    const fields: FieldChange[] = [
      { field: "contracted_service_id", before: null, after: serviceId },
      ...plan.vacancyClear.map((c) => ({ field: c.column as string, before: c.before, after: null })),
      ...(Object.entries(plan.serviceFeed) as Array<[keyof ServiceFeed, unknown]>).map(([key, value]) => ({
        field: LINK_AUDIT_SERVICE_FIELD_PREFIX + key,
        before: null,
        after: value,
      })),
    ];
    await this.auditRepo.logFieldChangesSafe(client, {
      jobPostingId: vacancyId,
      fields,
      actorUserId: actor.actorUserId,
      actorType: actor.actorType,
      actorLabel: actor.actorLabel,
      traceId: actor.traceId ?? null,
    });

    const fedFields = (Object.keys(plan.serviceFeed) as Array<keyof ServiceFeed>).map(
      (k) => FEED_KEY_TO_LINK_FIELD[k],
    );
    return { vacancyId, serviceId, fedFields };
  }
}
