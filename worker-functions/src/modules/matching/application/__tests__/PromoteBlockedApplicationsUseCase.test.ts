/**
 * PromoteBlockedApplicationsUseCase.test.ts
 *
 * Cobre:
 *  - promove uma linha elegível (vaga válida + sem WJA + worker REGISTERED)
 *  - skip por WJA já existente (inclusive REJECTED — nunca ressuscita)
 *  - skip por vaga fechada / draft / deletada (não encontrada)
 *  - skip por worker não-REGISTERED / merged (revalidação tardia)
 *  - conflito de UNIQUE (23505) vira skip, nunca propaga erro
 *  - erro genérico em uma linha não impede o processamento das demais
 *  - idempotência: segunda chamada não reprocessa linhas já promovidas
 *  - falha ao listar linhas é não-fatal (retorna zerado)
 */

import { PromoteBlockedApplicationsUseCase } from '../PromoteBlockedApplicationsUseCase';
import type { CreateManualWjaWithEncuadreUseCase } from '../CreateManualWjaWithEncuadreUseCase';

type QueryFn = jest.Mock;

function makePool(query: QueryFn) {
  return { query } as unknown as { query: QueryFn };
}

function makeCreateWjaUseCase(execute: jest.Mock) {
  return { execute } as unknown as CreateManualWjaWithEncuadreUseCase;
}

