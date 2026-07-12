/**
 * CleanupTestFixturesUseCase
 *
 * Teardown dos testes E2E + faxina geral de dado is_test: hard-DELETE de TODO
 * worker/job_posting marcado `is_test = true` e os filhos correlacionados.
 *
 * Worker/paciente de teste são criados por FLUXO REAL (sem endpoint de create
 * "backdoor") — este use case é SÓ o cleanup, chamado no teardown do E2E ou
 * manualmente pela operação para limpar resquícios de QA/smoke.
 *
 * SEGURANÇA (blindagem do WHERE): cada DELETE abaixo é filtrado
 * exclusivamente por
 *   worker_id      IN (SELECT id FROM workers      WHERE is_test = true)
 *   job_posting_id IN (SELECT id FROM job_postings WHERE is_test = true)
 * Nunca um DELETE sem esse filtro — dado real nunca é tocado. `patients` NÃO
 * tem is_test e NÃO é tocada aqui (o teste reusa paciente real existente).
 *
 * Ordem (filhos antes dos pais). Delete explícito é feito mesmo quando a FK já
 * tem ON DELETE CASCADE — garante contagem exata por tabela e blindagem
 * redundante (não depende de o schema manter CASCADE no futuro). Grafo FK
 * confirmado via grep em migrations/*.sql:
 *   1. messaging_outbox            — worker_id ON DELETE SET NULL (mig 085),
 *                                     job_posting_id ON DELETE SET NULL (mig 173) → NÃO cascata, delete explícito é obrigatório
 *   2. worker_job_applications     — worker_id + job_posting_id ON DELETE CASCADE (mig 011) → cascataria sozinho
 *   3. encuadres                   — worker_id ON DELETE SET NULL, job_posting_id ON DELETE CASCADE (mig 014) → parcialmente não cascata
 *   4. worker_service_areas        — worker_id ON DELETE CASCADE (mig 001)
 *   5. worker_documents            — worker_id ON DELETE CASCADE (mig 009)
 *   6. worker_availability         — worker_id ON DELETE CASCADE (mig 104)
 *   7. worker_blocked_applications — SEM FK, por design (mig 209) → nunca cascata
 *   8. job_postings WHERE is_test
 *   9. workers WHERE is_test
 *
 * Transação: tudo ou nada (BEGIN/COMMIT, ROLLBACK em qualquer erro).
 */

import type { Pool, PoolClient } from 'pg';
import { logger, reportError } from '@shared/logging';

const log = logger.child({ source: 'CleanupTestFixturesUseCase' });

export interface CleanupTestFixturesDeletedCounts {
  messaging_outbox: number;
  worker_job_applications: number;
  encuadres: number;
  worker_service_areas: number;
  worker_documents: number;
  worker_availability: number;
  worker_blocked_applications: number;
  job_postings: number;
  workers: number;
}

export interface CleanupTestFixturesResult {
  deleted: CleanupTestFixturesDeletedCounts;
}

/**
 * DELETEs filhos, em ordem — cada `sql` já embute o filtro blindado
 * (worker_id e/ou job_posting_id restrito a is_test=true). SQL literal (não
 * table name interpolado) para ficar auditável a olho nu / via grep.
 */
const CHILD_DELETES: ReadonlyArray<{
  key: keyof Omit<CleanupTestFixturesDeletedCounts, 'job_postings' | 'workers'>;
  sql: string;
}> = [
  {
    key: 'messaging_outbox',
    sql: `DELETE FROM messaging_outbox
          WHERE worker_id IN (SELECT id FROM workers WHERE is_test = true)
             OR job_posting_id IN (SELECT id FROM job_postings WHERE is_test = true)`,
  },
  {
    key: 'worker_job_applications',
    sql: `DELETE FROM worker_job_applications
          WHERE worker_id IN (SELECT id FROM workers WHERE is_test = true)
             OR job_posting_id IN (SELECT id FROM job_postings WHERE is_test = true)`,
  },
  {
    key: 'encuadres',
    sql: `DELETE FROM encuadres
          WHERE worker_id IN (SELECT id FROM workers WHERE is_test = true)
             OR job_posting_id IN (SELECT id FROM job_postings WHERE is_test = true)`,
  },
  {
    key: 'worker_service_areas',
    sql: `DELETE FROM worker_service_areas
          WHERE worker_id IN (SELECT id FROM workers WHERE is_test = true)`,
  },
  {
    key: 'worker_documents',
    sql: `DELETE FROM worker_documents
          WHERE worker_id IN (SELECT id FROM workers WHERE is_test = true)`,
  },
  {
    key: 'worker_availability',
    sql: `DELETE FROM worker_availability
          WHERE worker_id IN (SELECT id FROM workers WHERE is_test = true)`,
  },
  {
    key: 'worker_blocked_applications',
    sql: `DELETE FROM worker_blocked_applications
          WHERE worker_id IN (SELECT id FROM workers WHERE is_test = true)
             OR job_posting_id IN (SELECT id FROM job_postings WHERE is_test = true)`,
  },
];

export class CleanupTestFixturesUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(): Promise<CleanupTestFixturesResult> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const deleted = {} as CleanupTestFixturesDeletedCounts;

      for (const { key, sql } of CHILD_DELETES) {
        const res = await client.query(sql);
        deleted[key] = res.rowCount ?? 0;
      }

      const jobPostingsRes = await client.query(
        `DELETE FROM job_postings WHERE is_test = true`,
      );
      deleted.job_postings = jobPostingsRes.rowCount ?? 0;

      const workersRes = await client.query(
        `DELETE FROM workers WHERE is_test = true`,
      );
      deleted.workers = workersRes.rowCount ?? 0;

      await client.query('COMMIT');

      log.info({ msg: 'test_fixtures_cleanup_done', ...deleted });
      return { deleted };
    } catch (err) {
      await client.query('ROLLBACK');
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'CleanupTestFixturesUseCase:execute' });
      throw e;
    } finally {
      client.release();
    }
  }
}
