import type { Pool } from 'pg';
import type { ActiveWorkerDevice } from '../domain/WorkerDevice';
import type {
  RegisteredDevice,
  RegisterDeviceRecord,
  RevokedDeviceView,
  WorkerDeviceRepository,
} from '../ports/WorkerDeviceRepository';

/**
 * `worker_devices` (migration 593). Nenhum valor de coluna sensível (chave pública, id da instalação, token) vai a log:
 * este arquivo não importa o logger de propósito. A unicidade do ativo é do índice `uq_worker_devices_ativo_por_worker`.
 * A tabela não tem RLS (como `otp_challenges`): `pool.connect()` cru, sem contexto de ator, é o molde do WF para ela.
 */
export class PgWorkerDeviceRepository implements WorkerDeviceRepository {
  constructor(private readonly pool: Pick<Pool, 'connect' | 'query'>) {}

  async registerReplacingActive(record: RegisterDeviceRecord): Promise<RegisteredDevice> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // `other_device` sai do PRÓPRIO UPDATE que revoga (nunca de leitura separada): só é true se a linha desligada era
      // de OUTRA instalação. A comparação é no banco, entre UUIDs (maiúscula/minúscula do app não conta).
      const replaced = await client.query<{ id: string; other_device: boolean }>(
        `UPDATE worker_devices
            SET status = 'revogado', revoked_at = NOW(), revoked_reason = 'substituido'
          WHERE worker_id = $1 AND status = 'ativo'
          RETURNING id, installation_id <> $2::uuid AS other_device`,
        [record.workerId, record.installationId],
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO worker_devices (worker_id, installation_id, public_key, fcm_token_enc)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [record.workerId, record.installationId, record.publicKey, record.fcmTokenEnc],
      );
      await client.query('COMMIT');
      return {
        deviceId: inserted.rows[0].id,
        replacedDeviceId: replaced.rows[0]?.id ?? null,
        replacedPrevious: replaced.rows.some((r) => r.other_device === true),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findActive(workerId: string): Promise<ActiveWorkerDevice | null> {
    const { rows } = await this.pool.query<{ id: string; installation_id: string; public_key: string }>(
      `SELECT id, installation_id, public_key FROM worker_devices WHERE worker_id = $1 AND status = 'ativo'`,
      [workerId],
    );
    return rows[0] ? { deviceId: rows[0].id, installationId: rows[0].installation_id, publicKey: rows[0].public_key } : null;
  }

  async revokeActive(workerId: string, operatorUid: string): Promise<RevokedDeviceView | null> {
    const { rows } = await this.pool.query<{ id: string; fcm_token_enc: string | null }>(
      `UPDATE worker_devices
          SET status = 'revogado', revoked_at = NOW(), revoked_by = $2, revoked_reason = 'operador'
        WHERE worker_id = $1 AND status = 'ativo'
        RETURNING id, fcm_token_enc`,
      [workerId, operatorUid],
    );
    return rows[0] ? { deviceId: rows[0].id, fcmTokenEnc: rows[0].fcm_token_enc } : null;
  }

  async confirmWipe(workerId: string, installationId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE worker_devices SET wiped_at = NOW()
        WHERE id = (SELECT id FROM worker_devices
                     WHERE worker_id = $1 AND installation_id = $2 AND wiped_at IS NULL
                     ORDER BY registered_at DESC LIMIT 1)`,
      [workerId, installationId],
    );
    return (rowCount ?? 0) > 0;
  }

  async findAuthUid(workerId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ auth_uid: string }>(`SELECT auth_uid FROM workers WHERE id = $1`, [workerId]);
    return rows[0]?.auth_uid ?? null;
  }
}
