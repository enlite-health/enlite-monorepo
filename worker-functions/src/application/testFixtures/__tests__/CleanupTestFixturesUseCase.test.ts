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
import { CleanupTestFixturesUseCase, TEST_BASE_ACCOUNT_EMAILS } from '../CleanupTestFixturesUseCase';
import { LUZ_PRUEBA_SINTETICA_AUTH_UID } from '../../../modules/agentes/domain/LuzPruebaSintetica';

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
  auth_uid?: string;
  email?: string;
  application_id?: string;
  status?: string;
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
  patient_itinerary_assignment: Row[];
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
    patient_itinerary_assignment: [],
  };
}

/**
 * Interpreta `DELETE FROM <table> WHERE ...` contra a fixture mutável e SIMULA as
 * FKs sem ON DELETE da mig 480: apagar worker/candidatura/vaga referenciado por
 * QUALQUER alocação lança 23503 (o ROLLBACK real da faxina). Sem alocação apagada
 * pelo use case: o fake rejeita DELETE em patient_itinerary_assignment (REVOKE).
 */
function makeFakeClient(db: FakeDb): PoolClient {
  const fkError = (what: string) => Object.assign(new Error(`violates foreign key constraint (${what})`), { code: '23503' });
  const baseAccounts = new Set(TEST_BASE_ACCOUNT_EMAILS);
  const isBase = (w: Row) => w.email != null && baseAccounts.has(w.email.toLowerCase());
  const assignedWorkers = () => new Set(db.patient_itinerary_assignment.map(a => a.worker_id));
  const assignedApps = () => new Set(db.patient_itinerary_assignment.map(a => a.application_id));
  const assignedJobs = () => {
    const apps = assignedApps();
    return new Set(db.worker_job_applications.filter(w => apps.has(w.id)).map(w => w.job_posting_id));
  };

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const trimmed = sql.trim();

    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    const match = trimmed.match(/^DELETE FROM (\w+)/);
    if (!match) throw new Error(`fake client: query inesperada: ${trimmed}`);
    const table = match[1];
    if (table === 'patient_itinerary_assignment') throw new Error('permission denied: sem DELETE em patient_itinerary_assignment');

    // Cada DELETE só vale se o SQL carrega as guardas (o fake só poupa o que o SQL manda poupar).
    const sparesAnyAssignment = /NOT EXISTS \(SELECT 1 FROM patient_itinerary_assignment/.test(trimmed) && !trimmed.includes("'ACTIVE'");
    const sparesBase = trimmed.includes('NOT IN (') && trimmed.includes('@enlite.test');

    if (table === 'workers') {
      const before = db.workers.length;
      const poupa = trimmed.includes('auth_uid <> $1') ? String(params?.[0]) : null;
      const assigned = assignedWorkers();
      db.workers = db.workers.filter(w => {
        const alvo = w.is_test && !(poupa !== null && w.auth_uid === poupa) && !(sparesBase && isBase(w)) && !(sparesAnyAssignment && assigned.has(w.id));
        if (alvo && assigned.has(w.id)) throw fkError('patient_itinerary_assignment_worker_id_fkey');
        return !alvo;
      });
      return { rows: [], rowCount: before - db.workers.length };
    }
    if (table === 'job_postings') {
      const before = db.job_postings.length;
      const jobs = assignedJobs();
      db.job_postings = db.job_postings.filter(j => {
        const alvo = j.is_test && !(sparesAnyAssignment && jobs.has(j.id));
        if (alvo && jobs.has(j.id)) throw fkError('patient_itinerary_assignment_application_id_fkey');
        return !alvo;
      });
      return { rows: [], rowCount: before - db.job_postings.length };
    }
    if (!(CHILD_TABLES as readonly string[]).includes(table)) {
      throw new Error(`fake client: tabela desconhecida: ${table}`);
    }

    // Subquery avaliada contra o ESTADO ATUAL — expõe erro de ordem (pai antes do filho).
    const assigned = assignedWorkers();
    const testWorkerIds = new Set(db.workers.filter(w => w.is_test && !isBase(w) && !assigned.has(w.id)).map(w => w.id));
    const jobsAssigned = assignedJobs();
    const testJobIds = new Set(db.job_postings.filter(j => j.is_test && !jobsAssigned.has(j.id)).map(j => j.id));
    const hasJobPostingClause = trimmed.includes('job_posting_id IN');
    const apps = assignedApps();

    const rows = db[table as keyof FakeDb] as Row[];
    const before = rows.length;
    const kept = rows.filter(r => {
      const workerMatch = r.worker_id != null && testWorkerIds.has(r.worker_id);
      const jobMatch = hasJobPostingClause && r.job_posting_id != null && testJobIds.has(r.job_posting_id);
      const alvo = workerMatch || jobMatch;
      if (alvo && table === 'worker_job_applications' && apps.has(r.id)) {
        if (sparesAnyAssignment) return true; // guarda do SQL: candidatura com alocação fica
        throw fkError('patient_itinerary_assignment_application_id_fkey');
      }
      return !alvo;
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

  it('spec 086: a prestadora sintética (is_test=true, auth_uid fixo) PERMANECE; o outro is_test some; os filhos da sintética somem', async () => {
    const db = makeFixture();
    db.workers.push({ id: 'w-sint', is_test: true, auth_uid: LUZ_PRUEBA_SINTETICA_AUTH_UID });
    db.messaging_outbox.push({ id: 'mo-sint', worker_id: 'w-sint', job_posting_id: null });
    const result = await new CleanupTestFixturesUseCase(makePool(makeFakeClient(db))).execute();

    expect(result.deleted.workers).toBe(1); // só w-test; a sintética fica
    expect(db.workers.map(w => w.id).sort()).toEqual(['w-real', 'w-sint']);
    expect(db.messaging_outbox.map(r => r.id)).not.toContain('mo-sint'); // rastro de teste da sintética some
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

  describe('proteção de fixture com alocação (qualquer status) e contas-base', () => {
    const run = async (db: FakeDb) => {
      const client = makeFakeClient(db);
      const result = await new CleanupTestFixturesUseCase(makePool(client)).execute();
      const all = (client.query as jest.Mock).mock.calls.map(c => String(c[0]));
      return { result, all, client };
    };
    const alocar = (db: FakeDb, workerId: string, appId: string, status: string) =>
      db.patient_itinerary_assignment.push({ id: `a-${workerId}-${status}`, worker_id: workerId, application_id: appId, status });

    it('os DELETE de workers/job_postings/candidaturas/filhos carregam NOT EXISTS da alocação SEM filtro de status', async () => {
      const { all } = await run(makeFixture());
      const finals = all.filter(q => /^DELETE FROM (workers|job_postings) /.test(q.trim()));
      expect(finals).toHaveLength(2);
      for (const q of finals) {
        expect(q).toContain('NOT EXISTS');
        expect(q).toContain('patient_itinerary_assignment');
        expect(q).not.toContain("'ACTIVE'");
      }
      const children = all.filter(q => /^DELETE FROM (?!workers |job_postings )\w+/.test(q.trim()));
      expect(children).toHaveLength(7);
      for (const q of children) {
        expect(q).toContain('NOT EXISTS');
        expect(q).not.toContain("'ACTIVE'");
      }
      expect(all.some(q => /DELETE FROM patient_itinerary/.test(q))).toBe(false);
    });

    it('(a) worker is_test com alocação ENDED NÃO dá ROLLBACK: é poupado (com a candidatura), o resto da faxina commita', async () => {
      const db = makeFixture();
      db.workers.push({ id: 'w-test-ended', is_test: true });
      db.worker_job_applications.push({ id: 'wja-ended', worker_id: 'w-test-ended', job_posting_id: 'jp-real' });
      db.worker_service_areas.push({ id: 'sa-ended', worker_id: 'w-test-ended' });
      alocar(db, 'w-test-ended', 'wja-ended', 'ENDED');
      alocar(db, 'w-test-ended', 'wja-ended', 'CANCELLED');
      const { result, all } = await run(db);

      expect(all[all.length - 1].trim()).toBe('COMMIT');
      expect(all.some(q => q.trim() === 'ROLLBACK')).toBe(false);
      expect(result.deleted.workers).toBe(1); // só w-test
      expect(db.workers.map(w => w.id).sort()).toEqual(['w-real', 'w-test-ended']);
      expect(db.worker_job_applications.map(r => r.id)).toContain('wja-ended');
      expect(db.worker_service_areas.map(r => r.id)).toContain('sa-ended');
      expect(db.patient_itinerary_assignment).toHaveLength(2); // alocação nunca é apagada
    });

    it('(a) worker is_test com alocação ACTIVE continua poupado e a contagem reflete só os apagados', async () => {
      const db = makeFixture();
      db.workers.push({ id: 'w-test-active', is_test: true });
      db.worker_job_applications.push({ id: 'wja-active', worker_id: 'w-test-active', job_posting_id: 'jp-real' });
      db.worker_service_areas.push({ id: 'sa-3', worker_id: 'w-test-active' });
      alocar(db, 'w-test-active', 'wja-active', 'ACTIVE');
      const { result } = await run(db);

      expect(result.deleted.workers).toBe(1);
      expect(result.deleted.worker_service_areas).toBe(1); // só sa-1
      expect(db.workers.map(w => w.id).sort()).toEqual(['w-real', 'w-test-active']);
      expect(db.worker_service_areas.map(r => r.id).sort()).toEqual(['sa-2', 'sa-3']);
    });

    it('(b) worker REAL com alocação (e candidatura em vaga de teste) nunca é tocado', async () => {
      const db = makeFixture();
      alocar(db, 'w-real', 'wja-3', 'ENDED'); // wja-3 = w-real em jp-test
      const { result, all } = await run(db);

      expect(all.some(q => q.trim() === 'ROLLBACK')).toBe(false);
      expect(db.workers.map(w => w.id)).toContain('w-real');
      expect(db.worker_job_applications.map(r => r.id).sort()).toEqual(['wja-2', 'wja-3']);
      expect(db.job_postings.map(j => j.id)).toContain('jp-test'); // vaga com alocação da candidatura real fica
      expect(result.deleted.job_postings).toBe(0);
    });

    it('(c) worker is_test alocado a paciente REAL: não é apagado (nem a alocação, nem a candidatura)', async () => {
      const db = makeFixture();
      // o paciente real é invisível à faxina: a única informação é a alocação existir
      alocar(db, 'w-test', 'wja-1', 'ENDED');
      const { result, all } = await run(db);

      expect(all.some(q => q.trim() === 'ROLLBACK')).toBe(false);
      expect(result.deleted.workers).toBe(0);
      expect(db.workers.map(w => w.id).sort()).toEqual(['w-real', 'w-test']);
      expect(db.worker_job_applications.map(r => r.id)).toContain('wja-1');
      expect(db.patient_itinerary_assignment).toHaveLength(1);
    });

    it('job_posting is_test cuja candidatura tem alocação (qualquer status) permanece', async () => {
      const db = makeFixture();
      alocar(db, 'w-real', 'wja-3', 'CANCELLED');
      const { result } = await run(db);

      expect(result.deleted.job_postings).toBe(0);
      expect(db.job_postings.map(j => j.id).sort()).toEqual(['jp-real', 'jp-test']);
      expect(db.messaging_outbox.map(r => r.id)).toContain('mo-3'); // filho do job protegido fica
    });

    it('SEM a guarda no SQL, a alocação ENDED reproduz o ROLLBACK (o fake simula a FK; garante que o teste morre)', async () => {
      const db = makeFixture();
      db.workers.push({ id: 'w-fk', is_test: true });
      db.worker_job_applications.push({ id: 'wja-fk', worker_id: 'w-fk', job_posting_id: 'jp-real' });
      alocar(db, 'w-fk', 'wja-fk', 'ENDED');
      const client = makeFakeClient(db);
      await expect(client.query('DELETE FROM workers w WHERE w.is_test = true')).rejects.toMatchObject({ code: '23503' });
    });

    it('contas-base (allowlist fechada) NÃO são apagadas nem perdem os filhos, mesmo sem alocação; e-mail fora da lista some', async () => {
      const db = makeFixture();
      TEST_BASE_ACCOUNT_EMAILS.forEach((email, i) => {
        db.workers.push({ id: `w-base-${i}`, is_test: true, email: i % 2 ? email.toUpperCase() : email });
        db.worker_service_areas.push({ id: `sa-base-${i}`, worker_id: `w-base-${i}` });
      });
      db.workers.push({ id: 'w-qa-outra', is_test: true, email: 'qa.worker@enlite.test' }); // parecida, FORA da lista
      db.workers.push({ id: 'w-glob', is_test: true, email: 'qa.worker.novo@enlite.test' }); // glob não vale
      const { result } = await run(db);

      expect(TEST_BASE_ACCOUNT_EMAILS).toHaveLength(5);
      const ids = db.workers.map(w => w.id);
      for (let i = 0; i < 5; i++) expect(ids).toContain(`w-base-${i}`);
      expect(ids).not.toContain('w-qa-outra');
      expect(ids).not.toContain('w-glob');
      expect(result.deleted.workers).toBe(3); // w-test + as duas fora da lista
      expect(db.worker_service_areas.filter(r => r.id.startsWith('sa-base-'))).toHaveLength(5);
    });

    it('a allowlist está nos SQL de worker e dos filhos, e o e-mail nunca vai para log', async () => {
      const { all } = await run(makeFixture());
      const comEmail = all.filter(q => q.includes('@enlite.test'));
      expect(comEmail.length).toBeGreaterThanOrEqual(8); // 7 filhos com worker_id + DELETE workers (messaging/…)
      const logging = jest.requireMock('@shared/logging') as { logger: { child: jest.Mock } };
      const logger = logging.logger.child.mock.results[0]?.value as { info: jest.Mock };
      const logged = JSON.stringify(logger.info.mock.calls);
      expect(logged).not.toContain('@enlite.test');
    });
  });
});
