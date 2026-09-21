/**
 * FanOutNotificationUseCase — TDD (spec 022, Bloco 4, T401/T402).
 *
 * Molde: `PostMessageUseCase.test.ts` — `clientWith(handlers)` roteia `client.query` por
 * SUBSTRING do SQL; NÃO mocka `NotificationRepository`/`ConversationRepository` inteiros (usa as
 * classes reais) para poder inspecionar o SQL/params literais dos INSERTs — só "chamou insert"
 * não prova quem entrou na lista de destinatários; ver os params prova.
 *
 * Regra (D-09): destinatários = mencionados ∪ autor do root ∪ autores de replies da thread,
 * MENOS o autor da mensagem atual, dedupe por uid. Decisão de desenho desta implementação
 * (documentada aqui e na evidência): quando um uid está em AMBOS os conjuntos (mencionado E
 * participante da thread), ele recebe SÓ a notificação de menção (`CONVERSATION_MENTIONED`) —
 * nunca duas notificações para a mesma mensagem.
 */
import type { Pool, PoolClient } from 'pg';
import { FanOutNotificationUseCase } from '../FanOutNotificationUseCase';
import { NotificationRepository } from '../../infrastructure/NotificationRepository';
import { ConversationRepository } from '@modules/conversation/infrastructure/ConversationRepository';
import type { PostMessageResult } from '@modules/conversation/application/PostMessageUseCase';

/** Nunca usado de fato — `client` de cada teste é quem recebe as chamadas; molde
 * `PostMessageUseCase.test.ts` (evita o construtor default cair em `DatabaseConnection.getInstance()`,
 * que lança sem `DATABASE_URL` no ambiente de teste unitário). */
const POOL = {} as unknown as Pool;

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

function threadAuthorsHandler(authorUids: string[]): Handler {
  return (sql) =>
    sql.includes('FROM conversation_messages') && sql.includes('DISTINCT author_uid')
      ? { rows: authorUids.map((authorUid) => ({ authorUid })) }
      : undefined;
}

function insertEventHandler(idsByType: Partial<Record<string, string>>): Handler {
  return (sql, params) => {
    if (!sql.includes('INSERT INTO notification_events')) return undefined;
    const typeCode = params[0] as string;
    return { rows: [{ id: idsByType[typeCode] ?? `evt-${typeCode}` }] };
  };
}

function baseMessage(overrides: Partial<PostMessageResult> = {}): PostMessageResult {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    patientId: 'patient-1',
    rootMessageId: null,
    authorUid: 'author-1',
    createdAt: new Date('2026-09-21T10:00:00.000Z'),
    mentionedUids: [],
    ...overrides,
  };
}

