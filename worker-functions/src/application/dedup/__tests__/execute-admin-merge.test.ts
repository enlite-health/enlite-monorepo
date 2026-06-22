/**
 * execute-admin-merge.test.ts
 *
 * Testes unitários de ExecuteAdminMergeUseCase.
 * Cobre: happy path, survivor não encontrado, survivor já mergeado,
 * absorbed não encontrado (skip), absorbed já mergeado (skip),
 * fieldChoices com OVERRIDABLE_FIELDS, erro propagado.
 */

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

jest.mock('../../../infrastructure/services/WorkerPhoneMergeService');
jest.mock('../../../infrastructure/services/WorkerPhoneMergeFkDiscovery');

import type { Pool } from 'pg';
import { ExecuteAdminMergeUseCase } from '../ExecuteAdminMergeUseCase';
import { WorkerPhoneMergeService } from '../../../infrastructure/services/WorkerPhoneMergeService';
import { discoverWorkerFkTables } from '../../../infrastructure/services/WorkerPhoneMergeFkDiscovery';

const mockDiscoverFks = discoverWorkerFkTables as jest.MockedFunction<typeof discoverWorkerFkTables>;
const MockMergeService = WorkerPhoneMergeService as jest.MockedClass<typeof WorkerPhoneMergeService>;

// ── Pool mock helper ──────────────────────────────────────────────────────────

function makePool(responses: Array<{ rows: unknown[] }>): jest.Mocked<Pick<Pool, 'query'>> {
  let idx = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const resp = responses[idx++] ?? { rows: [] };
      return Promise.resolve(resp);
    }),
  } as unknown as jest.Mocked<Pick<Pool, 'query'>>;
}

const SURVIVOR_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ABSORBED_ID = 'aaaaaaaa-0000-0000-0000-000000000002';
const PHONE_NORM  = '5491100000001';

beforeEach(() => {
  jest.clearAllMocks();
  mockDiscoverFks.mockResolvedValue([]);
  MockMergeService.prototype.executeSingleMerge.mockResolvedValue(undefined);
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('ExecuteAdminMergeUseCase — happy path', () => {
  it('executa merge e retorna audit_ids quando absorvido existe e não está mergeado', async () => {
    const pool = makePool([
      // survivor query
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      // absorbed query
      { rows: [{ merged_into_id: null }] },
      // auditId query após merge
      { rows: [{ id: 42 }] },
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
    });

    expect(result.survivor_id).toBe(SURVIVOR_ID);
    expect(result.absorbed_ids).toEqual([ABSORBED_ID]);
    expect(result.audit_ids).toEqual([42]);
    expect(MockMergeService.prototype.executeSingleMerge).toHaveBeenCalledTimes(1);
  });

  it('retorna audit_ids vazio quando auditRes não tem linhas', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      { rows: [{ merged_into_id: null }] },
      { rows: [] }, // auditId query retorna vazio
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
    });

    expect(result.audit_ids).toEqual([]);
  });

  it('phone_normalized null é normalizado para string vazia', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: null, merged_into_id: null }] },
      { rows: [{ merged_into_id: null }] },
      { rows: [{ id: 7 }] },
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
    });

    expect(result.audit_ids).toEqual([7]);
    const call = MockMergeService.prototype.executeSingleMerge.mock.calls[0][0];
    expect(call.phoneNormalized).toBe('');
  });
});

// ── Erros de validação ────────────────────────────────────────────────────────

describe('ExecuteAdminMergeUseCase — erros de validação', () => {
  it('lança erro quando survivor não encontrado', async () => {
    const pool = makePool([{ rows: [] }]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    await expect(useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
    })).rejects.toThrow(`Survivor worker não encontrado: ${SURVIVOR_ID}`);
  });

  it('lança erro quando survivor já foi mergeado', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: 'some-other-id' }] },
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    await expect(useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
    })).rejects.toThrow(`Survivor ${SURVIVOR_ID} já foi mergeado`);
  });
});

// ── Casos de skip de absorbed ─────────────────────────────────────────────────

