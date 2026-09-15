import { isContestReason, AnaCareHoursServiceError } from '../AnaCareShift';

describe('isContestReason', () => {
  it('aceita os 4 valores da lista fechada (D344)', () => {
    expect(isContestReason('no_asistio')).toBe(true);
    expect(isContestReason('horario_distinto')).toBe(true);
    expect(isContestReason('horas_mal_cargadas')).toBe(true);
    expect(isContestReason('otro')).toBe(true);
  });

  it('recusa string fora da lista', () => {
    expect(isContestReason('motivo_inventado')).toBe(false);
  });

  it('recusa valor não-string (nunca lança)', () => {
    expect(isContestReason(123)).toBe(false);
    expect(isContestReason(null)).toBe(false);
    expect(isContestReason(undefined)).toBe(false);
  });
});

describe('AnaCareHoursServiceError', () => {
  it('carrega o code e usa o code como mensagem default', () => {
    const err = new AnaCareHoursServiceError('JA_VALIDADO');
    expect(err.code).toBe('JA_VALIDADO');
    expect(err.message).toBe('JA_VALIDADO');
    expect(err.name).toBe('AnaCareHoursServiceError');
  });

  it('aceita mensagem custom', () => {
    const err = new AnaCareHoursServiceError('NOTA_OBRIGATORIA', 'nota acima do limite');
    expect(err.message).toBe('nota acima do limite');
  });
});
