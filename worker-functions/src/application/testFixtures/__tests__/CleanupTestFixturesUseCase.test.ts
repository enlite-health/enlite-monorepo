/**
 * CleanupTestFixturesUseCase.test.ts
 *
 * bug-shield red-first: mocka o Pool/PoolClient com um "fake DB" em memória
 * cujas queries DELETE são interpretadas contra fixtures mutáveis — não é um
 * simples mock de retorno fixo. Isso prova comportamento real de SQL:
 *   - a subquery `WHERE worker_id IN (SELECT id FROM workers WHERE is_test)`
 *     é avaliada contra o ESTADO ATUAL da fixture no momento da chamada —
 *     se a ordem do use case deletar `workers` ANTES dos filhos, a fixture já
 *     não tem mais o worker de teste e a contagem dos filhos vem errada (0).
 *   - portanto este teste PROVA a ordem "filhos primeiro", não só confia nela.
 *
 * Cenário (conforme especificado):
 *   1 worker is_test (com WJA + outbox + service_area + encuadre + blocked_application)
 *   1 worker real     (com WJA + outbox)
 *   1 job_posting is_test (com WJA + outbox + blocked_application filhos)
 *   1 job_posting real
 *
 * Cleanup deve apagar SOMENTE o que é is_test, na ordem certa, sem violar FK,
 * e o worker/job_posting real (+ seus filhos) permanecem intactos.
 */

import type { Pool, PoolClient } from 'pg';
import { CleanupTestFixturesUseCase } from '../CleanupTestFixturesUseCase';

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

// ── Fake DB em memória ──────────────────────────────────────────────────────

interface Row {
  id: string;
  worker_id?: string | null;
  job_posting_id?: string | null;
  is_test?: boolean;
}

interface FakeDb {
  workers: Row[];
  job_postings: Row[];
  messaging_outbox: Row[];
  worker_job_applications: Row[];
  encuadres: Row[];
  worker_service_areas: Row[];
  worker_documents: Row[];
  worker_availability: Row[];
  worker_blocked_applications: Row[];
}

const CHILD_TABLES = [
  'messaging_outbox',
  'worker_job_applications',
  'encuadres',
  'worker_service_areas',
  'worker_documents',
  'worker_availability',
  'worker_blocked_applications',
] as const;

function makeFixture(): FakeDb {
  return {
    workers: [
      { id: 'w-test', is_test: true },
      { id: 'w-real', is_test: false },
    ],
    job_postings: [
      { id: 'jp-test', is_test: true },
      { id: 'jp-real', is_test: false },
    ],
    messaging_outbox: [
      { id: 'mo-1', worker_id: 'w-test', job_posting_id: null },
      { id: 'mo-2', worker_id: 'w-real', job_posting_id: null },
      { id: 'mo-3', worker_id: 'w-real', job_posting_id: 'jp-test' }, // apaga via job_posting_id, worker real
    ],
    worker_job_applications: [
      { id: 'wja-1', worker_id: 'w-test', job_posting_id: 'jp-real' },
      { id: 'wja-2', worker_id: 'w-real', job_posting_id: 'jp-real' }, // 100% real — nunca toca
      { id: 'wja-3', worker_id: 'w-real', job_posting_id: 'jp-test' },
    ],
    encuadres: [
      { id: 'en-1', worker_id: 'w-test', job_posting_id: 'jp-real' },
    ],
    worker_service_areas: [
      { id: 'sa-1', worker_id: 'w-test' },
      { id: 'sa-2', worker_id: 'w-real' },
    ],
    worker_documents: [
      { id: 'doc-1', worker_id: 'w-real' },
    ],
    worker_availability: [],
    worker_blocked_applications: [
      { id: 'ba-1', worker_id: 'w-test', job_posting_id: 'jp-real' },
    ],
  };
}

