/**
 * O que o PUT /vacancies/:id manda ao Talentum. Tudo dublê (Gemini e cliente). Semaforo-da-vaga F4: o ramo de STATUS saiu
 * (ninguém edita status; pausa/retomada seguem o paciente e a baixa); sobra o horário.
 */
import { propagateVacancyEditToTalentum } from '../propagateVacancyEditToTalentum';

const ID = 'v-1';
function deps(over: Partial<{ gen: jest.Mock; propagate: jest.Mock }> = {}) {
  const gen = over.gen ?? jest.fn(async () => ({ description: 'nova' }));
  const propagate = over.propagate ?? jest.fn(async () => ({ status: 'OK' }));
  return { gen, propagate, d: { describer: { generateDescription: gen }, content: { propagate } } as never };
}
const base = { vacancyId: ID, published: true, scheduleChanged: false };

describe('propagateVacancyEditToTalentum', () => {
  beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(); });
  afterEach(() => jest.restoreAllMocks());

  it('vaga NÃO publicada (rascunho): nada é chamado, resultado null', async () => {
    const x = deps();
    await expect(propagateVacancyEditToTalentum({ ...base, published: false, scheduleChanged: true }, x.d)).resolves.toBeNull();
    expect([x.gen, x.propagate].map((f) => f.mock.calls.length)).toEqual([0, 0]);
  });

  it('(c) horário alterado: regera a descrição e DEPOIS propaga', async () => {
    const x = deps();
    const r = await propagateVacancyEditToTalentum({ ...base, scheduleChanged: true }, x.d);
    expect(r).toEqual({ status: 'OK' });
    expect(x.gen).toHaveBeenCalledWith(ID, undefined);
    expect(x.propagate).toHaveBeenCalledWith(ID, undefined);
    expect(x.gen.mock.invocationCallOrder[0]).toBeLessThan(x.propagate.mock.invocationCallOrder[0]);
  });

  it('sem mudança de horário não há nada a enviar (null), mesmo publicada', async () => {
    const x = deps();
    await expect(propagateVacancyEditToTalentum(base, x.d)).resolves.toBeNull();
    expect([x.gen, x.propagate].map((f) => f.mock.calls.length)).toEqual([0, 0]);
  });

  it('(c) Gemini falha: FAILED e NÃO envia a descrição velha', async () => {
    const x = deps({ gen: jest.fn(async () => { throw new Error('quota'); }) });
    const r = await propagateVacancyEditToTalentum({ ...base, scheduleChanged: true }, x.d);
    expect(r?.status).toBe('FAILED');
    expect(x.propagate).not.toHaveBeenCalled();
  });

  it('o envio devolve o pior resultado (OTHER_ACCOUNT > OK)', async () => {
    const x = deps({ propagate: jest.fn(async () => ({ status: 'OTHER_ACCOUNT', message: 'otra' })) });
    const r = await propagateVacancyEditToTalentum({ ...base, scheduleChanged: true }, x.d);
    expect(r?.status).toBe('OTHER_ACCOUNT');
  });
});
