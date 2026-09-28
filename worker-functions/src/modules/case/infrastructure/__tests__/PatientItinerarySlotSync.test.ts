/**
 * PatientItinerarySlotSync — client mockado (molde `cliente()` de
 * `PatientContractedServiceRepository.test.ts:45-60`); a prova de que o SQL real funciona é o
 * e2e `tests/e2e/patient-itinerary-slots.e2e.test.ts` (P9).
 */
import { syncItinerarySlots } from '../PatientItinerarySlotSync';
import { InvalidScheduleEntryError, type ScheduleEntry } from '../../domain/ItinerarySchedule';
import type { PoolClient } from 'pg';
import { SlotHasActiveAllocationError } from '../../application/ItinerarySlotWriteUseCase';

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

describe('syncItinerarySlots — D442: recusa desativar slot com alocação vigente', () => {
  const PAIS_SQL = /^\s*SELECT p\.country FROM patient_contracted_services/;
  const CHECK_SQL = /^\s*SELECT s\.id FROM patient_itinerary_slot s/;

  /** Molde do `cliente()` acima, com resposta para o país e para a checagem de alocação. */
  function clienteD442(opts: { country: string | null; blockedSlotId: string | null }) {
    const chamadas: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      chamadas.push({ sql, params });
      if (PAIS_SQL.test(sql)) {
        return opts.country === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ country: opts.country }], rowCount: 1 };
      }
      if (CHECK_SQL.test(sql)) {
        return opts.blockedSlotId === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: opts.blockedSlotId }], rowCount: 1 };
      }
      if (/^\s*INSERT INTO patient_itinerary_slot/.test(sql)) return { rows: [], rowCount: 1 };
      if (/^\s*UPDATE patient_itinerary_slot/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    return { cli: { query } as unknown as PoolClient, chamadas };
  }

  const escritas = (chamadas: Array<{ sql: string }>) =>
    chamadas.filter((c) => /^\s*(INSERT|UPDATE)\b/i.test(c.sql));

  const QUARTA: ScheduleEntry[] = [{ dayOfWeek: 3, startTime: '14:00', endTime: '18:00' }];
  const NOW = new Date('2026-10-06T02:30:00Z');

  it('slot a desativar COM alocação vigente → SlotHasActiveAllocationError com o slotId e nenhum INSERT/UPDATE', async () => {
    const { cli, chamadas } = clienteD442({ country: 'AR', blockedSlotId: 'slot-seg' });
    const err = await syncItinerarySlots(cli, 'svc-1', QUARTA, 'actor-1', NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlotHasActiveAllocationError);
    expect((err as SlotHasActiveAllocationError).slotId).toBe('slot-seg');
    expect((err as SlotHasActiveAllocationError).serviceId).toBe('svc-1');
    expect(escritas(chamadas)).toHaveLength(0);
    console.log('[12.P3]', 'recusa', (err as SlotHasActiveAllocationError).slotId, 'escritas', escritas(chamadas).length);
  });

  it('sem linha na checagem → o INSERT e o UPDATE de sempre', async () => {
    const { cli, chamadas } = clienteD442({ country: 'AR', blockedSlotId: null });
    const res = await syncItinerarySlots(cli, 'svc-1', QUARTA, 'actor-1', NOW);
    expect(res).toEqual({ upserted: 1, deactivated: 1 });
    const check = chamadas.filter((c) => CHECK_SQL.test(c.sql));
    expect(check).toHaveLength(1);
    expect(check[0].sql).toContain('AND NOT ((weekday, start_time, end_time) IN (($3, $4, $5)))');
    expect(check[0].params).toEqual(['svc-1', '2026-10-05', 3, '14:00', '18:00']);
    const updates = chamadas.filter((c) => /^\s*UPDATE patient_itinerary_slot/.test(c.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual(['svc-1', 'actor-1', 3, '14:00', '18:00']);
    // a checagem roda ANTES de qualquer escrita
    const idxCheck = chamadas.findIndex((c) => CHECK_SQL.test(c.sql));
    const idxPrimeiraEscrita = chamadas.findIndex((c) => /^\s*(INSERT|UPDATE)\b/i.test(c.sql));
    expect(idxCheck).toBeLessThan(idxPrimeiraEscrita);
  });

  it('desired vazio (schedule null) → a checagem SEM "NOT (" e com o parâmetro hoje', async () => {
    const { cli, chamadas } = clienteD442({ country: 'AR', blockedSlotId: null });
    await syncItinerarySlots(cli, 'svc-1', null, 'actor-1', NOW);
    const check = chamadas.filter((c) => CHECK_SQL.test(c.sql));
    expect(check).toHaveLength(1);
    expect(check[0].sql).not.toMatch(/NOT \(/);
    expect(check[0].params).toEqual(['svc-1', '2026-10-05']);
  });

  it('hoje = operationDateOf(AR, now) para um instante que cruza a meia-noite UTC', async () => {
    expect(NOW.toISOString().slice(0, 10)).toBe('2026-10-06');
    const { cli, chamadas } = clienteD442({ country: 'AR', blockedSlotId: null });
    await syncItinerarySlots(cli, 'svc-1', QUARTA, 'actor-1', NOW);
    const check = chamadas.find((c) => CHECK_SQL.test(c.sql));
    expect(check?.params[1]).toBe('2026-10-05');
  });

  it('país sem linha → nenhuma checagem de alocação; o UPDATE de sempre roda', async () => {
    const { cli, chamadas } = clienteD442({ country: null, blockedSlotId: 'nao-deve-ser-lido' });
    await syncItinerarySlots(cli, 'svc-1', QUARTA, 'actor-1', NOW);
    expect(chamadas.filter((c) => PAIS_SQL.test(c.sql))).toHaveLength(1);
    expect(chamadas.filter((c) => CHECK_SQL.test(c.sql))).toHaveLength(0);
    expect(chamadas.filter((c) => /^\s*UPDATE patient_itinerary_slot/.test(c.sql))).toHaveLength(1);
  });

  it('a SQL da checagem usa o predicado de vigência com hoje por parâmetro, sem relógio do banco', async () => {
    const { cli, chamadas } = clienteD442({ country: 'AR', blockedSlotId: null });
    await syncItinerarySlots(cli, 'svc-1', QUARTA, 'actor-1', NOW);
    const sql = chamadas.find((c) => CHECK_SQL.test(c.sql))?.sql ?? '';
    expect(sql).toContain("status = 'ACTIVE'");
    expect(sql).toMatch(/(a\.)?valid_to IS NULL OR (a\.)?valid_to >= \$2::date/);
    expect(sql).not.toMatch(/now\(\)/i);
    expect(sql).not.toMatch(/CURRENT_DATE/i);
    expect(chamadas.find((c) => PAIS_SQL.test(c.sql))?.params).toEqual(['svc-1']);
  });

  it('nenhuma SQL emitida é DELETE, nem na recusa', async () => {
    const { cli, chamadas } = clienteD442({ country: 'AR', blockedSlotId: 'slot-seg' });
    await expect(syncItinerarySlots(cli, 'svc-1', null, 'actor-1', NOW)).rejects.toBeInstanceOf(
      SlotHasActiveAllocationError,
    );
    expect(chamadas.length).toBeGreaterThan(0);
    expect(chamadas.every((c) => !/^\s*DELETE/i.test(c.sql))).toBe(true);
  });
});
