/**
 * Composição na borda das ações dos estados humanos (estado-automatico-do-paciente, F3, E2). Arquivo à parte de
 * `patientStatusComposition.ts` de propósito: a leitura das horas reusa `PatientStatusDerivation.evaluate`, que já importa aquela
 * composição — juntar os dois criaria um ciclo de import. Os use cases só conhecem ports; aqui entram os adapters Pg.
 */
import { PatientStatusDerivation } from '../../application/PatientStatusDerivation';
import { PatientStatusActionUseCase } from '../../application/PatientStatusActionUseCase';
import { ListPatientStatusActionsUseCase } from '../../application/ListPatientStatusActionsUseCase';
import { PgCompletenessReader, PgLiveAllocation, PgTransactionRunner } from '../../infrastructure/PgPatientStatusAdapters';
import { PgHorasDoItinerario, PgTransitionCatalog } from '../../infrastructure/PgPatientStatusActionAdapters';
import { movePatientStatus } from './patientStatusComposition';

/** A leitura das horas é a da derivação, com o escritor da composição (nunca escreve: só `evaluate`). */
const horasDoItinerario = (): PgHorasDoItinerario =>
  new PgHorasDoItinerario((client, patientId, now) => new PatientStatusDerivation({ moveStatus: movePatientStatus }).evaluate(client, patientId, now));

export const buildPatientStatusActionUseCase = (): PatientStatusActionUseCase =>
  new PatientStatusActionUseCase({ transaction: new PgTransactionRunner(), horas: horasDoItinerario(), moveStatus: movePatientStatus });

export const buildListPatientStatusActionsUseCase = (): ListPatientStatusActionsUseCase =>
  new ListPatientStatusActionsUseCase({
    transaction: new PgTransactionRunner(),
    horas: horasDoItinerario(),
    catalog: new PgTransitionCatalog(),
    completeness: new PgCompletenessReader(),
    allocation: new PgLiveAllocation(),
  });
