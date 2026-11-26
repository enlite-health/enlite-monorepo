/**
 * Composição na borda (estado-automatico-do-paciente, E2): o único lugar que liga os adapters Pg aos ports do escritor de
 * estado e do foguete. Controllers, a derivação e `PatientService` recebem o escritor DAQUI; os use cases só conhecem ports.
 */
import { createPatientStatusWriter, type MovePatientStatus } from '../../application/PatientStatusWriter';
import { ActivateRecruitmentUseCase } from '../../application/ActivateRecruitmentUseCase';
import {
  buildPgPatientStatusPorts,
  PgTransactionRunner,
} from '../../infrastructure/PgPatientStatusAdapters';
import { PgRecruitmentContext, PgVacancyAudit, PgVacancyLink } from '../../infrastructure/PgRecruitmentAdapters';

/** O escritor de estado montado sobre os adapters Pg — a única instância de produção. */
export const movePatientStatus: MovePatientStatus = createPatientStatusWriter(buildPgPatientStatusPorts());

/** O foguete montado sobre os adapters Pg e o escritor acima. */
export const buildActivateRecruitmentUseCase = (): ActivateRecruitmentUseCase =>
  new ActivateRecruitmentUseCase({
    transaction: new PgTransactionRunner(),
    context: new PgRecruitmentContext(),
    links: new PgVacancyLink(),
    audit: new PgVacancyAudit(),
    moveStatus: movePatientStatus,
  });
