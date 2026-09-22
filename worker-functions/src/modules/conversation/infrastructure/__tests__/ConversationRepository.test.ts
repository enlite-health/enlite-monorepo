/**
 * ConversationRepository — unit (pool e KMS mockados na fronteira). Molde:
 * PatientChatIdsRepository.test.ts (pool injetado no construtor) +
 * PatientResponsibleRepository.test.ts (KMSEncryptionService mockado por módulo).
 *
 * `mapWithConcurrency` também é mockado por módulo — o mock delega para
 * `Promise.all(items.map(fn))` (preserva ordem, sem limite real) e só serve de
 * PONTO DE OBSERVAÇÃO: a suíte de decifra em paralelo espia os argumentos com
 * que o repositório o chamou (limite 10), não o comportamento interno do pool.
 * O comportamento real do pool (nunca mais que `limit` promessas simultâneas)
 * já está provado em `mapWithConcurrency.test.ts` (T105/T106) — não se repete aqui.
 */
import type { Pool } from 'pg';
import { mapWithConcurrency } from '@shared/async/mapWithConcurrency';

/** Só para cobrir o `pool ?? DatabaseConnection...` do construtor sem args (molde: PatientChatIdsRepository.test.ts). */
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

const mockEncrypt = jest.fn(async (v: string | null) => (v ? `enc:${v}` : null));
const mockDecrypt = jest.fn(async (v: string | null) => (v ? `plain:${v}` : ''));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
  })),
}));

/** Achado A5 do gate 21/09: uma falha ISOLADA de KMS ao decifrar `originalName` de UM anexo não
 *  pode derrubar a listagem inteira — espiado aqui pra provar que `reportError` é chamado sem o
 *  nome (o nome é justamente o que falhou em decifrar; nunca temos o plaintext pra vazar). */
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: mockReportError,
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@shared/async/mapWithConcurrency', () => ({
  mapWithConcurrency: jest.fn((items: unknown[], _limit: number, fn: (item: unknown) => Promise<unknown>) =>
    Promise.all(items.map(fn)),
  ),
}));

import { ConversationRepository, CONVERSATION_PAGE_SIZE } from '../ConversationRepository';

const CONVERSATION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function poolWith(query: jest.Mock): Pool {
  return { query } as unknown as Pool;
}

/** Client mockado (o que `insertMessage`/`updateMessage`/etc. recebem — nunca abrem conexão própria). */
function clientWith(query: jest.Mock) {
  return { query } as unknown as import('pg').PoolClient;
}

