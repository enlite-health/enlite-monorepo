/**
 * Composition root do "Cómo llegar" (spec 077 FR-46), no molde do `createGetCostOverviewUseCase` (`modules/custos/index.ts`):
 * o use case recebe só portas; aqui entram o pool (`withActorContext`), os adaptadores de banco e o Google. O pool só é pedido
 * na 1ª consulta (o `src/index.ts` monta isto no boot, sem banco).
 */
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { GetWorkerTransitToPatientUseCase } from '../application/GetWorkerTransitToPatientUseCase';
import { GoogleTransitDirections } from './GoogleTransitDirections';
import { CaseItineraryAdapter, PgWorkerZoneReader, type RunInActorContext } from './WorkerTransitReaders';

export function createGetWorkerTransitToPatientUseCase(): GetWorkerTransitToPatientUseCase {
  const run: RunInActorContext = (fn) => withActorContext(DatabaseConnection.getInstance().getPool(), fn);
  return new GetWorkerTransitToPatientUseCase(new PgWorkerZoneReader(run), new CaseItineraryAdapter(run), new GoogleTransitDirections());
}
