/**
 * PatientItinerarySlotSync — client mockado (molde `cliente()` de
 * `PatientContractedServiceRepository.test.ts:45-60`); a prova de que o SQL real funciona é o
 * e2e `tests/e2e/patient-itinerary-slots.e2e.test.ts` (P9).
 */
import { syncItinerarySlots } from '../PatientItinerarySlotSync';
import { InvalidScheduleEntryError, type ScheduleEntry } from '../../domain/ItinerarySchedule';
import type { PoolClient } from 'pg';

function cliente() {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/^\s*INSERT INTO patient_itinerary_slot/.test(sql)) return { rows: [], rowCount: 1 };
    if (/^\s*UPDATE patient_itinerary_slot/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query } as unknown as PoolClient, chamadas };
}

describe('syncItinerarySlots', () => {
  it('schedule de 2 faixas: 2 INSERT (ON CONFLICT reativa) e 1 UPDATE desativa o resto pelas 2 chaves', async () => {
    const { cli, chamadas } = cliente();
    const schedule: ScheduleEntry[] = [
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 3, startTime: '14:00', endTime: '18:00' },
    ];
    await syncItinerarySlots(cli, 'svc-1', schedule, 'actor-1');

    const inserts = chamadas.filter((c) => /^\s*INSERT INTO patient_itinerary_slot/.test(c.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).toContain(
      'ON CONFLICT (contracted_service_id, weekday, start_time, end_time)',
    );
    expect(inserts[0].sql).toContain(
      'DO UPDATE SET active = true, updated_by = EXCLUDED.updated_by, updated_at = now()',
    );
    expect(inserts[0].sql).toContain('WHERE patient_itinerary_slot.active = false');
    expect(inserts[0].params).toEqual(['svc-1', 1, '08:00', '12:00', 'actor-1']);
    expect(inserts[1].params).toEqual(['svc-1', 3, '14:00', '18:00', 'actor-1']);

    const updates = chamadas.filter((c) => /^\s*UPDATE patient_itinerary_slot/.test(c.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/SET active = false, updated_by = \$2, updated_at = now\(\)/);
    expect(updates[0].sql).toContain('WHERE contracted_service_id = $1 AND active');
    expect(updates[0].sql).toMatch(
      /NOT \(\(weekday, start_time, end_time\) IN \(\(\$3, \$4, \$5\), \(\$6, \$7, \$8\)\)\)/,
    );
    expect(updates[0].params).toEqual(['svc-1', 'actor-1', 1, '08:00', '12:00', 3, '14:00', '18:00']);
  });

  it('schedule null: 0 INSERT e 1 UPDATE que desativa todos os ativos do serviço, sem NOT IN', async () => {
    const { cli, chamadas } = cliente();
    await syncItinerarySlots(cli, 'svc-1', null, 'actor-1');

    expect(chamadas.filter((c) => /^\s*INSERT INTO patient_itinerary_slot/.test(c.sql))).toHaveLength(0);
    const updates = chamadas.filter((c) => /^\s*UPDATE patient_itinerary_slot/.test(c.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).not.toMatch(/NOT \(/);
    expect(updates[0].params).toEqual(['svc-1', 'actor-1']);
  });

  it('3 faixas idênticas (schedule real da stage): dedup em 1 INSERT', async () => {
    const { cli, chamadas } = cliente();
    const schedule: ScheduleEntry[] = [
      { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' },
    ];
    await syncItinerarySlots(cli, 'svc-1', schedule, 'actor-1');
    expect(chamadas.filter((c) => /^\s*INSERT INTO patient_itinerary_slot/.test(c.sql))).toHaveLength(1);
  });

  it('nenhuma SQL emitida é DELETE (o app não tem privilégio; a tabela não apaga linha)', async () => {
    const { cli, chamadas } = cliente();
    await syncItinerarySlots(cli, 'svc-1', [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }], 'actor-1');
    await syncItinerarySlots(cli, 'svc-1', null, 'actor-1');
    expect(chamadas.every((c) => !/^\s*DELETE/i.test(c.sql))).toBe(true);
  });

  it('entrada inválida (endTime <= startTime) lança InvalidScheduleEntryError ANTES de qualquer query', async () => {
    const { cli, chamadas } = cliente();
    const invalid: ScheduleEntry[] = [{ dayOfWeek: 1, startTime: '12:00', endTime: '08:00' }];
    await expect(syncItinerarySlots(cli, 'svc-1', invalid, 'actor-1')).rejects.toBeInstanceOf(
      InvalidScheduleEntryError,
    );
    expect(chamadas).toHaveLength(0);
  });
});
