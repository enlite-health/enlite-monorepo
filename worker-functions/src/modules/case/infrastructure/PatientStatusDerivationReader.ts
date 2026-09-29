/**
 * PatientStatusDerivationReader — o SUJEITO da derivação do estado do paciente (cadeia Fase 15, DX-15.8).
 *
 * UMA query, no client da transação do escritor (nunca pool cru, nunca transação própria): o status
 * atual, o país (fuso da data de operação) e se o itinerário está montado (existe linha no log
 * append-only de montagem — `ItineraryAssemblyWriter.ts`). `FOR UPDATE OF p` é o MESMO lock que
 * `movePatientStatus` pega (reentrante na mesma transação): fecha a corrida com um arrasto manual
 * concorrente. Nenhuma coluna de nome, telefone ou diagnóstico.
 */
import type { PoolClient } from 'pg';

export interface DerivationSubject {
  status: string | null;
  country: string;
  montado: boolean;
}

export class PatientStatusDerivationReader {
  async readSubjectWith(client: PoolClient, patientId: string): Promise<DerivationSubject | null> {
    const res = await client.query<{ status: string | null; country: string; montado: boolean }>(
      `SELECT p.status, p.country,
              EXISTS (SELECT 1 FROM patient_itinerary_assembly a WHERE a.patient_id = p.id) AS montado
         FROM patients p
        WHERE p.id = $1 AND p.deleted_at IS NULL
        FOR UPDATE OF p`,
      [patientId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { status: row.status, country: row.country, montado: row.montado === true };
  }
}
