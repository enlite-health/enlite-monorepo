/**
 * Relógio civil — InterviewSchedulingService.
 *  - `createSlotsForJob`: "hoje" é o dia de Buenos Aires, não o dia UTC. Às 23:30Z de 29/10 (20:30 em BA) o dia UTC
 *    ainda é 29, mas às 02:30Z de 30/10 (23:30 em BA) o dia UTC já é 30 e o slot de HOJE em BA seria rejeitado.
 *  - `enqueueInvitation`: a data do slot (dia civil) sai com `timeZone: 'UTC'` — igual em qualquer fuso do processo.
 * Só mocks: nenhuma mensagem é enviada.
 */
jest.mock('../TokenService', () => ({
  TokenService: jest.fn().mockImplementation(() => ({ generate: jest.fn().mockResolvedValue('tok') })),
}));

import { InterviewSchedulingService } from '../InterviewSchedulingService';

type FakeCfg = NonNullable<Parameters<typeof jest.useFakeTimers>[0]>;
const FAKE_ONLY_DATE = {
  doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
} as FakeCfg;

function build() {
  const repo = { createSlots: jest.fn().mockResolvedValue([]), getSlotById: jest.fn(), bookSlot: jest.fn() };
  const db = { query: jest.fn() };
  const svc = new InterviewSchedulingService(repo as never, db as never);
  return { svc, repo, db };
}

describe('InterviewSchedulingService — relógio civil', () => {
  afterEach(() => jest.useRealTimers());

  it('23:30 BA (02:30Z do dia seguinte): slot de HOJE em BA (29/10) é aceito', async () => {
    jest.useFakeTimers({ ...FAKE_ONLY_DATE, now: new Date('2026-10-30T02:30:00Z') });
    const { svc, repo } = build();
    const dto = { slots: [{ date: '2026-10-29' }] } as never;
    await expect(svc.createSlotsForJob(dto)).resolves.toEqual([]);
    expect(repo.createSlots).toHaveBeenCalled();
  });

  it('20:30 BA (23:30Z): hoje é 29/10, ontem (28/10) é rejeitado', async () => {
    jest.useFakeTimers({ ...FAKE_ONLY_DATE, now: new Date('2026-10-29T23:30:00Z') });
    const { svc } = build();
    await expect(svc.createSlotsForJob({ slots: [{ date: '2026-10-29' }] } as never)).resolves.toEqual([]);
    await expect(svc.createSlotsForJob({ slots: [{ date: '2026-10-28' }] } as never)).rejects.toThrow(/in the past/);
  });

  it('convite: dia civil do slot formatado em UTC (29/10/2026), sem deslizar um dia', async () => {
    const { svc, repo, db } = build();
    repo.getSlotById.mockResolvedValue({ id: 's1', meetLink: null });
    repo.bookSlot.mockResolvedValue({
      success: true,
      slot: { id: 's1', slotDate: '2026-10-29', slotTime: '10:00', meetLink: null },
    });
    db.query
      .mockResolvedValueOnce({ rows: [{ worker_id: 'w1', location: null }] })
      .mockResolvedValue({ rows: [] });

    const r = await svc.bookSlot({ slotId: 's1', encuadreId: 'e1' } as never, db as never);

    expect(r.isSuccess).toBe(true);
    const insert = db.query.mock.calls.find((c) => String(c[0]).includes('messaging_outbox'))!;
    expect(JSON.parse(insert[1][2]).date).toBe('29/10/2026');
  });
});
