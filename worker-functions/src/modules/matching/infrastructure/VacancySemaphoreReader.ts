/**
 * VacancySemaphoreReader — o leitor em lote do `n` do semáforo (semaforo-da-vaga, F2, design §4).
 * UMA consulta por request, qualquer que seja o número de vagas, com o MESMO fragmento da lista de vagas
 * (`semaforoContagemSql`): lista e Kanban de pacientes leem a mesma expressão. Roda sob `withActorContext` (RLS de país).
 * Só `n`: sem nome de prestador, sem dado do paciente.
 */
import type { PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import type { VacancySemaphoreReaderPort } from '../../case/application/vacancySemaphorePort';
import { semaforoContagemSql } from './vacancySemaphoreSql';

export class VacancySemaphoreReader implements VacancySemaphoreReaderPort {
  async readMany(vacancyIds: string[]): Promise<Map<string, number>> {
    if (vacancyIds.length === 0) return new Map();
    return withActorContext(DatabaseConnection.getInstance().getPool(), (client) => this.readManyWith(client, vacancyIds));
  }

  async readManyWith(client: PoolClient, vacancyIds: string[]): Promise<Map<string, number>> {
    const res = await client.query<{ id: string; n: number }>(
      `SELECT jp.id, ${semaforoContagemSql('jp.id')} AS n
         FROM job_postings jp
        WHERE jp.id = ANY($1::uuid[])`,
      [vacancyIds],
    );
    return new Map(res.rows.map((r) => [r.id, Number(r.n)]));
  }
}
