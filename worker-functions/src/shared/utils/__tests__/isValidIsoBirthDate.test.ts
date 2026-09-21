import { isValidIsoBirthDate } from '../isValidIsoBirthDate';

/**
 * Defeito 1 (21/09/2026, autorizado pelo Gabriel): backend aceitava qualquer
 * string em `birthDate` (openapi `WorkerGeneralInfoBody.birthDate: z.string().optional()`
 * era só documentação — a rota `saveGeneralInfo` não validava nada em runtime).
 * Este gate garante YYYY-MM-DD de data real, não futura.
 */
describe('isValidIsoBirthDate', () => {
  it('aceita datas reais, completas e passadas', () => {
    expect(isValidIsoBirthDate('1990-04-18')).toBe(true);
    expect(isValidIsoBirthDate('1985-07-25')).toBe(true);
    expect(isValidIsoBirthDate('2000-01-01')).toBe(true);
  });

  it('aceita 29/02 em ano bissexto', () => {
    expect(isValidIsoBirthDate('2020-02-29')).toBe(true);
  });

  it('rejeita 29/02 em ano não-bissexto', () => {
    expect(isValidIsoBirthDate('2021-02-29')).toBe(false);
  });

  it('rejeita mês inexistente', () => {
    expect(isValidIsoBirthDate('1985-13-10')).toBe(false);
    expect(isValidIsoBirthDate('1985-00-10')).toBe(false);
  });

  it('rejeita dia inexistente no mês', () => {
    expect(isValidIsoBirthDate('1985-02-30')).toBe(false);
    expect(isValidIsoBirthDate('1985-04-31')).toBe(false);
  });

  it('rejeita formato errado (não YYYY-MM-DD)', () => {
    expect(isValidIsoBirthDate('25/31/985')).toBe(false);
    expect(isValidIsoBirthDate('18/03/1990')).toBe(false);
    expect(isValidIsoBirthDate('1990/01/01')).toBe(false);
    expect(isValidIsoBirthDate('not-a-date')).toBe(false);
    expect(isValidIsoBirthDate('')).toBe(false);
  });

  it('rejeita ano implausível (antes de 1900)', () => {
    expect(isValidIsoBirthDate('1899-12-31')).toBe(false);
  });

  it('rejeita data futura', () => {
    const futureYear = new Date().getUTCFullYear() + 1;
    expect(isValidIsoBirthDate(`${futureYear}-01-01`)).toBe(false);
  });

  it('aceita hoje (não é "futura")', () => {
    const today = new Date();
    const iso = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    expect(isValidIsoBirthDate(iso)).toBe(true);
  });
});