describe('FanOutNotificationUseCase (D-09)', () => {
  it('mensagem de topo com 2 menções: 1 evento CONVERSATION_MENTIONED com os 2 uids, nenhuma consulta de thread', async () => {
    const { client, calls } = clientWith([insertEventHandler({})]);
    const useCase = new FanOutNotificationUseCase(new NotificationRepository(POOL), new ConversationRepository(POOL));

    await useCase.execute(client, baseMessage({ mentionedUids: ['u2', 'u3'] }));

    const threadQuery = calls.find((c) => c.sql.includes('DISTINCT author_uid'));
    expect(threadQuery).toBeUndefined(); // sem rootMessageId, nunca consulta thread

    const eventInsert = calls.find((c) => c.sql.includes('INSERT INTO notification_events'));
    expect(eventInsert?.params).toEqual(['CONVERSATION_MENTIONED', 'author-1', 'patient-1', 'conv-1', 'msg-1']);

    const notifInsert = calls.find((c) => c.sql.includes('INSERT INTO notifications'));
    expect(notifInsert?.params).toEqual(['evt-CONVERSATION_MENTIONED', 'u2', 'u3']);
  });

  it('menção duplicada no corpo (mesmo uid 2x): dedupe — 1 notificação só, nunca 2 para o mesmo destinatário', async () => {
    const { client, calls } = clientWith([insertEventHandler({})]);
    const useCase = new FanOutNotificationUseCase(new NotificationRepository(POOL), new ConversationRepository(POOL));

    await useCase.execute(client, baseMessage({ mentionedUids: ['u2', 'u2'] }));

    const notifInsert = calls.find((c) => c.sql.includes('INSERT INTO notifications'));
    expect(notifInsert?.params).toEqual(['evt-CONVERSATION_MENTIONED', 'u2']);
  });

  it('autor mencionar a si mesmo: nunca gera notificação para o próprio autor', async () => {
    const { client, calls } = clientWith([insertEventHandler({})]);
    const useCase = new FanOutNotificationUseCase(new NotificationRepository(POOL), new ConversationRepository(POOL));

    await useCase.execute(client, baseMessage({ mentionedUids: ['author-1'] }));

    const eventInsert = calls.find((c) => c.sql.includes('INSERT INTO notification_events'));
    expect(eventInsert).toBeUndefined();
    const notifInsert = calls.find((c) => c.sql.includes('INSERT INTO notifications'));
    expect(notifInsert).toBeUndefined();
  });

  it('reply numa thread de 3 participantes: notifica os outros 2, NUNCA o autor da resposta atual', async () => {
    const { client, calls } = clientWith([
      threadAuthorsHandler(['root-author', 'author-1', 'reply-author-2']),
      insertEventHandler({}),
    ]);
    const useCase = new FanOutNotificationUseCase(new NotificationRepository(POOL), new ConversationRepository(POOL));

    await useCase.execute(
      client,
      baseMessage({ id: 'msg-reply', rootMessageId: 'root-msg', authorUid: 'author-1' }),
    );

    const eventInsert = calls.find((c) => c.sql.includes('INSERT INTO notification_events'));
    expect(eventInsert?.params).toEqual(['CONVERSATION_REPLIED', 'author-1', 'patient-1', 'conv-1', 'msg-reply']);

    const notifInsert = calls.find((c) => c.sql.includes('INSERT INTO notifications'));
    expect(notifInsert?.params).toEqual(['evt-CONVERSATION_REPLIED', 'root-author', 'reply-author-2']);
  });

  it('reply de quem TAMBÉM foi mencionado nesta mesma mensagem: recebe só MENTIONED, nunca as duas', async () => {
    const { client, calls } = clientWith([
      threadAuthorsHandler(['root-author', 'author-1']),
      insertEventHandler({}),
    ]);
    const useCase = new FanOutNotificationUseCase(new NotificationRepository(POOL), new ConversationRepository(POOL));

    await useCase.execute(
      client,
      baseMessage({
        id: 'msg-reply',
        rootMessageId: 'root-msg',
        authorUid: 'author-1',
        mentionedUids: ['root-author'],
      }),
    );

    const eventInserts = calls.filter((c) => c.sql.includes('INSERT INTO notification_events'));
    expect(eventInserts).toHaveLength(1); // só MENTIONED — REPLIED ficaria vazio (só sobraria author-1, excluído)
    expect(eventInserts[0].params).toEqual(['CONVERSATION_MENTIONED', 'author-1', 'patient-1', 'conv-1', 'msg-reply']);

    const notifInsert = calls.find((c) => c.sql.includes('INSERT INTO notifications'));
    expect(notifInsert?.params).toEqual(['evt-CONVERSATION_MENTIONED', 'root-author']);
  });

  it('mensagem de topo sem menção nenhuma: não insere NADA (nem evento, nem notificação)', async () => {
    const { client, calls } = clientWith([]);
    const useCase = new FanOutNotificationUseCase(new NotificationRepository(POOL), new ConversationRepository(POOL));

    await useCase.execute(client, baseMessage());

    expect(calls.filter((c) => c.sql.includes('INSERT'))).toHaveLength(0);
  });

  it('payload do evento é SEMPRE só-ids (nunca body/texto) — assinatura do INSERT não tem 6º param', async () => {
    const { client, calls } = clientWith([insertEventHandler({})]);
    const useCase = new FanOutNotificationUseCase(new NotificationRepository(POOL), new ConversationRepository(POOL));

    await useCase.execute(client, baseMessage({ mentionedUids: ['u2'] }));

    const eventInsert = calls.find((c) => c.sql.includes('INSERT INTO notification_events'));
    expect(eventInsert?.params).toHaveLength(5); // type_code, actor_uid, patient_id, conversation_id, message_id — sem payload de texto
  });
});
