/**
 * EditMessageUseCase + DeleteMessageUseCase — TDD (spec 022, Bloco 1, T113/T114/T115).
 *
 * Molde igual ao de `PostMessageUseCase.test.ts`: `withActorContext` mockado inteiro (o `fn`
 * roda com um client fake), `KMSEncryptionService` mockado por módulo, `ConversationRepository`
 * REAL — para inspecionar o SQL literal do UPDATE (edição re-cifra; exclusão zera o corpo).
 *
 * `clientWith(handlers)` roteia `client.query` por SUBSTRING do SQL, na ordem dos handlers;
 * o primeiro handler que não devolver `undefined` vence. Todas as chamadas ficam em `calls`.
 *
 * D-04 (fechada, não replanejar): só o autor edita/apaga, sem janela de tempo; autor diferente
 * é erro de domínio; edição re-cifra e marca `edited_at`; exclusão é soft (`deleted_at` +
 * `body_encrypted = NULL` na MESMA instrução, sem cascata para replies).
 */
const mockEncrypt = jest.fn(async (v: string | null) => (v ? `enc:${v}` : null));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: mockEncrypt,
    decrypt: jest.fn(async (v: string | null) => (v ? `plain:${v}` : '')),
  })),
}));

const mockWithActorContext = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: (...args: unknown[]) => mockWithActorContext(...args),
}));

// Só para os testes de construção "sem dependências explícitas" (default do construtor) —
// nunca chega a rodar query real: toda leitura/escrita do teste passa o `client` explícito.
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

import type { Pool, PoolClient } from 'pg';
import { ConversationRepository } from '../../infrastructure/ConversationRepository';
import { EditMessageUseCase } from '../EditMessageUseCase';
import { DeleteMessageUseCase } from '../DeleteMessageUseCase';

type Handler = (sql: string, params: unknown[]) => unknown | undefined;

function clientWith(handlers: Handler[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const handler of handlers) {
      const result = handler(sql, params);
      if (result !== undefined) return result;
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, calls };
}

/** Handler comum: responde ao SELECT de autoria pelo `messageId` semeado. */
function authorHandler(messageId: string, authorUid: string): Handler {
  return (sql, params) =>
    sql.includes('SELECT author_uid') && params[0] === messageId ? { rows: [{ authorUid }] } : undefined;
}

/**
 * Handler comum: mensagem já apagada (soft delete) — mesma linha do SELECT de autoria, mas com
 * `deletedAt` preenchido. Prova o guard do CONSERTO 2 (achado do gate revisao-pr, Bloco 1):
 * editar mensagem apagada tem que recusar ANTES de chegar no UPDATE.
 */
function deletedMessageHandler(messageId: string, authorUid: string): Handler {
  return (sql, params) =>
    sql.includes('SELECT author_uid') && params[0] === messageId
      ? { rows: [{ authorUid, deletedAt: new Date('2026-09-01T09:00:00.000Z') }] }
      : undefined;
}

/** Handler comum: responde às replies existentes de um root — usado para provar "sem cascata". */
function repliesHandler(rootMessageId: string, replyIds: string[]): Handler {
  return (sql, params) =>
    sql.includes('FROM conversation_messages') && sql.includes('WHERE root_message_id = $1') && params[0] === rootMessageId
      ? { rows: replyIds.map((id) => ({ id, bodyEncrypted: `enc:${id}-body` })) }
      : undefined;
}

const POOL = {} as unknown as Pool;

function runOn(client: PoolClient) {
  mockWithActorContext.mockImplementation(async (_pool: Pool, fn: (c: PoolClient) => unknown) => fn(client));
}

beforeEach(() => {
  mockWithActorContext.mockReset();
  mockEncrypt.mockClear();
});

