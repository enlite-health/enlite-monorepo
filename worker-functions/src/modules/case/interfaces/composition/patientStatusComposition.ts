/**
 * Composição na borda (estado-automatico-do-paciente, E2): o único lugar que liga os adapters Pg aos ports do escritor de
 * estado e do foguete. Controllers, a derivação e `PatientService` recebem o escritor DAQUI; os use cases só conhecem ports.
 */
import { ActivateRecruitmentUseCase } from '../../application/ActivateRecruitmentUseCase';
import { PgTransactionRunner } from '../../infrastructure/PgPatientStatusAdapters';
import { movePatientStatus } from '../../infrastructure/patientStatusWriterInstance';
import { PgRecruitmentContext, PgVacancyAudit, PgVacancyLink } from '../../infrastructure/PgRecruitmentAdapters';

/** O escritor de estado montado sobre os adapters Pg — a única instância de produção (montada na infraestrutura, re-exportada aqui). */
export { movePatientStatus };

/** O foguete montado sobre os adapters Pg e o escritor acima. */
export const buildActivateRecruitmentUseCase = (): ActivateRecruitmentUseCase =>
  new ActivateRecruitmentUseCase({
    transaction: new PgTransactionRunner(),
    context: new PgRecruitmentContext(),
    links: new PgVacancyLink(),
    audit: new PgVacancyAudit(),
    moveStatus: movePatientStatus,
  });
