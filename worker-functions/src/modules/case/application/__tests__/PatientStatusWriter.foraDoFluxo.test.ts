/**
 * Spec 051 (F2) — troca manual de estado FORA do fluxo: a permissão do DESTINO, a integridade que
 * continua valendo, o log `*_override`, a derivação do sistema.
 *
 * O writer roda de verdade; só o banco é de mentira: o estado atual e a FSM entram COMO DADO
 * (`fixtures/fsmClinicaProd20261010`, os 27 pares clínicos medidos em prd em 10/10/2026). O esperado
 * de cada caso da matriz é derivado da REGRA (par na FSM? ator com a célula?), nunca escrito caso a caso.
 */
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../patientTransaction', () => ({
  inPatientTransaction: (fn: (c: unknown) => Promise<unknown>) => fn(mockClient),
}));
jest.mock('firebase-functions', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import * as functions from 'firebase-functions';
import {
  movePatientStatus,
  PatientStatusPermissionError,
  PatientStatusTransitionError,
  PatientStatusNotReadyError,
  OnHoldReasonRequiredError,
  SuspensionExitReasonRequiredError,
  type MoveStatusOptions,
} from '../PatientStatusWriter';
import { CLINICAL_PATIENT_STATUSES, type ClinicalPatientStatus } from '../../domain/enums/PatientStatus';
import { CELULA_DO_DESTINO } from '../../domain/trocaForaDoFluxo';
import { patientStatusSchema } from '../../interfaces/validators/patientSectionSchemas';
import { naFsm, PARES_NA_FSM } from './fixtures/fsmClinicaProd20261010';

const PID = '11111111-1111-4111-8111-111111111111';

const FICHA_COMPLETA = {
  birth_date: '1980-01-01', has_consent: true, insurance_informed: 'OSDE',
  active_address_count: '1', active_responsible_count: '0', active_service_count: '1',
  services_without_address_count: '0', services_without_schedule_count: '0',
};

function banco(de: string | null, ficha: Partial<typeof FICHA_COMPLETA> = {}) {
  mockClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/services_without_schedule_count/.test(sql)) return { rows: [{ ...FICHA_COMPLETA, ...ficha }], rowCount: 1 };
    if (/FROM patients/.test(sql) && /FOR UPDATE/.test(sql)) return de === null ? { rows: [], rowCount: 0 } : { rows: [{ status: de }], rowCount: 1 };
    if (/patient_status_transitions/.test(sql)) {
      const [f, t] = params as [string, string];
      return { rows: naFsm(f, t) ? [{ ok: 1 }] : [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
}
const sqls = (): string[] => mockClient.query.mock.calls.map(([s]) => String(s));
const escreveu = (): boolean => sqls().some((s) => /^UPDATE patients/.test(s) || /set_config/.test(s));
const changeSourceGravado = (): unknown =>
  mockClient.query.mock.calls.find(([s]) => /set_config\('app\.change_source'/.test(String(s)))?.[1]?.[0];
const update = () => mockClient.query.mock.calls.find(([s]) => /^UPDATE patients/.test(String(s)));

/** Opções que satisfazem toda a integridade — a matriz mede a GUARDA, não a integridade. */
const base = (o: Partial<MoveStatusOptions> = {}): MoveStatusOptions => ({
  changeSource: 'admin_panel', onHoldReason: 'SCHOOL', suspensionExitReason: 'OTHER', ...o,
});

type Coluna = 'com_celula' | 'celulas_vazias' | 'cells_null';
const celulasDa = (c: Coluna, para: ClinicalPatientStatus): readonly string[] | null =>
  c === 'com_celula' ? ['patient:update', CELULA_DO_DESTINO[para]] : c === 'celulas_vazias' ? [] : null;

// ── T1 — a matriz A1, GERADA (7×7 − diagonal) × 3 colunas ───────────────────────────────────────
const CASOS = CLINICAL_PATIENT_STATUSES.flatMap((de) =>
  CLINICAL_PATIENT_STATUSES.filter((para) => para !== de).flatMap((para) =>
    (['com_celula', 'celulas_vazias', 'cells_null'] as Coluna[]).map((coluna) => ({ de, para, coluna, dentro: naFsm(de, para) })),
  ),
);

describe('T1 — matriz A1: 42 pares × {com a célula do destino, cells=[], cells=null} = 126 casos', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('a contagem declarada bate com a FSM: 126 casos = 27 dentro × 3 + 15 fora × 3', () => {
    const dentro = CASOS.filter((c) => c.dentro).length;
    const fora = CASOS.filter((c) => !c.dentro).length;
    // eslint-disable-next-line no-console
    console.log(`matriz A1: total=${CASOS.length} dentro=${dentro} (${PARES_NA_FSM.length} pares × 3) fora=${fora} (${fora / 3} pares × 3)`);
    expect(CASOS).toHaveLength(126);
    expect(PARES_NA_FSM).toHaveLength(27);
    expect(dentro).toBe(27 * 3);
    expect(fora).toBe(15 * 3);
  });

  it.each(CASOS)('$de → $para [$coluna] (na FSM: $dentro)', async ({ de, para, coluna, dentro }) => {
    banco(de);
    const cells = celulasDa(coluna, para);
    const mover = () => movePatientStatus(PID, para, base({ cells }));

    if (dentro) {
      // Na FSM: passa da guarda nas 3 colunas e grava a origem normal.
      await expect(mover()).resolves.toEqual({ id: PID, status: para });
      expect(changeSourceGravado()).toBe('admin_panel');
    } else if (coluna === 'com_celula') {
      await expect(mover()).resolves.toEqual({ id: PID, status: para });
      expect(changeSourceGravado()).toBe('admin_panel_override');
    } else if (coluna === 'celulas_vazias') {
      await expect(mover()).rejects.toMatchObject({
        name: 'PatientStatusPermissionError', code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED', from: de, to: para, cell: CELULA_DO_DESTINO[para],
      });
      expect(escreveu()).toBe(false);
    } else {
      await expect(mover()).rejects.toBeInstanceOf(PatientStatusTransitionError);
      expect(escreveu()).toBe(false);
    }
  });

  it('controle positivo: ao menos 1 par fora da FSM com a célula é ACEITO e 1 sem a célula é 403', async () => {
    banco('ACTIVE');
    expect(naFsm('ACTIVE', 'SEARCHING')).toBe(false);
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: ['patient:update', 'patient_status:move_to_searching'] })))
      .resolves.toEqual({ id: PID, status: 'SEARCHING' });
    jest.clearAllMocks(); banco('ACTIVE');
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: ['patient:update'] }))).rejects.toBeInstanceOf(PatientStatusPermissionError);
  });

  it('a célula é a do DESTINO: a de outro destino não vale', async () => {
    banco('ACTIVE');
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: [CELULA_DO_DESTINO.ALTA] }))).rejects.toBeInstanceOf(PatientStatusPermissionError);
  });

  it('cells ausente (undefined) = null = comportamento de hoje (422), nunca 403', async () => {
    banco('ACTIVE');
    await expect(movePatientStatus(PID, 'SEARCHING', base())).rejects.toBeInstanceOf(PatientStatusTransitionError);
  });
});

