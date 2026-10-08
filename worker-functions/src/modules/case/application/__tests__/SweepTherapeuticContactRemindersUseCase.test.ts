jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({}) }) },
}));
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ reportError: (...a: unknown[]) => mockReportError(...a) }));
// A transação é do banco real (e2e); aqui `withActorContext` só entrega um client fantasma e repropaga erro, como o real.
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn(async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ __client: true })),
}));

import { SweepTherapeuticContactRemindersUseCase } from '../SweepTherapeuticContactRemindersUseCase';

const vig = { id: 'v-1', createdAt: '2026-10-01T10:00:00.000Z', annulledAt: null, country: 'AR' };

function montar(over: {
  ciclos?: Array<{ id: string; patientId: string } | null>;
  due?: Array<{ id: string; dayOffset: number }>;
  versions?: unknown[];
  status?: unknown[];
  recipients?: unknown[];
  eventIds?: string[];
  falhaNoCiclo?: string;
}) {
  const fila = [...(over.ciclos ?? [])];
  const reminders = {
    claimNextDueCycle: jest.fn(async (_c?: unknown, _excluded?: string[]) => (fila.length ? fila.shift() ?? null : null)),
    lockPatient: jest.fn(async () => undefined),
    dueReminders: jest.fn(async () => over.due ?? []),
    cancelReminders: jest.fn(async (_c: unknown, ids: string[]) => ids.length),
    cancelOpenRemindersOfCycle: jest.fn(async () => 2),
    markSent: jest.fn(async () => undefined),
    closeCycle: jest.fn(async () => undefined),
    countDueCycles: jest.fn(async () => 0),
  };
  const projects = {
    listForPatient: jest.fn(async (patientId: string) => {
      if (over.falhaNoCiclo === patientId) throw new Error('boom');
      return over.versions ?? [vig];
    }),
  };
  const statuses = { listByVersions: jest.fn(async () => new Map([['v-1', over.status ?? []]])) };
  const recipients = { resolve: jest.fn(async () => over.recipients ?? [{ uid: 'op1', fields: ['RESPONSIBLE'] }]) };
  const publisher = { publishPtContactsPending: jest.fn(async () => over.eventIds ?? ['ev-1']) };
  const uc = new SweepTherapeuticContactRemindersUseCase(reminders as never, projects as never, statuses as never, recipients as never, publisher as never);
  return { uc, reminders, projects, statuses, recipients, publisher };
}
const PEND = [{ kind: 'RESPONSIBLE', status: 'PENDING', pendingSince: new Date(), markedByUid: 'op1' }];

