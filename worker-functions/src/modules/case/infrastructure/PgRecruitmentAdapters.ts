/**
 * Adapters Pg dos ports do foguete (`ActivateRecruitmentUseCase`; estado-automatico-do-paciente, D7 / design §5): o contexto
 * travado do portão, a lista de vagas do vínculo e a trilha da vaga. O `StatusTx` é sempre o `PoolClient` da transação aberta
 * por `PgTransactionRunner`; o cast é só a volta do tipo mínimo ao concreto.
 */
import type { PoolClient } from 'pg';
import { LinkExistingVacancyRepository } from './LinkExistingVacancyRepository';
import { JobPostingAuditRepository } from '../../matching/infrastructure/JobPostingAuditRepository';
import { auditVacancyCreated } from '../../matching/interfaces/controllers/vacancyCrudAuditHelpers';
import { lockRecruitmentContext } from '../application/recruitmentReadinessContext';
import type {
  LinkableVacancyRow,
  RecruitmentActor,
  RecruitmentContextPort,
  StatusTx,
  VacancyAuditPort,
  VacancyLinkPort,
} from '../application/ports/patientStatusPorts';

const pg = (tx: StatusTx): PoolClient => tx as unknown as PoolClient;

export class PgRecruitmentContext implements RecruitmentContextPort {
  lock(tx: StatusTx, patientId: string, serviceId: string) {
    return lockRecruitmentContext(pg(tx), patientId, serviceId);
  }
}

export class PgVacancyLink implements VacancyLinkPort {
  constructor(private readonly repo: Pick<LinkExistingVacancyRepository, 'listPatientVacanciesForLink'> = new LinkExistingVacancyRepository()) {}

  async listPatientVacanciesForLink(tx: StatusTx, patientId: string): Promise<LinkableVacancyRow[]> {
    return this.repo.listPatientVacanciesForLink(pg(tx), patientId);
  }
}

export class PgVacancyAudit implements VacancyAuditPort {
  constructor(private readonly repo: Pick<JobPostingAuditRepository, 'logFieldChangesSafe'> = new JobPostingAuditRepository()) {}

  vacancyCreated(tx: StatusTx, vacancyId: string, row: Record<string, unknown>, actor: RecruitmentActor): Promise<void> {
    return auditVacancyCreated(pg(tx), vacancyId, row, actor);
  }

  linkableDeclined(tx: StatusTx, vacancyId: string, declinedIds: readonly string[], actor: RecruitmentActor): Promise<void> {
    return this.repo.logFieldChangesSafe(pg(tx), {
      jobPostingId: vacancyId,
      fields: [{ field: 'linkable_vacancies_declined', before: null, after: [...declinedIds] }],
      actorUserId: actor.actorUserId,
      actorType: actor.actorType,
      actorLabel: actor.actorLabel,
      traceId: actor.traceId ?? null,
    });
  }
}
