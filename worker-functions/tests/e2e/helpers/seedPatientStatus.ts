/**
 * Semeia o estado de um paciente por SQL (F5 do estado-automatico-do-paciente).
 *
 * Depois da F5 o `PUT /status` não monta mais estado derivado (SEARCHING/REPLACEMENT/ACTIVE): quem
 * precisa de um paciente nesse estado o semeia aqui. `app.change_source='system'` vai na MESMA
 * transação para a trilha (`patient_status_history`) sair coerente com uma mudança de sistema.
 */
import type { Pool } from 'pg';

export async function seedPatientStatus(pool: Pool, patientId: string, status: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.change_source', 'system', true)");
    await client.query('UPDATE patients SET status = $2 WHERE id = $1', [patientId, status]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
