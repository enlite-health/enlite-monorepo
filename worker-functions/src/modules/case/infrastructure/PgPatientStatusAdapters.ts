/**
 * Adapters Pg dos ports do escritor de estado (estado-automatico-do-paciente, D7 / design §5). Os do foguete: `PgRecruitmentAdapters.ts`.
 *
 * Tudo que fala com o banco que o escritor (`PatientStatusWriter`) usava
 * por import direto mora AQUI; ele depende só de `ports/patientStatusPorts`. O `StatusTx` que chega é sempre o
 * `PoolClient` da transação aberta por `PgTransactionRunner` (ou o client que o chamador já tinha — a derivação, dentro do
 * escritor do itinerário): o cast para `PoolClient` é só a volta do tipo mínimo ao concreto, no único lugar que o conhece.
 */
import type { PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { loadPatientCompleteness } from './PatientCompletenessLoader';
import { countVivasForPatient } from './VacancyAllocationProbe';
import type { EscopoDaCompletude } from '../domain/PatientCompleteness';
import type {
  CompletenessReaderPort,
  LiveAllocationPort,
  PatientStatusPorts,
  StatusTx,
  TransactionRunnerPort,
} from '../application/ports/patientStatusPorts';

const pg = (tx: StatusTx): PoolClient => tx as unknown as PoolClient;

/** `withActorContext`: abre a transação no client certo (RLS por ator/país), reusando o client da request quando há. */
export class PgTransactionRunner implements TransactionRunnerPort {
  run<T>(fn: (tx: StatusTx) => Promise<T>): Promise<T> {
    return withActorContext(DatabaseConnection.getInstance().getPool(), (client) => fn(client));
  }
}

export class PgCompletenessReader implements CompletenessReaderPort {
  /** `paciente` mede todos os serviços ativos; `servico` mede só o `serviceId` (a leitura filtra `pcs.id`); `servicos_com_vaga_viva` só os com vaga viva. */
  async missingFor(tx: StatusTx, patientId: string, escopo: EscopoDaCompletude) {
    const { missing } = await loadPatientCompleteness(
      pg(tx),
      patientId,
      escopo.kind === 'servico' ? escopo.serviceId : undefined,
      escopo.kind === 'servicos_com_vaga_viva',
    );
    return missing;
  }
}

export class PgLiveAllocation implements LiveAllocationPort {
  countLive(tx: StatusTx, patientId: string): Promise<number> {
    return countVivasForPatient(pg(tx), patientId);
  }
}

export const buildPgPatientStatusPorts = (): PatientStatusPorts => ({
  transaction: new PgTransactionRunner(),
  completeness: new PgCompletenessReader(),
  allocation: new PgLiveAllocation(),
});
