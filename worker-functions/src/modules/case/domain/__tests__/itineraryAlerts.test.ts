import { uncoveredDayAlerts, uncoveredDayCount, uncoveredShiftCount, type UncoverableOccurrence } from '../itineraryAlerts';

/**
 * itineraryAlerts — spec 069 (FR-12/FR-35). A entrada são as OCORRÊNCIAS; só `uncovered` dentro de `[asOf, asOf+6]` vira alerta.
 */
const ASOF = '2026-10-10';

function occ(o: Partial<UncoverableOccurrence> & { date: string }): UncoverableOccurrence {
  return { serviceId: 'svc-1', startTime: '08:00', endTime: '12:00', status: 'uncovered', ...o };
}

describe('uncoveredDayAlerts', () => {
  it('só ocorrência uncovered conta: covered e substituted ficam de fora', () => {
    const result = uncoveredDayAlerts(
      [occ({ date: '2026-10-11', status: 'covered' }), occ({ date: '2026-10-12', status: 'substituted' }), occ({ date: '2026-10-13' })],
      ASOF,
    );
    expect(result.map((a) => a.date)).toEqual(['2026-10-13']);
  });

  it('janela [asOf, asOf+6]: ontem e hoje+7 ficam fora; hoje e hoje+6 entram (hoje inteiro, sem olhar a hora)', () => {
    const result = uncoveredDayAlerts(
      [occ({ date: '2026-10-09' }), occ({ date: '2026-10-10' }), occ({ date: '2026-10-16' }), occ({ date: '2026-10-17' })],
      ASOF,
    );
    expect(result.map((a) => a.date)).toEqual(['2026-10-10', '2026-10-16']);
  });

  it('ordena por date, startTime e serviceId e remove repetição (mesma chave composta = mesmo turno)', () => {
    const result = uncoveredDayAlerts(
      [
        occ({ date: '2026-10-12', startTime: '14:00', endTime: '18:00', serviceId: 'svc-b' }),
        occ({ date: '2026-10-11', serviceId: 'svc-b' }),
        occ({ date: '2026-10-11', serviceId: 'svc-a' }),
        occ({ date: '2026-10-11', serviceId: 'svc-a' }),
        occ({ date: '2026-10-12', startTime: '08:00', serviceId: 'svc-b' }),
      ],
      ASOF,
    );
    expect(result).toEqual([
      { serviceId: 'svc-a', date: '2026-10-11', startTime: '08:00', endTime: '12:00' },
      { serviceId: 'svc-b', date: '2026-10-11', startTime: '08:00', endTime: '12:00' },
      { serviceId: 'svc-b', date: '2026-10-12', startTime: '08:00', endTime: '12:00' },
      { serviceId: 'svc-b', date: '2026-10-12', startTime: '14:00', endTime: '18:00' },
    ]);
  });

  it('o mesmo horário e data em serviços diferentes ordena por serviceId', () => {
    const result = uncoveredDayAlerts([occ({ date: '2026-10-11', serviceId: 'svc-z' }), occ({ date: '2026-10-11', serviceId: 'svc-a' })], ASOF);
    expect(result.map((a) => a.serviceId)).toEqual(['svc-a', 'svc-z']);
  });

  it('mesma data, início e serviço com FIM diferente: são dois turnos (a ordem é estável, nenhum se perde)', () => {
    const result = uncoveredDayAlerts([occ({ date: '2026-10-11', endTime: '12:00' }), occ({ date: '2026-10-11', endTime: '13:00' })], ASOF);
    expect(result.map((a) => a.endTime)).toEqual(['12:00', '13:00']);
  });

  it('serviços do mesmo horário ordenam por serviceId qualquer que seja a ordem de entrada', () => {
    const ids = ['svc-c', 'svc-a', 'svc-d', 'svc-b'];
    const crescente = uncoveredDayAlerts([...ids].sort().map((serviceId) => occ({ date: '2026-10-11', serviceId })), ASOF);
    const decrescente = uncoveredDayAlerts([...ids].sort().reverse().map((serviceId) => occ({ date: '2026-10-11', serviceId })), ASOF);
    expect(crescente.map((a) => a.serviceId)).toEqual(['svc-a', 'svc-b', 'svc-c', 'svc-d']);
    expect(decrescente.map((a) => a.serviceId)).toEqual(['svc-a', 'svc-b', 'svc-c', 'svc-d']);
  });

  it('lista vazia → vazia', () => {
    expect(uncoveredDayAlerts([], ASOF)).toEqual([]);
  });

  it('o resultado não carrega workerId nem status (só serviço, data e horário)', () => {
    const [a] = uncoveredDayAlerts([{ ...occ({ date: '2026-10-11' }), workerId: 'w-1' } as UncoverableOccurrence], ASOF);
    expect(Object.keys(a).sort()).toEqual(['date', 'endTime', 'serviceId', 'startTime']);
  });
});

describe('uncoveredDayCount / uncoveredShiftCount', () => {
  const duasFaixasNoMesmoDia = uncoveredDayAlerts(
    [occ({ date: '2026-10-11', startTime: '08:00', endTime: '12:00' }), occ({ date: '2026-10-11', startTime: '14:00', endTime: '18:00' })],
    ASOF,
  );

  it('2 faixas descobertas no MESMO dia = 1 DIA (Kanban) e 2 TURNOS (cartão/alerta)', () => {
    expect(duasFaixasNoMesmoDia).toHaveLength(2);
    expect(uncoveredDayCount(duasFaixasNoMesmoDia)).toBe(1);
    expect(uncoveredShiftCount(duasFaixasNoMesmoDia)).toBe(2);
  });

  it('dias distintos contam cada um', () => {
    const alerts = uncoveredDayAlerts([occ({ date: '2026-10-11' }), occ({ date: '2026-10-12' })], ASOF);
    expect(uncoveredDayCount(alerts)).toBe(2);
  });

  it('vazio → 0 e 0', () => {
    expect(uncoveredDayCount([])).toBe(0);
    expect(uncoveredShiftCount([])).toBe(0);
  });
});
