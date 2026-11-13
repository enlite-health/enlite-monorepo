/** D3 c/d: o que o PUT /vacancies/:id manda ao Talentum. Tudo dublê (Gemini, cliente e pause service). */
import { propagateVacancyEditToTalentum, talentumLifecycleAction } from '../propagateVacancyEditToTalentum';

const ID = 'v-1';
function deps(over: Partial<{ gen: jest.Mock; propagate: jest.Mock; pause: jest.Mock; resume: jest.Mock }> = {}) {
  const gen = over.gen ?? jest.fn(async () => ({ description: 'nova' }));
  const propagate = over.propagate ?? jest.fn(async () => ({ status: 'OK' }));
  const pause = over.pause ?? jest.fn(async () => [{ vacancyId: ID, state: 'PAUSED', attempted: true }]);
  const resume = over.resume ?? jest.fn(async () => [{ vacancyId: ID, state: null, attempted: true }]);
  return { gen, propagate, pause, resume, d: { describer: { generateDescription: gen }, content: { propagate }, lifecycle: { pause, resume } } as never };
}
const base = { vacancyId: ID, published: true, scheduleChanged: false, statusFrom: null, statusTo: null };

describe('talentumLifecycleAction', () => {
  it.each([
    ['ACTIVE', 'ON_HOLD', 'pause'], ['SEARCHING', 'SUSPENDED', 'pause'], ['RAPID_RESPONSE', 'CLOSED', 'pause'],
    ['ON_HOLD', 'ACTIVE', 'resume'], ['CLOSED', 'SEARCHING', 'resume'], ['SUSPENDED', 'PENDING_ACTIVATION', 'resume'],
    ['ON_HOLD', 'SEARCHING_REPLACEMENT', 'resume'], ['CLOSED', 'RAPID_RESPONSE', 'resume'],
    ['ON_HOLD', 'CLOSED', null], ['SUSPENDED', 'ON_HOLD', null], ['ACTIVE', 'SEARCHING', null], ['ACTIVE', 'ACTIVE', null],
  ])('%s → %s = %s', (from, to, expected) => {
    expect(talentumLifecycleAction(from as string, to as string)).toBe(expected);
  });
});

describe('propagateVacancyEditToTalentum', () => {
  beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(); });
  afterEach(() => jest.restoreAllMocks());

  it('vaga NÃO publicada (rascunho): nada é chamado, resultado null', async () => {
    const x = deps();
    await expect(propagateVacancyEditToTalentum({ ...base, published: false, scheduleChanged: true, statusFrom: 'ACTIVE', statusTo: 'ON_HOLD' }, x.d)).resolves.toBeNull();
    expect([x.gen, x.propagate, x.pause, x.resume].map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0]);
  });

  it('(c) horário alterado: regera a descrição e DEPOIS propaga', async () => {
    const x = deps();
    const r = await propagateVacancyEditToTalentum({ ...base, scheduleChanged: true }, x.d);
    expect(r).toEqual({ status: 'OK' });
    expect(x.gen).toHaveBeenCalledWith(ID, undefined);
    expect(x.propagate).toHaveBeenCalledWith(ID, undefined);
    expect(x.gen.mock.invocationCallOrder[0]).toBeLessThan(x.propagate.mock.invocationCallOrder[0]);
    expect(x.pause.mock.calls.length + x.resume.mock.calls.length).toBe(0);
  });

  it('(c) Gemini falha: FAILED e NÃO envia a descrição velha', async () => {
    const x = deps({ gen: jest.fn(async () => { throw new Error('quota'); }) });
    const r = await propagateVacancyEditToTalentum({ ...base, scheduleChanged: true }, x.d);
    expect(r?.status).toBe('FAILED');
    expect(x.propagate).not.toHaveBeenCalled();
  });

  it('(d) entra em pausa → pause; sai → resume; mesmo grupo → nada; sem mudança de horário não regera', async () => {
    const a = deps();
    await expect(propagateVacancyEditToTalentum({ ...base, statusFrom: 'ACTIVE', statusTo: 'ON_HOLD' }, a.d)).resolves.toEqual({ status: 'OK' });
    expect(a.pause).toHaveBeenCalledWith([ID]);
    expect(a.resume).not.toHaveBeenCalled();
    expect(a.gen).not.toHaveBeenCalled();

    const b = deps();
    await propagateVacancyEditToTalentum({ ...base, statusFrom: 'CLOSED', statusTo: 'ACTIVE' }, b.d);
    expect(b.resume).toHaveBeenCalledWith([ID]);
    expect(b.pause).not.toHaveBeenCalled();

    const c = deps();
    await expect(propagateVacancyEditToTalentum({ ...base, statusFrom: 'ON_HOLD', statusTo: 'CLOSED' }, c.d)).resolves.toBeNull();
    expect(c.pause.mock.calls.length + c.resume.mock.calls.length).toBe(0);
  });

  it('(d) Talentum recusa (MANUAL_PAUSE / MANUAL_RESUME) → FAILED; erro do serviço também; nunca lança', async () => {
    const p = deps({ pause: jest.fn(async () => [{ vacancyId: ID, state: 'MANUAL_PAUSE', attempted: true }]) });
    expect((await propagateVacancyEditToTalentum({ ...base, statusFrom: 'ACTIVE', statusTo: 'SUSPENDED' }, p.d))?.status).toBe('FAILED');
    const r = deps({ resume: jest.fn(async () => [{ vacancyId: ID, state: 'MANUAL_RESUME', attempted: true }]) });
    expect((await propagateVacancyEditToTalentum({ ...base, statusFrom: 'ON_HOLD', statusTo: 'ACTIVE' }, r.d))?.status).toBe('FAILED');
    const e = deps({ pause: jest.fn(async () => { throw new Error('db'); }) });
    expect((await propagateVacancyEditToTalentum({ ...base, statusFrom: 'ACTIVE', statusTo: 'CLOSED' }, e.d))?.status).toBe('FAILED');
  });

  it('horário + status juntos: devolve o pior resultado (OTHER_ACCOUNT > OK)', async () => {
    const x = deps({ propagate: jest.fn(async () => ({ status: 'OTHER_ACCOUNT', message: 'otra' })) });
    const r = await propagateVacancyEditToTalentum({ ...base, scheduleChanged: true, statusFrom: 'ACTIVE', statusTo: 'ON_HOLD' }, x.d);
    expect(r?.status).toBe('OTHER_ACCOUNT');
    expect(x.pause).toHaveBeenCalled();
  });
});
