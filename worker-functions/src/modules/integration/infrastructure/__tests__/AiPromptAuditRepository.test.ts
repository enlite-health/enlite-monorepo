/**
 * AiPromptAuditRepository.test.ts
 *
 * Cenários:
 *  1. logEvent() grava com UM único INSERT INTO ai_prompt_audit_log
 *  2. Mapeia promptId → prompt_id (entityId), fieldName fixo 'body', e todos os campos
 *     opcionais ausentes viram NULL (não `undefined`, que o driver `pg` rejeitaria)
 *  3. Aceita o evento RESTORED (que o AuditEventType compartilhado não tem — prova que o cast
 *     em AiPromptAuditRepository.ts entrega o literal certo em runtime, não só compila)
 *  4. A casca NÃO expõe logEventSafe — só logEvent (prova em código, não só no comentário)
 *  5. logEvent() PROPAGA a falha do INSERT (não engole, ao contrário de logEventSafe)
 *  6. Aceite adicional da T008: força a falha do registro da trilha DENTRO de uma transação que
 *     também grava conteúdo em ai_prompts, e exige que o conteúdo não persista — com um caso de
 *     controle positivo (sem falha, o conteúdo persiste), para que a ausência de persistência no
 *     caso 6 prove alguma coisa em vez de ser só "o mock nunca comita".
 */

import { AiPromptAuditRepository } from '../AiPromptAuditRepository';