describe('ExecuteAdminMergeUseCase — skip de absorbed', () => {
  it('skipa absorbed não encontrado sem lançar erro', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      { rows: [] }, // absorbed não encontrado
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
    });

    expect(result.audit_ids).toEqual([]);
    expect(MockMergeService.prototype.executeSingleMerge).not.toHaveBeenCalled();
  });

  it('skipa absorbed que já está mergeado sem lançar erro', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      { rows: [{ merged_into_id: 'already-merged-into' }] },
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
    });

    expect(result.audit_ids).toEqual([]);
    expect(MockMergeService.prototype.executeSingleMerge).not.toHaveBeenCalled();
  });

  it('processa múltiplos absorbedIds: skipa inválidos e processa válidos', async () => {
    const ABSORBED2 = 'aaaaaaaa-0000-0000-0000-000000000003';

    const pool = makePool([
      // survivor
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      // absorbed 1: não encontrado → skip
      { rows: [] },
      // absorbed 2: válido
      { rows: [{ merged_into_id: null }] },
      // auditId para absorbed 2
      { rows: [{ id: 99 }] },
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID, ABSORBED2],
    });

    expect(result.audit_ids).toEqual([99]);
    expect(MockMergeService.prototype.executeSingleMerge).toHaveBeenCalledTimes(1);
  });
});

// ── fieldChoices ──────────────────────────────────────────────────────────────

describe('ExecuteAdminMergeUseCase — fieldChoices', () => {
  it('aplica overrides de OVERRIDABLE_FIELDS quando choice = "absorbed:<id>"', async () => {
    const pool = makePool([
      // survivor
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      // absorbed validation
      { rows: [{ merged_into_id: null }] },
      // SELECT absorbed row para fieldChoices (profession)
      { rows: [{ profession: 'AT', knowledge_level: null, years_experience: null, status: null }] },
      // UPDATE workers SET profession
      { rows: [] },
      // auditId
      { rows: [{ id: 55 }] },
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
      fieldChoices: {
        profession: `absorbed:${ABSORBED_ID}`,
        knowledge_level: 'survivor', // not 'absorbed:...' → skip
        some_encrypted_field: `absorbed:${ABSORBED_ID}`, // not in OVERRIDABLE_FIELDS → skip
      },
    });

    expect(result.audit_ids).toEqual([55]);

    const calls = (pool.query as jest.Mock).mock.calls;
    const updateCall = calls.find(
      (c: [string, unknown[]]) => c[0].includes('UPDATE workers SET') && c[0].includes('profession'),
    );
    expect(updateCall).toBeDefined();
  });

  it('não chama UPDATE quando nenhum choice é "absorbed:<id>" para campo OVERRIDABLE', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      { rows: [{ merged_into_id: null }] },
      // não deve ter SELECT do absorbed para fieldChoices
      { rows: [{ id: 66 }] },
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
      fieldChoices: {
        profession: 'survivor', // escolhe survivor → não sobrescreve
        non_overridable_field: `absorbed:${ABSORBED_ID}`, // campo não overridable → skip
      },
    });

    const calls = (pool.query as jest.Mock).mock.calls;
    const updateCall = calls.find(
      (c: [string, unknown[]]) => c[0].includes('UPDATE workers SET') && c[0].includes('profession'),
    );
    expect(updateCall).toBeUndefined();
  });

  it('fieldChoices com objeto vazio não chama applyFieldChoices', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      { rows: [{ merged_into_id: null }] },
      { rows: [{ id: 77 }] },
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
      fieldChoices: {},
    });

    // Apenas 3 queries: survivor, absorbed, auditId
    expect((pool.query as jest.Mock)).toHaveBeenCalledTimes(3);
  });

  it('skip applyFieldChoices quando absorbed não existe na query de override', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      { rows: [{ merged_into_id: null }] },
      // SELECT absorbed row para fieldChoices: 0 rows
      { rows: [] },
      // auditId
      { rows: [{ id: 88 }] },
    ]);

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
      fieldChoices: { profession: `absorbed:${ABSORBED_ID}` },
    });

    expect(result.audit_ids).toEqual([88]);
  });
});

// ── Propagação de erro ────────────────────────────────────────────────────────

describe('ExecuteAdminMergeUseCase — propagação de erro', () => {
  it('propaga erro lançado por executeSingleMerge', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      { rows: [{ merged_into_id: null }] },
    ]);

    MockMergeService.prototype.executeSingleMerge.mockRejectedValueOnce(
      new Error('merge failed: constraint violation'),
    );

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    await expect(useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
    })).rejects.toThrow('merge failed: constraint violation');
  });

  it('wraps erros não-Error em Error', async () => {
    const pool = makePool([
      { rows: [{ id: SURVIVOR_ID, phone_normalized: PHONE_NORM, merged_into_id: null }] },
      { rows: [{ merged_into_id: null }] },
    ]);

    MockMergeService.prototype.executeSingleMerge.mockRejectedValueOnce('string error');

    const useCase = new ExecuteAdminMergeUseCase(pool as unknown as Pool);
    await expect(useCase.execute({
      survivorId: SURVIVOR_ID,
      absorbedIds: [ABSORBED_ID],
    })).rejects.toThrow('string error');
  });
});
