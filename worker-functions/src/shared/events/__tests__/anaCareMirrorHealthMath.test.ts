import {
  computeOldestStuckAgeHours,
  isMirrorStuck,
} from '../anaCareMirrorHealthMath';

describe('computeOldestStuckAgeHours', () => {
  const now = new Date('2026-08-10T12:00:00Z');

  it('retorna 0 quando não há preso', () => {
    expect(computeOldestStuckAgeHours(null, now)).toBe(0);
  });

  it('calcula a idade em horas com 1 casa decimal', () => {
    expect(computeOldestStuckAgeHours(new Date('2026-08-10T09:30:00Z'), now)).toBe(2.5);
  });

  it('mede o incidente real (30/07 16:58 -> 10/08) em ~259h', () => {
    expect(computeOldestStuckAgeHours(new Date('2026-07-30T16:58:00Z'), now)).toBeCloseTo(259, 0);
  });

  it('nunca retorna negativo para timestamp no futuro (clock skew)', () => {
    expect(computeOldestStuckAgeHours(new Date('2026-08-10T13:00:00Z'), now)).toBe(0);
  });
});

describe('isMirrorStuck', () => {
  it('é falso só quando o backlog recente zera de verdade', () => {
    expect(isMirrorStuck(0)).toBe(false);
  });

  it('é verdadeiro com um único preso', () => {
    expect(isMirrorStuck(1)).toBe(true);
  });

  /**
   * A propriedade que o alerta de borda não tinha: o predicado não depende de
   * ter havido uma FALHA na janela de observação. Uma rajada que já passou
   * (zero falhas novas agora) continua com o predicado verdadeiro enquanto
   * houver gente presa — logo o cron reemite o WARN e o alerta não se
   * auto-resolve.
   */
  it('permanece verdadeiro sem nenhuma falha nova, só com backlog de pé', () => {
    const semFalhaNova = 20; // estado observado em prod em 10/08, 11 dias após a última mudança
    expect(isMirrorStuck(semFalhaNova)).toBe(true);
  });
});
