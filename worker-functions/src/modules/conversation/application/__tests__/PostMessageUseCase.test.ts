/**
 * PostMessageUseCase — TDD (spec 022, Bloco 1, T109/T110).
 *
 * Molde de mock: `MatchmakingService.test.ts` (`withActorContext` mockado inteiro, `fn` chamado
 * com um client fake) + `ConversationRepository.test.ts` (`KMSEncryptionService` mockado por
 * módulo). Deliberadamente NÃO mocka o `ConversationRepository` inteiro: usa a classe REAL,
 * para que o teste de cifra (item 3) possa inspecionar o SQL literal do INSERT — provar que
 * "algum encrypt foi chamado" não prova que o CLARO não foi para o banco; só ver os params do
 * INSERT prova.
 *
 * `clientWith(handlers)` roteia `client.query` por SUBSTRING do SQL, na ordem dos handlers
 * (molde `makeDb` de `PatientTestFixtureService.test.ts`) — cada handler decide se responde;
 * o primeiro que não devolver `undefined` vence. Todas as chamadas ficam em `calls`, para
 * inspecionar SQL + params depois.
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

// Só para o teste de construção "sem dependências explícitas" (default do construtor) —
// nunca chega a rodar query real: toda leitura/escrita do teste passa o `client` explícito.
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

import type { Pool, PoolClient } from 'pg';
import { ConversationRepository } from '../../infrastructure/ConversationRepository';
import { PostMessageUseCase, type PostMessageFanOutHook } from '../PostMessageUseCase';

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

/** Handler comum: responde ao INSERT da mensagem — a maioria dos testes não é SOBRE esta linha. */
function insertMessageHandler(id = 'm-new', createdAt = new Date('2026-09-20T10:00:00.000Z')): Handler {
  return (sql) => (sql.includes('INSERT INTO conversation_messages') ? { rows: [{ id, createdAt }] } : undefined);
}

/**
 * Handler do cruzamento de posse (T305-T317, Bloco 3): cada id em `ownedIds` "existe, é desta
 * conversa, deste autor e ainda não está anexado" (owned=true); qualquer outro id pedido pelo
 * teste mas fora desta lista simplesmente não aparece nas rows (mesmo efeito de "não existe" —
 * `assertFilesOwnedByAuthor` trata ausência e `owned:false` da MESMA forma).
 */
function filesOwnedHandler(ownedIds: string[]): Handler {
  return (sql) =>
    sql.includes('FROM stored_files sf') ? { rows: ownedIds.map((id) => ({ id, owned: true }))} : undefined;
}

/** Variante: id existe mas reprova em UM dos 3 critérios (conversa/autor/já-anexado) — owned:false. */
function fileRejectedHandler(id: string): Handler {
  return (sql) => (sql.includes('FROM stored_files sf') ? { rows: [{ id, owned: false }] } : undefined);
}

const POOL = {} as unknown as Pool;

function runOn(client: PoolClient) {
  mockWithActorContext.mockImplementation(async (_pool: Pool, fn: (c: PoolClient) => unknown) => fn(client));
}

beforeEach(() => {
  mockWithActorContext.mockReset();
  mockEncrypt.mockClear();
});

