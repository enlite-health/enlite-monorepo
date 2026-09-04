import { DiagnosisSource, InvalidDiagnosisSourceError } from '../DiagnosisSource';

describe('DiagnosisSource', () => {
  it('parses os três valores válidos', () => {
    expect(DiagnosisSource.parse('PANEL').value).toBe('PANEL');
    expect(DiagnosisSource.parse('CLICKUP').value).toBe('CLICKUP');
    expect(DiagnosisSource.parse('BACKFILL').value).toBe('BACKFILL');
  });

  it('rejeita valor fora do enum, null e undefined com o MESMO tipo de erro', () => {
    expect(() => DiagnosisSource.parse('WEBHOOK')).toThrow(InvalidDiagnosisSourceError);
    expect(() => DiagnosisSource.parse(null)).toThrow(InvalidDiagnosisSourceError);
    expect(() => DiagnosisSource.parse(undefined)).toThrow(InvalidDiagnosisSourceError);
  });

  it('PANEL > CLICKUP > BACKFILL na precedência (REGRA-03, Diego)', () => {
    expect(DiagnosisSource.PANEL.outranks(DiagnosisSource.CLICKUP)).toBe(true);
    expect(DiagnosisSource.CLICKUP.outranks(DiagnosisSource.PANEL)).toBe(false);
    expect(DiagnosisSource.CLICKUP.outranks(DiagnosisSource.BACKFILL)).toBe(true);
    expect(DiagnosisSource.PANEL.outranks(DiagnosisSource.BACKFILL)).toBe(true);
    expect(DiagnosisSource.BACKFILL.outranks(DiagnosisSource.PANEL)).toBe(false);
  });

  it('nenhuma origem outranks a si mesma', () => {
    expect(DiagnosisSource.PANEL.outranks(DiagnosisSource.PANEL)).toBe(false);
  });

  it('equals compara por valor, não por identidade de instância', () => {
    expect(DiagnosisSource.parse('PANEL').equals(DiagnosisSource.PANEL)).toBe(true);
    expect(DiagnosisSource.PANEL.equals(DiagnosisSource.CLICKUP)).toBe(false);
  });

  it('toString devolve o valor cru', () => {
    expect(DiagnosisSource.CLICKUP.toString()).toBe('CLICKUP');
    expect(String(DiagnosisSource.BACKFILL)).toBe('BACKFILL');
  });
});
