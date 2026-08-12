/**
 * ReconcileClickUpPatientsUseCase — Unit Tests
 *
 * Cobre os quatro modos, a guarda de concorrência (advisory lock), os contadores
 * e o isolamento de erro por task. O caso que justifica a change tem teste
 * próprio: um órfão de CASE_NUMBER_CONFLICT é rebuscado e reprocessado
 * (modo `orphans`) — o incidente do caso 601.
 */

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  ReconcileClickUpPatientsUseCase,
  type ReconcileMode,
} from '../../../src/modules/integration/application/ReconcileClickUpPatientsUseCase';
import type { ClickUpTask } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import type { SyncPatientResult } from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';

const NOW = 1_700_000_000_000;

function task(id: string): ClickUpTask {
  return { id } as unknown as ClickUpTask;
}

function updated(taskId: string): SyncPatientResult {
  return { kind: 'UPDATED', patientId: `p-${taskId}`, flagged: false, taskId, patientName: 'X' };
}

function fakePool(opts: { locked?: boolean; orphanIds?: string[] } = {}) {
  const sqls: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      sqls.push(sql);
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked: opts.locked ?? true }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => client),
    query: jest.fn(async (sql: string) => {
      sqls.push(sql);
      return { rows: (opts.orphanIds ?? []).map(id => ({ clickup_task_id: id })) };
    }),
  };
  return { pool, client, sqls };
}

function fakeGateway(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fetchUpdatedSince: jest.fn(async () => [] as ClickUpTask[]),
    fetchAll: jest.fn(async () => [] as ClickUpTask[]),
    fetchById: jest.fn(async (id: string) => task(id)),
    ...overrides,
  } as never;
}

function fakeSync(impl?: (t: ClickUpTask) => Promise<SyncPatientResult>) {
  return {
    execute: jest.fn(impl ?? (async (t: ClickUpTask) => updated(t.id))),
  } as never;
}

function build(parts: {
  pool?: ReturnType<typeof fakePool>;
  gateway?: ReturnType<typeof fakeGateway>;
  sync?: ReturnType<typeof fakeSync>;
}) {
  const pool = parts.pool ?? fakePool();
  const gateway = parts.gateway ?? fakeGateway();
  const sync = parts.sync ?? fakeSync();
  const useCase = new ReconcileClickUpPatientsUseCase({
    gateway: gateway as never,
    syncUseCase: sync as never,
    pool: pool.pool as never,
  });
  return { useCase, pool, gateway: gateway as never, sync: sync as never };
}

function run(useCase: ReconcileClickUpPatientsUseCase, mode: ReconcileMode, windowMinutes = 30) {
  return useCase.execute({ mode, windowMinutes, now: () => NOW });
}

