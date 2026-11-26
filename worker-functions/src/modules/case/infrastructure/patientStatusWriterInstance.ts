/**
 * O escritor de estado montado sobre os adapters Pg — a ÚNICA instância de produção. Mora na infraestrutura (que pode importar
 * `application/`) para que `application/` (a derivação) a use como padrão sem importar `interfaces/`; a composição
 * (`interfaces/composition/patientStatusComposition.ts`) a re-exporta para controllers e serviços.
 */
import { createPatientStatusWriter, type MovePatientStatus } from '../application/PatientStatusWriter';
import { buildPgPatientStatusPorts } from './PgPatientStatusAdapters';

export const movePatientStatus: MovePatientStatus = createPatientStatusWriter(buildPgPatientStatusPorts());