/** Interpreta `DELETE FROM <table> WHERE ...` contra a fixture mutável. */
function makeFakeClient(db: FakeDb): PoolClient {
  const query = jest.fn(async (sql: string) => {
    const trimmed = sql.trim();

    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    const match = trimmed.match(/^DELETE FROM (\w+)/);
    if (!match) throw new Error(`fake client: query inesperada: ${trimmed}`);
    const table = match[1];

    if (table === 'workers') {
      const before = db.workers.length;
      db.workers = db.workers.filter(w => !w.is_test);
      return { rows: [], rowCount: before - db.workers.length };
    }
    if (table === 'job_postings') {
      const before = db.job_postings.length;
      db.job_postings = db.job_postings.filter(j => !j.is_test);
      return { rows: [], rowCount: before - db.job_postings.length };
    }
    if (!(CHILD_TABLES as readonly string[]).includes(table)) {
      throw new Error(`fake client: tabela desconhecida: ${table}`);
    }

    // Subquery avaliada contra o ESTADO ATUAL (não um snapshot pré-calculado) —
    // é isso que expõe erro de ordem (parent deletado antes do filho).
    const testWorkerIds = new Set(db.workers.filter(w => w.is_test).map(w => w.id));
    const testJobIds = new Set(db.job_postings.filter(j => j.is_test).map(j => j.id));
    const hasJobPostingClause = trimmed.includes('job_posting_id IN');

    const rows = db[table as keyof FakeDb] as Row[];
    const before = rows.length;
    const kept = rows.filter(r => {
      const workerMatch = r.worker_id != null && testWorkerIds.has(r.worker_id);
      const jobMatch = hasJobPostingClause && r.job_posting_id != null && testJobIds.has(r.job_posting_id);
      return !(workerMatch || jobMatch);
    });
    (db as unknown as Record<string, Row[]>)[table] = kept;
    return { rows: [], rowCount: before - kept.length };
  });

  return { query, release: jest.fn() } as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
}

// ── Testes ───────────────────────────────────────────────────────────────

describe('CleanupTestFixturesUseCase', () => {
  it('apaga SÓ o worker/job_posting is_test e os filhos correlacionados, preservando dado real', async () => {
    const db = makeFixture();
    const client = makeFakeClient(db);
    const useCase = new CleanupTestFixturesUseCase(makePool(client));

    const result = await useCase.execute();

    expect(result.deleted).toEqual({
      messaging_outbox: 2, // mo-1 (worker test) + mo-3 (job_posting test)
      worker_job_applications: 2, // wja-1 (worker test) + wja-3 (job_posting test)
      encuadres: 1,
      worker_service_areas: 1,
      worker_documents: 0,
      worker_availability: 0,
      worker_blocked_applications: 1,
      job_postings: 1,
      workers: 1,
    });

    // ── Blindagem: dado real permanece intacto ──────────────────────────────
    expect(db.workers.map(w => w.id)).toEqual(['w-real']);
    expect(db.job_postings.map(j => j.id)).toEqual(['jp-real']);
    expect(db.worker_job_applications.map(r => r.id)).toEqual(['wja-2']);
    expect(db.messaging_outbox.map(r => r.id)).toEqual(['mo-2']);
    expect(db.worker_documents.map(r => r.id)).toEqual(['doc-1']);
    expect(db.worker_service_areas.map(r => r.id)).toEqual(['sa-2']);
  });

  it('roda dentro de uma transação (BEGIN...COMMIT) e libera o client', async () => {
    const db = makeFixture();
    const client = makeFakeClient(db);
    const pool = makePool(client);
    const useCase = new CleanupTestFixturesUseCase(pool);

    await useCase.execute();

    const calls = (client.query as jest.Mock).mock.calls.map(c => String(c[0]).trim());
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('faz ROLLBACK e propaga o erro quando um DELETE falha', async () => {
    const db = makeFixture();
    const client = makeFakeClient(db);
    const realQuery = client.query as jest.Mock;
    let callCount = 0;
    const spy = jest.fn(async (sql: string) => {
      callCount++;
      // BEGIN (1ª call) passa; a 2ª call (1º DELETE filho) explode.
      if (callCount === 2) throw new Error('boom');
      return realQuery(sql);
    });
    (client as unknown as { query: typeof spy }).query = spy;

    const useCase = new CleanupTestFixturesUseCase(makePool(client));
    await expect(useCase.execute()).rejects.toThrow('boom');

    const calls = spy.mock.calls.map(c => String(c[0]).trim());
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);

    // Nenhum dado foi apagado — fixture intacta (transação não commitou).
    expect(db.workers).toHaveLength(2);
  });
});