describe('EditMessageUseCase', () => {
  it('autor edita a própria mensagem: sucesso, edited_at marcado, corpo RE-CIFRADO', async () => {
    const { client, calls } = clientWith([authorHandler('m1', 'staff:1')]);
    runOn(client);
    const useCase = new EditMessageUseCase(new ConversationRepository(POOL));

    const result = await useCase.execute(POOL, { messageId: 'm1', requesterUid: 'staff:1', body: 'novo corpo' });

    expect(result).toEqual({ id: 'm1' });
    expect(mockEncrypt).toHaveBeenCalledWith('novo corpo');
    const updateCall = calls.find((c) => c.sql.includes('UPDATE conversation_messages') && c.sql.includes('edited_at'));
    expect(updateCall?.sql).toContain('edited_at = now()');
    expect(updateCall?.params).toEqual(['m1', 'enc:novo corpo']); // CIFRADO no UPDATE, nunca o claro
  });

  it('editar mensagem ALHEIA: recusa com erro de domínio, nunca chama UPDATE', async () => {
    const { client, calls } = clientWith([authorHandler('m1', 'staff:1')]);
    runOn(client);
    const useCase = new EditMessageUseCase(new ConversationRepository(POOL));

    await expect(
      useCase.execute(POOL, { messageId: 'm1', requesterUid: 'staff:OUTRO', body: 'tentando editar' }),
    ).rejects.toMatchObject({ name: 'NotMessageAuthorError', code: 'NOT_MESSAGE_AUTHOR', status: 403 });

    expect(calls.some((c) => c.sql.includes('UPDATE conversation_messages'))).toBe(false);
  });

  it('messageId inexistente: recusa com MessageNotFoundError, nunca chama UPDATE', async () => {
    const { client, calls } = clientWith([]); // nenhum handler responde ao SELECT de autoria → rows: []
    runOn(client);
    const useCase = new EditMessageUseCase(new ConversationRepository(POOL));

    await expect(
      useCase.execute(POOL, { messageId: 'fantasma', requesterUid: 'staff:1', body: 'x' }),
    ).rejects.toMatchObject({ name: 'MessageNotFoundError', code: 'MESSAGE_NOT_FOUND', status: 404 });

    expect(calls.some((c) => c.sql.includes('UPDATE conversation_messages'))).toBe(false);
  });

  it('new EditMessageUseCase() usa ConversationRepository default sem lançar', async () => {
    const { client } = clientWith([authorHandler('m1', 'staff:1')]);
    runOn(client);
    const useCase = new EditMessageUseCase();

    await expect(
      useCase.execute(POOL, { messageId: 'm1', requesterUid: 'staff:1', body: 'novo' }),
    ).resolves.toEqual({ id: 'm1' });
  });

  it('editar mensagem JÁ APAGADA: recusa com MessageAlreadyDeletedError (409), NUNCA chama UPDATE — body_encrypted continua NULL', async () => {
    const { client, calls } = clientWith([deletedMessageHandler('m1', 'staff:1')]);
    runOn(client);
    const useCase = new EditMessageUseCase(new ConversationRepository(POOL));

    await expect(
      useCase.execute(POOL, { messageId: 'm1', requesterUid: 'staff:1', body: 'tentando reviver' }),
    ).rejects.toMatchObject({ name: 'MessageAlreadyDeletedError', code: 'MESSAGE_ALREADY_DELETED', status: 409 });

    // Nenhuma chamada tocou o UPDATE que re-cifraria o corpo — `body_encrypted` continua NULL
    // porque a escrita nunca aconteceu (não é "escreveu e desfez", é "nunca escreveu").
    expect(calls.some((c) => c.sql.includes('UPDATE conversation_messages'))).toBe(false);
    expect(mockEncrypt).not.toHaveBeenCalled();
  });
});

describe('DeleteMessageUseCase', () => {
  it('autor apaga a própria mensagem: soft delete com os DOIS efeitos — deleted_at E body_encrypted NULL', async () => {
    const { client, calls } = clientWith([authorHandler('m1', 'staff:1')]);
    runOn(client);
    const useCase = new DeleteMessageUseCase(new ConversationRepository(POOL));

    const result = await useCase.execute(POOL, { messageId: 'm1', requesterUid: 'staff:1' });

    expect(result).toEqual({ id: 'm1' });
    const deleteCall = calls.find((c) => c.sql.includes('UPDATE conversation_messages') && c.sql.includes('deleted_at'));
    // os DOIS efeitos na MESMA instrução — prova os dois, não só um
    expect(deleteCall?.sql).toContain('deleted_at = now()');
    expect(deleteCall?.sql).toContain('body_encrypted = NULL');
    expect(deleteCall?.params).toEqual(['m1']);
  });

  it('apagar mensagem ALHEIA: recusa com erro de domínio, nunca chama o UPDATE de soft delete', async () => {
    const { client, calls } = clientWith([authorHandler('m1', 'staff:1')]);
    runOn(client);
    const useCase = new DeleteMessageUseCase(new ConversationRepository(POOL));

    await expect(
      useCase.execute(POOL, { messageId: 'm1', requesterUid: 'staff:OUTRO' }),
    ).rejects.toMatchObject({ name: 'NotMessageAuthorError', code: 'NOT_MESSAGE_AUTHOR', status: 403 });

    expect(calls.some((c) => c.sql.includes('UPDATE conversation_messages') && c.sql.includes('deleted_at'))).toBe(
      false,
    );
  });

  it('apagar mensagem que tem replies: as replies CONTINUAM existindo (soft delete não cascateia)', async () => {
    const { client, calls } = clientWith([authorHandler('root-1', 'staff:1'), repliesHandler('root-1', ['r1', 'r2'])]);
    runOn(client);
    const useCase = new DeleteMessageUseCase(new ConversationRepository(POOL));
    const repository = new ConversationRepository(POOL);

    await useCase.execute(POOL, { messageId: 'root-1', requesterUid: 'staff:1' });

    // nenhuma chamada da exclusão tocou os filhos (nenhum WHERE root_message_id / WHERE id = replyId)
    expect(calls.some((c) => c.sql.includes('root_message_id') && c.sql.includes('UPDATE'))).toBe(false);
    expect(calls.some((c) => c.params.includes('r1') || c.params.includes('r2'))).toBe(false);

    // e as replies seguem legíveis pela MESMA repository — nada foi apagado/cascateado nelas
    const stillThere = await repository.listReplies('root-1', client);
    expect(stillThere.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('new DeleteMessageUseCase() usa ConversationRepository default sem lançar', async () => {
    const { client } = clientWith([authorHandler('m1', 'staff:1')]);
    runOn(client);
    const useCase = new DeleteMessageUseCase();

    await expect(useCase.execute(POOL, { messageId: 'm1', requesterUid: 'staff:1' })).resolves.toEqual({ id: 'm1' });
  });
});
