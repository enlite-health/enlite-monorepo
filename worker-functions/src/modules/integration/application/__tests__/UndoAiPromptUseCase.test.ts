/**
 * UndoAiPromptUseCase.test.ts (spec 029, T019b).
 *
 * Molde: `UpdateAiPromptUseCase.test.ts` — pool/client fake, `AiPromptRepository`/
 * `AiPromptAuditRepository` injetados como dublês (o SQL de cada um já tem prova própria em
 * T007/T008). Aqui testamos a orquestração nova: achar o evento anterior na trilha, lock
 * otimista, transação única, e o que vai para a trilha como `RESTORED`.
 *
 * `pool.query` tem DOIS usos nesta classe, ao contrário do Update: a leitura do último evento
 * (fora da transação, via `this.pool.query`) e a abertura da transação (`this.pool.connect`,
 * dentro de `withActorContext`). `makePool` abaixo modela os dois.
 */
import type { Pool, PoolClient } from 'pg';
import { UndoAiPromptUseCase } from '../UndoAiPromptUseCase';
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
const LAST_EVENT_ID = '22222222-2222-2222-2222-222222222222';

function makeAiPrompt(overrides: Partial<AiPrompt> = {}): AiPrompt {
  return {
    slug: 'VACANCY_DESCRIPTION',
    body: 'Texto novo (o que está valendo agora).',
    version: 8,
    isActive: true,
    createdBy: 'uid-criador',
    updatedBy: 'uid-editor-anterior',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

/** Linha que `pool.query` (SELECT do último evento) devolve — molda `LastAuditEventRow`. */
function makeLastEventRow(overrides: { before?: unknown; after?: unknown } = {}) {
  return {
    event_id: LAST_EVENT_ID,
    prompt_id: PROMPT_ID,
    changes: {
      before: overrides.before === undefined ? 'Texto antigo (o que volta a valer).' : overrides.before,
      after: overrides.after === undefined ? 'Texto novo (o que está valendo agora).' : overrides.after,
    },
  };
}

/** Client fake da transação: responde igual ao molde de Update (nada além do que `withActorContext`
 * e o `logEvent`/`updateBody` injetados inspecionam). */
function makeClient(): { client: PoolClient; queryMock: jest.Mock } {
  const queryMock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const client = { query: queryMock, release: jest.fn() } as unknown as PoolClient;
  return { client, queryMock };
}

/** Pool fake: `connect()` devolve o client da transação; `query()` é o SELECT do último evento,
 * fora da transação — assumível pela ordem de chamada (só há UM `pool.query` por `execute`). */
function makePool(client: PoolClient, poolQueryMock: jest.Mock): Pool {
  return { connect: jest.fn().mockResolvedValue(client), query: poolQueryMock } as unknown as Pool;
}

function poolQueryComUltimoEvento(row: ReturnType<typeof makeLastEventRow> | null): jest.Mock {
  return jest.fn().mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
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

describe('UndoAiPromptUseCase (spec 029 T019b)', () => {
  it('desfaz a última alteração: volta ao conteúdo imediatamente anterior e registra RESTORED apontando o evento desfeito', async () => {
    const current = makeAiPrompt({ body: 'Texto novo (o que está valendo agora).', version: 8 });
    const restaurado = makeAiPrompt({ body: 'Texto antigo (o que volta a valer).', version: 9, updatedBy: 'uid-1' });
    const findBySlug = jest.fn().mockResolvedValue(current);
    const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: restaurado } satisfies UpdateAiPromptOutcome);
    const logEvent = jest.fn().mockResolvedValue(undefined);
    const { client, queryMock } = makeClient();
    const poolQuery = poolQueryComUltimoEvento(makeLastEventRow());
    const useCase = new UndoAiPromptUseCase(
      makeRepo({ findBySlug, updateBody }),
      makeAuditRepo(logEvent),
      makePool(client, poolQuery),
    );

    const result = await useCase.execute({ slug: 'VACANCY_DESCRIPTION', expectedVersion: 8 }, HUMAN_ACTOR);

    // Volta ao conteúdo imediatamente anterior: o `body` gravado é o `changes.before` do último evento.
    expect(result).toEqual({ outcome: 'restored', prompt: restaurado });
    expect(updateBody).toHaveBeenCalledWith(
      'VACANCY_DESCRIPTION',
      'Texto antigo (o que volta a valer).',
      8,
      'uid-1',
      client,
    );

    // Registra RESTORED apontando o evento desfeito (undoneEventId = id do último evento).
    expect(logEvent).toHaveBeenCalledTimes(1);
    const [loggedClient, params] = logEvent.mock.calls[0] as [PoolClient, LogAiPromptEventParams];
    expect(loggedClient).toBe(client); // MESMA transação do UPDATE
    expect(params).toEqual({
      promptId: PROMPT_ID,
      eventType: 'RESTORED',
      changes: {
        before: 'Texto novo (o que está valendo agora).',
        after: 'Texto antigo (o que volta a valer).',
        undoneEventId: LAST_EVENT_ID,
      },
      actorUserId: 'uid-1',
      actorType: 'HUMAN',
      actorLabel: null,
      traceId: null,
    });

    // Controle positivo: a transação foi até COMMIT — prova que este caminho GRAVA de verdade,
    // o que dá sentido aos "sem gravar" dos testes de 409 e 422 abaixo.
    expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(false);
  });

  it('versão divergente → 409 sem gravar (nem trilha é chamada — mesma prova de UpdateAiPromptUseCase.test.ts)', async () => {
    const current = makeAiPrompt({ body: 'Texto novo (o que está valendo agora).', version: 8 });
    const findBySlug = jest.fn().mockResolvedValue(current);
    const updateBody = jest
      .fn()
      .mockResolvedValue({ outcome: 'conflict', currentVersion: 9, updatedBy: 'uid-outra-pessoa' } satisfies UpdateAiPromptOutcome);
    const logEvent = jest.fn().mockResolvedValue(undefined);
    const { client } = makeClient();
    const poolQuery = poolQueryComUltimoEvento(makeLastEventRow());
    const useCase = new UndoAiPromptUseCase(
      makeRepo({ findBySlug, updateBody }),
      makeAuditRepo(logEvent),
      makePool(client, poolQuery),
    );

    const result = await useCase.execute({ slug: 'VACANCY_DESCRIPTION', expectedVersion: 8 }, HUMAN_ACTOR);

    expect(result).toEqual({ outcome: 'conflict', currentVersion: 9, updatedBy: 'uid-outra-pessoa' });
    // Nada gravado: a trilha não é chamada — é a prova de que RESTORED não foi registrado. O
    // conteúdo em si nunca chega a mudar porque `AiPromptRepository.updateBody` (com prova própria
    // em T007) só dá `rowCount > 0` quando `version` bate; aqui o dublê simula o `rowCount === 0`.
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('sem versão anterior → 422 (último evento é CREATED, changes.before nulo) — não chama updateBody nem a trilha', async () => {
    const current = makeAiPrompt({ body: 'Único conteúdo desde a criação.', version: 1 });
    const findBySlug = jest.fn().mockResolvedValue(current);
    const updateBody = jest.fn();
    const logEvent = jest.fn();
    const { client } = makeClient();
    const poolQuery = poolQueryComUltimoEvento(makeLastEventRow({ before: null, after: 'Único conteúdo desde a criação.' }));
    const pool = makePool(client, poolQuery);
    const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(logEvent), pool);

    const result = await useCase.execute({ slug: 'VACANCY_DESCRIPTION', expectedVersion: 1 }, HUMAN_ACTOR);

    expect(result).toEqual({ outcome: 'no_previous_version' });
    // Nada foi persistido: nem o lock otimista é tentado, nem a trilha é chamada, nem a transação abre.
    expect(updateBody).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('sem versão anterior → 422 também quando não existe NENHUM evento na trilha (defesa: nunca inventar um "anterior")', async () => {
    const current = makeAiPrompt({ version: 1 });
    const findBySlug = jest.fn().mockResolvedValue(current);
    const updateBody = jest.fn();
    const { client } = makeClient();
    const poolQuery = poolQueryComUltimoEvento(null);
    const pool = makePool(client, poolQuery);
    const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), pool);

    const result = await useCase.execute({ slug: 'VACANCY_DESCRIPTION', expectedVersion: 1 }, HUMAN_ACTOR);

    expect(result).toEqual({ outcome: 'no_previous_version' });
    expect(updateBody).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('slug sem linha na tabela (before não encontrado) devolve not_found sem consultar a trilha nem abrir transação', async () => {
    const findBySlug = jest.fn().mockResolvedValue(null);
    const updateBody = jest.fn();
    const poolQuery = jest.fn();
    const pool = makePool(makeClient().client, poolQuery);
    const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), pool);

    const result = await useCase.execute({ slug: 'PRESCREENING_AT', expectedVersion: 1 }, HUMAN_ACTOR);

    expect(result).toEqual({ outcome: 'not_found' });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(updateBody).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('changes.before de tipo inesperado (não string, não null) é tratado como "sem versão anterior" — defesa contra dado corrompido', async () => {
    const current = makeAiPrompt({ version: 3 });
    const findBySlug = jest.fn().mockResolvedValue(current);
    const updateBody = jest.fn();
    const { client } = makeClient();
    // `before: 42` simula corrupção de dado — `changes.before` nunca deveria ser número (a coluna
    // `body` é TEXT), mas `changes` é JSONB sem schema fixo além do que a aplicação escreve.
    const poolQuery = poolQueryComUltimoEvento(makeLastEventRow({ before: 42 }));
    const pool = makePool(client, poolQuery);
    const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), pool);

    const result = await useCase.execute({ slug: 'VACANCY_DESCRIPTION', expectedVersion: 3 }, HUMAN_ACTOR);

    expect(result).toEqual({ outcome: 'no_previous_version' });
    expect(updateBody).not.toHaveBeenCalled();
  });

  it('race entre o SELECT do último evento e o UPDATE: updateBody devolve not_found (linha sumiu) — repassado sem gravar trilha', async () => {
    const current = makeAiPrompt({ version: 8 });
    const findBySlug = jest.fn().mockResolvedValue(current);
    const updateBody = jest.fn().mockResolvedValue({ outcome: 'not_found' } satisfies UpdateAiPromptOutcome);
    const logEvent = jest.fn();
    const { client } = makeClient();
    const poolQuery = poolQueryComUltimoEvento(makeLastEventRow());
    const pool = makePool(client, poolQuery);
    const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(logEvent), pool);

    const result = await useCase.execute({ slug: 'VACANCY_DESCRIPTION', expectedVersion: 8 }, HUMAN_ACTOR);

    expect(result).toEqual({ outcome: 'not_found' });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('ator não-HUMAN (ex.: SYSTEM) deriva updatedBy e o ActorContext pelo ramo de label', async () => {
    const current = makeAiPrompt({ version: 8 });
    const restaurado = makeAiPrompt({ body: 'Texto antigo (o que volta a valer).', version: 9, updatedBy: 'clickup-sync' });
    const findBySlug = jest.fn().mockResolvedValue(current);
    const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: restaurado } satisfies UpdateAiPromptOutcome);
    const { client } = makeClient();
    const poolQuery = poolQueryComUltimoEvento(makeLastEventRow());
    const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client, poolQuery));

    const result = await useCase.execute(
      { slug: 'VACANCY_DESCRIPTION', expectedVersion: 8 },
      { actorUserId: null, actorType: 'SYSTEM', actorLabel: 'clickup-sync' },
    );

    expect(result).toEqual({ outcome: 'restored', prompt: restaurado });
    expect(updateBody).toHaveBeenCalledWith('VACANCY_DESCRIPTION', 'Texto antigo (o que volta a valer).', 8, 'clickup-sync', client);
  });

  describe('updatedByValue — os dois fallbacks "unknown"', () => {
    it('HUMAN sem actorUserId cai para "unknown"', async () => {
      const current = makeAiPrompt({ version: 8 });
      const restaurado = makeAiPrompt({ body: 'Texto antigo (o que volta a valer).', version: 9, updatedBy: 'unknown' });
      const findBySlug = jest.fn().mockResolvedValue(current);
      const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: restaurado } satisfies UpdateAiPromptOutcome);
      const { client } = makeClient();
      const poolQuery = poolQueryComUltimoEvento(makeLastEventRow());
      const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client, poolQuery));

      await useCase.execute(
        { slug: 'VACANCY_DESCRIPTION', expectedVersion: 8 },
        { actorUserId: null, actorType: 'HUMAN', actorLabel: null },
      );

      expect(updateBody).toHaveBeenCalledWith('VACANCY_DESCRIPTION', 'Texto antigo (o que volta a valer).', 8, 'unknown', client);
    });

    it('não-HUMAN sem actorLabel cai para "unknown"', async () => {
      const current = makeAiPrompt({ version: 8 });
      const restaurado = makeAiPrompt({ body: 'Texto antigo (o que volta a valer).', version: 9, updatedBy: 'unknown' });
      const findBySlug = jest.fn().mockResolvedValue(current);
      const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: restaurado } satisfies UpdateAiPromptOutcome);
      const { client } = makeClient();
      const poolQuery = poolQueryComUltimoEvento(makeLastEventRow());
      const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client, poolQuery));

      await useCase.execute(
        { slug: 'VACANCY_DESCRIPTION', expectedVersion: 8 },
        { actorUserId: null, actorType: 'SYSTEM', actorLabel: null },
      );

      expect(updateBody).toHaveBeenCalledWith('VACANCY_DESCRIPTION', 'Texto antigo (o que volta a valer).', 8, 'unknown', client);
    });
  });

  describe('toDbActorContext — o ramo undefined de cada ternário', () => {
    it('HUMAN sem actorUserId devolve undefined (cai no ator da request via ALS)', async () => {
      const current = makeAiPrompt({ version: 8 });
      const restaurado = makeAiPrompt({ body: 'Texto antigo (o que volta a valer).', version: 9, updatedBy: 'unknown' });
      const findBySlug = jest.fn().mockResolvedValue(current);
      const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: restaurado } satisfies UpdateAiPromptOutcome);
      const { client, queryMock } = makeClient();
      const poolQuery = poolQueryComUltimoEvento(makeLastEventRow());
      const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client, poolQuery));

      const result = await useCase.execute(
        { slug: 'VACANCY_DESCRIPTION', expectedVersion: 8 },
        { actorUserId: null, actorType: 'HUMAN', actorLabel: null },
      );

      expect(result.outcome).toBe('restored');
      expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('app.current_uid'))).toBe(false);
      expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(true);
    });

    it('não-HUMAN sem actorLabel devolve undefined (cai no ator da request via ALS)', async () => {
      const current = makeAiPrompt({ version: 8 });
      const restaurado = makeAiPrompt({ body: 'Texto antigo (o que volta a valer).', version: 9, updatedBy: 'unknown' });
      const findBySlug = jest.fn().mockResolvedValue(current);
      const updateBody = jest.fn().mockResolvedValue({ outcome: 'updated', prompt: restaurado } satisfies UpdateAiPromptOutcome);
      const { client, queryMock } = makeClient();
      const poolQuery = poolQueryComUltimoEvento(makeLastEventRow());
      const useCase = new UndoAiPromptUseCase(makeRepo({ findBySlug, updateBody }), makeAuditRepo(), makePool(client, poolQuery));

      const result = await useCase.execute(
        { slug: 'VACANCY_DESCRIPTION', expectedVersion: 8 },
        { actorUserId: null, actorType: 'SYSTEM', actorLabel: null },
      );

      expect(result.outcome).toBe('restored');
      expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('app.current_uid'))).toBe(false);
      expect(queryMock.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(true);
    });
  });

  describe('Construtor sem dependências injetadas', () => {
    // Mesmo raciocínio de `UpdateAiPromptUseCase.test.ts`: `pg.Pool` só conecta de verdade em
    // `.connect()`/`.query()`, nunca no construtor. DATABASE_URL falso, setado e restaurado só aqui.
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

      const useCase = new UndoAiPromptUseCase();
      const internals = useCase as unknown as { repo: unknown; auditRepo: unknown; pool: unknown };

      expect(internals.repo).toBeInstanceOf(AiPromptRepository);
      expect(internals.auditRepo).toBeInstanceOf(AiPromptAuditRepository);
      expect(internals.pool).toBeDefined();
    });
  });
});
