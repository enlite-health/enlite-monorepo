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
