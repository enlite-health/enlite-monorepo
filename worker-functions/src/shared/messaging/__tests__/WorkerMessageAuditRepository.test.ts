/**
 * WorkerMessageAuditRepository.test.ts
 *
 * Cenários:
 *  1. record() grava com UM único INSERT (ponto único de escrita, ver design.md Decisão 1)
 *  2. Campos opcionais ausentes viram NULL/[] (não `undefined`, que o driver `pg` rejeitaria)
 *  3. missingDocuments é passado como array (mapeado para TEXT[] pelo driver)
 *  4. Falha no INSERT (ex.: CHECK de missing_documents violado — code 23514) NÃO propaga para
 *     o caller — best-effort, mesmo padrão já usado nos 15 sites existentes
 *  5. Falha loga com logger.warn + reportError, sem lançar
 *  6. Aceita tanto Pool quanto PoolClient (StageMessageHandler passa o client da transação)
 *
 * A prova de que o CHECK de `missing_documents` REALMENTE rejeita slug fora do vocabulário
 * (Postgres real, não mock) está fora deste teste unitário — ver validação da migration
 * contra Postgres local, fora do jest (mock não simula constraint de banco).
 */

import { WorkerMessageAuditRepository } from '../WorkerMessageAuditRepository';

jest.mock('@shared/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
}));

import { logger, reportError } from '@shared/logging';

