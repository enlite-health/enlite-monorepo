import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

// WorkerLocation types inline (moved from OperationalEntities)
export interface WorkerLocation {
  id: string;
  workerId: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  postalCode: string | null;
  workZone: string | null;
  interestZone: string | null;
  dataSource: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkerLocationDTO {
  workerId: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string;
  postalCode?: string | null;
  workZone?: string | null;
  interestZone?: string | null;
  dataSource?: string | null;
  lat?: number | null;
  lng?: number | null;
}

// =====================================================
// WorkerLocationRepository
//
// Após consolidação (migrations 158/159/160 — 2026-05-06), persiste em
// `worker_service_areas` (única fonte de verdade do endereço do worker).
// A interface foi mantida pra não quebrar callers — mas agora leitura/escrita
// passam pela tabela canônica.
// =====================================================
export class WorkerLocationRepository {
  private pool: Pool;
  constructor() { this.pool = DatabaseConnection.getInstance().getPool(); }

  async upsert(dto: CreateWorkerLocationDTO): Promise<{ location: WorkerLocation; created: boolean }> {
    // worker_service_areas não tem unique constraint em worker_id (suporta vários
    // endereços por worker). Mantemos comportamento de upsert "primeiro endereço"
    // checando existência antes — soft-deleted rows são ignoradas.
    const existing = await this.pool.query(
      `SELECT id FROM worker_service_areas
        WHERE worker_id = $1 AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 1`,
      [dto.workerId],
    );

    if (existing.rows[0]) {
      const updated = await this.pool.query(
        `UPDATE worker_service_areas SET
           address_line  = $2,
           city          = $3,
           state         = $4,
           country       = $5,
           postal_code   = $6,
           work_zone     = $7,
           interest_zone = $8,
           data_source   = $9,
           latitude      = COALESCE($10, latitude),
           longitude     = COALESCE($11, longitude),
           updated_at    = now()
         WHERE id = $1
         RETURNING *`,
        [
          existing.rows[0].id,
          dto.address ?? null,
          dto.city ?? null,
          dto.state ?? null,
          dto.country ?? 'AR',
          dto.postalCode ?? null,
          dto.workZone ?? null,
          dto.interestZone ?? null,
          dto.dataSource ?? null,
          dto.lat ?? null,
          dto.lng ?? null,
        ],
      );
      return { location: this.mapRow(updated.rows[0]), created: false };
    }

    const inserted = await this.pool.query(
      `INSERT INTO worker_service_areas (
         worker_id, address_line, city, state, country, postal_code,
         work_zone, interest_zone, data_source, latitude, longitude, radius_km
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,20)
       RETURNING *`,
      [
        dto.workerId,
        dto.address ?? null,
        dto.city ?? null,
        dto.state ?? null,
        dto.country ?? 'AR',
        dto.postalCode ?? null,
        dto.workZone ?? null,
        dto.interestZone ?? null,
        dto.dataSource ?? null,
        dto.lat ?? null,
        dto.lng ?? null,
      ],
    );
    return { location: this.mapRow(inserted.rows[0]), created: true };
  }

  async findByWorkerId(workerId: string): Promise<WorkerLocation | null> {
    const result = await this.pool.query(
      `SELECT * FROM worker_service_areas
        WHERE worker_id = $1 AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 1`,
      [workerId],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByCity(city: string, options: { limit?: number; offset?: number } = {}): Promise<WorkerLocation[]> {
    const result = await this.pool.query(
      `SELECT * FROM worker_service_areas
        WHERE city ILIKE $1 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [`%${city}%`, options.limit ?? 50, options.offset ?? 0],
    );
    return result.rows.map(this.mapRow);
  }

  async findByWorkZone(workZone: string, options: { limit?: number; offset?: number } = {}): Promise<WorkerLocation[]> {
    const result = await this.pool.query(
      `SELECT * FROM worker_service_areas
        WHERE work_zone ILIKE $1 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [`%${workZone}%`, options.limit ?? 50, options.offset ?? 0],
    );
    return result.rows.map(this.mapRow);
  }

  async deleteByWorkerId(workerId: string): Promise<boolean> {
    // Soft delete via deleted_at — comportamento mais conservador que o legacy.
    const result = await this.pool.query(
      `UPDATE worker_service_areas SET deleted_at = now()
        WHERE worker_id = $1 AND deleted_at IS NULL`,
      [workerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private mapRow(row: Record<string, unknown>): WorkerLocation {
    return {
      id: row.id as string,
      workerId: row.worker_id as string,
      address: (row.address_line as string | null) ?? null,
      city: row.city as string | null,
      state: row.state as string | null,
      country: row.country as string,
      postalCode: row.postal_code as string | null,
      workZone: row.work_zone as string | null,
      interestZone: row.interest_zone as string | null,
      dataSource: row.data_source as string | null,
      lat: row.latitude != null ? parseFloat(row.latitude as string) : null,
      lng: row.longitude != null ? parseFloat(row.longitude as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