// ── T2 — integridade intacta, COM a célula do destino e par fora da FSM quando couber ────────────
describe('T2 — a integridade vale em toda troca, inclusive com a célula (spec §5, A4)', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  const com = (para: ClinicalPatientStatus) => ['patient:update', CELULA_DO_DESTINO[para]];

  it('(a) SEARCHING sem horário em serviço ativo → NotReady [SERVICE_SCHEDULE], nada gravado', async () => {
    banco('ACTIVE', { services_without_schedule_count: '1' });
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: com('SEARCHING') }))).rejects.toMatchObject({ code: 'PATIENT_STATUS_NOT_READY', missing: ['SERVICE_SCHEDULE'] });
    expect(escreveu()).toBe(false);
  });

  it('(b1) SEARCHING fora do fluxo sem NENHUM serviço ativo → NotReady com CONTRACTED_SERVICE, nada gravado', async () => {
    banco('ACTIVE', { active_service_count: '0' });
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: com('SEARCHING') }))).rejects.toMatchObject({ missing: expect.arrayContaining(['CONTRACTED_SERVICE']) });
    expect(escreveu()).toBe(false);
  });

  it('(b2) SEARCHING fora do fluxo com serviço sem endereço → NotReady [SERVICE_ADDRESS], nada gravado', async () => {
    banco('DISCHARGED', { services_without_address_count: '1' });
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: com('SEARCHING') }))).rejects.toMatchObject({ missing: ['SERVICE_ADDRESS'] });
    expect(escreveu()).toBe(false);
  });

  it('(c) ALTA → ACTIVE (fora do fluxo) sem endereço do paciente → NotReady [ADDRESS], nada gravado', async () => {
    banco('ALTA', { active_address_count: '0' });
    expect(naFsm('ALTA', 'ACTIVE')).toBe(false);
    await expect(movePatientStatus(PID, 'ACTIVE', base({ cells: com('ACTIVE') }))).rejects.toMatchObject({ code: 'PATIENT_STATUS_NOT_READY', missing: ['ADDRESS'] });
    expect(escreveu()).toBe(false);
  });

  it('(d) ON_HOLD sem motivo (par fora do fluxo, com a célula) → OnHoldReasonRequiredError, nada gravado', async () => {
    banco('ALTA');
    await expect(movePatientStatus(PID, 'ON_HOLD', { changeSource: 'admin_panel', cells: com('ON_HOLD') })).rejects.toBeInstanceOf(OnHoldReasonRequiredError);
    expect(escreveu()).toBe(false);
  });

  it('(e) sair de SUSPENDED sem motivo (com a célula do destino) → SuspensionExitReasonRequiredError, nada gravado', async () => {
    banco('SUSPENDED');
    await expect(movePatientStatus(PID, 'SEARCHING', { changeSource: 'admin_panel', cells: com('SEARCHING') })).rejects.toBeInstanceOf(SuspensionExitReasonRequiredError);
    expect(escreveu()).toBe(false);
  });

  it('(f) sair de ON_HOLD por fora do fluxo (ON_HOLD → REPLACEMENT) zera motivo e nota', async () => {
    banco('ON_HOLD');
    expect(naFsm('ON_HOLD', 'REPLACEMENT')).toBe(false);
    await movePatientStatus(PID, 'REPLACEMENT', base({ cells: com('REPLACEMENT'), onHoldReason: 'SCHOOL', onHoldNote: 'x' }));
    expect(update()?.[1]).toEqual([PID, 'REPLACEMENT', null, null]);
    expect(changeSourceGravado()).toBe('admin_panel_override');
  });

  it('(h) paciente inexistente/deletado → not found, nada gravado', async () => {
    banco(null);
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: com('SEARCHING') }))).rejects.toThrow(/Patient not found/);
    expect(escreveu()).toBe(false);
  });

  it('(i) destino fora do vocabulário → erro antes de tocar o banco', async () => {
    banco('ACTIVE');
    await expect(movePatientStatus(PID, 'DISCONTINUED' as never, base({ cells: ['patient:update'] }))).rejects.toThrow(/Invalid patient status/);
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('a completude cobra DEPOIS da guarda: sem a célula é 403 mesmo com a ficha incompleta', async () => {
    banco('ACTIVE', { services_without_schedule_count: '1' });
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: [] }))).rejects.toBeInstanceOf(PatientStatusPermissionError);
  });
});

