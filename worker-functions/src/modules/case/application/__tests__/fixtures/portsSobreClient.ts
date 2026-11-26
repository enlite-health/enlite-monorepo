/**
 * Ports do escritor de estado para os testes que dão o BANCO como dado (cliente de mentira): a transação entrega o
 * `client` recebido; a completude e a sonda de alocação são os adapters Pg REAIS lendo por esse client — assim os testes
 * continuam exercitando o SQL do loader. Os testes com dublê de port puro estão em `PatientStatusWriter.ports.test.ts`.
 */
import { createPatientStatusWriter, type MovePatientStatus } from '../../PatientStatusWriter';
import type { StatusTx } from '../../ports/patientStatusPorts';
import { PgCompletenessReader, PgLiveAllocation } from '../../../infrastructure/PgPatientStatusAdapters';

export function writerSobreClient(client: unknown): MovePatientStatus {
  return createPatientStatusWriter({
    transaction: { run: (fn) => fn(client as StatusTx) },
    completeness: new PgCompletenessReader(),
    allocation: new PgLiveAllocation(),
  });
}