describe('SweepTherapeuticContactRemindersUseCase (spec 048)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sem ciclo vencido: não faz nada', async () => {
    const { uc, publisher } = montar({ ciclos: [] });
    expect(await uc.execute({ limit: 10 })).toEqual({ cycles: 0, sent: 0, cancelled: 0, superseded: 0, skippedNoRecipient: 0, failed: 0, remainingDue: 0 });
    expect(publisher.publishPtContactsPending).not.toHaveBeenCalled();
  });

  it('há pendente: UMA publicação pela vigente, carimba sent_at com o id do evento, ciclo continua aberto antes do dia 12', async () => {
    const { uc, publisher, reminders, recipients } = montar({ ciclos: [{ id: 'c1', patientId: 'p1' }], due: [{ id: 'r2', dayOffset: 2 }], status: PEND });
    const r = await uc.execute({ limit: 10 });
    expect(r).toMatchObject({ cycles: 1, sent: 1, superseded: 0, failed: 0 });
    expect(recipients.resolve).toHaveBeenCalledWith(expect.anything(), PEND, false);
    expect(publisher.publishPtContactsPending).toHaveBeenCalledWith(expect.anything(), { patientId: 'p1', cycleId: 'c1', versionId: 'v-1', dayOffset: 2, recipients: expect.any(Array) });
    expect(reminders.markSent).toHaveBeenCalledWith(expect.anything(), 'r2', 'ev-1');
    expect(reminders.closeCycle).not.toHaveBeenCalled();
  });

  it('2 lembretes vencidos juntos (job parado): sai UMA notificação pelo maior dia e o menor vira SUPERSEDED', async () => {
    const { uc, publisher, reminders } = montar({ ciclos: [{ id: 'c1', patientId: 'p1' }], due: [{ id: 'r2', dayOffset: 2 }, { id: 'r5', dayOffset: 5 }], status: PEND });
    const r = await uc.execute({ limit: 10 });
    expect(publisher.publishPtContactsPending).toHaveBeenCalledTimes(1);
    expect(reminders.cancelReminders).toHaveBeenCalledWith(expect.anything(), ['r2'], 'SUPERSEDED');
    expect(reminders.markSent).toHaveBeenCalledWith(expect.anything(), 'r5', 'ev-1');
    expect(r.superseded).toBe(1);
  });

  it('dia 12: inclui o aviso por célula e FECHA o ciclo (COMPLETED)', async () => {
    const { uc, recipients, reminders } = montar({ ciclos: [{ id: 'c1', patientId: 'p1' }], due: [{ id: 'r12', dayOffset: 12 }], status: PEND });
    await uc.execute({ limit: 10 });
    expect(recipients.resolve).toHaveBeenCalledWith(expect.anything(), PEND, true);
    expect(reminders.closeCycle).toHaveBeenCalledWith(expect.anything(), 'c1', 'COMPLETED');
  });

  it('nada pendente na vigente: cancela o resto, fecha RESOLVED e NINGUÉM é avisado', async () => {
    const { uc, publisher, reminders } = montar({ ciclos: [{ id: 'c1', patientId: 'p1' }], due: [{ id: 'r5', dayOffset: 5 }], status: [] });
    const r = await uc.execute({ limit: 10 });
    expect(publisher.publishPtContactsPending).not.toHaveBeenCalled();
    expect(reminders.cancelOpenRemindersOfCycle).toHaveBeenCalledWith(expect.anything(), 'c1', 'RESOLVED');
    expect(reminders.closeCycle).toHaveBeenCalledWith(expect.anything(), 'c1', 'RESOLVED');
    expect(r).toMatchObject({ cancelled: 2, sent: 0 });
  });

  it('só NOT_NEEDED na vigente conta como resolvido (P5)', async () => {
    const { uc, publisher } = montar({ ciclos: [{ id: 'c1', patientId: 'p1' }], due: [{ id: 'r5', dayOffset: 5 }], status: [{ kind: 'EXTERNAL', status: 'NOT_NEEDED', pendingSince: null, markedByUid: 'm' }] });
    await uc.execute({ limit: 10 });
    expect(publisher.publishPtContactsPending).not.toHaveBeenCalled();
  });

  it('todas as versões anuladas: NO_CURRENT_VERSION, sem aviso', async () => {
    const { uc, publisher, reminders } = montar({ ciclos: [{ id: 'c1', patientId: 'p1' }], due: [{ id: 'r5', dayOffset: 5 }], versions: [{ ...vig, annulledAt: '2026-10-02T00:00:00.000Z' }] });
    await uc.execute({ limit: 10 });
    expect(publisher.publishPtContactsPending).not.toHaveBeenCalled();
    expect(reminders.closeCycle).toHaveBeenCalledWith(expect.anything(), 'c1', 'NO_CURRENT_VERSION');
  });

  it('ninguém vivo para avisar: carimba com evento null (NO_ACTIVE_RECIPIENT) e conta; nunca evento vazio', async () => {
    const { uc, reminders } = montar({ ciclos: [{ id: 'c1', patientId: 'p1' }], due: [{ id: 'r2', dayOffset: 2 }], status: PEND, eventIds: [] });
    const r = await uc.execute({ limit: 10 });
    expect(reminders.markSent).toHaveBeenCalledWith(expect.anything(), 'r2', null);
    expect(r).toMatchObject({ sent: 0, skippedNoRecipient: 1 });
  });

  it('erro no ciclo 1 NÃO impede o ciclo 2 (isolamento por ciclo) e é contado + reportado sem corpo', async () => {
    const { uc, publisher } = montar({
      ciclos: [{ id: 'c1', patientId: 'p-ruim' }, { id: 'c2', patientId: 'p-bom' }],
      due: [{ id: 'r2', dayOffset: 2 }], status: PEND, falhaNoCiclo: 'p-ruim',
    });
    const r = await uc.execute({ limit: 10 });
    expect(r).toMatchObject({ cycles: 1, failed: 1, sent: 1 });
    expect(publisher.publishPtContactsPending).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), { source: 'SweepTherapeuticContactRemindersUseCase', cycleId: 'c1' });
  });

  it('o ciclo que falhou é excluído da próxima busca (sem laço infinito) e o limite corta a corrida', async () => {
    const { uc, reminders } = montar({ ciclos: [{ id: 'c1', patientId: 'p-ruim' }], falhaNoCiclo: 'p-ruim', due: [{ id: 'r2', dayOffset: 2 }] });
    await uc.execute({ limit: 10 });
    expect(reminders.claimNextDueCycle.mock.calls[1][1]).toEqual(['c1']);

    const lim = montar({ ciclos: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, patientId: 'p' })), due: [{ id: 'r2', dayOffset: 2 }], status: PEND });
    const r = await lim.uc.execute({ limit: 2 });
    expect(r.cycles).toBe(2);
  });
});
