/**
 * TalentumInboxRepository — adapter pg + KMS do port `ITalentumInboxRepository` (spec 095 §3.2).
 *
 * O corpo do webhook (nome, e-mail, telefone, respostas) é PII: vai cifrado em `payload_enc` com o
 * mesmo `KMSEncryptionService` que cifra PII de workers. Nenhum método loga o corpo.
 * Pool lazy (`DatabaseConnection`), como os irmãos do módulo.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type {
  InboxQueryable,
  InsertReceivedParams,
  InsertReceivedResult,
  ITalentumInboxRepository,
  TalentumInboxRow,
  TalentumInboxState,
} from '../domain/TalentumInbox';

interface InboxDbRow {
  id: string;
  received_at: Date;
  action: string;
  subtype: string | null;
  talentum_prescreening_id: string | null;
  talentum_profile_id: string | null;
  environment: 'production' | 'test';
  state: TalentumInboxState;
  attempts: number;
  payload_enc: string | null;
}

const ROW_COLUMNS = `id, received_at, action, subtype, talentum_prescreening_id, talentum_profile_id,
       environment, state, attempts, payload_enc`;

function mapRow(row: InboxDbRow): TalentumInboxRow {
  return {
    id: row.id,
    receivedAt: row.received_at,
    action: row.action,
    subtype: row.subtype,
    talentumPrescreeningId: row.talentum_prescreening_id,
    talentumProfileId: row.talentum_profile_id,
    environment: row.environment,
    state: row.state,
    attempts: row.attempts,
    payloadEnc: row.payload_enc,
  };
}

export class TalentumInboxRepository implements ITalentumInboxRepository {
  private pool?: Pool;

  constructor(private readonly kms: Pick<KMSEncryptionService, 'encrypt' | 'decrypt'> = new KMSEncryptionService()) {}

  private getPool(): Pool {
    return (this.pool ??= DatabaseConnection.getInstance().getPool());
  }

  async insertReceived(p: InsertReceivedParams): Promise<InsertReceivedResult> {
    const payloadEnc = await this.kms.encrypt(JSON.stringify(p.payload));
    const inserted = await this.getPool().query(
      `INSERT INTO talentum_webhook_inbox
         (body_hash, action, subtype, status_label, talentum_prescreening_id, talentum_profile_id,
          environment, ingress_host, state, payload_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RECEIVED', $9)
       ON CONFLICT (body_hash) DO NOTHING
       RETURNING id`,
      [p.bodyHash, p.action, p.subtype, p.statusLabel, p.prescreeningId, p.profileId, p.environment, p.ingressHost, payloadEnc],
    );
    if (inserted.rows.length > 0) return { id: inserted.rows[0].id, duplicate: false };

    const existing = await this.getPool().query(`SELECT id FROM talentum_webhook_inbox WHERE body_hash = $1`, [p.bodyHash]);
    return { id: existing.rows[0].id, duplicate: true };
  }

  async lockKey(client: InboxQueryable, prescreeningId: string | null, profileId: string | null): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`talentum-inbox|${prescreeningId ?? ''}|${profileId ?? ''}`]);
  }

  async findById(client: InboxQueryable, id: string): Promise<TalentumInboxRow | null> {
    const r = await client.query(`SELECT ${ROW_COLUMNS} FROM talentum_webhook_inbox WHERE id = $1`, [id]);
    return r.rows[0] ? mapRow(r.rows[0] as InboxDbRow) : null;
  }

  async pendingForKey(
    client: InboxQueryable, prescreeningId: string | null, profileId: string | null, alsoIds: string[] = [],
  ): Promise<TalentumInboxRow[]> {
    const r = await client.query(
      `SELECT ${ROW_COLUMNS}
         FROM talentum_webhook_inbox
        WHERE (state IN ('RECEIVED', 'FAILED') OR (id = ANY($3::uuid[]) AND state <> 'PROCESSED'))
          AND talentum_prescreening_id IS NOT DISTINCT FROM $1
          AND talentum_profile_id IS NOT DISTINCT FROM $2
        ORDER BY received_at, id`,
      [prescreeningId, profileId, alsoIds],
    );
    return (r.rows as InboxDbRow[]).map(mapRow);
  }

  async decryptPayload(row: Pick<TalentumInboxRow, 'payloadEnc'>): Promise<unknown> {
    return JSON.parse(await this.kms.decrypt(row.payloadEnc));
  }

  async markProcessed(client: InboxQueryable, id: string): Promise<void> {
    await client.query(
      `UPDATE talentum_webhook_inbox
          SET state = 'PROCESSED', processed_at = now(), error_code = NULL, attempts = attempts + 1
        WHERE id = $1`,
      [id],
    );
  }

  async markFailed(client: InboxQueryable, id: string, errorCode: string): Promise<void> {
    await client.query(
      `UPDATE talentum_webhook_inbox SET state = 'FAILED', error_code = $2, attempts = attempts + 1 WHERE id = $1`,
      [id, errorCode],
    );
  }

  async markState(
    client: InboxQueryable,
    id: string,
    state: Exclude<TalentumInboxState, 'RECEIVED' | 'PROCESSED'>,
    errorCode: string | null,
  ): Promise<void> {
    await client.query(
      `UPDATE talentum_webhook_inbox SET state = $2, error_code = $3, attempts = attempts + 1 WHERE id = $1`,
      [id, state, errorCode],
    );
  }
}
