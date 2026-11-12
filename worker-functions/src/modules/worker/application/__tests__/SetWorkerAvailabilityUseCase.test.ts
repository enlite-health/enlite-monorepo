import { loggingAls } from '@shared/logging';
import { SetWorkerAvailabilityUseCase } from '../SetWorkerAvailabilityUseCase';

const WID = 'df7a15ca-693f-415c-8f25-6946a7cd8e7f';

function makeDeps(workerExists = true) {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
  const db = {
    query: jest.fn().mockResolvedValue({ rows: workerExists ? [{ '?column?': 1 }] : [] }),
    connect: jest.fn().mockResolvedValue(client),
  };
  return { uc: new SetWorkerAvailabilityUseCase(db as never), db, client };
}

describe('SetWorkerAvailabilityUseCase', () => {
  it('rejeita lista vazia (não abre transação)', async () => {
    const { uc, db } = makeDeps();
    const res = await uc.execute({ workerId: WID, slots: [] });
    expect(res).toEqual({ ok: false, slots: 0, reason: 'empty_slots' });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('rejeita slot inválido (dia fora de 0-6 ou horário mal-formado)', async () => {
    const { uc, db } = makeDeps();
    const res = await uc.execute({
      workerId: WID,
      slots: [{ dayOfWeek: 9, startTime: '10:30', endTime: '16:30' }],
    });
    expect(res.reason).toBe('invalid_slot');
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('worker inexistente → worker_not_found, sem transação', async () => {
    const { uc, db } = makeDeps(false);
    const res = await uc.execute({
      workerId: WID,
      slots: [{ dayOfWeek: 6, startTime: '10:30', endTime: '16:30' }],
    });
    expect(res.reason).toBe('worker_not_found');
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('substitui atômico + auditado: BEGIN, app.current_uid, DELETE, INSERT, COMMIT', async () => {
    const { uc, client } = makeDeps();
    const res = await uc.execute({
      workerId: WID,
      slots: [{ dayOfWeek: 6, startTime: '10:30', endTime: '16:30' }],
    });
    expect(res).toEqual({ ok: true, slots: 1 });
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('BEGIN'))).toBe(true);
    expect(sqls.some((s) => s.includes('app.current_uid'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM worker_availability'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO worker_availability'))).toBe(true);
    expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
    // default timezone aplicado
    const insert = client.query.mock.calls.find((c) => String(c[0]).includes('INSERT'));
    expect(insert[1][4]).toBe('America/Argentina/Buenos_Aires');
  });

  const uidGravado = (client: { query: jest.Mock }): unknown =>
    client.query.mock.calls.find((c) => String(c[0]).includes('app.current_uid'))?.[1]?.[0];
  const slots = [{ dayOfWeek: 6, startTime: '10:30', endTime: '16:30' }];

  it('SEM ator na request (caminho legado): carimba luz:set-availability, como sempre', async () => {
    const { uc, client } = makeDeps();
    await uc.execute({ workerId: WID, slots });
    expect(uidGravado(client)).toBe('luz:set-availability');
  });

  it('COM ator na request (porta do agente): carimba o ATOR (agent:luz), não o uid fixo', async () => {
    const { uc, client } = makeDeps();
    await loggingAls.run({ traceId: 't', actor: { source: 'luz_conversation', id: 'agent:luz' } }, () => uc.execute({ workerId: WID, slots }));
    expect(uidGravado(client)).toBe('agent:luz');
  });

  it('erro no INSERT: ROLLBACK, sem COMMIT, e o erro sobe', async () => {
    const { uc, client } = makeDeps();
    client.query.mockImplementation(async (sql: string) => { if (String(sql).includes('INSERT INTO worker_availability')) throw new Error('x'); return { rows: [] }; });
    await expect(uc.execute({ workerId: WID, slots })).rejects.toThrow('x');
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});
