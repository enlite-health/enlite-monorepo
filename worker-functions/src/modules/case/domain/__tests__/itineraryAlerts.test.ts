import { uncoveredDayAlerts, uncoveredDayCount } from '../itineraryAlerts';

/**
 * uncoveredDayAlerts — Fase 13, DX-13.9, P11. A entrada já é SÓ a ausência sem substituto (quem
 * substitui está coberto — não entra aqui); nada de `workerId`/nome/endereço/clínico na saída
 * (critério 13).
 */
describe('uncoveredDayAlerts', () => {
  const ASOF = '2026-09-28';
  const SERVICE_A = 'service-a';
  const SERVICE_B = 'service-b';

  it('date = asOf → entra (vigente)', () => {
    const result = uncoveredDayAlerts(
      [{ serviceId: SERVICE_A, date: ASOF, startTime: '08:00', endTime: '12:00' }],
      ASOF,
    );
    expect(result).toEqual([{ serviceId: SERVICE_A, date: ASOF, startTime: '08:00', endTime: '12:00' }]);
  });

  it('date = asOf − 1 (string menor) → sai (não vigente)', () => {
    const result = uncoveredDayAlerts(
      [{ serviceId: SERVICE_A, date: '2026-09-27', startTime: '08:00', endTime: '12:00' }],
      ASOF,
    );
    expect(result).toEqual([]);
  });

  it('ordenação por data, depois início, depois serviço — fora de ordem na entrada', () => {
    const result = uncoveredDayAlerts(
      [
        { serviceId: SERVICE_B, date: '2026-09-30', startTime: '08:00', endTime: '10:00' },
        { serviceId: SERVICE_A, date: '2026-09-29', startTime: '14:00', endTime: '16:00' },
        { serviceId: SERVICE_A, date: '2026-09-29', startTime: '08:00', endTime: '10:00' },
        { serviceId: SERVICE_B, date: '2026-09-29', startTime: '08:00', endTime: '10:00' },
      ],
      ASOF,
    );
    expect(result).toEqual([
      { serviceId: SERVICE_A, date: '2026-09-29', startTime: '08:00', endTime: '10:00' },
      { serviceId: SERVICE_B, date: '2026-09-29', startTime: '08:00', endTime: '10:00' },
      { serviceId: SERVICE_A, date: '2026-09-29', startTime: '14:00', endTime: '16:00' },
      { serviceId: SERVICE_B, date: '2026-09-30', startTime: '08:00', endTime: '10:00' },
    ]);
  });

  it('entrada repetida (mesmo serviço/data/horário) → sai UMA vez só', () => {
    const result = uncoveredDayAlerts(
      [
        { serviceId: SERVICE_A, date: ASOF, startTime: '08:00', endTime: '12:00' },
        { serviceId: SERVICE_A, date: ASOF, startTime: '08:00', endTime: '12:00' },
      ],
      ASOF,
    );
    expect(result).toHaveLength(1);
  });

  it('a saída tem EXATAMENTE as chaves serviceId, date, startTime, endTime — nenhuma chave de worker/nome/endereço/clínico', () => {
    const result = uncoveredDayAlerts(
      [{ serviceId: SERVICE_A, date: ASOF, startTime: '08:00', endTime: '12:00' }],
      ASOF,
    );
    expect(Object.keys(result[0]).sort()).toEqual(['date', 'endTime', 'serviceId', 'startTime']);
    const proibido = /worker|name|address|diagnos|clinic/i;
    for (const chave of Object.keys(result[0])) {
      expect(proibido.test(chave)).toBe(false);
    }
  });

  it('lista vazia de ausências → alerta vazio', () => {
    expect(uncoveredDayAlerts([], ASOF)).toEqual([]);
  });
});

/**
 * uncoveredDayCount — achado L2 (veredito parcial-1): `alerts.length` conta ALERTAS (chave
 * `date|start|service|end`), não DIAS. 2 faixas descobertas no MESMO dia do MESMO serviço (horários
 * diferentes) davam `uncoveredDays: 2`. `alerts[]` continua 1 item por faixa — só a CONTAGEM dedupe
 * por `date`.
 */
describe('uncoveredDayCount', () => {
  const ASOF = '2026-09-28';
  const SERVICE_A = 'service-a';

  it('2 faixas descobertas no MESMO dia do MESMO serviço, horários diferentes → 1 dia (não 2 alertas)', () => {
    const alerts = uncoveredDayAlerts(
      [
        { serviceId: SERVICE_A, date: ASOF, startTime: '08:00', endTime: '10:00' },
        { serviceId: SERVICE_A, date: ASOF, startTime: '14:00', endTime: '16:00' },
      ],
      ASOF,
    );
    expect(alerts).toHaveLength(2); // alerts[] não muda
    expect(uncoveredDayCount(alerts)).toBe(1); // a contagem, sim
  });

  it('2 dias diferentes → 2 (contagem igual a alerts.length quando não há repetição de dia)', () => {
    const alerts = uncoveredDayAlerts(
      [
        { serviceId: SERVICE_A, date: '2026-09-28', startTime: '08:00', endTime: '10:00' },
        { serviceId: SERVICE_A, date: '2026-09-29', startTime: '08:00', endTime: '10:00' },
      ],
      ASOF,
    );
    expect(uncoveredDayCount(alerts)).toBe(2);
  });

  it('lista vazia → 0', () => {
    expect(uncoveredDayCount([])).toBe(0);
  });
});
