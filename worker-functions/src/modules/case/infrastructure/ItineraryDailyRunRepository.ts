/**
 * ItineraryDailyRunRepository — o fato "a rotina diária do itinerário rodou para o país no dia" (spec 069 F4, tabela
 * `itinerary_daily_run`, migration 548) e a lista de pacientes que a derivação diária reavalia (P12).
 *
 * `begin` é idempotente (re-chamada no dia não reabre nem apaga o registro de uma rodada anterior); `finish` carimba
 * `finished_at` + `failures` (a última rodada do dia vence). Só `app_system` escreve aqui. Sem PII.
 */
import type { PoolClient } from 'pg';
import { FUNIL, MANUAIS } from '../domain/derivarEstadoPaciente';

export class ItineraryDailyRunRepository {
  async begin(client: PoolClient, country: string, operationDate: string): Promise<void> {
    await client.query(
      `INSERT INTO itinerary_daily_run (country, operation_date) VALUES ($1, $2::date) ON CONFLICT (country, operation_date) DO NOTHING`,
      [country, operationDate],
    );
  }

  async finish(client: PoolClient, country: string, operationDate: string, failures: number): Promise<void> {
    await client.query(
      `UPDATE itinerary_daily_run SET finished_at = now(), failures = $3 WHERE country = $1 AND operation_date = $2::date`,
      [country, operationDate, failures],
    );
  }

  /**
   * P12: TODO paciente do país sujeito à derivação (fora dos estados manuais e do funil de admissão — as mesmas listas da regra pura)
   * e com itinerário montado. Seleção por ESTADO, não por borda de data: um dia de job parado não perde transição.
   */
  async listDerivationCandidates(client: PoolClient, country: string): Promise<string[]> {
    const res = await client.query<{ id: string }>(
      `SELECT p.id
         FROM patients p
        WHERE p.country = $1 AND p.deleted_at IS NULL
          AND p.status <> ALL($2::text[])
          AND EXISTS (SELECT 1 FROM patient_itinerary_assembly a WHERE a.patient_id = p.id)
        ORDER BY p.id`,
      [country, [...MANUAIS, ...FUNIL]],
    );
    return res.rows.map((r) => r.id);
  }
}