describe('PostMessageUseCase', () => {
  describe('normalização de thread (D-03) — reply de reply normaliza pro ROOT do root, sem erro', () => {
    it('cenário de 3 níveis: m1 é root, r1 já é reply de m1; responder a r1 grava root_message_id=m1 (nunca r1)', async () => {
      const { client, calls } = clientWith([
        (sql, params) =>
          sql.includes('FROM conversation_messages WHERE id = $1') && params[0] === 'r1'
            ? { rows: [{ id: 'r1', conversationId: 'c1', rootMessageId: 'm1' }] } // r1 SEEDADA: já é reply de m1, MESMA conversa
            : undefined,
        insertMessageHandler(),
      ]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      const result = await useCase.execute(POOL, {
        conversationId: 'c1',
        authorUid: 'staff:1',
        body: 'msg-1',
        rootMessageId: 'r1', // pede para responder à REPLY, não ao root
      });

      expect(result.rootMessageId).toBe('m1'); // normalizado — o servidor NÃO cria 2º nível
      const insertCall = calls.find((c) => c.sql.includes('INSERT INTO conversation_messages'));
      expect(insertCall?.params[1]).toBe('m1'); // root_message_id gravado é o ROOT do root
    });

    it('responder a uma mensagem de TOPO (m1, sem root próprio): rootMessageId vira o próprio m1', async () => {
      const { client } = clientWith([
        (sql, params) =>
          sql.includes('FROM conversation_messages WHERE id = $1') && params[0] === 'm1'
            ? { rows: [{ id: 'm1', conversationId: 'c1', rootMessageId: null }] } // m1 SEEDADA: é ela mesma o root, MESMA conversa
            : undefined,
        insertMessageHandler('r-new'),
      ]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      const result = await useCase.execute(POOL, {
        conversationId: 'c1',
        authorUid: 'staff:1',
        body: 'msg-1',
        rootMessageId: 'm1',
      });

      expect(result.rootMessageId).toBe('m1');
    });

    it('mensagem de TOPO nova (sem rootMessageId): não consulta thread nenhuma, grava root=null', async () => {
      const { client, calls } = clientWith([insertMessageHandler()]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      const result = await useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'msg-1' });

      expect(result.rootMessageId).toBeNull();
      expect(calls.some((c) => c.sql.includes('FROM conversation_messages WHERE id = $1'))).toBe(false);
    });

    it('responder a um id que não existe: recusa com MessageNotFoundError (404), NUNCA insere — achado do gate revisao-pr: antes normalizava em silêncio, abrindo o mesmo buraco do vetor cross-conversa', async () => {
      const { client, calls } = clientWith([
        (sql) => (sql.includes('FROM conversation_messages WHERE id = $1') ? { rows: [] } : undefined),
        insertMessageHandler(),
      ]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, {
          conversationId: 'c1',
          authorUid: 'staff:1',
          body: 'msg-1',
          rootMessageId: 'orfao',
        }),
      ).rejects.toMatchObject({ name: 'MessageNotFoundError', code: 'MESSAGE_NOT_FOUND', status: 404 });
      expect(calls.some((c) => c.sql.includes('INSERT INTO conversation_messages'))).toBe(false);
    });

    it('responder a rootMessageId que EXISTE mas é de OUTRA conversa: recusa com MessageNotFoundError (404), NUNCA insere — vazamento cross-paciente do achado (achados.md, "Achado NOVO — irmão fora do nomeado")', async () => {
      const { client, calls } = clientWith([
        (sql, params) =>
          sql.includes('FROM conversation_messages WHERE id = $1') && params[0] === 'm-de-outro-paciente'
            ? { rows: [{ id: 'm-de-outro-paciente', conversationId: 'c-OUTRO-paciente', rootMessageId: null }] }
            : undefined,
        insertMessageHandler(),
      ]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, {
          conversationId: 'c1', // conversa do REQUESTER — NÃO bate com a do root acima
          authorUid: 'staff:1',
          body: 'msg-1',
          rootMessageId: 'm-de-outro-paciente',
        }),
      ).rejects.toMatchObject({ name: 'MessageNotFoundError', code: 'MESSAGE_NOT_FOUND', status: 404 });
      expect(calls.some((c) => c.sql.includes('INSERT INTO conversation_messages'))).toBe(false);
    });
  });

  describe('menção — extrai <@uid> do corpo e valida contra users', () => {
    it('uid mencionado que NÃO existe em users: recusa com erro de domínio (400), nunca insere', async () => {
      const { client, calls } = clientWith([
        (sql) => (sql.includes('FROM users WHERE firebase_uid') ? { rows: [] } : undefined),
        insertMessageHandler(),
      ]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'oi <@staff:999>' }),
      ).rejects.toMatchObject({
        name: 'MentionedUserNotFoundError',
        code: 'MENTIONED_USER_NOT_FOUND',
        status: 400,
        uid: 'staff:999',
      });
      expect(calls.some((c) => c.sql.includes('INSERT INTO conversation_messages'))).toBe(false);
    });

    it('uid mencionado que EXISTE: grava a menção junto e segue', async () => {
      const { client, calls } = clientWith([
        (sql) =>
          sql.includes('FROM users WHERE firebase_uid') ? { rows: [{ firebaseUid: 'staff:2' }] } : undefined,
        insertMessageHandler(),
      ]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      const result = await useCase.execute(POOL, {
        conversationId: 'c1',
        authorUid: 'staff:1',
        body: 'oi <@staff:2>',
      });

      expect(result.mentionedUids).toEqual(['staff:2']);
      const mentionCall = calls.find((c) => c.sql.includes('INSERT INTO conversation_message_mentions'));
      expect(mentionCall?.params).toEqual(['m-new', 'staff:2']);
    });

    it('corpo sem menção: não consulta users nem grava conversation_message_mentions', async () => {
      const { client, calls } = clientWith([insertMessageHandler()]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      const result = await useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'sem menção' });

      expect(result.mentionedUids).toEqual([]);
      expect(calls.some((c) => c.sql.includes('FROM users WHERE firebase_uid'))).toBe(false);
      expect(calls.some((c) => c.sql.includes('INSERT INTO conversation_message_mentions'))).toBe(false);
    });
  });

  describe('cifra antes de gravar — o texto em claro NUNCA chega ao INSERT', () => {
    it('o body passa por KMSEncryptionService.encrypt e o INSERT recebe o CIFRADO, nunca o claro', async () => {
      const { client, calls } = clientWith([insertMessageHandler()]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'msg-1' });

      expect(mockEncrypt).toHaveBeenCalledWith('msg-1');
      const insertCall = calls.find((c) => c.sql.includes('INSERT INTO conversation_messages'));
      expect(insertCall?.params).toContain('enc:msg-1'); // o CIFRADO está nos params do INSERT
      expect(insertCall?.params).not.toContain('msg-1'); // o CLARO nunca está
    });
  });

  describe('anexos — grava conversation_message_attachments quando há fileIds', () => {
    it('com fileIds: insere um par (message_id, file_id) por arquivo', async () => {
      const { client, calls } = clientWith([insertMessageHandler(), filesOwnedHandler(['f1', 'f2'])]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await useCase.execute(POOL, {
        conversationId: 'c1',
        authorUid: 'staff:1',
        body: 'msg-1',
        fileIds: ['f1', 'f2'],
      });

      const attachCall = calls.find((c) => c.sql.includes('INSERT INTO conversation_message_attachments'));
      expect(attachCall?.params).toEqual(['m-new', 'f1', 'f2']);

      // Cruzamento de posse (T305-T317): o SELECT carrega conversationId + authorUid do REQUEST,
      // não confia em nada que venha do cliente além do fileId.
      const ownershipCall = calls.find((c) => c.sql.includes('FROM stored_files sf'));
      expect(ownershipCall?.params).toEqual([['f1', 'f2'], 'c1', 'staff:1']);
    });

    it('fileId INEXISTENTE em stored_files: recusa com AttachedFileNotFoundError (400), NUNCA insere a mensagem — achado do gate revisao-pr (Tarefa 3): sem esta checagem, id arbitrário virava FK violation (500) e o ON DELETE RESTRICT tornava o arquivo indeletável', async () => {
      const { client, calls } = clientWith([insertMessageHandler(), filesOwnedHandler(['f1'])]); // só f1 existe; f2 não aparece nas rows
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, {
          conversationId: 'c1',
          authorUid: 'staff:1',
          body: 'msg-1',
          fileIds: ['f1', 'f2'],
        }),
      ).rejects.toMatchObject({ code: 'ATTACHED_FILE_NOT_FOUND', status: 400 });

      expect(calls.some((c) => c.sql.includes('INSERT INTO conversation_messages'))).toBe(false);
      expect(calls.some((c) => c.sql.includes('INSERT INTO conversation_message_attachments'))).toBe(false);
    });

    it('fileId de OUTRA conversa/paciente (existe, mas owned:false) — MESMO erro/código que "não existe" (anti-enumeração, T305-T317)', async () => {
      const { client, calls } = clientWith([insertMessageHandler(), fileRejectedHandler('f-de-outro-paciente')]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, {
          conversationId: 'c1',
          authorUid: 'staff:1',
          body: 'msg-1',
          fileIds: ['f-de-outro-paciente'],
        }),
      ).rejects.toMatchObject({ code: 'ATTACHED_FILE_NOT_FOUND', status: 400 });

      expect(calls.some((c) => c.sql.includes('INSERT INTO conversation_messages'))).toBe(false);
    });

    it('fileId enviado por OUTRO autor (owned:false) — recusa com o MESMO código, nunca 403 (não confirma que o arquivo existe para outro uid)', async () => {
      const { client } = clientWith([insertMessageHandler(), fileRejectedHandler('f-de-outro-autor')]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, {
          conversationId: 'c1',
          authorUid: 'staff:intruso',
          body: 'msg-1',
          fileIds: ['f-de-outro-autor'],
        }),
      ).rejects.toMatchObject({ code: 'ATTACHED_FILE_NOT_FOUND', status: 400 });
    });

    it('fileId JÁ ANEXADO a outra mensagem (owned:false) — recusa, nunca reusa o mesmo arquivo em 2 mensagens', async () => {
      const { client } = clientWith([insertMessageHandler(), fileRejectedHandler('f-ja-anexado')]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, {
          conversationId: 'c1',
          authorUid: 'staff:1',
          body: 'msg-1',
          fileIds: ['f-ja-anexado'],
        }),
      ).rejects.toMatchObject({ code: 'ATTACHED_FILE_NOT_FOUND', status: 400 });
    });

    it('🔒 corrida: 2 POSTs concorrentes passam os DOIS no SELECT de posse (owned:true) mas o INSERT estoura 23505 (UNIQUE file_id, migration 461) — recusa com AttachedFileNotFoundError (400), NUNCA 500', async () => {
      const conflictErr = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      const { client, calls } = clientWith([
        insertMessageHandler(),
        filesOwnedHandler(['f1']),
        (sql) => {
          if (!sql.includes('INSERT INTO conversation_message_attachments')) return undefined;
          throw conflictErr;
        },
      ]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'msg-1', fileIds: ['f1'] }),
      ).rejects.toMatchObject({ code: 'ATTACHED_FILE_NOT_FOUND', status: 400 });

      expect(calls.some((c) => c.sql.includes('INSERT INTO conversation_message_attachments'))).toBe(true);
    });

    it('🔒 achado do gate revisao-pr (B3-r2, item 3): a corrida 23505 NUNCA atribui a colisão a um fileId específico — a UNIQUE não diz qual colidiu, e apontar `fileIds[0]` arbitrariamente é mensagem enganosa; a resposta é genérica, sem nenhum id do payload', async () => {
      const conflictErr = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      const { client } = clientWith([
        insertMessageHandler(),
        filesOwnedHandler(['f1', 'f2']),
        (sql) => {
          if (!sql.includes('INSERT INTO conversation_message_attachments')) return undefined;
          throw conflictErr;
        },
      ]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      // nenhuma das duas (`f1`/`f2`) aparece na mensagem — não há como saber qual colidiu de
      // verdade, então nenhuma é citada (mensagem genérica, `fileId: null`).
      await expect(
        useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'msg-1', fileIds: ['f1', 'f2'] }),
      ).rejects.toMatchObject({
        code: 'ATTACHED_FILE_NOT_FOUND',
        status: 400,
        fileId: null,
        message: 'one or more attached files could not be attached',
      });
    });

    it('erro de banco SEM code 23505 no INSERT de anexo propaga cru (nunca mascarado como posse)', async () => {
      const genericErr = new Error('connection reset');
      const { client } = clientWith([
        insertMessageHandler(),
        filesOwnedHandler(['f1']),
        (sql) => {
          if (!sql.includes('INSERT INTO conversation_message_attachments')) return undefined;
          throw genericErr;
        },
      ]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'msg-1', fileIds: ['f1'] }),
      ).rejects.toBe(genericErr);
    });

    it('sem fileIds: não toca conversation_message_attachments', async () => {
      const { client, calls } = clientWith([insertMessageHandler()]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'msg-1' });

      expect(calls.some((c) => c.sql.includes('INSERT INTO conversation_message_attachments'))).toBe(false);
    });
  });

  describe('fan-out na MESMA transação (D-09) — stub por ora, Bloco 4 substitui', () => {
    it('o hook de fan-out é chamado com o CLIENT da transação (não um novo/segundo)', async () => {
      const { client } = clientWith([insertMessageHandler()]);
      runOn(client);
      const fanOutHook: PostMessageFanOutHook = { execute: jest.fn().mockResolvedValue(undefined) };
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL), fanOutHook);

      const result = await useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'msg-1' });

      expect(fanOutHook.execute).toHaveBeenCalledTimes(1);
      expect(fanOutHook.execute).toHaveBeenCalledWith(client, expect.objectContaining({ id: result.id }));
    });

    it('sem hook explícito, usa o STUB no-op default — não quebra nem chama nada externo', async () => {
      const { client } = clientWith([insertMessageHandler()]);
      runOn(client);
      const useCase = new PostMessageUseCase(new ConversationRepository(POOL));

      await expect(
        useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'msg-1' }),
      ).resolves.toMatchObject({ id: 'm-new' });
    });
  });

  describe('construção sem dependências explícitas (produção real)', () => {
    it('new PostMessageUseCase() usa ConversationRepository/hook default sem lançar', async () => {
      const { client } = clientWith([insertMessageHandler()]);
      runOn(client);
      const useCase = new PostMessageUseCase();

      await expect(
        useCase.execute(POOL, { conversationId: 'c1', authorUid: 'staff:1', body: 'msg-1' }),
      ).resolves.toMatchObject({ id: 'm-new' });
    });
  });
});
