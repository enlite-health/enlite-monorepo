import { assertLocalDsn, dateBA, hhmmBA, main, occurrenceIdOf, planShifts, seedLocal, LOCAL_HOSTS } from '../seed-e2e-itinerario-local';

const NOT_LOCAL = [
  'postgresql://enlite_app@10.0.0.1:5436/enlite_ar',
  'postgresql://enlite_app@192.168.0.5:5432/enlite_e2e',
  'postgresql://enlite_app@db.enlite.internal:5432/enlite_ar',
  'postgresql://enlite_app@34.95.1.2:5432/enlite_ar',
  'postgresql://enlite_app@127.0.0.1.evil.com:5432/enlite_ar',
  'postgresql://enlite_app@localhost.evil.com:5432/enlite_ar',
  'postgresql://enlite_app@0.0.0.0:5432/enlite_ar',
  'postgresql://enlite_app@[::1]:5432/enlite_ar',
];

describe('seed-e2e-itinerario-local — guarda de alvo (só 127.0.0.1 / localhost)', () => {
  it.each(NOT_LOCAL)('assertLocalDsn recusa %s', (dsn) => {
    expect(() => assertLocalDsn(dsn)).toThrow(/RECUSADO/);
  });

  it.each(['not a url', 'mysql://127.0.0.1/x', ''])('assertLocalDsn recusa DSN inválida ou de outro protocolo: "%s"', (dsn) => {
    expect(() => assertLocalDsn(dsn)).toThrow(/RECUSADO/);
  });

  it.each(['postgresql://u:p@127.0.0.1:5671/enlite_e2e', 'postgres://u:p@localhost:5432/x'])('assertLocalDsn aceita %s', (dsn) => {
    expect(assertLocalDsn(dsn)).toBe(dsn);
  });

  it('a lista de hosts aceitos é exatamente a do computador', () => {
    expect([...LOCAL_HOSTS]).toEqual(['127.0.0.1', 'localhost']);
  });

  it.each(NOT_LOCAL)('seedLocal recusa %s ANTES de abrir conexão (morre se a guarda sair)', async (dsn) => {
    await expect(seedLocal(dsn)).rejects.toThrow(/RECUSADO/);
  });

  it('main recusa DSN de fora e a ausência de DSN, sem conexão', async () => {
    await expect(main(['--dsn', NOT_LOCAL[0]])).rejects.toThrow(/RECUSADO/);
    await expect(main([])).rejects.toThrow(/RECUSADO/);
  });
});

describe('seed-e2e-itinerario-local — os 3 turnos', () => {
  const now = new Date('2026-11-26T17:00:30Z'); // 14:00 em BA
  const plans = planShifts(now);
  const byCase = Object.fromEntries(plans.map((p) => [p.case, p]));
  const end = (c: string): Date => new Date(byCase[c].startsAt.getTime() + byCase[c].durationMin * 60_000);

  it('REPORT termina há 3 h; OPEN_4H há 4 h 30 (≥ 240 min do corte do alerta); REFUSED inclui "agora − 75 min"', () => {
    const ago = (d: Date): number => (Math.floor(now.getTime() / 60_000) * 60_000 - d.getTime()) / 60_000;
    expect(ago(end('REPORT'))).toBe(180);
    expect(ago(end('OPEN_4H'))).toBe(270);
    const t = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 75 * 60_000);
    expect(byCase.REFUSED.startsAt.getTime()).toBeLessThan(t.getTime());
    expect(end('REFUSED').getTime()).toBeGreaterThan(t.getTime());
  });

  it('data e hora no fuso de BA (UTC-3) e occurrence_id determinístico (uuid v5 de slot|data|worker)', () => {
    expect(dateBA(new Date('2026-11-26T02:30:00Z'))).toBe('2026-11-25');
    expect(hhmmBA(new Date('2026-11-26T02:30:00Z'))).toBe('23:30');
    expect(occurrenceIdOf('s', '2026-11-26', 'w')).toBe(occurrenceIdOf('s', '2026-11-26', 'w'));
    expect(occurrenceIdOf('s', '2026-11-26', 'w')).not.toBe(occurrenceIdOf('s', '2026-11-27', 'w'));
  });
});