describe('AiPromptAuditRepository', () => {
  let mockQuery: jest.Mock;
  let mockClient: { query: jest.Mock };
  let repo: AiPromptAuditRepository;

  beforeEach(() => {
    mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockClient = { query: mockQuery };
    repo = new AiPromptAuditRepository();
  });

  it('grava com exatamente UM INSERT INTO ai_prompt_audit_log', async () => {
    await repo.logEvent(mockClient as never, {
      promptId: 'prompt-1',
      eventType: 'UPDATED',
      changes: { before: 'texto antigo', after: 'texto novo' },
      actorType: 'HUMAN',
      actorUserId: 'uid-1',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO ai_prompt_audit_log');
    expect(sql).toContain('prompt_id');
  });

  it('mapeia promptId → prompt_id, fixa field_name em "body" e monta changes como JSON', async () => {
    await repo.logEvent(mockClient as never, {
      promptId: 'prompt-2',
      eventType: 'CREATED',
      changes: { before: null, after: 'conteúdo inicial' },
      actorType: 'HUMAN',
      actorUserId: 'uid-2',
      actorLabel: 'admin_panel',
      traceId: 'trace-abc',
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([
      'prompt-2', // entityId (prompt_id)
      'CREATED', // event_type
      'body', // field_name — sempre 'body' nesta entrega (data-model.md)
      JSON.stringify({ before: null, after: 'conteúdo inicial' }),
      'uid-2', // actor_user_id
      'HUMAN', // actor_type
      'admin_panel', // actor_label
      'trace-abc', // trace_id
    ]);
  });

  it('campos opcionais ausentes viram NULL — nunca undefined', async () => {
    await repo.logEvent(mockClient as never, {
      promptId: 'prompt-3',
      eventType: 'UPDATED',
      changes: { before: 'a', after: 'b' },
      actorType: 'SYSTEM',
      actorLabel: 'migration-485-seed',
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[4]).toBeNull(); // actor_user_id (não informado)
    expect(params[7]).toBeNull(); // trace_id (não informado)
    params.forEach((p: unknown) => expect(p).not.toBeUndefined());
  });

  it('aceita o evento RESTORED — fora do AuditEventType compartilhado, mas dentro do CHECK da migration 485', async () => {
    await repo.logEvent(mockClient as never, {
      promptId: 'prompt-4',
      eventType: 'RESTORED',
      changes: { before: 'versão 3', after: 'versão 1' },
      actorType: 'HUMAN',
      actorUserId: 'uid-4',
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBe('RESTORED');
  });

  it('NÃO expõe logEventSafe — só logEvent (a trilha aqui não pode ser best-effort)', () => {
    expect((repo as unknown as { logEventSafe?: unknown }).logEventSafe).toBeUndefined();
    expect(typeof repo.logEvent).toBe('function');
  });

  it('logEvent PROPAGA a falha do INSERT — não engole (comportamento oposto de logEventSafe)', async () => {
    const insertError = Object.assign(new Error('new row violates check constraint'), { code: '23514' });
    mockQuery.mockRejectedValueOnce(insertError);

    await expect(
      repo.logEvent(mockClient as never, {
        promptId: 'prompt-5',
        eventType: 'UPDATED',
        changes: { before: 'a', after: 'b' },
        actorType: 'HUMAN',
        actorUserId: 'uid-5',
      }),
    ).rejects.toThrow('new row violates check constraint');

    // Nenhum SAVEPOINT é emitido — logEvent (ao contrário de logEventSafe) não tenta recuperar.
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).startsWith('SAVEPOINT'))).toBe(false);
  });

  describe('aceite adicional T008 — falha na trilha aborta a escrita do conteúdo (mesma transação)', () => {
    /**
     * Fake mínimo do comportamento REAL do Postgres dentro de BEGIN...COMMIT: um erro em
     * qualquer comando deixa a transação "aborted" até um ROLLBACK; COMMIT com a transação
     * aborted NÃO lança — o Postgres desfaz silenciosamente (mesmo padrão documentado em
     * src/shared/messaging/__tests__/WorkerMessageAuditRepository.test.ts). `committedRows` só
     * recebe o conteúdo staged quando o COMMIT realmente efetiva — é ele, não `stagedRows', que
     * mede "o que persistiu".
     */
    function makeFakePgTransaction(opts: { auditShouldFail: boolean }) {
      let aborted = false;
      let committed = false;
      let stagedRows: string[] = [];
      let committedRows: string[] = [];
      const calls: string[] = [];

      const query = jest.fn(async (sql: string) => {
        calls.push(sql);
        if (sql === 'BEGIN') {
          aborted = false;
          return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO ai_prompts')) {
          if (aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
          stagedRows.push('conteudo-novo');
          return { rows: [{ id: 'prompt-9' }] };
        }
        // BaseAuditLogRepository.insertSql é um template literal indentado (começa com '\n
        // '), não com 'INSERT' — .includes(), não .startsWith(), para casar com o SQL real.
        if (sql.includes('INSERT INTO ai_prompt_audit_log')) {
          if (aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
          if (opts.auditShouldFail) {
            aborted = true;
            throw new Error('simulated ai_prompt_audit_log insert failure');
          }
          return { rows: [] };
        }
        if (sql === 'COMMIT') {
          if (aborted) {
            committed = false;
            return { rows: [] }; // ROLLBACK silencioso — Postgres real não lança aqui
          }
          committed = true;
          committedRows = [...stagedRows];
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          aborted = false;
          committed = false;
          stagedRows = [];
          return { rows: [] };
        }
        return { rows: [] };
      });

      return {
        client: { query, release: jest.fn() },
        calls,
        isCommitted: () => committed,
        persistedContent: () => committedRows,
      };
    }

    it('CONTROLE POSITIVO: sem falha na trilha, BEGIN → INSERT conteúdo → logEvent → COMMIT persiste o conteúdo', async () => {
      const { client, isCommitted, persistedContent } = makeFakePgTransaction({ auditShouldFail: false });

      await client.query('BEGIN');
      await client.query('INSERT INTO ai_prompts (body, version) VALUES ($1, $2)');
      await repo.logEvent(client as never, {
        promptId: 'prompt-9',
        eventType: 'UPDATED',
        changes: { before: 'antigo', after: 'novo' },
        actorType: 'HUMAN',
        actorUserId: 'uid-9',
      });
      await client.query('COMMIT');

      expect(isCommitted()).toBe(true);
      expect(persistedContent()).toEqual(['conteudo-novo']);
    });

    it('falha no INSERT da trilha → conteúdo gravado na MESMA transação NÃO persiste (rollback, explícito ou silencioso)', async () => {
      const { client, isCommitted, persistedContent } = makeFakePgTransaction({ auditShouldFail: true });

      await client.query('BEGIN');
      await client.query('INSERT INTO ai_prompts (body, version) VALUES ($1, $2)');

      await expect(
        repo.logEvent(client as never, {
          promptId: 'prompt-9',
          eventType: 'UPDATED',
          changes: { before: 'antigo', after: 'novo' },
          actorType: 'HUMAN',
          actorUserId: 'uid-9',
        }),
      ).rejects.toThrow('simulated ai_prompt_audit_log insert failure');

      // Nem o caller mais desatento escapa: mesmo que ele NÃO capture a rejeição acima e só
      // tente o COMMIT de sempre (sem ROLLBACK explícito), uma transação abortada não persiste
      // nada — o Postgres real desfaz silenciosamente (mesmo comportamento documentado em
      // src/shared/messaging/__tests__/WorkerMessageAuditRepository.test.ts). O caller correto
      // (UpdateAiPromptUseCase/RestoreAiPromptUseCase, T010/T038) ainda deve fazer ROLLBACK
      // explícito para liberar a conexão — mas o dado já não sobrevive de qualquer forma.
      await client.query('COMMIT').catch(() => {});

      expect(isCommitted()).toBe(false);
      expect(persistedContent()).toEqual([]); // o conteúdo novo NÃO sobrevive
    });
  });
});
