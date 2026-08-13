import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { Pool } from 'pg';
import { WorkerDocExpiry, UpdateDocExpiryDTO } from '@modules/worker';

// =====================================================
// DocExpiryRepository
// Gerencia vencimentos de documentos (migration 015)
// =====================================================
export class DocExpiryRepository {
  private pool: Pool;
  constructor() { this.pool = DatabaseConnection.getInstance().getPool(); }

  async update(dto: UpdateDocExpiryDTO): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [dto.workerId];
    let idx = 2;

    if (dto.criminalRecordExpiry !== undefined) {
      sets.push(`criminal_record_expiry = $${idx++}`);
      values.push(dto.criminalRecordExpiry);
    }
    if (dto.insuranceExpiry !== undefined) {
      sets.push(`insurance_expiry = $${idx++}`);
      values.push(dto.insuranceExpiry);
    }
    if (dto.professionalRegExpiry !== undefined) {
      sets.push(`professional_reg_expiry = $${idx++}`);
      values.push(dto.professionalRegExpiry);
    }

    if (sets.length === 0) return;

    await this.pool.query(
      `INSERT INTO worker_documents (worker_id, documents_status)
       VALUES ($1, 'pending')
       ON CONFLICT (worker_id) DO NOTHING`,
      [dto.workerId]
    );

    await this.pool.query(
      `UPDATE worker_documents SET ${sets.join(', ')}, updated_at = NOW() WHERE worker_id = $1`,
      values
    );
  }

  async findByWorkerId(workerId: string): Promise<WorkerDocExpiry | null> {
    const result = await this.pool.query(
      `SELECT worker_id, criminal_record_expiry, insurance_expiry, professional_reg_expiry
       FROM worker_documents WHERE worker_id = $1`,
      [workerId]
    );
    if (!result.rows[0]) return null;
    return this.mapRow(result.rows[0]);
  }

  async findExpiringSoon(_daysAhead = 30): Promise<WorkerDocExpiry[]> {
    const result = await this.pool.query(
      `SELECT * FROM workers_docs_expiry_alert
       WHERE criminal_expiring_soon = true
          OR insurance_expiring_soon = true
          OR profreg_expiring_soon = true
          OR criminal_expired = true
          OR insurance_expired = true
          OR profreg_expired = true`,
    );
    return result.rows.map(this.mapRow);
  }

  private mapRow(row: Record<string, unknown>): WorkerDocExpiry {
    return {
      workerId: row.worker_id as string,
      criminalRecordExpiry: row.criminal_record_expiry ? new Date(row.criminal_record_expiry as string) : null,
      insuranceExpiry: row.insurance_expiry ? new Date(row.insurance_expiry as string) : null,
      professionalRegExpiry: row.professional_reg_expiry ? new Date(row.professional_reg_expiry as string) : null,
      criminalExpiringSoon: row.criminal_expiring_soon as boolean | undefined,
      insuranceExpiringSoon: row.insurance_expiring_soon as boolean | undefined,
      profregExpiringSoon: row.profreg_expiring_soon as boolean | undefined,
      criminalExpired: row.criminal_expired as boolean | undefined,
      insuranceExpired: row.insurance_expired as boolean | undefined,
      profregExpired: row.profreg_expired as boolean | undefined,
    };
  }
}
