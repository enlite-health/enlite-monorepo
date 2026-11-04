/**
 * WorkerApplicationRegisterCapability — spec 067 FR-16: o link do pré-screening da Talentum sai à Luz SÓ no `ok:true`.
 * O `ok:false` (prestador inelegível) nunca o carrega. Sem banco, sem rede: o caso de uso é dublê.
 */
import { WorkerApplicationRegisterCapability } from '../WorkerApplicationRegisterCapability';

const WORKER = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const LINK = 'http://talentum.invalid/public/pre-screening/00000000-0000-4000-8000-000000000067/chat';

function build(result: unknown) {
  const apply = { execute: jest.fn().mockResolvedValue(result) };
  const getWorker = { execute: jest.fn().mockResolvedValue({ worker: { firstName: 'Ficticia', lastName: 'Teste', phone: '+5491100000000' } }) };
  const cap = new WorkerApplicationRegisterCapability(apply as never, {} as never, getWorker as never);
  return { cap, apply };
}

describe('WorkerApplicationRegisterCapability (spec 067 FR-16)', () => {
  it('ok:true devolve wjaId E o prescreeningUrl da postulação aprovada', async () => {
    const { cap } = build({ ok: true, wjaId: 'wja-1', prescreeningUrl: LINK });
    await expect(cap.execute({ workerId: WORKER, jobPostingId: JOB })).resolves.toEqual({ ok: true, wjaId: 'wja-1', prescreeningUrl: LINK });
  });

  it('ok:true numa vaga sem link devolve prescreeningUrl null (a Luz não inventa link)', async () => {
    const { cap } = build({ ok: true, wjaId: 'wja-1', prescreeningUrl: null });
    await expect(cap.execute({ workerId: WORKER, jobPostingId: JOB })).resolves.toEqual({ ok: true, wjaId: 'wja-1', prescreeningUrl: null });
  });

  it('ok:false NUNCA carrega o link, mesmo que o caso de uso o trouxesse', async () => {
    const { cap } = build({ ok: false, httpStatus: 403, code: 'WORKER_NOT_ELIGIBLE', reason: 'registration_incomplete', workerStatus: 'INCOMPLETE_REGISTER', missingFields: ['phone'], prescreeningUrl: LINK });
    const out = await cap.execute({ workerId: WORKER, jobPostingId: JOB });
    expect(out).toEqual({ ok: false, reason: 'registration_incomplete', workerStatus: 'INCOMPLETE_REGISTER', missingFields: ['phone'] });
    expect(JSON.stringify(out)).not.toContain('prescreeningUrl');
    expect(JSON.stringify(out)).not.toContain(LINK);
  });
});
