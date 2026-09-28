import { uncoveredDayAlerts } from '../itineraryAlerts';

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
