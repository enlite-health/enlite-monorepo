/**
 * UpdateAiPromptUseCase — spec 029 T010.
 *
 * Molde de mocking: `ReactivateArchivedWorkerUseCase.test.ts` (pool/client fake, sem mockar
 * `@shared/logging` — `withActorContext` roda de verdade, sem sessão ALS ativa em teste, então
 * `applyCountryContext` vira no-op e o único GUC setado é o `ActorContext` explícito que o próprio
 * use case deriva). `AiPromptRepository` e `AiPromptAuditRepository` são injetados como dublês —
 * o SQL de cada um já tem prova própria em T007/T008; aqui testamos só a orquestração: lock
 * otimista, transação única, e o que vai para a trilha.
 */
import type { Pool, PoolClient } from 'pg';
import { UpdateAiPromptUseCase } from '../UpdateAiPromptUseCase';
import {
  AiPromptRepository,
  type AiPrompt,
  type UpdateAiPromptOutcome,
} from '../../infrastructure/AiPromptRepository';
import {
  AiPromptAuditRepository,
  type LogAiPromptEventParams,
} from '../../infrastructure/AiPromptAuditRepository';

const PROMPT_ID = '11111111-1111-1111-1111-111111111111';

function makeAiPrompt(overrides: Partial<AiPrompt> = {}): AiPrompt {
  return {
    slug: 'VACANCY_DESCRIPTION',
    body: 'Texto antigo.',
    version: 7,
    isActive: true,
    createdBy: 'uid-criador',
    updatedBy: 'uid-editor-anterior',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

/** Client fake: responde `SELECT id FROM ai_prompts` com PROMPT_ID; qualquer outra query (BEGIN,
 * set_config, COMMIT, ROLLBACK) devolve linha vazia — o que `withActorContext` não inspeciona. */
function makeClient(): { client: PoolClient; queryMock: jest.Mock } {
  const queryMock = jest.fn().mockImplementation((sql: string) => {
    if (String(sql).includes('SELECT id FROM ai_prompts')) {
      return Promise.resolve({ rows: [{ id: PROMPT_ID }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  const client = { query: queryMock, release: jest.fn() } as unknown as PoolClient;
  return { client, queryMock };
}

/** Variante de `makeClient` em que a busca do id pela FK volta vazia — simula o cenário
 * invariante impossível (linha sumiu na mesma transação logo após o UPDATE ter sucesso). */
function makeClientIdSumiu(): { client: PoolClient; queryMock: jest.Mock } {
  const queryMock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const client = { query: queryMock, release: jest.fn() } as unknown as PoolClient;
  return { client, queryMock };
}

function makePool(client: PoolClient): Pool {
  return { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
}

function makeRepo(overrides: {
  findBySlug?: jest.Mock;
  updateBody?: jest.Mock;
} = {}): AiPromptRepository {
  return {
    findBySlug: overrides.findBySlug ?? jest.fn(),
    updateBody: overrides.updateBody ?? jest.fn(),
    listAll: jest.fn(),
  } as unknown as AiPromptRepository;
}

function makeAuditRepo(logEvent?: jest.Mock): AiPromptAuditRepository {
  return { logEvent: logEvent ?? jest.fn().mockResolvedValue(undefined) } as unknown as AiPromptAuditRepository;
}

const HUMAN_ACTOR = { actorUserId: 'uid-1', actorType: 'HUMAN' as const, actorLabel: null };

describe('UpdateAiPromptUseCase (spec 029 T010)', () => {
  it('grava e incrementa a versão', async () => {
    const before = makeAiPrompt({ body: 'Texto antigo.', version: 7 });
    const updated = makeAiPrompt({ body: 'Texto novo.', version: 8, updatedBy: 'uid-1' });
    const findBySlug = jest.fn().mockResolvedValue(before);
    const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
    const { client, queryMock } = makeClient();
    const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client));

    const result = await useCase.execute(
      { slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 },
      HUMAN_ACTOR,
    );

    expect(result).toEqual({ outcome: 'updated', prompt: updated });
    expect(updateBody).toHaveBeenCalledWith('VACANCY_DESCRIPTION', 'Texto novo.', 7, 'uid-1', client);
    // Prova que persistiu: a transação foi até COMMIT (controle positivo do teste de rollback abaixo).
    expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(false);
  });

  it('versão divergente não grava e devolve conflito', async () => {
    const before = makeAiPrompt({ body: 'Texto antigo.', version: 7 });
    const findBySlug = jest.fn().mockResolvedValue(before);
    const updateBody = jest
      .fn()
      .mockResolvedValue({ outcome: 'conflict', currentVersion: 9, updatedBy: 'uid-outra-pessoa' } satisfies UpdateAiPromptOutcome);
    const { client, queryMock } = makeClient();
    const auditRepo = makeAuditRepo();
    const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), auditRepo, makePool(client));

    const result = await useCase.execute(
      { slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 },
      HUMAN_ACTOR,
    );

    expect(result).toEqual({ outcome: 'conflict', currentVersion: 9, updatedBy: 'uid-outra-pessoa' });
    // Não grava: nem a trilha é chamada, nem o id do prompt é buscado (short-circuit antes da FK lookup).
    expect(auditRepo.logEvent).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('SELECT id FROM ai_prompts'))).toBe(false);
  });

  it('slug válido sem linha na tabela (before não encontrado) devolve not_found sem abrir transação de escrita', async () => {
    const findBySlug = jest.fn().mockResolvedValue(null);
    const updateBody = jest.fn();
    const auditRepo = makeAuditRepo();
    const { client, queryMock } = makeClient();
    const pool = makePool(client);
    const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), auditRepo, pool);

    const result = await useCase.execute(
      { slug: 'PRESCREENING_AT', body: 'Texto novo.', expectedVersion: 1 },
      HUMAN_ACTOR,
    );

    expect(result).toEqual({ outcome: 'not_found' });
    // Curto-circuito ANTES de abrir a transação: nem updateBody, nem trilha, nem pool.connect.
    expect(updateBody).not.toHaveBeenCalled();
    expect(auditRepo.logEvent).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('invariante: id sumido logo após update bem-sucedido aborta a transação em vez de gravar sem trilha', async () => {
    const before = makeAiPrompt({ body: 'Texto antigo.', version: 7 });
    const updated = makeAiPrompt({ body: 'Texto novo.', version: 8, updatedBy: 'uid-1' });
    const findBySlug = jest.fn().mockResolvedValue(before);
    const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
    const { client, queryMock } = makeClientIdSumiu();
    const auditRepo = makeAuditRepo();
    const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), auditRepo, makePool(client));

    await expect(
      useCase.execute({ slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 }, HUMAN_ACTOR),
    ).rejects.toThrow('UpdateAiPromptUseCase: id não encontrado para slug VACANCY_DESCRIPTION logo após update bem-sucedido');

    // Nada foi para a trilha, e a transação abortou (ROLLBACK), nunca COMMIT.
    expect(auditRepo.logEvent).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(false);
  });

  it('ator não-HUMAN (ex.: SYSTEM) deriva o ActorContext pelo ramo de label, não pelo de uid', async () => {
    const before = makeAiPrompt({ body: 'Texto antigo.', version: 7 });
    const updated = makeAiPrompt({ body: 'Texto novo.', version: 8, updatedBy: 'clickup-sync' });
    const findBySlug = jest.fn().mockResolvedValue(before);
    const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
    const { client } = makeClient();
    const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client));

    const result = await useCase.execute(
      { slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 },
      { actorUserId: null, actorType: 'SYSTEM', actorLabel: 'clickup-sync' },
    );

    expect(result).toEqual({ outcome: 'updated', prompt: updated });
    expect(updateBody).toHaveBeenCalledWith('VACANCY_DESCRIPTION', 'Texto novo.', 7, 'clickup-sync', client);
  });

  it('conteúdo vazio recusado', async () => {
    const findBySlug = jest.fn();
    const updateBody = jest.fn();
    const auditRepo = makeAuditRepo();
    const { client } = makeClient();
    const pool = makePool(client);
    const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), auditRepo, pool);

    const result = await useCase.execute(
      { slug: 'VACANCY_DESCRIPTION', body: '   ', expectedVersion: 7 },
      HUMAN_ACTOR,
    );

    expect(result).toEqual({ outcome: 'invalid', reason: 'empty_body' });
    // Recusado antes de qualquer leitura ou transação — nem abre conexão.
    expect(findBySlug).not.toHaveBeenCalled();
    expect(updateBody).not.toHaveBeenCalled();
    expect(auditRepo.logEvent).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('evento aparece na trilha, com o conteúdo anterior INTEGRAL (não a diferença)', async () => {
    const textoLongoAntigo = `${'A'.repeat(3000)} versão velha`;
    const textoLongoNovo = `${'A'.repeat(3000)} versão nova`;
    const before = makeAiPrompt({ body: textoLongoAntigo, version: 7 });
    const updated = makeAiPrompt({ body: textoLongoNovo, version: 8, updatedBy: 'uid-1' });
    const findBySlug = jest.fn().mockResolvedValue(before);
    const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
    const logEvent = jest.fn().mockResolvedValue(undefined);
    const { client } = makeClient();
    const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(logEvent), makePool(client));

    const result = await useCase.execute(
      { slug: 'VACANCY_DESCRIPTION', body: textoLongoNovo, expectedVersion: 7 },
      { actorUserId: 'uid-1', actorType: 'HUMAN', actorLabel: null, traceId: 'trace-abc' },
    );

    expect(result.outcome).toBe('updated');
    expect(logEvent).toHaveBeenCalledTimes(1);
    const [loggedClient, params] = logEvent.mock.calls[0] as [PoolClient, LogAiPromptEventParams];
    expect(loggedClient).toBe(client); // MESMA transação do UPDATE, não uma conexão à parte
    expect(params).toEqual({
      promptId: PROMPT_ID,
      eventType: 'UPDATED',
      changes: { before: textoLongoAntigo, after: textoLongoNovo },
      actorUserId: 'uid-1',
      actorType: 'HUMAN',
      actorLabel: null,
      traceId: 'trace-abc',
    });
    // Integral, não diferença: o texto guardado tem o tamanho INTEIRO do antigo, não só o trecho mudado.
    expect((params.changes.before as string).length).toBe(textoLongoAntigo.length);
    expect((params.changes.before as string).startsWith('A'.repeat(3000))).toBe(true);
  });

  it('falha na trilha aborta a gravação do conteúdo — ROLLBACK, não COMMIT (contrapõe o controle positivo do 1º teste)', async () => {
    const before = makeAiPrompt({ body: 'Texto antigo.', version: 7 });
    const updated = makeAiPrompt({ body: 'Texto novo.', version: 8, updatedBy: 'uid-1' });
    const findBySlug = jest.fn().mockResolvedValue(before);
    const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
    const logEvent = jest.fn().mockRejectedValue(new Error('INSERT na trilha falhou (simulado)'));
    const { client, queryMock } = makeClient();
    const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(logEvent), makePool(client));

    await expect(
      useCase.execute({ slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 }, HUMAN_ACTOR),
    ).rejects.toThrow('INSERT na trilha falhou (simulado)');

    expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(false);
  });

  describe('Construtor sem dependências injetadas (linhas 72-76)', () => {
    // `DatabaseConnection.getInstance()` (o default do 3º parâmetro) exige DATABASE_URL ou
    // DB_HOST/DB_NAME/DB_USER/DB_PASSWORD no ambiente — nenhum dos dois existe no `.env` deste
    // pacote (verificado: não há `.env` em worker-functions). `pg.Pool` só abre conexão de
    // verdade em `.connect()`/`.query()`, nunca no construtor — por isso um DATABASE_URL falso,
    // setado e restaurado só para este teste, é suficiente e não toca rede nenhuma.
    const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

    afterAll(() => {
      if (ORIGINAL_DATABASE_URL === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
      }
    });

    it('usa AiPromptRepository, AiPromptAuditRepository e pool reais quando nada é passado', () => {
      process.env.DATABASE_URL = 'postgres://fake-para-teste-de-construtor/db';

      const useCase = new UpdateAiPromptUseCase();
      const internals = useCase as unknown as { repo: unknown; auditRepo: unknown; pool: unknown };

      expect(internals.repo).toBeInstanceOf(AiPromptRepository);
      expect(internals.auditRepo).toBeInstanceOf(AiPromptAuditRepository);
      expect(internals.pool).toBeDefined();
    });
  });

  describe('updatedByValue (linha 95) — os dois fallbacks "unknown"', () => {
    it('HUMAN sem actorUserId cai para "unknown" (não para o ramo actorLabel)', async () => {
      const before = makeAiPrompt({ body: 'Texto antigo.', version: 7 });
      const updated = makeAiPrompt({ body: 'Texto novo.', version: 8, updatedBy: 'unknown' });
      const findBySlug = jest.fn().mockResolvedValue(before);
      const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
      const { client } = makeClient();
      const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client));

      await useCase.execute(
        { slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 },
        { actorUserId: null, actorType: 'HUMAN', actorLabel: null },
      );

      expect(updateBody).toHaveBeenCalledWith('VACANCY_DESCRIPTION', 'Texto novo.', 7, 'unknown', client);
    });

    it('não-HUMAN sem actorLabel cai para "unknown" (não para o ramo actorUserId)', async () => {
      const before = makeAiPrompt({ body: 'Texto antigo.', version: 7 });
      const updated = makeAiPrompt({ body: 'Texto novo.', version: 8, updatedBy: 'unknown' });
      const findBySlug = jest.fn().mockResolvedValue(before);
      const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
      const { client } = makeClient();
      const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client));

      await useCase.execute(
        { slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 },
        { actorUserId: null, actorType: 'SYSTEM', actorLabel: null },
      );

      expect(updateBody).toHaveBeenCalledWith('VACANCY_DESCRIPTION', 'Texto novo.', 7, 'unknown', client);
    });
  });

  describe('changes por fallback quando não há diff real (linha 127)', () => {
    it('salvar o MESMO corpo (before === after) ainda grava o snapshot integral, como o docstring 16-21 promete', async () => {
      const before = makeAiPrompt({ body: 'Mesmo texto, sem alteração real.', version: 7 });
      const updated = makeAiPrompt({ body: 'Mesmo texto, sem alteração real.', version: 8, updatedBy: 'uid-1' });
      const findBySlug = jest.fn().mockResolvedValue(before);
      const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
      const logEvent = jest.fn().mockResolvedValue(undefined);
      const { client } = makeClient();
      const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(logEvent), makePool(client));

      const result = await useCase.execute(
        { slug: 'VACANCY_DESCRIPTION', body: 'Mesmo texto, sem alteração real.', expectedVersion: 7 },
        HUMAN_ACTOR,
      );

      // `captureEntityDiff` não acha diff (before.body === result.prompt.body), então o fallback
      // do docstring 16-21 entra: `changes` é preenchido com {before, after} INTEGRAIS mesmo assim
      // — a trilha nunca fica sem o snapshot, mesmo quando o save não mudou o conteúdo.
      expect(result.outcome).toBe('updated');
      expect(logEvent).toHaveBeenCalledTimes(1);
      const [, params] = logEvent.mock.calls[0] as [PoolClient, LogAiPromptEventParams];
      expect(params.changes).toEqual({
        before: 'Mesmo texto, sem alteração real.',
        after: 'Mesmo texto, sem alteração real.',
      });
    });
  });

  describe('toDbActorContext (linhas 161 e 163) — o ramo undefined de cada ternário', () => {
    it('HUMAN sem actorUserId devolve undefined (cai no ator da request via ALS, não trava a escrita)', async () => {
      const before = makeAiPrompt({ body: 'Texto antigo.', version: 7 });
      const updated = makeAiPrompt({ body: 'Texto novo.', version: 8, updatedBy: 'unknown' });
      const findBySlug = jest.fn().mockResolvedValue(before);
      const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
      const { client, queryMock } = makeClient();
      const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client));

      const result = await useCase.execute(
        { slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 },
        { actorUserId: null, actorType: 'HUMAN', actorLabel: null },
      );

      expect(result.outcome).toBe('updated');
      // Sem ActorContext explícito: nenhum set_config de app.current_uid/app.change_source é
      // emitido (resolveActor cai no ALS, vazio em teste) — só BEGIN/SELECT id/COMMIT.
      expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('app.current_uid'))).toBe(false);
      expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(true);
    });

    it('não-HUMAN sem actorLabel devolve undefined (cai no ator da request via ALS, não trava a escrita)', async () => {
      const before = makeAiPrompt({ body: 'Texto antigo.', version: 7 });
      const updated = makeAiPrompt({ body: 'Texto novo.', version: 8, updatedBy: 'unknown' });
      const findBySlug = jest.fn().mockResolvedValue(before);
      const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: updated } satisfies UpdateAiPromptOutcome);
      const { client, queryMock } = makeClient();
      const useCase = new UpdateAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client));

      const result = await useCase.execute(
        { slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 },
        { actorUserId: null, actorType: 'SYSTEM', actorLabel: null },
      );

      expect(result.outcome).toBe('updated');
      expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('app.current_uid'))).toBe(false);
      expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(true);
    });
  });
});
