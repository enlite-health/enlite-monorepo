import { Pool } from 'pg';
import { IServiceAreaRepository } from '../ports/IServiceAreaRepository';
import { WorkerServiceArea, CreateServiceAreaDTO } from '../domain/WorkerServiceArea';
import { Result } from '@shared/utils/Result';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger, safeErrorFields } from '@shared/logging';

export class ServiceAreaRepository implements IServiceAreaRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async create(data: CreateServiceAreaDTO): Promise<Result<WorkerServiceArea>> {
    try {
      return Result.ok<WorkerServiceArea>(await this.insert(this.pool, data));
    } catch (error: any) {
      return Result.fail<WorkerServiceArea>(`Failed to create service area: ${error.message}`);
    }
  }

  /**
   * Troca a zona numa transação (DELETE + INSERT): se o INSERT falhar, a zona anterior volta.
   * `addressComplement` undefined = o pedido não falou do complemento: mantém o gravado;
   * null/'' = apagar; texto = trocar.
   */
  async replaceByWorkerId(data: CreateServiceAreaDTO): Promise<Result<WorkerServiceArea>> {
    try {
      const area = await withActorContext(this.pool, async (client) => {
        const old = await client.query(
          'DELETE FROM worker_service_areas WHERE worker_id = $1 RETURNING address_complement',
          [data.workerId],
        );
        const addressComplement =
          data.addressComplement === undefined ? old.rows[0]?.address_complement : data.addressComplement;
        return this.insert(client, { ...data, addressComplement });
      });
      return Result.ok<WorkerServiceArea>(area);
    } catch (error: unknown) {
      // Só o nome/código do erro: a mensagem do PG pode ecoar o endereço (PII).
      logger.error(safeErrorFields(error), '[ServiceAreaRepository] replaceByWorkerId failed');
      return Result.fail<WorkerServiceArea>('Failed to save service area');
    }
  }

  private async insert(db: Pick<Pool, 'query'>, data: CreateServiceAreaDTO): Promise<WorkerServiceArea> {
    const result = await db.query(
      `INSERT INTO worker_service_areas
          (worker_id, address_line, city, state, postal_code, latitude, longitude, radius_km, address_complement, country, neighborhood)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
      [
        data.workerId,
        data.address,
        data.city || null,
        null, // state - não disponível no DTO
        data.postalCode || null,
        data.lat,
        data.lng,
        data.serviceRadiusKm,
        data.addressComplement || null,
        'BR',
        data.neighborhood || null,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      workerId: row.worker_id,
      address: row.address_line,
      lat: parseFloat(row.latitude),
      lng: parseFloat(row.longitude),
      serviceRadiusKm: row.radius_km,
      addressComplement: row.address_complement || undefined,
      city: row.city || undefined,
      postalCode: row.postal_code || undefined,
      neighborhood: row.neighborhood || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findByWorkerId(workerId: string): Promise<Result<WorkerServiceArea[]>> {
    try {
      const query = `
        SELECT * FROM worker_service_areas
        WHERE worker_id = $1
        ORDER BY created_at DESC
      `;

      const result = await this.pool.query(query, [workerId]);

      const serviceAreas: WorkerServiceArea[] = result.rows.map(row => ({
        id: row.id,
        workerId: row.worker_id,
        address: row.address_line,
        addressComplement: row.address_complement,
        serviceRadiusKm: row.radius_km,
        lat: parseFloat(row.latitude),
        lng: parseFloat(row.longitude),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return Result.ok<WorkerServiceArea[]>(serviceAreas);
    } catch (error: any) {
      return Result.fail<WorkerServiceArea[]>(`Failed to find service areas: ${error.message}`);
    }
  }

  async deleteByWorkerId(workerId: string): Promise<Result<void>> {
    try {
      const query = `DELETE FROM worker_service_areas WHERE worker_id = $1`;
      await this.pool.query(query, [workerId]);
      return Result.ok<void>();
    } catch (error: any) {
      return Result.fail<void>(`Failed to delete service areas: ${error.message}`);
    }
  }
}
