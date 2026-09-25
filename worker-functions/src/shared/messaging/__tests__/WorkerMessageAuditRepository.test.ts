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
});