// ── T3 — log ────────────────────────────────────────────────────────────────────────────────────
describe('T3 — change_source: *_override só fora do fluxo, decidido pelo servidor (A5)', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  const loggado = () => (functions.logger.info as jest.Mock).mock.calls.find(([m]) => m === 'patient_status.moved')?.[1];

  it.each([
    ['admin_panel', 'admin_panel_override'],
    ['kanban', 'kanban_override'],
  ] as const)('fora do fluxo, origem %s → grava %s no set_config E no log patient_status.moved', async (origem, esperado) => {
    banco('ACTIVE');
    await movePatientStatus(PID, 'SEARCHING', base({ changeSource: origem, cells: [CELULA_DO_DESTINO.SEARCHING] }));
    expect(changeSourceGravado()).toBe(esperado);
    expect(loggado()).toMatchObject({ changeSource: esperado, from: 'ACTIVE', to: 'SEARCHING' });
  });

  it.each(['admin_panel', 'kanban'] as const)('dentro do fluxo, origem %s → grava %s (sem override)', async (origem) => {
    banco('ACTIVE');
    await movePatientStatus(PID, 'ON_HOLD', base({ changeSource: origem, cells: [CELULA_DO_DESTINO.ON_HOLD] }));
    expect(changeSourceGravado()).toBe(origem);
    expect(loggado()).toMatchObject({ changeSource: origem });
  });

  it('o corpo da rota NÃO aceita *_override (zod) — o cliente não se declara override', () => {
    expect(patientStatusSchema.safeParse({ status: 'SEARCHING', changeSource: 'admin_panel_override' }).success).toBe(false);
    expect(patientStatusSchema.safeParse({ status: 'SEARCHING', changeSource: 'kanban_override' }).success).toBe(false);
    expect(patientStatusSchema.safeParse({ status: 'SEARCHING', changeSource: 'kanban' }).success).toBe(true);
  });
});

