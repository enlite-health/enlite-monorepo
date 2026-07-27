import { assertAutoInviteTargetAllowed } from '../AutoInviteTargeting';

describe('assertAutoInviteTargetAllowed', () => {
  const makeDb = (row: { engaged: boolean; prior_invite: boolean }) =>
    ({ query: jest.fn().mockResolvedValue({ rows: [row] }) }) as never;

  it('engajou no funil (ativo) → allowed, mesmo já tendo convite anterior', async () => {
    const r = await assertAutoInviteTargetAllowed(makeDb({ engaged: true, prior_invite: true }), 'w1');
    expect(r.allowed).toBe(true);
  });

  it('não engajou mas é a primeira vaga (sem convite anterior) → allowed', async () => {
    const r = await assertAutoInviteTargetAllowed(makeDb({ engaged: false, prior_invite: false }), 'w1');
    expect(r.allowed).toBe(true);
  });

  it('não engajou E já recebeu vaga antes → blocked (o perfil de spam)', async () => {
    const r = await assertAutoInviteTargetAllowed(makeDb({ engaged: false, prior_invite: true }), 'w1');
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe('NOT_ACTIVE_AND_ALREADY_INVITED');
  });

  it('engajou E primeira vaga → allowed', async () => {
    const r = await assertAutoInviteTargetAllowed(makeDb({ engaged: true, prior_invite: false }), 'w1');
    expect(r.allowed).toBe(true);
  });

  it('passa o workerId como parâmetro da query', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ engaged: true, prior_invite: false }] }) };
    await assertAutoInviteTargetAllowed(db as never, 'worker-xyz');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('worker_job_applications'), ['worker-xyz']);
  });
});
