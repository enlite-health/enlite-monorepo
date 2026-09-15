/**
 * PatientPhotoOrphanRepository — `patient_photo_orphans` (migration 426; task 4.8/4.3h).
 *
 * Fila de retry para objeto GCS que o servidor NÃO conseguiu apagar (foto ou documento — a
 * coluna `bucket` distingue). Sem `patient_id` (a linha guarda só o caminho cifrado + motivo);
 * a origem some de propósito depois que o objeto vira "para apagar", não "de quem".
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export type OrphanBucket = 'PHOTOS' | 'DOCUMENTS';
export type OrphanReason = 'REPLACE' | 'PURGE' | 'REVOKE' | 'DELETE' | 'UPLOAD_FAILED';

export interface PatientPhotoOrphanRow {
  id: string;
  object_path_encrypted: string;
  bucket: OrphanBucket;
  reason: OrphanReason;
  created_at: string;
}

export class PatientPhotoOrphanRepository {
  constructor(private readonly pool: Pool = DatabaseConnection.getInstance().getPool()) {}

  async record(
    objectPathEncrypted: string,
    bucket: OrphanBucket,
    reason: OrphanReason,
    executor: Pool | PoolClient = this.pool,
  ): Promise<{ id: string }> {
    const { rows } = await executor.query<{ id: string }>(
      `INSERT INTO patient_photo_orphans (object_path_encrypted, bucket, reason) VALUES ($1, $2, $3) RETURNING id`,
      [objectPathEncrypted, bucket, reason],
    );
    return { id: rows[0].id };
  }

  /** Fila pendente — o processo de retry consome por aqui (task 4.3h). */
  async listPending(limit = 50, executor: Pool | PoolClient = this.pool): Promise<PatientPhotoOrphanRow[]> {
    const { rows } = await executor.query<PatientPhotoOrphanRow>(
      `SELECT id, object_path_encrypted, bucket, reason, created_at
         FROM patient_photo_orphans ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /**
   * Trava a fila pendente contra corrida (conserto #4 da 2ª revisão do PR-4).
   *
   * `PatientPhotoOrphanRetryService.retryOnce` é disparado OPORTUNISTA a cada upload/delete/
   * revoke/purge (`scheduleOpportunisticOrphanRetry`, fire-and-forget) — duas requests
   * concorrentes no MESMO processo, ou a MESMA linha vista por duas instâncias Cloud Run
   * diferentes, podiam `listPending` a mesma linha e as duas tentarem apagar/remover o mesmo
   * objeto GCS ao mesmo tempo.
   *
   * Escolha (1 linha): `SELECT ... FOR UPDATE SKIP LOCKED` em vez de guarda in-process — a Enlite
   * roda a API em múltiplas instâncias Cloud Run, e um guard só na memória do processo não
   * protegeria duas instâncias pegando a mesma linha ao mesmo tempo; o lock de banco protege as
   * duas concorrências (intra e inter-processo) com o mesmo mecanismo.
   *
   * O lock fica aberto durante a chamada ao GCS dentro de `fn` — aceitável aqui porque o lote é
   * pequeno (3 no caminho oportunista, até 50 no scheduled) e best-effort; outra instância que bata
   * nas MESMAS linhas simplesmente pula (`SKIP LOCKED`) e pega outras, nunca bloqueia.
   */
  async withPendingLocked<T>(
    limit: number,
    fn: (rows: PatientPhotoOrphanRow[], client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<PatientPhotoOrphanRow>(
        `SELECT id, object_path_encrypted, bucket, reason, created_at
           FROM patient_photo_orphans ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      const result = await fn(rows, client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async remove(id: string, executor: Pool | PoolClient = this.pool): Promise<void> {
    await executor.query(`DELETE FROM patient_photo_orphans WHERE id = $1`, [id]);
  }

  /** Contagem para o alarme (>0 por >24h — task 4.3h); `since` filtra por idade mínima da fila. */
  async countOlderThan(since: Date, executor: Pool | PoolClient = this.pool): Promise<number> {
    const { rows } = await executor.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM patient_photo_orphans WHERE created_at < $1`,
      [since],
    );
    return Number(rows[0]?.n ?? '0');
  }
}
