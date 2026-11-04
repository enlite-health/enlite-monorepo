/**
 * D489/D530 — toda troca MANUAL de estado é recusada quando o paciente tem alocação VIVA no
 * itinerário; a lista de destinos marca TODOS como bloqueados. Origem interna (derivação `system`)
 * não é afetada. O writer e a lista rodam de verdade; só o banco é de mentira.
 */
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../patientTransaction', () => ({
  inPatientTransaction: (fn: (c: unknown) => Promise<unknown>) => fn(mockClient),
}));
jest.mock('firebase-functions', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import type { PoolClient } from 'pg';
import { movePatientStatus, PatientStatusLockedByAllocationError } from '../PatientStatusWriter';
import { loadStatusOptions, ACTIVE_ALLOCATION_BLOCK } from '../PatientStatusOptions';
import { destinosNaFsm, naFsm } from './fixtures/fsmClinicaProd20261010';

const PID = '11111111-1111-4111-8111-111111111111';
const FICHA_COMPLETA = {
  birth_date: '1980-01-01', has_consent: true, insurance_informed: 'OSDE',
  active_address_count: '1', active_responsible_count: '0', active_service_count: '1',
  services_without_address_count: '0', services_without_schedule_count: '0',
};

/** `vivas` = alocações vivas que a consulta do itinerário devolve. */
function banco(de: string, vivas: number) {
  mockClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/patient_itinerary_assignment/.test(sql)) return { rows: [{ n: vivas }], rowCount: 1 };
    if (/services_without_schedule_count/.test(sql)) return { rows: [FICHA_COMPLETA], rowCount: 1 };
    if (/FROM patients/.test(sql)) return { rows: [{ status: de }], rowCount: 1 };
    if (/FROM patient_status_transitions WHERE from_status = \$1$/.test(sql.trim())) {
      const [f] = params as [string];
      return { rows: destinosNaFsm(f).map((t) => ({ to_status: t })), rowCount: 0 };
    }
    if (/patient_status_transitions/.test(sql)) {
      const [f, t] = params as [string, string];
      return { rows: naFsm(f, t) ? [{ ok: 1 }] : [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
}
const sqls = (): string[] => mockClient.query.mock.calls.map((c) => String(c[0]));
const gravou = (): boolean => sqls().some((s) => /^UPDATE patients SET/.test(s.trim()));
const consultouItinerario = (): boolean => sqls().some((s) => /patient_itinerary_assignment/.test(s));

describe('D489/D530 — writer: troca manual com alocação viva', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['admin_panel', 'kanban'] as const)('%s + 2 alocações vivas → PATIENT_STATUS_LOCKED_BY_ALLOCATION com a contagem; nada é gravado', async (changeSource) => {
    banco('SEARCHING', 2);
    const err = await movePatientStatus(PID, 'ON_HOLD', { changeSource, onHoldReason: 'SCHOOL' }).catch((e) => e);
    expect(err).toBeInstanceOf(PatientStatusLockedByAllocationError);
    expect(err).toMatchObject({ code: 'PATIENT_STATUS_LOCKED_BY_ALLOCATION', allocations: 2 });
    expect(gravou()).toBe(false);
  });

  it('a consulta é a alocação ACTIVE e vigente pelo "hoje" do país no banco (inclui futura; sem CURRENT_DATE) — e é parametrizada', async () => {
    banco('SEARCHING', 1);
    await movePatientStatus(PID, 'ON_HOLD', { changeSource: 'admin_panel', onHoldReason: 'SCHOOL' }).catch(() => undefined);
    const call = mockClient.query.mock.calls.find((c) => /patient_itinerary_assignment/.test(String(c[0])))!;
    expect(String(call[0])).toMatch(/a\.status = 'ACTIVE'/);
    expect(String(call[0])).toMatch(/a\.valid_to IS NULL OR a\.valid_to >= fn_operation_date\(p\.country\)/);
    expect(String(call[0])).not.toMatch(/valid_from|CURRENT_DATE/);
    expect(call[1]).toEqual([PID]);
  });

  it('manual SEM alocação viva (itinerário montado sem prestador) → troca normal', async () => {
    banco('SEARCHING', 0);
    await expect(movePatientStatus(PID, 'ON_HOLD', { changeSource: 'admin_panel', onHoldReason: 'SCHOOL' })).resolves.toEqual({ id: PID, status: 'ON_HOLD' });
    expect(gravou()).toBe(true);
  });

  it('CONTROLE: a derivação (changeSource system) com alocação viva continua movendo — e nem consulta o itinerário', async () => {
    banco('SEARCHING', 3);
    await expect(movePatientStatus(PID, 'ACTIVE', { changeSource: 'system' })).resolves.toEqual({ id: PID, status: 'ACTIVE' });
    expect(gravou()).toBe(true);
    expect(consultouItinerario()).toBe(false);
  });

  it('manual reenviando o estado ATUAL com alocação viva não é troca: passa e nem consulta o itinerário', async () => {
    banco('SEARCHING', 3);
    await expect(movePatientStatus(PID, 'SEARCHING', { changeSource: 'admin_panel' })).resolves.toEqual({ id: PID, status: 'SEARCHING' });
    expect(consultouItinerario()).toBe(false);
  });
});

describe('D489/D530 — status-options: alocação viva bloqueia TODO destino', () => {
  beforeEach(() => jest.clearAllMocks());
  const lista = (vivas: number) => (banco('SEARCHING', vivas), loadStatusOptions(mockClient as unknown as PoolClient, PID, ['patient:update'], 'admin_panel'));

  it('com alocação viva: todo destino sai com blockedBy [ACTIVE_ALLOCATION] e a completude nem é lida', async () => {
    const r = await lista(1);
    expect(r.options.length).toBeGreaterThan(0);
    expect(r.options.every((o) => o.blockedBy?.length === 1 && o.blockedBy[0] === ACTIVE_ALLOCATION_BLOCK)).toBe(true);
    expect(sqls().some((s) => /services_without_schedule_count/.test(s))).toBe(false);
  });

  it('sem alocação viva: nenhum destino é marcado ACTIVE_ALLOCATION', async () => {
    const r = await lista(0);
    expect(r.options.length).toBeGreaterThan(0);
    expect(r.options.some((o) => o.blockedBy?.includes(ACTIVE_ALLOCATION_BLOCK))).toBe(false);
  });
});
