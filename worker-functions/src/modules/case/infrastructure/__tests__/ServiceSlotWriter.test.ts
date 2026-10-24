/**
 * ServiceSlotWriter — client `pg` mockado (molde `PatientItinerarySlotSync.test.ts`); a prova do SQL
 * real (trava, trigger) é do harness de banco (T1.9).
 */
import type { PoolClient } from 'pg';
import { replaceServiceSlots, ServiceSlotOverlapError } from '../ServiceSlotWriter';
import { InvalidScheduleEntryError, type ShiftEntry } from '../../domain/ItinerarySchedule';
import { SlotHasActiveAllocationError } from '../../application/ItinerarySlotWriteUseCase';

interface Opts {
  vigentes?: Array<{ id: string; weekday: number; start_time: string; duration_minutes: number }>;
  bloqueada?: string | null;
  insertError?: unknown;
  validAtual?: string;
}

function cliente(o: Opts = {}) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/FROM patient_itinerary_slot WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ valid: o.validAtual ?? '[2026-10-01,)' }], rowCount: 1 };
    if (/FROM patient_contracted_services pcs JOIN patients/.test(sql)) return { rows: [{ country: 'AR' }], rowCount: 1 };
    if (/^\s*SELECT[\s\S]*FROM patient_itinerary_slot s[\s\S]*valid @>/.test(sql) && !/patient_itinerary_assignment/.test(sql)) {
      const rows = o.vigentes ?? [];
      return { rows, rowCount: rows.length };
    }
    if (/patient_itinerary_assignment/.test(sql) && /^\s*SELECT/.test(sql)) {
      return o.bloqueada ? { rows: [{ id: o.bloqueada }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/^\s*UPDATE patient_itinerary_slot/.test(sql)) return { rows: [], rowCount: 1 };
    if (/^\s*INSERT INTO patient_itinerary_slot/.test(sql)) {
      if (o.insertError) throw o.insertError;
      return { rows: [{ id: 'novo' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query } as unknown as PoolClient, chamadas };
}

const NOW = new Date('2026-10-18T15:00:00Z'); // 12:00 em Buenos Aires → hoje = 2026-10-18
const escritas = <T extends { sql: string }>(c: T[]): T[] => c.filter((x) => /^\s*(UPDATE|INSERT)/.test(x.sql));

describe('replaceServiceSlots', () => {
  it('fecha antes de abrir: seg 08-12 vira seg 08-13 → SELECT país, SELECT vigentes, SELECT alocação, SELECT FOR UPDATE, UPDATE valid, INSERT', async () => {
    const { cli, chamadas } = cliente({ vigentes: [{ id: 'slot-old', weekday: 1, start_time: '08:00', duration_minutes: 240 }] });
    const entries: ShiftEntry[] = [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 300 }];

    const r = await replaceServiceSlots(cli, 'svc-1', entries, 'actor-1', NOW);

    expect(r).toEqual({ opened: 1, closed: 1 });
    expect(chamadas).toHaveLength(6);
    expect(chamadas[0].sql).toMatch(/SELECT p\.country/);
    expect(chamadas[1].sql).toMatch(/valid @> \$2::date/);
    expect(chamadas[2].sql).toMatch(/patient_itinerary_assignment/);
    expect(chamadas[3].sql).toMatch(/valid::text AS valid FROM patient_itinerary_slot WHERE id = \$1 FOR UPDATE/);
    expect(chamadas[4].sql).toMatch(/^\s*UPDATE patient_itinerary_slot/);
    expect(chamadas[4].sql).toContain('SET valid = $2');
    expect(chamadas[4].params).toEqual(['slot-old', '[2026-10-01,2026-10-18)', 'actor-1']);
    expect(chamadas[5].sql).toMatch(/^\s*INSERT INTO patient_itinerary_slot/);
    expect(chamadas[5].sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $6)');
    expect(chamadas[5].sql).not.toContain('daterange(');
    expect(chamadas[5].sql).not.toMatch(/ON CONFLICT/);
    expect(chamadas[5].params).toEqual(['svc-1', 1, '08:00', 300, '[2026-10-18,)', 'actor-1']);
    expect(chamadas.some((c) => /active/.test(c.sql.replace(/pcs\.active/g, '')))).toBe(false);
  });

  it('closeSlot vazio: faixa nascida hoje e fechada hoje grava empty (nunca vigente)', async () => {
    const { cli, chamadas } = cliente({
      vigentes: [{ id: 'slot-hoje', weekday: 1, start_time: '08:00', duration_minutes: 240 }],
      validAtual: '[2026-10-18,)',
    });
    await replaceServiceSlots(cli, 'svc-1', [{ dayOfWeek: 2, startTime: '08:00', durationMinutes: 240 }], 'actor-1', NOW);
    const upd = chamadas.find((c) => /^\s*UPDATE patient_itinerary_slot/.test(c.sql))!;
    expect(upd.params).toEqual(['slot-hoje', 'empty', 'actor-1']);
  });

  it('equivalência: com o relógio às 01:30 UTC (22:30 do dia anterior em AR) o limite gravado é o dia LOCAL, nunca a data UTC', async () => {
    const AGORA_UTC = new Date('2026-10-19T01:30:00Z'); // 22:30 de 18/10 em Buenos Aires; a data UTC já é 19/10
    const { cli, chamadas } = cliente({ vigentes: [{ id: 'slot-old', weekday: 1, start_time: '08:00', duration_minutes: 240 }], validAtual: '[2026-10-01,)' });
    await replaceServiceSlots(cli, 'svc-1', [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 300 }], 'actor-1', AGORA_UTC);
    const [fecha, abre] = escritas(chamadas);
    expect(fecha.params[1]).toBe('[2026-10-01,2026-10-18)'); // ≤ dia local (18), nunca 19
    expect(abre.params[4]).toBe('[2026-10-18,)');
  });

  it('alocação vigente na faixa que sai → SlotHasActiveAllocationError e NENHUM UPDATE/INSERT', async () => {
    const { cli, chamadas } = cliente({
      vigentes: [{ id: 'slot-old', weekday: 1, start_time: '08:00', duration_minutes: 240 }],
      bloqueada: 'slot-old',
    });
    await expect(
      replaceServiceSlots(cli, 'svc-1', [{ dayOfWeek: 2, startTime: '08:00', durationMinutes: 240 }], 'actor-1', NOW),
    ).rejects.toBeInstanceOf(SlotHasActiveAllocationError);
    expect(escritas(chamadas)).toHaveLength(0);
  });

  it('23P01 de pis_sem_sobreposicao no INSERT → ServiceSlotOverlapError', async () => {
    const { cli } = cliente({ insertError: Object.assign(new Error('exclusion'), { code: '23P01', constraint: 'pis_sem_sobreposicao' }) });
    await expect(
      replaceServiceSlots(cli, 'svc-1', [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], 'actor-1', NOW),
    ).rejects.toBeInstanceOf(ServiceSlotOverlapError);
  });

  it('outro erro no INSERT propaga intacto (não vira overlap)', async () => {
    const boom = Object.assign(new Error('x'), { code: '23514', constraint: 'pis_duration_range' });
    const { cli } = cliente({ insertError: boom });
    await expect(
      replaceServiceSlots(cli, 'svc-1', [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], 'actor-1', NOW),
    ).rejects.toBe(boom);
  });

  it('conjunto igual → 0 escritas', async () => {
    const { cli, chamadas } = cliente({ vigentes: [{ id: 's', weekday: 1, start_time: '08:00', duration_minutes: 240 }] });
    const r = await replaceServiceSlots(cli, 'svc-1', [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], 'actor-1', NOW);
    expect(r).toEqual({ opened: 0, closed: 0 });
    expect(escritas(chamadas)).toHaveLength(0);
  });

  it('horário null fecha todas as vigentes e não abre nada', async () => {
    const { cli, chamadas } = cliente({ vigentes: [{ id: 'a', weekday: 1, start_time: '08:00', duration_minutes: 240 }, { id: 'b', weekday: 2, start_time: '08:00', duration_minutes: 240 }] });
    const r = await replaceServiceSlots(cli, 'svc-1', null, 'actor-1', NOW);
    expect(r).toEqual({ opened: 0, closed: 2 });
    expect(chamadas.filter((c) => /^\s*UPDATE/.test(c.sql))).toHaveLength(2);
  });

  it('entrada inválida lança ANTES de qualquer query', async () => {
    const { cli, chamadas } = cliente();
    await expect(
      replaceServiceSlots(cli, 'svc-1', [{ dayOfWeek: 7, startTime: '08:00', durationMinutes: 240 }], 'actor-1', NOW),
    ).rejects.toBeInstanceOf(InvalidScheduleEntryError);
    expect(chamadas).toHaveLength(0);
  });
});
