/**
 * BajaVacanciesUseCase — tudo-ou-nada, motivo gravado, auditoria por baixa, NUNCA DELETE.
 * `withActorContext` imitado: roda a fn com o client dublê (a prova com SQL real é o e2e `084-vagas-antigas`).
 */
const mockClient = { query: jest.fn() };
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_pool: unknown, fn: (c: typeof mockClient) => Promise<unknown>) => fn(mockClient),
}));

import { BajaVacanciesUseCase } from '../BajaVacanciesUseCase';

const ACTOR = { actorUserId: 'uid-1', actorType: 'HUMAN' as const, actorLabel: 'admin_panel', traceId: null };
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function setup(rows: Array<{ id: string; status: string | null; contracted_service_id: string | null }>) {
  mockClient.query.mockReset();
  mockClient.query.mockImplementation(async (sql: string) => {
    if (/^\s*SELECT id, status, contracted_service_id/.test(sql)) return { rows };
    return { rows: [], rowCount: 1 };
  });
  const audit = { logEventSafe: jest.fn(async () => undefined) };
  return { uc: new BajaVacanciesUseCase({} as never, audit as never), audit };
}

describe('BajaVacanciesUseCase (spec 084 F1)', () => {
  it('baixa as vagas sem serviço: grava status_before_baja + motivo, 1 auditoria por vaga, nenhum DELETE', async () => {
    const { uc, audit } = setup([
      { id: A, status: 'SEARCHING', contracted_service_id: null },
      { id: B, status: 'CLOSED', contracted_service_id: null },
    ]);
    const out = await uc.execute([B, A, A], 'MANUAL', ACTOR);
    expect(out).toEqual({ ok: true, baixadas: [{ vacancyId: A, statusBefore: 'SEARCHING' }, { vacancyId: B, statusBefore: 'CLOSED' }] });
    const sqls = mockClient.query.mock.calls.map((c) => String(c[0]));
    const updates = sqls.filter((q) => /UPDATE job_postings/.test(q));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain("status_before_baja = status");
    expect(updates[0]).toContain("baja_reason = $2");
    expect(updates[0]).toContain('contracted_service_id IS NULL');
    expect(sqls.some((q) => /\bDELETE\s+FROM\b/i.test(q))).toBe(false); // R2: nunca apaga
    expect(mockClient.query.mock.calls.filter((c) => /UPDATE job_postings/.test(String(c[0]))).every((c) => (c[1] as unknown[])[1] === 'MANUAL')).toBe(true);
    expect(audit.logEventSafe).toHaveBeenCalledTimes(2);
    expect(audit.logEventSafe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobPostingId: A, eventType: 'STATUS_CHANGED', actorUserId: 'uid-1',
        changes: { before: { status: 'SEARCHING', baja_reason: null }, after: { status: 'DE_BAJA', baja_reason: 'MANUAL' } },
      }),
    );
  });

  it('R13 (teste-chave): a pausa do Talentum fica PENDING_PAUSE na MESMA transação/UPDATE da baixa — nunca NULL calado se o trabalho pós-resposta for descartado', async () => {
    const { uc } = setup([{ id: A, status: 'SEARCHING', contracted_service_id: null }]);
    await uc.execute([A], 'MANUAL', ACTOR);
    const update = mockClient.query.mock.calls.map((c) => String(c[0])).find((q) => /UPDATE job_postings/.test(q))!;
    expect(update).toMatch(/talentum_pause_state = CASE WHEN talentum_project_id IS NOT NULL THEN 'PENDING_PAUSE'/);
    // vaga SEM projeto no Talentum não ganha estado: nada a pausar
    expect(update).toMatch(/ELSE talentum_pause_state END/);
  });

  it('TUDO OU NADA: uma vaga com serviço no lote recusa o lote inteiro e NADA é gravado (P1)', async () => {
    const { uc, audit } = setup([
      { id: A, status: 'SEARCHING', contracted_service_id: null },
      { id: B, status: 'SEARCHING', contracted_service_id: 'svc-1' },
    ]);
    const out = await uc.execute([A, B], 'MANUAL', ACTOR);
    expect(out).toEqual({ ok: false, refused: [{ vacancyId: B, code: 'VACANCY_HAS_SERVICE' }] });
    expect(mockClient.query.mock.calls.some((c) => /UPDATE job_postings/.test(String(c[0])))).toBe(false);
    expect(audit.logEventSafe).not.toHaveBeenCalled();
  });

  it('vaga inexistente/apagada e vaga já baixada entram na lista de recusas', async () => {
    const { uc } = setup([{ id: A, status: 'DE_BAJA', contracted_service_id: null }]);
    const out = await uc.execute([A, B], 'CUTOFF', ACTOR);
    expect(out).toEqual({
      ok: false,
      refused: [{ vacancyId: A, code: 'VACANCY_ALREADY_DE_BAJA' }, { vacancyId: B, code: 'VACANCY_NOT_FOUND' }],
    });
  });

  it('o SELECT trava as linhas (FOR UPDATE) só de vagas vivas — nunca toca apagadas', async () => {
    const { uc } = setup([{ id: A, status: 'SEARCHING', contracted_service_id: null }]);
    await uc.execute([A], 'MANUAL', ACTOR);
    const select = String(mockClient.query.mock.calls[0][0]);
    expect(select).toContain('FOR UPDATE');
    expect(select).toContain('deleted_at IS NULL');
  });
});
