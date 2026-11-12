import { decideManualBaja, refusesCloseOfActiveServiceVacancy, BAJA_REFUSAL_MESSAGES } from '../VacancyBajaPolicy';

describe('VacancyBajaPolicy (spec 084 P1/P2/R4)', () => {
  it('P1: baixa à mão só em vaga SEM serviço', () => {
    expect(decideManualBaja({ status: 'SEARCHING', contractedServiceId: null })).toEqual({ ok: true });
    expect(decideManualBaja({ status: 'SEARCHING', contractedServiceId: 'svc-1' })).toEqual({ ok: false, code: 'VACANCY_HAS_SERVICE' });
  });

  it('vaga já baixada: recusa (idempotência explícita, nunca sobrescreve status_before_baja)', () => {
    expect(decideManualBaja({ status: 'DE_BAJA', contractedServiceId: null })).toEqual({ ok: false, code: 'VACANCY_ALREADY_DE_BAJA' });
  });

  it.each(['SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'PENDING_ACTIVATION', 'ACTIVE', 'ON_HOLD', 'SUSPENDED', 'CLOSED'])(
    'vaga sem serviço em %s pode baixar (sem apagar)',
    (status) => {
      expect(decideManualBaja({ status, contractedServiceId: null })).toEqual({ ok: true });
    },
  );

  it('R4: encerrar vaga de serviço ATIVO é recusado; serviço inativo, vaga sem serviço e outros status passam', () => {
    expect(refusesCloseOfActiveServiceVacancy('CLOSED', { contractedServiceId: 's', serviceActive: true })).toBe(true);
    expect(refusesCloseOfActiveServiceVacancy('CLOSED', { contractedServiceId: 's', serviceActive: false })).toBe(false);
    expect(refusesCloseOfActiveServiceVacancy('CLOSED', { contractedServiceId: null, serviceActive: null })).toBe(false);
    expect(refusesCloseOfActiveServiceVacancy('ON_HOLD', { contractedServiceId: 's', serviceActive: true })).toBe(false);
  });

  it('toda recusa tem mensagem em es E pt-BR (P1: "mensagem clara em es + pt-BR")', () => {
    for (const [code, m] of Object.entries(BAJA_REFUSAL_MESSAGES)) {
      expect(m.es.length).toBeGreaterThan(10);
      expect(m['pt-BR'].length).toBeGreaterThan(10);
      expect(m.es).not.toBe(m['pt-BR']);
      expect(code).toMatch(/^[A-Z_]+$/);
    }
  });
});
