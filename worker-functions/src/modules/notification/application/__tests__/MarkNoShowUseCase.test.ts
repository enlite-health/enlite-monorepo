/**
 * MarkNoShowUseCase.test.ts
 *
 * Testa a transição de no-show em entrevistas via WJA.
 *
 * Cenários:
 * 1. WJA com interview_response='pending' + vencida → no_response + CONFIRMED→IN_DOUBT
 * 2. WJA com stage diferente de CONFIRMED → no_response sem mover stage
 * 3. Idempotência: WJA já no_response não aparece na query (WHERE pending)
 * 4. Retorna { marked: 0 } quando não há no-shows
 * 5. Processa múltiplos no-shows em batch
 */

import { MarkNoShowUseCase } from '../MarkNoShowUseCase';

describe('MarkNoShowUseCase', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let useCase: MarkNoShowUseCase;

  beforeEach(() => {
    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    useCase = new MarkNoShowUseCase(mockDb as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('retorna { marked: 0, stageMovedToInDoubt: 0 } quando não há no-shows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute();

    expect(result).toEqual({ marked: 0, stageMovedToInDoubt: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Verifica que o SELECT busca 'pending' com +30min de atraso
    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall[0]).toContain("interview_response = 'pending'");
    expect(selectCall[0]).toContain('INTERVAL \'30 minutes\'');
  });

  it('marca no_response + move CONFIRMED→IN_DOUBT', async () => {
    const noShowRow = {
      worker_id: 'w-1',
      job_posting_id: 'jp-1',
      application_funnel_stage: 'CONFIRMED',
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [noShowRow] }) // SELECT
      .mockResolvedValueOnce({ rows: [] });          // UPDATE

    const result = await useCase.execute();

    expect(result).toEqual({ marked: 1, stageMovedToInDoubt: 1 });

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain("interview_response = 'no_response'");
    expect(updateCall[0]).toContain("application_funnel_stage = 'IN_DOUBT'");
    expect(updateCall[1]).toEqual(['w-1', 'jp-1']);
  });

  it('marca no_response sem mover stage quando funnel_stage != CONFIRMED', async () => {
    const noShowRow = {
      worker_id: 'w-2',
      job_posting_id: 'jp-2',
      application_funnel_stage: 'QUALIFIED',
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [noShowRow] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute();

    expect(result).toEqual({ marked: 1, stageMovedToInDoubt: 0 });

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain("interview_response = 'no_response'");
    expect(updateCall[0]).not.toContain("application_funnel_stage = 'IN_DOUBT'");
  });

  it('idempotência: já-no_response não aparecem (WHERE pending filtra na query)', async () => {
    // Simula que a query retorna vazio (no_response já foi setado antes)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute();

    // Nenhum UPDATE é chamado
    expect(result).toEqual({ marked: 0, stageMovedToInDoubt: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('UPDATE usa WHERE interview_response = pending (double-check idempotência por linha)', async () => {
    // Garante que mesmo se o SELECT retornar uma linha, o UPDATE só atualiza se ainda pending
    const noShowRow = {
      worker_id: 'w-3',
      job_posting_id: 'jp-3',
      application_funnel_stage: 'CONFIRMED',
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [noShowRow] })
      .mockResolvedValueOnce({ rows: [] });

    await useCase.execute();

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain("interview_response = 'pending'");
  });

  it('processa múltiplos no-shows em batch', async () => {
    const rows = [
      { worker_id: 'w-a', job_posting_id: 'jp-a', application_funnel_stage: 'CONFIRMED' },
      { worker_id: 'w-b', job_posting_id: 'jp-b', application_funnel_stage: 'QUALIFIED' },
      { worker_id: 'w-c', job_posting_id: 'jp-c', application_funnel_stage: 'CONFIRMED' },
    ];

    mockQuery
      .mockResolvedValueOnce({ rows })   // SELECT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE w-a
      .mockResolvedValueOnce({ rows: [] }) // UPDATE w-b
      .mockResolvedValueOnce({ rows: [] }); // UPDATE w-c

    const result = await useCase.execute();

    expect(result).toEqual({ marked: 3, stageMovedToInDoubt: 2 });
    expect(mockQuery).toHaveBeenCalledTimes(4); // 1 SELECT + 3 UPDATEs
  });
});