describe('ReconcileClickUpPatientsUseCase', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('guarda de concorrência', () => {
    it('devolve BUSY e não toca no ClickUp quando o lock já está tomado', async () => {
      const pool = fakePool({ locked: false });
      const { useCase, gateway } = build({ pool });

      const outcome = await run(useCase, 'cycle');

      expect(outcome.kind).toBe('BUSY');
      expect((gateway as never as { fetchUpdatedSince: jest.Mock }).fetchUpdatedSince).not.toHaveBeenCalled();
    });

    it('libera o lock e devolve o client à pool depois de rodar', async () => {
      const pool = fakePool();
      const { useCase } = build({ pool });

      await run(useCase, 'incremental');

      expect(pool.sqls.some(s => s.includes('pg_advisory_unlock'))).toBe(true);
      expect(pool.client.release).toHaveBeenCalled();
    });

    it('libera o lock mesmo quando a reconciliação falha', async () => {
      const pool = fakePool();
      const gateway = fakeGateway({
        fetchUpdatedSince: jest.fn(async () => {
          throw new Error('ClickUp fora do ar');
        }),
      });
      const { useCase } = build({ pool, gateway });

      await expect(run(useCase, 'incremental')).rejects.toThrow('ClickUp fora do ar');

      expect(pool.sqls.some(s => s.includes('pg_advisory_unlock'))).toBe(true);
      expect(pool.client.release).toHaveBeenCalled();
    });
  });

  describe('modo incremental', () => {
    it('busca a janela a partir de now - windowMinutes', async () => {
      const gateway = fakeGateway();
      const { useCase } = build({ gateway });

      await run(useCase, 'incremental', 30);

      expect((gateway as never as { fetchUpdatedSince: jest.Mock }).fetchUpdatedSince)
        .toHaveBeenCalledWith(NOW - 30 * 60_000);
    });

    it('não consulta órfãos', async () => {
      const pool = fakePool({ orphanIds: ['o1'] });
      const { useCase } = build({ pool });

      await run(useCase, 'incremental');

      expect(pool.pool.query).not.toHaveBeenCalled();
    });
  });

  describe('modo orphans', () => {
    it('seleciona só case_number NULL + needs_attention e reprocessa cada card', async () => {
      const pool = fakePool({ orphanIds: ['86abq2pzg'] });
      const gateway = fakeGateway();
      const sync = fakeSync();
      const { useCase } = build({ pool, gateway, sync });

      const outcome = await run(useCase, 'orphans');

      const sql = pool.sqls.find(s => s.includes('FROM patients')) ?? '';
      expect(sql).toContain('case_number IS NULL');
      expect(sql).toContain('needs_attention = true');
      expect(sql).toContain('deleted_at IS NULL');

      expect((gateway as never as { fetchById: jest.Mock }).fetchById).toHaveBeenCalledWith('86abq2pzg');
      expect((sync as never as { execute: jest.Mock }).execute).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ kind: 'DONE', counters: { updated: 1, processed: 1 } });
    });

    it('não chama a janela incremental', async () => {
      const gateway = fakeGateway();
      const { useCase } = build({ gateway });

      await run(useCase, 'orphans');

      expect((gateway as never as { fetchUpdatedSince: jest.Mock }).fetchUpdatedSince).not.toHaveBeenCalled();
    });

    it('conta como otherList o órfão cujo card saiu da lista de pacientes', async () => {
      const pool = fakePool({ orphanIds: ['movido'] });
      const gateway = fakeGateway({ fetchById: jest.fn(async () => null) });
      const sync = fakeSync();
      const { useCase } = build({ pool, gateway, sync });

      const outcome = await run(useCase, 'orphans');

      expect(outcome).toMatchObject({ counters: { skipped: { otherList: 1 } } });
      expect((sync as never as { execute: jest.Mock }).execute).not.toHaveBeenCalled();
    });

    it('falha ao buscar um órfão não impede os demais', async () => {
      const pool = fakePool({ orphanIds: ['ruim', 'bom'] });
      const gateway = fakeGateway({
        fetchById: jest.fn(async (id: string) => {
          if (id === 'ruim') throw new Error('404');
          return task(id);
        }),
      });
      const sync = fakeSync();
      const { useCase } = build({ pool, gateway, sync });

      const outcome = await run(useCase, 'orphans');

      expect(outcome).toMatchObject({ counters: { errors: 1, updated: 1 } });
      expect((sync as never as { execute: jest.Mock }).execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('modo cycle (default do scheduler)', () => {
    it('roda janela incremental E órfãos na mesma execução', async () => {
      const pool = fakePool({ orphanIds: ['o1'] });
      const gateway = fakeGateway({
        fetchUpdatedSince: jest.fn(async () => [task('w1')]),
      });
      const { useCase } = build({ pool, gateway });

      const outcome = await run(useCase, 'cycle');

      expect((gateway as never as { fetchUpdatedSince: jest.Mock }).fetchUpdatedSince).toHaveBeenCalled();
      expect((gateway as never as { fetchById: jest.Mock }).fetchById).toHaveBeenCalledWith('o1');
      expect(outcome).toMatchObject({ counters: { fetched: 2, processed: 2 } });
    });
  });

  describe('modo full', () => {
    it('varre a lista inteira e não usa janela', async () => {
      const gateway = fakeGateway({ fetchAll: jest.fn(async () => [task('a'), task('b')]) });
      const { useCase } = build({ gateway });

      const outcome = await run(useCase, 'full');

      expect((gateway as never as { fetchAll: jest.Mock }).fetchAll).toHaveBeenCalled();
      expect((gateway as never as { fetchUpdatedSince: jest.Mock }).fetchUpdatedSince).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ counters: { fetched: 2, windowMinutes: null } });
    });
  });

  describe('contadores', () => {
    it('conta CASE_NUMBER_CONFLICT como conflito, não como erro', async () => {
      const gateway = fakeGateway({ fetchAll: jest.fn(async () => [task('c')]) });
      const sync = fakeSync(async () => ({
        kind: 'CASE_NUMBER_CONFLICT',
        patientId: 'p1',
        taskId: 'c',
        caseNumber: 600,
        patientName: 'X',
      }));
      const { useCase } = build({ gateway, sync });

      const outcome = await run(useCase, 'full');

      expect(outcome).toMatchObject({ counters: { conflicts: 1, errors: 0, processed: 1 } });
    });

    it('separa os tipos de skip', async () => {
      const gateway = fakeGateway({
        fetchAll: jest.fn(async () => [task('s'), task('n'), task('m')]),
      });
      const sync = fakeSync(async (t: ClickUpTask) => {
        if (t.id === 's') return { kind: 'SKIPPED_SUBTASK', taskId: 's' };
        if (t.id === 'n') return { kind: 'SKIPPED_NO_PATIENT_NAME', taskId: 'n' };
        return { kind: 'SKIPPED_MAPPER_NULL', taskId: 'm' };
      });
      const { useCase } = build({ gateway, sync });

      const outcome = await run(useCase, 'full');

      expect(outcome).toMatchObject({
        counters: { processed: 0, skipped: { subtask: 1, noName: 1, mapperNull: 1 } },
      });
    });

    it('uma task que estoura não aborta as demais', async () => {
      const gateway = fakeGateway({
        fetchAll: jest.fn(async () => [task('boom'), task('ok')]),
      });
      const sync = fakeSync(async (t: ClickUpTask) => {
        if (t.id === 'boom') throw new Error('erro inesperado');
        return updated(t.id);
      });
      const { useCase } = build({ gateway, sync });

      const outcome = await run(useCase, 'full');

      expect(outcome).toMatchObject({ counters: { errors: 1, updated: 1, processed: 1 } });
    });

    it('conta CREATED separado de UPDATED', async () => {
      const gateway = fakeGateway({ fetchAll: jest.fn(async () => [task('new')]) });
      const sync = fakeSync(async () => ({
        kind: 'CREATED',
        patientId: 'p',
        flagged: false,
        taskId: 'new',
        patientName: 'X',
      }));
      const { useCase } = build({ gateway, sync });

      const outcome = await run(useCase, 'full');

      expect(outcome).toMatchObject({ counters: { created: 1, updated: 0 } });
    });
  });

  describe('incidente do caso 601 (o teste que justifica a change)', () => {
    it('órfão volta a ser processado depois que o conflito é resolvido no ClickUp', async () => {
      // Estado: o card do caso 601 está no banco sem case_number (perdeu o conflito).
      const pool = fakePool({ orphanIds: ['86abq2pzg'] });
      // No ClickUp o conflito já foi resolvido — o card rival foi renumerado.
      const gateway = fakeGateway({ fetchById: jest.fn(async (id: string) => task(id)) });
      const sync = fakeSync(async (t: ClickUpTask) => updated(t.id));
      const { useCase } = build({ pool, gateway, sync });

      const outcome = await run(useCase, 'orphans');

      // O card é rebuscado e reprocessado pelo caminho de produção — sem intervenção manual.
      expect((gateway as never as { fetchById: jest.Mock }).fetchById).toHaveBeenCalledWith('86abq2pzg');
      expect((sync as never as { execute: jest.Mock }).execute).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ kind: 'DONE', counters: { updated: 1, errors: 0 } });
    });

    it('enquanto o conflito NÃO for resolvido, segue órfão sem virar erro', async () => {
      const pool = fakePool({ orphanIds: ['86abj6ehp'] }); // caso 600, conflito ativo
      const sync = fakeSync(async () => ({
        kind: 'CASE_NUMBER_CONFLICT',
        patientId: 'p',
        taskId: '86abj6ehp',
        caseNumber: 600,
        patientName: 'X',
      }));
      const { useCase } = build({ pool, sync });

      const outcome = await run(useCase, 'orphans');

      expect(outcome).toMatchObject({ counters: { conflicts: 1, errors: 0 } });
    });
  });
});
