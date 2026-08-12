import { Pool } from 'pg';
import { IAvailabilityRepository } from '../ports/IAvailabilityRepository';
import { WorkerAvailability, CreateAvailabilityDTO } from '../domain/WorkerAvailability';
import { Result } from '@shared/utils/Result';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export class AvailabilityRepository implements IAvailabilityRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async create(data: CreateAvailabilityDTO): Promise<Result<WorkerAvailability>> {
    try {
      const query = `
        INSERT INTO worker_availability 
          (worker_id, day_of_week, start_time, end_time, timezone, crosses_midnight)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `;

      const values = [
        data.workerId,
        data.dayOfWeek,
        data.startTime,
        data.endTime,
        data.timezone,
        data.crossesMidnight || false,
      ];

      const result = await this.pool.query(query, values);
      const row = result.rows[0];

      const availability: WorkerAvailability = {
        id: row.id,
        workerId: row.worker_id,
        dayOfWeek: row.day_of_week,
        startTime: row.start_time,
        endTime: row.end_time,
        timezone: row.timezone,
        crossesMidnight: row.crosses_midnight,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

      return Result.ok<WorkerAvailability>(availability);
    } catch (error: any) {
      return Result.fail<WorkerAvailability>(`Failed to create availability: ${error.message}`);
    }
  }

  async createBatch(data: CreateAvailabilityDTO[]): Promise<Result<void>> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      for (const slot of data) {
        const query = `
          INSERT INTO worker_availability 
            (worker_id, day_of_week, start_time, end_time, timezone, crosses_midnight)
          VALUES ($1, $2, $3, $4, $5, $6)
        `;

        const values = [
          slot.workerId,
          slot.dayOfWeek,
          slot.startTime,
          slot.endTime,
          slot.timezone,
          slot.crossesMidnight || false,
        ];

        await client.query(query, values);
      }

      await client.query('COMMIT');
      return Result.ok<void>();
    } catch (error: any) {
      await client.query('ROLLBACK');
      return Result.fail<void>(`Failed to create availability batch: ${error.message}`);
    } finally {
      client.release();
    }
  }

  async replaceByWorkerId(workerId: string, data: CreateAvailabilityDTO[]): Promise<Result<void>> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [workerId]);

      for (const slot of data) {
        await client.query(
          `
          INSERT INTO worker_availability
            (worker_id, day_of_week, start_time, end_time, timezone, crosses_midnight)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
          [
            slot.workerId,
            slot.dayOfWeek,
            slot.startTime,
            slot.endTime,
            slot.timezone,
            slot.crossesMidnight || false,
          ],
        );
      }

      await client.query('COMMIT');
      return Result.ok<void>();
    } catch (error: any) {
      await client.query('ROLLBACK');
      return Result.fail<void>(`Failed to replace availability: ${error.message}`);
    } finally {
      client.release();
    }
  }

  async findByWorkerId(workerId: string): Promise<Result<WorkerAvailability[]>> {
    try {
      const query = `
        SELECT * FROM worker_availability
        WHERE worker_id = $1
        ORDER BY day_of_week ASC, start_time ASC
      `;

      const result = await this.pool.query(query, [workerId]);

      const availabilities: WorkerAvailability[] = result.rows.map(row => ({
        id: row.id,
        workerId: row.worker_id,
        dayOfWeek: row.day_of_week,
        startTime: row.start_time,
        endTime: row.end_time,
        timezone: row.timezone,
        crossesMidnight: row.crosses_midnight,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return Result.ok<WorkerAvailability[]>(availabilities);
    } catch (error: any) {
      return Result.fail<WorkerAvailability[]>(`Failed to find availabilities: ${error.message}`);
    }
  }

  async deleteByWorkerId(workerId: string): Promise<Result<void>> {
    try {
      const query = `DELETE FROM worker_availability WHERE worker_id = $1`;
      await this.pool.query(query, [workerId]);
      return Result.ok<void>();
    } catch (error: any) {
      return Result.fail<void>(`Failed to delete availabilities: ${error.message}`);
    }
  }
}
