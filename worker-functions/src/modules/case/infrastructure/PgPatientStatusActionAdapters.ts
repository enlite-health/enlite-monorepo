/**
 * Adapters Pg dos ports das ações dos estados humanos (estado-automatico-do-paciente, F3). Os do escritor: `PgPatientStatusAdapters.ts`.
 * `StatusTx` é sempre o `PoolClient` da transação aberta por `PgTransactionRunner` (o cast é só a volta do tipo mínimo ao concreto).
 */
import type { PoolClient } from 'pg';
import type { EntradaDerivacao } from '../domain/derivarEstadoPaciente';
import type { PatientStatus } from '../domain/enums/PatientStatus';
import type { HorasDoItinerarioPort, StatusTx, TransitionCatalogPort } from '../application/ports/patientStatusPorts';

/** A leitura das horas é a MESMA da derivação (`PatientStatusDerivation.evaluate`), injetada para este arquivo não importar `application/`. */
export type AvaliaHoras = (client: PoolClient, patientId: string, now: Date) => Promise<{ input: EntradaDerivacao } | null>;

export class PgHorasDoItinerario implements HorasDoItinerarioPort {
  constructor(private readonly avalia: AvaliaHoras) {}

  async load(tx: StatusTx, patientId: string, now: Date): Promise<EntradaDerivacao | null> {
    return (await this.avalia(tx as unknown as PoolClient, patientId, now))?.input ?? null;
  }
}

export class PgTransitionCatalog implements TransitionCatalogPort {
  async destinosDe(tx: StatusTx, from: PatientStatus | null): Promise<readonly PatientStatus[]> {
    const res = await tx.query<{ to_status: PatientStatus }>('SELECT to_status FROM patient_status_transitions WHERE from_status = $1', [from]);
    return res.rows.map((r) => r.to_status);
  }
}