describe('PromoteBlockedApplicationsUseCase', () => {
  const WORKER_ID = 'worker-1';

  it('promove uma linha elegível: vaga válida + sem WJA + worker REGISTERED', async () => {
    const query = jest.fn();
    // 1. lista blocked applications
    query.mockResolvedValueOnce({
      rows: [{ id: 'ba-1', job_posting_id: 'jp-1', acquisition_channel: 'facebook' }],
    });
    // 2. assertWorkerCanApply
    query.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    // 3. SELECT job_postings
    query.mockResolvedValueOnce({ rows: [{ is_draft: false, status: 'SEARCHING' }] });
    // 4. NOT EXISTS wja
    query.mockResolvedValueOnce({ rows: [] });
    // 6. UPDATE worker_blocked_applications
    query.mockResolvedValueOnce({ rows: [] });

    const execute = jest.fn().mockResolvedValue({ wjaId: 'wja-created-1' });
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    const result = await useCase.execute(WORKER_ID);

    expect(result).toEqual({ promoted: 1, skipped: 0, reasons: {} });
    expect(execute).toHaveBeenCalledWith(expect.anything(), {
      workerId: WORKER_ID,
      jobPostingId: 'jp-1',
      acquisitionChannel: 'facebook',
    });

    const updateCall = query.mock.calls[4];
    expect(updateCall[0]).toMatch(/UPDATE worker_blocked_applications/);
    expect(updateCall[1]).toEqual(['ba-1', 'wja-created-1']);
  });

  it('usa canal neutro quando acquisition_channel é null', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({
      rows: [{ id: 'ba-null', job_posting_id: 'jp-1', acquisition_channel: null }],
    });
    query.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    query.mockResolvedValueOnce({ rows: [{ is_draft: false, status: 'ACTIVE' }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });

    const execute = jest.fn().mockResolvedValue({ wjaId: 'wja-x' });
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    await useCase.execute(WORKER_ID);

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ acquisitionChannel: 'blocked_promotion' }),
    );
  });

  it('skip: WJA já existe para o par (inclusive REJECTED — nunca ressuscita)', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({
      rows: [{ id: 'ba-1', job_posting_id: 'jp-1', acquisition_channel: 'site' }],
    });
    query.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    query.mockResolvedValueOnce({ rows: [{ is_draft: false, status: 'SEARCHING' }] });
    // NOT EXISTS wja → já existe (qualquer stage, ex: REJECTED)
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const execute = jest.fn();
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    const result = await useCase.execute(WORKER_ID);

    expect(result).toEqual({ promoted: 0, skipped: 1, reasons: { wja_already_exists: 1 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['vaga não encontrada (deletada)', []],
    ['vaga is_draft=true', [{ is_draft: true, status: 'SEARCHING' }]],
    ['vaga status=CLOSED', [{ is_draft: false, status: 'CLOSED' }]],
  ])('skip: %s', async (_label, jobPostingRows) => {
    const query = jest.fn();
    query.mockResolvedValueOnce({
      rows: [{ id: 'ba-1', job_posting_id: 'jp-1', acquisition_channel: 'site' }],
    });
    query.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    query.mockResolvedValueOnce({ rows: jobPostingRows });

    const execute = jest.fn();
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    const result = await useCase.execute(WORKER_ID);

    expect(result).toEqual({ promoted: 0, skipped: 1, reasons: { vacancy_invalid: 1 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('skip: worker não-REGISTERED (revalidação tardia) — todas as linhas puladas', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({
      rows: [
        { id: 'ba-1', job_posting_id: 'jp-1', acquisition_channel: 'site' },
        { id: 'ba-2', job_posting_id: 'jp-2', acquisition_channel: 'facebook' },
      ],
    });
    // assertWorkerCanApply → status incompleto
    query.mockResolvedValueOnce({ rows: [{ status: 'INCOMPLETE_REGISTER' }] });

    const execute = jest.fn();
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    const result = await useCase.execute(WORKER_ID);

    expect(result).toEqual({ promoted: 0, skipped: 2, reasons: { worker_not_eligible: 2 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('skip: worker merged (não encontrado por merged_into_id IS NULL)', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({
      rows: [{ id: 'ba-1', job_posting_id: 'jp-1', acquisition_channel: 'site' }],
    });
    // assertWorkerCanApply → 0 rows (merged ou inexistente)
    query.mockResolvedValueOnce({ rows: [] });

    const execute = jest.fn();
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    const result = await useCase.execute(WORKER_ID);

    expect(result).toEqual({ promoted: 0, skipped: 1, reasons: { worker_not_eligible: 1 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('conflito de UNIQUE (23505) vira skip, nunca propaga erro', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({
      rows: [{ id: 'ba-1', job_posting_id: 'jp-1', acquisition_channel: 'site' }],
    });
    query.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    query.mockResolvedValueOnce({ rows: [{ is_draft: false, status: 'SEARCHING' }] });
    query.mockResolvedValueOnce({ rows: [] });

    const execute = jest.fn().mockRejectedValue(
      Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    );
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    const result = await useCase.execute(WORKER_ID);

    expect(result).toEqual({ promoted: 0, skipped: 1, reasons: { unique_conflict: 1 } });
  });

  it('erro genérico em uma linha não impede o processamento das demais', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({
      rows: [
        { id: 'ba-fail', job_posting_id: 'jp-1', acquisition_channel: 'site' },
        { id: 'ba-ok', job_posting_id: 'jp-2', acquisition_channel: 'facebook' },
      ],
    });
    query.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }); // assertWorkerCanApply

    // Linha 1 (ba-fail): SELECT job_postings lança erro genérico
    query.mockRejectedValueOnce(new Error('DB timeout'));

    // Linha 2 (ba-ok): fluxo normal de sucesso
    query.mockResolvedValueOnce({ rows: [{ is_draft: false, status: 'SEARCHING' }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] }); // UPDATE

    const execute = jest.fn().mockResolvedValue({ wjaId: 'wja-ok' });
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    const result = await useCase.execute(WORKER_ID);

    expect(result.promoted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.reasons.error).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobPostingId: 'jp-2' }),
    );
  });

  it('idempotência: segunda chamada não reprocessa (filtro promoted_at IS NULL já exclui a linha)', async () => {
    const query = jest.fn();
    // Segunda chamada: a listagem (SQL real filtra promoted_at IS NULL) já não
    // retorna a linha promovida anteriormente.
    query.mockResolvedValueOnce({ rows: [] });

    const execute = jest.fn();
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    const result = await useCase.execute(WORKER_ID);

    expect(result).toEqual({ promoted: 0, skipped: 0, reasons: {} });
    expect(execute).not.toHaveBeenCalled();
    // Nem sequer chega a verificar elegibilidade do worker — retorno antecipado
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('falha ao listar linhas é não-fatal — retorna zerado sem lançar', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('DB down'));

    const execute = jest.fn();
    const useCase = new PromoteBlockedApplicationsUseCase(
      makePool(query) as never,
      makeCreateWjaUseCase(execute),
    );

    await expect(useCase.execute(WORKER_ID)).resolves.toEqual({
      promoted: 0,
      skipped: 0,
      reasons: {},
    });
  });
});
