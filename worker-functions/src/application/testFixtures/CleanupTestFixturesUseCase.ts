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
 *   job_posting_id IN (${TEST_JOB_IDS})
 * Nunca um DELETE sem esse filtro — dado real nunca é tocado. `patients` NÃO
 * é tocada aqui.
 *
 * PROTEÇÃO (SUP-F1-22): worker/job_posting is_test com QUALQUER alocação (ACTIVE,
 * ENDED ou CANCELLED) em `patient_itinerary_assignment` (FKs worker_id e
 * application_id sem ON DELETE, mig 480) são PULADOS, junto com os filhos deles.
 * Antes só a ACTIVE poupava, e uma alocação ENDED/CANCELLED fazia o DELETE de
 * workers/worker_job_applications violar a FK e dar ROLLBACK da faxina inteira.
 * A faxina NUNCA apaga alocação: `app_runtime` não tem DELETE em
 * assignment/absence/change_log (REVOKE nas mig 480/484/494, trilha append-only).
 *
 * CONTAS-BASE (spec 077): lista fechada de e-mails em TEST_BASE_ACCOUNT_EMAILS,
 * poupadas sempre (mesmo sem alocação) — são a massa fixa dos fluxos e2e.
 * Os filtros `IN (...)` abaixo usam os fragmentos TEST_WORKER_IDS / TEST_JOB_IDS
 * (só os NÃO protegidos).
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
import { LUZ_PRUEBA_SINTETICA_AUTH_UID } from '../../modules/agentes/domain/LuzPruebaSintetica';

const log = logger.child({ source: 'CleanupTestFixturesUseCase' });

/**
 * Contas-base da massa de teste da 077 — NUNCA apagadas pela faxina. Lista FECHADA
 * (sem padrão/glob): conta nova só entra por edição explícita aqui. Fonte única;
 * o e-mail nunca é logado (a comparação é só no SQL).
 */
export const TEST_BASE_ACCOUNT_EMAILS: readonly string[] = [
  'qa.worker.inc@enlite.test',
  'qa.worker.longe@enlite.test',
  'qa.worker.ks@enlite.test',
  'qa.worker.subst@enlite.test',
  'qa.worker.at@enlite.test',
];

/** Literal SQL da allowlist; a validação do formato fecha qualquer injeção por edição futura. */
const BASE_ACCOUNTS_SQL = TEST_BASE_ACCOUNT_EMAILS.map((e) => {
  if (!/^[a-z0-9._-]+@enlite\.test$/.test(e)) throw new Error('TEST_BASE_ACCOUNT_EMAILS: formato inválido');
  return `'${e.trim().toLowerCase()}'`;
}).join(', ');

/** workers is_test, fora da allowlist e SEM nenhuma alocação (qualquer status). */
const TEST_WORKER_IDS = `SELECT w.id FROM workers w WHERE w.is_test = true
              AND (w.email IS NULL OR lower(btrim(w.email)) NOT IN (${BASE_ACCOUNTS_SQL}))
              AND NOT EXISTS (SELECT 1 FROM patient_itinerary_assignment a
                              WHERE a.worker_id = w.id)`;

/** job_postings is_test SEM nenhuma alocação (via candidatura da alocação, qualquer status). */
const TEST_JOB_IDS = `SELECT jp.id FROM job_postings jp WHERE jp.is_test = true
              AND NOT EXISTS (SELECT 1 FROM patient_itinerary_assignment a
                              JOIN worker_job_applications wja ON wja.id = a.application_id
                              WHERE wja.job_posting_id = jp.id)`;

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
          WHERE worker_id IN (${TEST_WORKER_IDS})
             OR job_posting_id IN (${TEST_JOB_IDS})`,
  },
  {
    key: 'worker_job_applications',
    sql: `DELETE FROM worker_job_applications
          WHERE (worker_id IN (${TEST_WORKER_IDS})
             OR job_posting_id IN (${TEST_JOB_IDS}))
            AND NOT EXISTS (SELECT 1 FROM patient_itinerary_assignment a
                            WHERE a.application_id = worker_job_applications.id)`,
  },
  {
    key: 'encuadres',
    sql: `DELETE FROM encuadres
          WHERE worker_id IN (${TEST_WORKER_IDS})
             OR job_posting_id IN (${TEST_JOB_IDS})`,
  },
  {
    key: 'worker_service_areas',
    sql: `DELETE FROM worker_service_areas
          WHERE worker_id IN (${TEST_WORKER_IDS})`,
  },
  {
    key: 'worker_documents',
    sql: `DELETE FROM worker_documents
          WHERE worker_id IN (${TEST_WORKER_IDS})`,
  },
  {
    key: 'worker_availability',
    sql: `DELETE FROM worker_availability
          WHERE worker_id IN (${TEST_WORKER_IDS})`,
  },
  {
    key: 'worker_blocked_applications',
    sql: `DELETE FROM worker_blocked_applications
          WHERE worker_id IN (${TEST_WORKER_IDS})
             OR job_posting_id IN (${TEST_JOB_IDS})`,
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
        `DELETE FROM job_postings jp WHERE jp.is_test = true
           AND NOT EXISTS (SELECT 1 FROM patient_itinerary_assignment a
                           JOIN worker_job_applications wja ON wja.id = a.application_id
                           WHERE wja.job_posting_id = jp.id)`,
      );
      deleted.job_postings = jobPostingsRes.rowCount ?? 0;

      const workersRes = await client.query(
        // Spec 086: a prestadora sintética da Luz (prueba) é is_test=true mas FICA (auth_uid fixo); os filhos dela acima somem como os de qualquer is_test.
        `DELETE FROM workers w WHERE w.is_test = true AND w.auth_uid <> $1
           AND (w.email IS NULL OR lower(btrim(w.email)) NOT IN (${BASE_ACCOUNTS_SQL}))
           AND NOT EXISTS (SELECT 1 FROM patient_itinerary_assignment a
                           WHERE a.worker_id = w.id)`,
        [LUZ_PRUEBA_SINTETICA_AUTH_UID],
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