describe('WorkerMessageAuditRepository', () => {
  let mockQuery: jest.Mock;
  let mockClient: { query: jest.Mock };
  let repo: WorkerMessageAuditRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockClient = { query: mockQuery };
    repo = new WorkerMessageAuditRepository();
  });

  it('grava com exatamente UM INSERT INTO worker_message_audit', async () => {
    await repo.record(mockClient as never, {
      workerId: 'worker-1',
      templateSlug: 'ar_vacancy_match_incomplete',
      source: 'system',
      outcome: 'queued',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO worker_message_audit');
  });

  it('mapeia todos os campos opcionais informados para os placeholders posicionais corretos', async () => {
    await repo.record(mockClient as never, {
      workerId: 'worker-1',
      jobPostingId: 'job-1',
      templateSlug: 'ar_vacancy_match_incomplete',
      channel: 'twilio',
      source: 'system',
      actorUid: 'admin:uid-1',
      traceId: 'trace-abc',
      workerStatusAtDispatch: 'INCOMPLETE_REGISTER',
      documentsStatusAtDispatch: 'pending',
      missingDocuments: ['criminal_record', 'resume_cv'],
      outcome: 'queued',
      skipReason: null,
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([
      'worker-1',
      'job-1',
      'ar_vacancy_match_incomplete',
      'twilio',
      'system',
      'admin:uid-1',
      'trace-abc',
      'INCOMPLETE_REGISTER',
      'pending',
      ['criminal_record', 'resume_cv'],
      'queued',
      null,
    ]);
  });

  it('campos opcionais ausentes viram NULL/[] — nunca undefined', async () => {
    await repo.record(mockClient as never, {
      workerId: null,
      templateSlug: 'talentum_incomplete_reminder',
      source: 'bulk',
      outcome: 'sent',
    });

    const [, params] = mockQuery.mock.calls[0];
    // worker_id, job_posting_id, channel, actor_uid, trace_id, worker_status,
    // documents_status, skip_reason → NULL; missing_documents → []
    expect(params[0]).toBeNull(); // worker_id
    expect(params[1]).toBeNull(); // job_posting_id
    expect(params[3]).toBeNull(); // channel
    expect(params[5]).toBeNull(); // actor_uid
    expect(params[6]).toBeNull(); // trace_id
    expect(params[7]).toBeNull(); // worker_status_at_dispatch
    expect(params[8]).toBeNull(); // documents_status_at_dispatch
    expect(params[9]).toEqual([]); // missing_documents
    expect(params[11]).toBeNull(); // skip_reason
    params.forEach((p: unknown) => expect(p).not.toBeUndefined());
  });

  it('INSERT rejeitado por CHECK (ex.: slug fora do vocabulário, code 23514) não lança para o caller', async () => {
    const checkViolation = Object.assign(new Error('new row violates check constraint'), { code: '23514' });
    mockQuery.mockRejectedValueOnce(checkViolation);

    await expect(
      repo.record(mockClient as never, {
        workerId: 'worker-1',
        templateSlug: 'ar_vacancy_match_incomplete',
        source: 'system',
        outcome: 'queued',
        missingDocuments: ['not_a_real_slug'],
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      checkViolation,
      expect.objectContaining({ source: 'WorkerMessageAuditRepository.record' }),
    );
  });

  it('banco indisponível (rejeição genérica) também não lança — best-effort', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      repo.record(mockClient as never, {
        workerId: 'worker-2',
        templateSlug: 'complete_register_ofc',
        source: 'bulk',
        outcome: 'failed',
        skipReason: 'CONNECTION_ERROR',
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('aceita PoolClient (transação existente) e passa ele mesmo para .query — não abre conexão própria', async () => {
    const txClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await repo.record(txClient as never, {
      workerId: 'worker-3',
      jobPostingId: 'job-3',
      templateSlug: 'ar_vacancy_match_complete',
      source: 'kanban',
      outcome: 'queued',
    });
    expect(txClient.query).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // Achado do gate 25/09 (Achado 2): `client` sem `.release` (Pool bruto, ou o mock acima que
  // só tem `.query`) não é uma transação aberta por este caller — cada `.query()` já é sua
  // própria transação implícita no Postgres, então uma falha aqui não pode deixar nada
  // "aborted" por trás. Prova: nenhum SAVEPOINT é emitido nesse caso (mantém o comportamento
  // de sempre 1 único INSERT, testado acima).
  it('client sem .release (Pool bruto) — NÃO emite SAVEPOINT', async () => {
    await repo.record(mockClient as never, {
      workerId: 'worker-4',
      templateSlug: 'ar_vacancy_match_complete',
      source: 'bulk',
      outcome: 'sent',
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO worker_message_audit');
  });

  describe('SAVEPOINT — client com .release (PoolClient de transação aberta pelo caller)', () => {
    /**
     * Fake mínimo do comportamento REAL do Postgres dentro de um bloco BEGIN...COMMIT:
     *   - um erro em QUALQUER comando deixa a transação "aborted" até um ROLLBACK (ou um
     *     ROLLBACK TO SAVEPOINT, que recupera só até o ponto do savepoint);
     *   - COMMIT executado com a transação "aborted" NÃO LANÇA — o Postgres faz ROLLBACK
     *     silenciosamente (é exatamente o comportamento medido no achado: o caller não
     *     percebe e segue como se tivesse commitado).
     * Isto NÃO é um mock ingênuo que sempre resolve — ele reproduz a semântica que faz o bug
     * ser real, para que o teste morra se o SAVEPOINT for removido de `record()`.
     */
    function makeFakePgTransaction() {
      let aborted = false;
      let committed = false;
      const calls: string[] = [];
      const query = jest.fn(async (sql: string) => {
        calls.push(sql);
        if (sql === 'BEGIN') { aborted = false; return { rows: [] }; }
        if (sql.startsWith('SAVEPOINT ')) {
          if (aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
          return { rows: [] };
        }
        if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) { aborted = false; return { rows: [] }; }
        if (sql.startsWith('RELEASE SAVEPOINT ')) {
          if (aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO worker_message_audit')) {
          if (aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
          aborted = true; // simula a falha do INSERT de auditoria
          throw new Error('simulated worker_message_audit insert failure');
        }
        if (sql === 'COMMIT') {
          if (aborted) { committed = false; return { rows: [] }; } // ROLLBACK silencioso, sem lançar
          committed = true;
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') { aborted = false; committed = false; return { rows: [] }; }
        return { rows: [] };
      });
      return {
        client: { query, release: jest.fn() },
        calls,
        isCommitted: () => committed,
      };
    }

    it('INSERT de auditoria falha DENTRO da transação → SAVEPOINT protege: a transação principal ainda COMMITA', async () => {
      const { client, calls, isCommitted } = makeFakePgTransaction();

      await client.query('BEGIN');
      await repo.record(client as never, {
        workerId: 'worker-5',
        jobPostingId: 'job-5',
        templateSlug: 'qualified_reprogram_confirm',
        source: 'kanban',
        outcome: 'queued',
      });
      await client.query('COMMIT');

      expect(isCommitted()).toBe(true);
      expect(calls.some((c) => c.startsWith('SAVEPOINT '))).toBe(true);
      expect(calls.some((c) => c.startsWith('ROLLBACK TO SAVEPOINT '))).toBe(true);
      expect(calls.some((c) => c.startsWith('RELEASE SAVEPOINT '))).toBe(true);
      // best-effort continua: a falha do INSERT de auditoria em si ainda é logada
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('savepoint tem nome único por chamada (duas auditorias na mesma transação não colidem)', async () => {
      const { client } = makeFakePgTransaction();
      await client.query('BEGIN');
      await repo.record(client as never, {
        workerId: 'worker-6', templateSlug: 'a', source: 'kanban', outcome: 'queued',
      });
      const firstSavepoint = (client.query as jest.Mock).mock.calls.find((c) => (c[0] as string).startsWith('SAVEPOINT '))![0];
      await repo.record(client as never, {
        workerId: 'worker-7', templateSlug: 'b', source: 'kanban', outcome: 'queued',
      });
      const savepoints = (client.query as jest.Mock).mock.calls
        .map((c) => c[0] as string)
        .filter((sql) => sql.startsWith('SAVEPOINT '));
      expect(savepoints).toHaveLength(2);
      expect(savepoints[1]).not.toBe(firstSavepoint);
    });
  });
});
