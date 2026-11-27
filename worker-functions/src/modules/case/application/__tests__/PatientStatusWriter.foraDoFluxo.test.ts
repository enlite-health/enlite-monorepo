/**
 * Spec 051 (F2) + estado-automatico-do-paciente F5 — troca manual de estado FORA do fluxo: a permissão do DESTINO (só os 4 humanos),
 * a recusa dos 3 destinos derivados pela origem (`PATIENT_STATUS_NOT_MANUAL`), a integridade que continua valendo, o log `*_override`,
 * a derivação do sistema.
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
  PatientStatusNotManualError,
  PatientStatusPermissionError,
  PatientStatusTransitionError,
  PatientStatusNotReadyError,
  OnHoldReasonRequiredError,
  SuspensionExitReasonRequiredError,
  type MoveStatusOptions,
} from '../PatientStatusWriter';
import { CLINICAL_PATIENT_STATUSES, type ClinicalPatientStatus } from '../../domain/enums/PatientStatus';
import { CELULA_DO_DESTINO, isDestinoHumano, type DestinoHumano } from '../../domain/trocaForaDoFluxo';
import { patientStatusSchema } from '../../interfaces/validators/patientSectionSchemas';
import { naFsm, PARES_NA_FSM, PARES_FSM_36 } from './fixtures/fsmClinicaProd20261010';
import { writerSobreClient } from './fixtures/portsSobreClient';

const PID = '11111111-1111-4111-8111-111111111111';
const movePatientStatus = writerSobreClient(mockClient);

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
  c === 'com_celula' ? ['patient:update', ...(isDestinoHumano(para) ? [CELULA_DO_DESTINO[para]] : [])] : c === 'celulas_vazias' ? [] : null;

// ── T0 — a tabela de origem recusa o destino ANTES de tocar o banco (F5, design §4) ─────────────────
describe('T0 — PATIENT_STATUS_NOT_MANUAL: quem pode pedir cada destino vem da tabela de origem', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  const DERIVADOS: ClinicalPatientStatus[] = ['SEARCHING', 'REPLACEMENT', 'ACTIVE'];

  it.each(DERIVADOS)('admin_panel pede %s (mesmo com TODAS as células do ator) → NotManual, o banco nem é aberto', async (para) => {
    banco('ON_HOLD');
    const err = await movePatientStatus(PID, para, base({ cells: ['patient:update', ...Object.values(CELULA_DO_DESTINO)] })).catch((e) => e);
    expect(err).toBeInstanceOf(PatientStatusNotManualError);
    expect(err).toMatchObject({ code: 'PATIENT_STATUS_NOT_MANUAL', to: para, changeSource: 'admin_panel' });
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it.each(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION', ...CLINICAL_PATIENT_STATUSES] as const)(
    'kanban pede %s → NotManual (o arrasto saiu; a origem não pede nada)',
    async (para) => {
      banco('ADMISSION');
      await expect(movePatientStatus(PID, para, base({ changeSource: 'kanban' }))).rejects.toBeInstanceOf(PatientStatusNotManualError);
      expect(mockClient.query).not.toHaveBeenCalled();
    },
  );

  it.each([['system'], ['resume']] as const)('%s pede os 3 derivados sem NotManual (a FSM/completude decidem)', async (origem) => {
    for (const para of DERIVADOS) {
      jest.clearAllMocks(); banco('DISCHARGED');
      const err = await movePatientStatus(PID, para, { changeSource: origem, cells: null }).catch((e) => e);
      expect(err).not.toBeInstanceOf(PatientStatusNotManualError);
    }
  });

  it('o foguete (recruitment_activation) só pede SEARCHING; REPLACEMENT e ACTIVE → NotManual', async () => {
    banco('ADMISSION');
    await expect(movePatientStatus(PID, 'ACTIVE', { changeSource: 'recruitment_activation' })).rejects.toBeInstanceOf(PatientStatusNotManualError);
    await expect(movePatientStatus(PID, 'REPLACEMENT', { changeSource: 'recruitment_activation' })).rejects.toBeInstanceOf(PatientStatusNotManualError);
    await expect(movePatientStatus(PID, 'SEARCHING', { changeSource: 'recruitment_activation' })).resolves.toMatchObject({ id: PID, status: 'SEARCHING' });
  });
});

// ── T1 — a matriz A1, GERADA (7×7 − diagonal) × 3 colunas ───────────────────────────────────────
const CASOS = CLINICAL_PATIENT_STATUSES.flatMap((de) =>
  CLINICAL_PATIENT_STATUSES.filter((para) => para !== de).flatMap((para) =>
    (['com_celula', 'celulas_vazias', 'cells_null'] as Coluna[]).map((coluna) => ({ de, para, coluna, dentro: naFsm(de, para) })),
  ),
);

describe('T1 — matriz A1: 42 pares × {com a célula do destino, cells=[], cells=null} = 126 casos (admin_panel)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('a fixture derivada das migrations (36 linhas) tem as MESMAS 27 clínicas medidas em prd em 10/10/2026', () => {
    const medidas = [
      'ACTIVE>ALTA', 'ACTIVE>DISCHARGED', 'ACTIVE>ON_HOLD', 'ACTIVE>REPLACEMENT', 'ACTIVE>SUSPENDED', 'ALTA>DISCHARGED',
      'DISCHARGED>ACTIVE', 'DISCHARGED>ALTA', 'ON_HOLD>ACTIVE', 'ON_HOLD>ALTA', 'ON_HOLD>DISCHARGED', 'ON_HOLD>SEARCHING',
      'REPLACEMENT>ACTIVE', 'REPLACEMENT>ALTA', 'REPLACEMENT>DISCHARGED', 'REPLACEMENT>SEARCHING', 'REPLACEMENT>SUSPENDED',
      'SEARCHING>ACTIVE', 'SEARCHING>ALTA', 'SEARCHING>DISCHARGED', 'SEARCHING>ON_HOLD',
      'SUSPENDED>ACTIVE', 'SUSPENDED>ALTA', 'SUSPENDED>DISCHARGED', 'SUSPENDED>ON_HOLD', 'SUSPENDED>REPLACEMENT', 'SUSPENDED>SEARCHING',
    ];
    expect(PARES_FSM_36).toHaveLength(36);
    expect(PARES_NA_FSM.map(([d, p]) => `${d}>${p}`).sort()).toEqual([...medidas].sort());
  });

  it('a contagem declarada bate: 126 casos = 18 pares com destino derivado × 3 (NotManual) + 24 pares com destino humano × 3', () => {
    const derivados = CASOS.filter((c) => !isDestinoHumano(c.para)).length;
    const humanos = CASOS.filter((c) => isDestinoHumano(c.para)).length;
    expect(CASOS).toHaveLength(126);
    expect(PARES_NA_FSM).toHaveLength(27);
    expect(derivados).toBe(18 * 3);
    expect(humanos).toBe(24 * 3);
  });

  it.each(CASOS)('$de → $para [$coluna] (na FSM: $dentro)', async ({ de, para, coluna, dentro }) => {
    banco(de);
    const cells = celulasDa(coluna, para);
    const mover = () => movePatientStatus(PID, para, base({ cells }));

    if (!isDestinoHumano(para)) {
      // F5: SEARCHING/REPLACEMENT/ACTIVE não saem pelo painel — nas 3 colunas, na FSM ou fora dela.
      await expect(mover()).rejects.toBeInstanceOf(PatientStatusNotManualError);
      expect(mockClient.query).not.toHaveBeenCalled();
    } else if (dentro) {
      // Na FSM: passa da guarda nas 3 colunas e grava a origem normal.
      await expect(mover()).resolves.toMatchObject({ id: PID, status: para });
      expect(changeSourceGravado()).toBe('admin_panel');
    } else if (coluna === 'com_celula') {
      await expect(mover()).resolves.toMatchObject({ id: PID, status: para });
      expect(changeSourceGravado()).toBe('admin_panel_override');
    } else if (coluna === 'celulas_vazias') {
      await expect(mover()).rejects.toMatchObject({
        name: 'PatientStatusPermissionError', code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED', from: de, to: para, cell: CELULA_DO_DESTINO[para as DestinoHumano],
      });
      expect(escreveu()).toBe(false);
    } else {
      await expect(mover()).rejects.toBeInstanceOf(PatientStatusTransitionError);
      expect(escreveu()).toBe(false);
    }
  });

  it('controle positivo: ao menos 1 par humano fora da FSM com a célula é ACEITO e 1 sem a célula é 403', async () => {
    banco('ON_HOLD');
    expect(naFsm('ON_HOLD', 'SUSPENDED')).toBe(false);
    await expect(movePatientStatus(PID, 'SUSPENDED', base({ cells: ['patient:update', CELULA_DO_DESTINO.SUSPENDED] })))
      .resolves.toMatchObject({ id: PID, status: 'SUSPENDED' });
    jest.clearAllMocks(); banco('ON_HOLD');
    await expect(movePatientStatus(PID, 'SUSPENDED', base({ cells: ['patient:update'] }))).rejects.toBeInstanceOf(PatientStatusPermissionError);
  });

  it('a célula é a do DESTINO: a de outro destino não vale', async () => {
    banco('ON_HOLD');
    await expect(movePatientStatus(PID, 'SUSPENDED', base({ cells: [CELULA_DO_DESTINO.ALTA] }))).rejects.toBeInstanceOf(PatientStatusPermissionError);
  });

  it('cells ausente (undefined) = null = comportamento de hoje (422), nunca 403', async () => {
    banco('ON_HOLD');
    await expect(movePatientStatus(PID, 'SUSPENDED', base())).rejects.toBeInstanceOf(PatientStatusTransitionError);
  });
});

// ── T2 — integridade intacta, COM a célula do destino e par fora da FSM quando couber ────────────
describe('T2 — a integridade vale em toda troca, inclusive com a célula (spec §5, A4)', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  const com = (para: DestinoHumano) => ['patient:update', CELULA_DO_DESTINO[para]];

  it('(a) retomar (resume) para SEARCHING sem horário em serviço ativo → NotReady [SERVICE_SCHEDULE], nada gravado', async () => {
    banco('ON_HOLD', { services_without_schedule_count: '1' });
    await expect(movePatientStatus(PID, 'SEARCHING', { changeSource: 'resume', cells: null })).rejects.toMatchObject({ code: 'PATIENT_STATUS_NOT_READY', missing: ['SERVICE_SCHEDULE'] });
    expect(escreveu()).toBe(false);
  });

  it('(c) reativar (resume) DISCHARGED → ACTIVE sem endereço do paciente → NotReady [ADDRESS], nada gravado', async () => {
    banco('DISCHARGED', { active_address_count: '0' });
    expect(naFsm('DISCHARGED', 'ACTIVE')).toBe(true);
    await expect(movePatientStatus(PID, 'ACTIVE', { changeSource: 'resume', cells: null })).rejects.toMatchObject({ code: 'PATIENT_STATUS_NOT_READY', missing: ['ADDRESS'] });
    expect(escreveu()).toBe(false);
  });

  it('(c2) o destino derivado fora da FSM não tem célula que o destrave: resume ALTA → ACTIVE → 422 de transição', async () => {
    banco('ALTA');
    expect(naFsm('ALTA', 'ACTIVE')).toBe(false);
    await expect(movePatientStatus(PID, 'ACTIVE', { changeSource: 'resume', cells: ['patient:update', ...Object.values(CELULA_DO_DESTINO)] })).rejects.toBeInstanceOf(PatientStatusTransitionError);
    expect(escreveu()).toBe(false);
  });

  it('(d) ON_HOLD sem motivo (par fora do fluxo, com a célula) → OnHoldReasonRequiredError, nada gravado', async () => {
    banco('ALTA');
    await expect(movePatientStatus(PID, 'ON_HOLD', { changeSource: 'admin_panel', cells: com('ON_HOLD') })).rejects.toBeInstanceOf(OnHoldReasonRequiredError);
    expect(escreveu()).toBe(false);
  });

  it('(e) sair de SUSPENDED sem motivo → SuspensionExitReasonRequiredError, nada gravado', async () => {
    banco('SUSPENDED');
    await expect(movePatientStatus(PID, 'DISCHARGED', { changeSource: 'admin_panel', cells: com('DISCHARGED') })).rejects.toBeInstanceOf(SuspensionExitReasonRequiredError);
    expect(escreveu()).toBe(false);
  });

  it('(f) sair de ON_HOLD por fora do fluxo (ON_HOLD → SUSPENDED) zera motivo e nota', async () => {
    banco('ON_HOLD');
    expect(naFsm('ON_HOLD', 'SUSPENDED')).toBe(false);
    await movePatientStatus(PID, 'SUSPENDED', base({ cells: com('SUSPENDED'), onHoldReason: 'SCHOOL', onHoldNote: 'x' }));
    expect(update()?.[1]).toEqual([PID, 'SUSPENDED', null, null]);
    expect(changeSourceGravado()).toBe('admin_panel_override');
  });

  it('(h) paciente inexistente/deletado → not found, nada gravado', async () => {
    banco(null);
    await expect(movePatientStatus(PID, 'DISCHARGED', base({ cells: com('DISCHARGED') }))).rejects.toThrow(/Patient not found/);
    expect(escreveu()).toBe(false);
  });

  it('(i) destino fora do vocabulário → erro antes de tocar o banco', async () => {
    banco('ACTIVE');
    await expect(movePatientStatus(PID, 'DISCONTINUED' as never, base({ cells: ['patient:update'] }))).rejects.toThrow(/Invalid patient status/);
    expect(mockClient.query).not.toHaveBeenCalled();
  });
});

// ── T3 — log ────────────────────────────────────────────────────────────────────────────────────
describe('T3 — change_source: *_override só fora do fluxo, decidido pelo servidor (A5)', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  const loggado = () => (functions.logger.info as jest.Mock).mock.calls.find(([m]) => m === 'patient_status.moved')?.[1];

  it('fora do fluxo (ON_HOLD → SUSPENDED), origem admin_panel → grava admin_panel_override no set_config E no log patient_status.moved', async () => {
    banco('ON_HOLD');
    await movePatientStatus(PID, 'SUSPENDED', base({ cells: [CELULA_DO_DESTINO.SUSPENDED] }));
    expect(changeSourceGravado()).toBe('admin_panel_override');
    expect(loggado()).toMatchObject({ changeSource: 'admin_panel_override', from: 'ON_HOLD', to: 'SUSPENDED' });
  });

  it('dentro do fluxo, origem admin_panel → grava admin_panel (sem override)', async () => {
    banco('ACTIVE');
    await movePatientStatus(PID, 'ON_HOLD', base({ cells: [CELULA_DO_DESTINO.ON_HOLD] }));
    expect(changeSourceGravado()).toBe('admin_panel');
    expect(loggado()).toMatchObject({ changeSource: 'admin_panel' });
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

  it.each([[null], [[]], [['patient:update', CELULA_DO_DESTINO.ALTA]]] as Array<[readonly string[] | null]>)(
    'ACTIVE → SEARCHING com cells=%j → 422 de transição (a célula NÃO destrava o sistema), nada gravado',
    async (cells) => {
      banco('ACTIVE');
      await expect(movePatientStatus(PID, 'SEARCHING', { changeSource: 'system', cells })).rejects.toBeInstanceOf(PatientStatusTransitionError);
      expect(escreveu()).toBe(false);
    },
  );

  it('dentro da FSM, o sistema grava "system", nunca *_override', async () => {
    banco('ACTIVE');
    expect(naFsm('ACTIVE', 'REPLACEMENT')).toBe(true);
    await movePatientStatus(PID, 'REPLACEMENT', { changeSource: 'system', cells: [] });
    expect(changeSourceGravado()).toBe('system');
  });
});

// ── T5 — o fluxo normal de SEARCHING não mudou ──────────────────────────────────────────────────
describe('T5 — retomar (resume) para SEARCHING pelo par NA FSM cobra só o que cobra hoje', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  const resume = (o: Partial<MoveStatusOptions> = {}): MoveStatusOptions => ({ changeSource: 'resume', suspensionExitReason: 'OTHER', ...o });

  it('ON_HOLD → SEARCHING com paciente SEM serviço ativo passa, como hoje (e grava resume)', async () => {
    banco('ON_HOLD', { active_service_count: '0', services_without_address_count: '0' });
    expect(naFsm('ON_HOLD', 'SEARCHING')).toBe(true);
    await expect(movePatientStatus(PID, 'SEARCHING', resume())).resolves.toMatchObject({ id: PID, status: 'SEARCHING' });
    expect(changeSourceGravado()).toBe('resume');
  });

  it('ON_HOLD → SEARCHING com serviço sem endereço também passa (só o horário é cobrado no fluxo)', async () => {
    banco('ON_HOLD', { services_without_address_count: '1' });
    await expect(movePatientStatus(PID, 'SEARCHING', resume())).resolves.toBeDefined();
  });

  it('ON_HOLD → SEARCHING sem horário → NotReady só com SERVICE_SCHEDULE', async () => {
    banco('ON_HOLD', { services_without_schedule_count: '2', active_service_count: '0' });
    const err = await movePatientStatus(PID, 'SEARCHING', resume()).catch((e) => e);
    expect(err).toBeInstanceOf(PatientStatusNotReadyError);
    expect(err.missing).toEqual(['SERVICE_SCHEDULE']);
  });
});

describe('PatientStatusPermissionError', () => {
  it('carrega from/to/cell e a mensagem nomeia a origem mesmo quando ela é null', () => {
    const e = new PatientStatusPermissionError(null, 'SUSPENDED', CELULA_DO_DESTINO.SUSPENDED);
    expect(e).toMatchObject({ from: null, to: 'SUSPENDED', cell: CELULA_DO_DESTINO.SUSPENDED });
    expect(e.message).toContain('null → SUSPENDED');
  });
});