/** Linha crua como o SELECT de `listReplies` devolveria (aliases camelCase do SQL). */
function replyRow(overrides: Partial<{
  id: string;
  conversationId: string;
  rootMessageId: string;
  authorUid: string;
  bodyEncrypted: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}> = {}) {
  return {
    id: 'r1',
    conversationId: CONVERSATION_ID,
    rootMessageId: 'm1',
    authorUid: 'staff:1',
    bodyEncrypted: 'enc:msg-1',
    createdAt: new Date('2026-09-01T10:05:00.000Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/** Linha crua como o SELECT de `listTopMessages` devolveria (aliases camelCase do SQL). */
function topRow(overrides: Partial<{
  id: string;
  conversationId: string;
  authorUid: string;
  bodyEncrypted: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  replyCount: number;
  lastReplyAt: Date | null;
}> = {}) {
  return {
    id: 'm1',
    conversationId: CONVERSATION_ID,
    authorUid: 'staff:1',
    bodyEncrypted: 'enc:msg-1',
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    editedAt: null,
    deletedAt: null,
    replyCount: 0,
    lastReplyAt: null,
    ...overrides,
  };
}

describe('ConversationRepository', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('construtor sem pool explícito usa DatabaseConnection.getInstance().getPool() (produção real)', () => {
    expect(() => new ConversationRepository()).not.toThrow();
  });

  describe('listTopMessages — paginação por cursor', () => {
    it('sem cursor: só filtra por conversationId, sem cláusula de comparação de tupla', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listTopMessages(CONVERSATION_ID, null, 50);

      const [sql, params] = query.mock.calls[0];
      expect(sql).not.toContain('(m.created_at, m.id) >');
      expect(params).toEqual([CONVERSATION_ID, 50]);
    });

    it('com cursor: filtra por (created_at, id) > (cursor), nesta ordem nos params', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));
      const after = { createdAt: new Date('2026-09-01T10:00:00.000Z'), id: 'm2' };

      await repo.listTopMessages(CONVERSATION_ID, after, 50);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('(m.created_at, m.id) >');
      expect(params).toEqual([CONVERSATION_ID, after.createdAt, after.id, 50]);
    });

    it('EMPATE de created_at: o cursor da página 2 usa o id do ÚLTIMO item da página 1 (nunca o primeiro) — é o id que desempata', async () => {
      const tie = new Date('2026-09-01T10:00:00.000Z');
      // três mensagens de topo com o MESMO created_at (empate real: import em lote, mesmo timestamp).
      const m1 = topRow({ id: 'm1', createdAt: tie });
      const m2 = topRow({ id: 'm2', createdAt: tie });
      const m3 = topRow({ id: 'm3', createdAt: tie });

      // página 1 (limit 2) devolve m1, m2 — o cursor pra próxima página nasce do ÚLTIMO (m2).
      const page1Query = jest.fn().mockResolvedValue({ rows: [m1, m2] });
      const page1 = await new ConversationRepository(poolWith(page1Query)).listTopMessages(
        CONVERSATION_ID,
        null,
        2,
      );
      const lastOfPage1 = page1[page1.length - 1];
      expect(lastOfPage1.id).toBe('m2');

      // página 2, com o cursor do item que a página 1 devolveu por ÚLTIMO.
      const page2Query = jest.fn().mockResolvedValue({ rows: [m3] });
      await new ConversationRepository(poolWith(page2Query)).listTopMessages(
        CONVERSATION_ID,
        { createdAt: lastOfPage1.createdAt, id: lastOfPage1.id },
        2,
      );

      const [, page2Params] = page2Query.mock.calls[0];
      // se o cursor usasse o PRIMEIRO item (m1) em vez do último (m2), a tupla (tie, 'm1') deixaria
      // m2 elegível de novo na página 2 (repetição) — usar o último é o que evita isso.
      expect(page2Params).toEqual([CONVERSATION_ID, tie, 'm2', 2]);
      expect(page2Params[2]).not.toBe('m1');
    });
  });

  describe('listTopMessages — limit default', () => {
    it('sem limit explícito, usa CONVERSATION_PAGE_SIZE (50)', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listTopMessages(CONVERSATION_ID, null);

      const [, params] = query.mock.calls[0];
      expect(params).toEqual([CONVERSATION_ID, CONVERSATION_PAGE_SIZE]);
    });
  });

  describe('decifra em paralelo', () => {
    it('passa as linhas por mapWithConcurrency com limite 10 — nunca em série, nunca sem limite', async () => {
      const rows = [topRow({ id: 'm1' }), topRow({ id: 'm2' })];
      const query = jest.fn().mockResolvedValue({ rows });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listTopMessages(CONVERSATION_ID, null, 50);

      // 2 chamadas: corpo da mensagem + nome do anexo (achado T-nome-anexo) — mesmo limite (10) nas duas.
      expect(mapWithConcurrency).toHaveBeenCalledTimes(2);
      expect(mapWithConcurrency).toHaveBeenCalledWith(rows, 10, expect.any(Function));
    });

    it('o corpo decifrado da resposta vem do mapWithConcurrency, não de decrypt chamado direto em série', async () => {
      const rows = [topRow({ id: 'm1', bodyEncrypted: 'enc:msg-1' })];
      const query = jest.fn().mockResolvedValue({ rows });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(out.body).toBe('plain:enc:msg-1');
      expect(mockDecrypt).toHaveBeenCalledWith('enc:msg-1');
    });
  });

  describe('agrega replyCount/lastReplyAt por mensagem de topo', () => {
    it('devolve replyCount e lastReplyAt da linha (uma query, GROUP BY root_message_id)', async () => {
      const lastReplyAt = new Date('2026-09-02T00:00:00.000Z');
      const query = jest.fn().mockResolvedValue({
        rows: [topRow({ id: 'm1', replyCount: 3, lastReplyAt })],
      });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(out.replyCount).toBe(3);
      expect(out.lastReplyAt).toEqual(lastReplyAt);
      expect(query.mock.calls[0][0]).toContain('GROUP BY root_message_id');
    });

    it('mensagem de topo sem nenhuma reply: replyCount 0 e lastReplyAt null', async () => {
      const query = jest.fn().mockResolvedValue({
        rows: [topRow({ id: 'm1', replyCount: 0, lastReplyAt: null })],
      });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(out.replyCount).toBe(0);
      expect(out.lastReplyAt).toBeNull();
    });
  });

  describe('mentions — agregação por mensagem (LACUNA 2 do fecho do B1)', () => {
    it('listTopMessages: UMA query com IN/ANY para mentions de VÁRIAS mensagens — nunca uma por mensagem (evita N+1)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' }), topRow({ id: 'm2' })] })
        .mockResolvedValueOnce({
          rows: [
            { messageId: 'm1', mentionedUid: 'staff:2' },
            { messageId: 'm1', mentionedUid: 'staff:3' },
            { messageId: 'm2', mentionedUid: 'staff:4' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      const out = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      // exatamente 3 chamadas ao pool: 1 para as mensagens, 1 para TODAS as mentions, 1 para
      // TODOS os anexos — nunca 1+N (mesma disciplina das duas agregações).
      expect(query).toHaveBeenCalledTimes(3);
      const [mentionsSql, mentionsParams] = query.mock.calls[1];
      expect(mentionsSql).toContain('WHERE message_id = ANY($1::uuid[])');
      expect(mentionsParams).toEqual([['m1', 'm2']]);

      expect(out.find((m) => m.id === 'm1')?.mentions).toEqual(['staff:2', 'staff:3']);
      expect(out.find((m) => m.id === 'm2')?.mentions).toEqual(['staff:4']);
    });

    it('listTopMessages: mensagem sem nenhuma menção devolve mentions: [] (nunca undefined)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(out.mentions).toEqual([]);
    });

    it('listTopMessages: página vazia NUNCA dispara a query de mentions (0 ids, nada para buscar)', async () => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(query).toHaveBeenCalledTimes(1);
    });

    it('listReplies: mesma agregação (UMA query com ANY), replies de threads diferentes não se misturam', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [replyRow({ id: 'r1' }), replyRow({ id: 'r2' })] })
        .mockResolvedValueOnce({
          rows: [{ messageId: 'r1', mentionedUid: 'staff:9' }],
        })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      const out = await repo.listReplies('m1');

      expect(query).toHaveBeenCalledTimes(3);
      const [, mentionsParams] = query.mock.calls[1];
      expect(mentionsParams).toEqual([['r1', 'r2']]);
      expect(out.find((r) => r.id === 'r1')?.mentions).toEqual(['staff:9']);
      expect(out.find((r) => r.id === 'r2')?.mentions).toEqual([]);
    });
  });

  describe('mentionDisplayNames — nome de cada menção resolvido na MESMA leitura (item 5a, gap irmão de authorDisplayName, F19)', () => {
    it('listTopMessages: cada uid mencionado ganha displayName no mapa, na MESMA query de mentions (sem query nova)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' }), topRow({ id: 'm2' })] })
        .mockResolvedValueOnce({
          rows: [
            { messageId: 'm1', mentionedUid: 'staff:2', mentionedDisplayName: 'Fulano' },
            { messageId: 'm1', mentionedUid: 'staff:3', mentionedDisplayName: 'Beltrano' },
            { messageId: 'm2', mentionedUid: 'staff:4', mentionedDisplayName: null },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      const out = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      // continua exatamente 3 chamadas — o nome vem da MESMA query de mentions, não de uma nova.
      expect(query).toHaveBeenCalledTimes(3);
      const m1 = out.find((m) => m.id === 'm1');
      const m2 = out.find((m) => m.id === 'm2');
      expect(m1?.mentions).toEqual(['staff:2', 'staff:3']); // uids inalterados (compat)
      expect(m1?.mentionDisplayNames).toEqual({ 'staff:2': 'Fulano', 'staff:3': 'Beltrano' });
      expect(m2?.mentionDisplayNames).toEqual({ 'staff:4': null }); // uid mencionado sem cadastro/JOIN vazio
    });

    it('listTopMessages: mensagem sem menção nenhuma devolve mentionDisplayNames: {} (nunca undefined)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(out.mentionDisplayNames).toEqual({});
    });

    it('a query de mentions faz LEFT JOIN users sem quebrar o WHERE já testado (message_id = ANY)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listTopMessages(CONVERSATION_ID, null, 50);

      const [mentionsSql] = query.mock.calls[1];
      expect(mentionsSql).toContain('LEFT JOIN users');
      expect(mentionsSql).toContain('WHERE message_id = ANY($1::uuid[])');
    });

    it('listReplies: mesmo mapa de nomes, por reply', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [replyRow({ id: 'r1' })] })
        .mockResolvedValueOnce({ rows: [{ messageId: 'r1', mentionedUid: 'staff:9', mentionedDisplayName: 'Ciclana' }] })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listReplies('m1');

      expect(out.mentionDisplayNames).toEqual({ 'staff:9': 'Ciclana' });
    });
  });

  describe('authorDisplayName — nome do autor por JOIN no servidor (item 5a, "un uid cru" em prd)', () => {
    it('listTopMessages: SELECT ganha LEFT JOIN users e devolve authorDisplayName da linha', async () => {
      const query = jest.fn().mockResolvedValue({
        rows: [{ ...topRow({ id: 'm1', authorUid: 'staff:1' }), authorDisplayName: 'Fulano de Tal' }],
      });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(out.authorDisplayName).toBe('Fulano de Tal');
      const [sql] = query.mock.calls[0];
      expect(sql).toContain('LEFT JOIN users');
      expect(sql).toContain('"authorDisplayName"');
    });

    it('listTopMessages: autor sem registro em users (JOIN vazio) devolve authorDisplayName null, nunca undefined', async () => {
      const query = jest.fn().mockResolvedValue({
        rows: [{ ...topRow({ id: 'm1' }), authorDisplayName: null }],
      });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(out.authorDisplayName).toBeNull();
    });

    it('listReplies: mesma resolução de authorDisplayName por JOIN', async () => {
      const query = jest.fn().mockResolvedValue({
        rows: [{ ...replyRow({ id: 'r1', authorUid: 'staff:1' }), authorDisplayName: 'Fulano de Tal' }],
      });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listReplies('m1');

      expect(out.authorDisplayName).toBe('Fulano de Tal');
      const [sql] = query.mock.calls[0];
      expect(sql).toContain('LEFT JOIN users');
      // as duas asserções já existentes (WHERE/ORDER BY) continuam válidas — SQL só ganhou o JOIN.
      expect(sql).toContain('WHERE root_message_id = $1');
      expect(sql).toContain('ORDER BY created_at ASC, id ASC');
    });
  });

  describe('attachments — agregação por mensagem (achado fechado no Bloco 3, evidencias/b3-backend-anexo.md)', () => {
    it('listTopMessages: UMA query com JOIN+ANY para anexos de VÁRIAS mensagens — nunca uma por mensagem (evita N+1)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' }), topRow({ id: 'm2' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { messageId: 'm1', fileId: 'f1', contentType: 'application/pdf', sizeBytes: 1024, originalNameEncrypted: 'enc:doc-um.pdf' },
            { messageId: 'm1', fileId: 'f2', contentType: 'image/png', sizeBytes: 2048, originalNameEncrypted: 'enc:foto-dois.png' },
          ],
        });
      const repo = new ConversationRepository(poolWith(query));

      const out = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(query).toHaveBeenCalledTimes(3);
      const [attachmentsSql, attachmentsParams] = query.mock.calls[2];
      expect(attachmentsSql).toContain('FROM conversation_message_attachments cma');
      expect(attachmentsSql).toContain('JOIN stored_files sf ON sf.id = cma.file_id');
      expect(attachmentsSql).toContain('WHERE cma.message_id = ANY($1::uuid[])');
      expect(attachmentsSql).toContain('sf.original_name_encrypted AS "originalNameEncrypted"');
      expect(attachmentsParams).toEqual([['m1', 'm2']]);

      expect(out.find((m) => m.id === 'm1')?.attachments).toEqual([
        { fileId: 'f1', contentType: 'application/pdf', sizeBytes: 1024, originalName: 'plain:enc:doc-um.pdf' },
        { fileId: 'f2', contentType: 'image/png', sizeBytes: 2048, originalName: 'plain:enc:foto-dois.png' },
      ]);
      expect(out.find((m) => m.id === 'm2')?.attachments).toEqual([]);
    });

    it('🔒 achado (T-nome-anexo): decifra `originalName` em LOTE (mapWithConcurrency, mesmo limite 10 do body) — nunca uma chamada KMS por anexo sem limite', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ messageId: 'm1', fileId: 'f1', contentType: 'application/pdf', sizeBytes: 1024, originalNameEncrypted: 'enc:x.pdf' }],
        });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listTopMessages(CONVERSATION_ID, null, 50);

      // mapWithConcurrency é chamado para o corpo E para os nomes de anexo — mesmo limite (10).
      const namesCall = (mapWithConcurrency as jest.Mock).mock.calls.find(
        ([items]) => Array.isArray(items) && items.length === 1 && (items[0] as { fileId: string }).fileId === 'f1',
      );
      expect(namesCall).toBeDefined();
      expect(namesCall![1]).toBe(10);
    });

    it('🔒 achado A5 do gate (21/09): falha de KMS ao decifrar UM `originalName` isola SÓ aquele anexo (originalName: null) — não derruba a listagem inteira', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { messageId: 'm1', fileId: 'f1', contentType: 'application/pdf', sizeBytes: 1024, originalNameEncrypted: 'enc:doc-ok.pdf' },
            { messageId: 'm1', fileId: 'f2', contentType: 'image/png', sizeBytes: 2048, originalNameEncrypted: 'enc:falha.png' },
          ],
        });
      // 3 decrypts nesta ordem: 1º o BODY da mensagem (`mapWithConcurrency` do corpo roda antes de
      // `fetchAttachmentsByMessageIds`), depois f1 (sucesso), depois f2 (a falha isolada de KMS).
      mockDecrypt
        .mockImplementationOnce(async (v: string | null) => (v ? `plain:${v}` : ''))
        .mockImplementationOnce(async (v: string | null) => (v ? `plain:${v}` : ''))
        .mockImplementationOnce(async () => { throw new Error('Failed to decrypt data'); });
      const repo = new ConversationRepository(poolWith(query));

      const out = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      // a listagem NÃO rejeita (não derruba a request inteira) — o anexo que falhou vira originalName: null.
      expect(out.find((m) => m.id === 'm1')?.attachments).toEqual([
        { fileId: 'f1', contentType: 'application/pdf', sizeBytes: 1024, originalName: 'plain:enc:doc-ok.pdf' },
        { fileId: 'f2', contentType: 'image/png', sizeBytes: 2048, originalName: null },
      ]);

      // a falha É reportada — mas SEM o nome (o nome é exatamente o que não temos: nunca decifrou).
      expect(mockReportError).toHaveBeenCalledTimes(1);
      const [reportedErr, reportedContext] = mockReportError.mock.calls[0];
      expect(reportedErr).toBeInstanceOf(Error);
      expect(reportedContext).toMatchObject({ fileId: 'f2' });
      expect(JSON.stringify(reportedContext)).not.toContain('falha.png');
      expect(JSON.stringify(reportedContext)).not.toMatch(/originalName|plain:/);
    });

    it('listTopMessages: mensagem sem nenhum anexo devolve attachments: [] (nunca undefined)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listTopMessages(CONVERSATION_ID, null, 50);

      expect(out.attachments).toEqual([]);
    });

    it('listTopMessages: página vazia NUNCA dispara a query de anexos (0 ids, nada para buscar)', async () => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listTopMessages(CONVERSATION_ID, null, 50);

      // 1 chamada só: nem mentions nem anexos disparam query com 0 ids.
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('listReplies: mesma agregação (UMA query com JOIN+ANY), com originalName decifrado (achado T-nome-anexo — a listagem agora devolve o nome)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [replyRow({ id: 'r1' }), replyRow({ id: 'r2' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ messageId: 'r1', fileId: 'f9', contentType: 'application/pdf', sizeBytes: 512, originalNameEncrypted: 'enc:laudo.pdf' }],
        });
      const repo = new ConversationRepository(poolWith(query));

      const out = await repo.listReplies('m1');

      expect(query).toHaveBeenCalledTimes(3);
      const [, attachmentsParams] = query.mock.calls[2];
      expect(attachmentsParams).toEqual([['r1', 'r2']]);
      const r1 = out.find((r) => r.id === 'r1');
      expect(r1?.attachments).toEqual([{ fileId: 'f9', contentType: 'application/pdf', sizeBytes: 512, originalName: 'plain:enc:laudo.pdf' }]);
      expect(Object.keys(r1?.attachments[0] ?? {}).sort()).toEqual(['contentType', 'fileId', 'originalName', 'sizeBytes']);
      expect(out.find((r) => r.id === 'r2')?.attachments).toEqual([]);
    });

    it('🔒 achado do gate revisao-pr (B3): a query de anexos JOIN conversation_messages ... AND deleted_at IS NULL — mensagem apagada nunca serve anexo (soft delete zera só o body, D-04, mas o filtro é defesa em profundidade no servidor)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listTopMessages(CONVERSATION_ID, null, 50);

      const [attachmentsSql] = query.mock.calls[2];
      expect(attachmentsSql).toContain('JOIN conversation_messages cm ON cm.id = cma.message_id AND cm.deleted_at IS NULL');
    });

    it('🔒 achado B5 do gate fecho: a query de anexos filtra sf.deleted_at IS NULL — arquivo apagado (stored_files.deleted_at) nunca sai na listagem, mesmo anexado a mensagem viva', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [topRow({ id: 'm1' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listTopMessages(CONVERSATION_ID, null, 50);

      const [attachmentsSql] = query.mock.calls[2];
      expect(attachmentsSql).toContain('sf.deleted_at IS NULL');
    });
  });

  describe('findMessageThreadInfo — id/root_message_id de uma mensagem (base da normalização D-03)', () => {
    it('mensagem é REPLY (root_message_id preenchido): devolve o rootMessageId da linha', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ id: 'r1', rootMessageId: 'm1' }] });
      const repo = new ConversationRepository(poolWith(jest.fn()));

      const info = await repo.findMessageThreadInfo('r1', clientWith(query));

      expect(info).toEqual({ id: 'r1', rootMessageId: 'm1' });
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('FROM conversation_messages WHERE id = $1');
      expect(params).toEqual(['r1']);
    });

    it('mensagem é ROOT (root_message_id NULL): devolve rootMessageId null', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ id: 'm1', rootMessageId: null }] });
      const repo = new ConversationRepository(poolWith(jest.fn()));

      const info = await repo.findMessageThreadInfo('m1', clientWith(query));

      expect(info).toEqual({ id: 'm1', rootMessageId: null });
    });

    it('mensagem inexistente: devolve null', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new ConversationRepository(poolWith(jest.fn()));

      const info = await repo.findMessageThreadInfo('nao-existe', clientWith(query));

      expect(info).toBeNull();
    });

    it('sem executor explícito, usa o pool do construtor', async () => {
      const poolQuery = jest.fn().mockResolvedValue({ rows: [{ id: 'm1', rootMessageId: null }] });
      const repo = new ConversationRepository(poolWith(poolQuery));

      await repo.findMessageThreadInfo('m1');

      expect(poolQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('listReplies — todas as replies de uma thread, decifradas pelo pool', () => {
    it('filtra por root_message_id e ordena por created_at ASC, id ASC', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      await repo.listReplies('m1');

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('WHERE root_message_id = $1');
      expect(sql).toContain('ORDER BY created_at ASC, id ASC');
      expect(params).toEqual(['m1']);
    });

    it('decifra pelo mapWithConcurrency com limite 10, como listTopMessages (D-01)', async () => {
      const rows = [replyRow({ id: 'r1' }), replyRow({ id: 'r2' })];
      const query = jest.fn().mockResolvedValue({ rows });
      const repo = new ConversationRepository(poolWith(query));

      const out = await repo.listReplies('m1');

      // 2 chamadas: corpo da mensagem + nome do anexo (achado T-nome-anexo) — mesmo limite (10) nas duas.
      expect(mapWithConcurrency).toHaveBeenCalledTimes(2);
      expect(mapWithConcurrency).toHaveBeenCalledWith(rows, 10, expect.any(Function));
      expect(out.map((r) => r.body)).toEqual(['plain:enc:msg-1', 'plain:enc:msg-1']);
      expect(mockDecrypt).toHaveBeenCalledWith('enc:msg-1');
    });

    it('devolve rootMessageId e demais campos mapeados da linha crua', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [replyRow({ id: 'r1', rootMessageId: 'm1' })] });
      const repo = new ConversationRepository(poolWith(query));

      const [out] = await repo.listReplies('m1');

      expect(out).toMatchObject({
        id: 'r1',
        conversationId: CONVERSATION_ID,
        rootMessageId: 'm1',
        authorUid: 'staff:1',
        body: 'plain:enc:msg-1',
      });
    });
  });

  describe('insertMessage — recebe client de fora, nunca abre conexão própria', () => {
    it('cifra o body ANTES do INSERT e devolve id/createdAt da linha gravada', async () => {
      const createdAt = new Date('2026-09-01T11:00:00.000Z');
      const query = jest.fn().mockResolvedValue({ rows: [{ id: 'm9', createdAt }] });
      const client = clientWith(query);
      const repo = new ConversationRepository(poolWith(jest.fn()));

      const result = await repo.insertMessage(
        { conversationId: CONVERSATION_ID, rootMessageId: null, authorUid: 'staff:1', body: 'msg-1' },
        client,
      );

      expect(mockEncrypt).toHaveBeenCalledWith('msg-1');
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('INSERT INTO conversation_messages');
      expect(params).toEqual([CONVERSATION_ID, null, 'staff:1', 'enc:msg-1']);
      expect(result).toEqual({ id: 'm9', createdAt });
    });

    it('grava rootMessageId quando é reply', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ id: 'r1', createdAt: new Date() }] });
      const client = clientWith(query);
      const repo = new ConversationRepository(poolWith(jest.fn()));

      await repo.insertMessage(
        { conversationId: CONVERSATION_ID, rootMessageId: 'm1', authorUid: 'staff:1', body: 'msg-1' },
        client,
      );

      const [, params] = query.mock.calls[0];
      expect(params).toEqual([CONVERSATION_ID, 'm1', 'staff:1', 'enc:msg-1']);
    });

    it('nunca chama pool.connect() — só usa o client recebido', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ id: 'm9', createdAt: new Date() }] });
      const client = clientWith(query);
      const poolConnect = jest.fn();
      const repo = new ConversationRepository({ query: jest.fn(), connect: poolConnect } as unknown as Pool);

      await repo.insertMessage(
        { conversationId: CONVERSATION_ID, rootMessageId: null, authorUid: 'staff:1', body: 'msg-1' },
        client,
      );

      expect(poolConnect).not.toHaveBeenCalled();
    });
  });

  describe('updateMessage — re-cifra e marca edited_at', () => {
    it('cifra o novo body e faz UPDATE de body_encrypted + edited_at pelo id', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const client = clientWith(query);
      const repo = new ConversationRepository(poolWith(jest.fn()));

      await repo.updateMessage('m1', 'msg-1-editada', client);

      expect(mockEncrypt).toHaveBeenCalledWith('msg-1-editada');
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('SET body_encrypted = $2, edited_at = now()');
      expect(sql).toContain('WHERE id = $1');
      expect(params).toEqual(['m1', 'enc:msg-1-editada']);
    });

    it('filtra AND deleted_at IS NULL — nunca ressuscita mensagem apagada (achado do gate, Bloco 1)', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const client = clientWith(query);
      const repo = new ConversationRepository(poolWith(jest.fn()));

      await repo.updateMessage('m1', 'msg-1-editada', client);

      const [sql] = query.mock.calls[0];
      expect(sql).toContain('WHERE id = $1 AND deleted_at IS NULL');
    });
  });

  describe('softDeleteMessage — zera body_encrypted E carimba deleted_at na MESMA instrução', () => {
    it('o SQL emitido contém deleted_at = now() e body_encrypted = NULL, num único UPDATE', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const client = clientWith(query);
      const repo = new ConversationRepository(poolWith(jest.fn()));

      await repo.softDeleteMessage('m1', client);

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('deleted_at = now()');
      expect(sql).toContain('body_encrypted = NULL');
      expect(sql).toContain('WHERE id = $1');
      expect(params).toEqual(['m1']);
      // nunca chama o KMS: apagar não é uma escrita de corpo, é a ausência dele.
      expect(mockEncrypt).not.toHaveBeenCalled();
    });
  });

  describe('getReadState — lastReadAt + unreadCount do ATOR (D-11), UMA query', () => {
    const ACTOR = 'staff:actor';

    it('faz exatamente UMA chamada ao pool — CTE + subqueries, nunca uma query de contagem por mensagem', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ lastReadAt: null, unreadCount: 0 }] });
      const repo = new ConversationRepository(poolWith(query));

      await repo.getReadState(CONVERSATION_ID, ACTOR);

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('WITH mark AS');
      expect(sql).toContain('author_uid <>');
      expect(sql).toContain("COALESCE((SELECT last_read_at FROM mark), '-infinity'::timestamptz)");
      expect(params).toEqual([CONVERSATION_ID, ACTOR]);
    });

    it('sem marca de leitura: lastReadAt null (linha do CTE devolve null)', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ lastReadAt: null, unreadCount: 4 }] });
      const repo = new ConversationRepository(poolWith(query));

      const state = await repo.getReadState(CONVERSATION_ID, ACTOR);

      expect(state.lastReadAt).toBeNull();
      expect(state.unreadCount).toBe(4);
    });

    it('com marca de leitura: devolve o lastReadAt da linha e o unreadCount pós-corte', async () => {
      const lastReadAt = new Date('2026-09-20T12:00:00.000Z');
      const query = jest.fn().mockResolvedValue({ rows: [{ lastReadAt, unreadCount: 1 }] });
      const repo = new ConversationRepository(poolWith(query));

      const state = await repo.getReadState(CONVERSATION_ID, ACTOR);

      expect(state.lastReadAt).toEqual(lastReadAt);
      expect(state.unreadCount).toBe(1);
    });

    it('executor explícito (client de transação) é usado no lugar do pool do construtor', async () => {
      const poolQuery = jest.fn();
      const clientQuery = jest.fn().mockResolvedValue({ rows: [{ lastReadAt: null, unreadCount: 0 }] });
      const repo = new ConversationRepository(poolWith(poolQuery));

      await repo.getReadState(CONVERSATION_ID, ACTOR, clientWith(clientQuery));

      expect(poolQuery).not.toHaveBeenCalled();
      expect(clientQuery).toHaveBeenCalledTimes(1);
    });

    it('sem linha nenhuma no resultado (defensivo): devolve lastReadAt null e unreadCount 0', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new ConversationRepository(poolWith(query));

      const state = await repo.getReadState(CONVERSATION_ID, ACTOR);

      expect(state).toEqual({ lastReadAt: null, unreadCount: 0 });
    });
  });

  describe('upsertReadMark — ON CONFLICT DO UPDATE, nunca INSERT que duplica', () => {
    it('o SQL contém ON CONFLICT (conversation_id, user_uid) DO UPDATE', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const client = clientWith(query);
      const repo = new ConversationRepository(poolWith(jest.fn()));
      const lastReadAt = new Date('2026-09-01T12:00:00.000Z');

      await repo.upsertReadMark(CONVERSATION_ID, 'staff:1', lastReadAt, client);

      const [sql, params] = query.mock.calls[0];
      // prova que a MESMA instrução que insere é a que resolve o conflito — nunca dois
      // statements (um INSERT solto seguido de um UPDATE condicional).
      expect(query).toHaveBeenCalledTimes(1);
      expect(sql).toContain('INSERT INTO conversation_read_marks');
      expect(sql).toContain('ON CONFLICT (conversation_id, user_uid) DO UPDATE');
      expect(params).toEqual([CONVERSATION_ID, 'staff:1', lastReadAt]);
    });

    it('o UPDATE do conflito usa EXCLUDED.last_read_at (a chamada MAIS RECENTE vence)', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const client = clientWith(query);
      const repo = new ConversationRepository(poolWith(jest.fn()));

      await repo.upsertReadMark(CONVERSATION_ID, 'staff:1', new Date(), client);

      const [sql] = query.mock.calls[0];
      expect(sql).toContain('SET last_read_at = EXCLUDED.last_read_at');
    });
  });

  describe('findPatientIdByConversationId — Bloco 4 (T403), fan-out precisa do patient_id da conversa', () => {
    it('conversa existe: devolve o patient_id da linha', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ patientId: 'p1' }] });
      const repo = new ConversationRepository(poolWith(jest.fn()));

      const patientId = await repo.findPatientIdByConversationId(CONVERSATION_ID, clientWith(query));

      expect(patientId).toBe('p1');
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('FROM conversations WHERE id = $1');
      expect(params).toEqual([CONVERSATION_ID]);
    });

    it('conversa não existe (defesa em profundidade): devolve null, nunca lança', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new ConversationRepository(poolWith(jest.fn()));

      const patientId = await repo.findPatientIdByConversationId('inexistente', clientWith(query));

      expect(patientId).toBeNull();
    });
  });

  describe('listThreadAuthorUids — Bloco 4 (T402), quem participou da thread (ROOT + replies)', () => {
    it('devolve os uids distintos de author_uid da thread inteira (root OU root_message_id = rootId)', async () => {
      const query = jest.fn().mockResolvedValue({
        rows: [{ authorUid: 'root-author' }, { authorUid: 'reply-author-2' }],
      });
      const repo = new ConversationRepository(poolWith(jest.fn()));

      const uids = await repo.listThreadAuthorUids('m1', clientWith(query));

      expect(uids).toEqual(['root-author', 'reply-author-2']);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('WHERE id = $1 OR root_message_id = $1');
      expect(sql).toContain('DISTINCT author_uid');
      expect(params).toEqual(['m1']);
    });

    it('thread sem nenhuma linha (root apagado/inexistente): devolve array vazio, nunca lança', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new ConversationRepository(poolWith(jest.fn()));

      const uids = await repo.listThreadAuthorUids('inexistente', clientWith(query));

      expect(uids).toEqual([]);
    });
  });
});