// ── T4 — o sistema (A10) ────────────────────────────────────────────────────────────────────────
describe('T4 — changeSource=system fora da FSM: não exige célula, não grava override, falha como hoje (A10)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it.each([[null], [[]], [['patient:update', 'patient_status:move_to_searching']]] as Array<[readonly string[] | null]>)(
    'ACTIVE → SEARCHING com cells=%j → 422 de transição (a célula NÃO destrava o sistema), nada gravado',
    async (cells) => {
      banco('ACTIVE');
      await expect(movePatientStatus(PID, 'SEARCHING', { changeSource: 'system', cells })).rejects.toBeInstanceOf(PatientStatusTransitionError);
      expect(escreveu()).toBe(false);
    },
  );

  it('dentro da FSM, o sistema grava "system", nunca *_override', async () => {
    banco('ACTIVE');
    await movePatientStatus(PID, 'ON_HOLD', { changeSource: 'system', onHoldReason: 'SCHOOL', cells: [] });
    expect(changeSourceGravado()).toBe('system');
  });
});

// ── T5 — o fluxo normal de SEARCHING não mudou ──────────────────────────────────────────────────
describe('T5 — par NA FSM para SEARCHING continua cobrando só o que cobra hoje', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('ON_HOLD → SEARCHING com paciente SEM serviço ativo passa, como hoje (e grava admin_panel)', async () => {
    banco('ON_HOLD', { active_service_count: '0', services_without_address_count: '0' });
    expect(naFsm('ON_HOLD', 'SEARCHING')).toBe(true);
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: [] }))).resolves.toEqual({ id: PID, status: 'SEARCHING' });
    expect(changeSourceGravado()).toBe('admin_panel');
  });

  it('ON_HOLD → SEARCHING com serviço sem endereço também passa (só o horário é cobrado no fluxo)', async () => {
    banco('ON_HOLD', { services_without_address_count: '1' });
    await expect(movePatientStatus(PID, 'SEARCHING', base({ cells: null }))).resolves.toBeDefined();
  });

  it('ON_HOLD → SEARCHING sem horário → NotReady só com SERVICE_SCHEDULE', async () => {
    banco('ON_HOLD', { services_without_schedule_count: '2', active_service_count: '0' });
    const err = await movePatientStatus(PID, 'SEARCHING', base()).catch((e) => e);
    expect(err).toBeInstanceOf(PatientStatusNotReadyError);
    expect(err.missing).toEqual(['SERVICE_SCHEDULE']);
  });
});

describe('PatientStatusPermissionError', () => {
  it('carrega from/to/cell e a mensagem nomeia a origem mesmo quando ela é null', () => {
    const e = new PatientStatusPermissionError(null, 'SEARCHING', 'patient_status:move_to_searching');
    expect(e).toMatchObject({ from: null, to: 'SEARCHING', cell: 'patient_status:move_to_searching' });
    expect(e.message).toContain('null → SEARCHING');
  });
});
