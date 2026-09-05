/**
 * PatientService.moveStatus v2 (spec 012, US-B7):
 *   1. transição clínica consulta `patient_status_transitions`; ausente → PatientStatusTransitionError
 *      (o controller mapeia para 422 com código de enum);
 *   2. ON_HOLD exige `onHoldReason` (OnHoldReasonRequiredError); ao sair de ON_HOLD, motivo e nota
 *      são LIMPOS (nenhuma segunda cópia — lex C7.1-e);
 *   3. `change_source` viaja por `set_config('app.change_source', …, true)` na MESMA transação —
 *      é o que o trigger da 254 grava em patient_status_history (a coluna "origem" do Historial);
 *   4. movimentos DENTRO do funil de admissão (Kanban) não passam pela tabela — continuam livres;
 *   5. `on_hold_note` NUNCA entra no log (C7.1-b): só from/to/reason.
 */
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown> = async () => ({ rows: [], rowCount: 0 });
const mockClient = {
  query: jest.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params)),
  release: jest.fn(),
};
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({})), getClient: jest.fn().mockResolvedValue(mockClient) })) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({ KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: jest.fn(), decrypt: jest.fn() })) }));
jest.mock('../../infrastructure/PatientIdentityRepository', () => ({ PatientIdentityRepository: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../infrastructure/PatientClinicalRepository', () => ({ PatientClinicalRepository: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../infrastructure/PatientResponsibleRepository', () => ({ PatientResponsibleRepository: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../../../infrastructure/services/GeocodingService', () => ({ GeocodingService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('firebase-functions', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import * as functions from 'firebase-functions';
import { PatientService } from '../PatientService';
import { PatientStatusTransitionError, OnHoldReasonRequiredError } from '../PatientStatusWriter';

const PID = '11111111-1111-4111-8111-111111111111';
const calls = (): Array<{ sql: string; params?: unknown[] }> =>
  mockClient.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));

/** Banco de mentira: status atual + quais transições existem. */
function db(current: string | null, allowed: Array<[string, string]>) {
  queryImpl = async (sql, params) => {
    if (/FROM patients/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: current === undefined ? [] : [{ status: current }], rowCount: 1 };
    if (/patient_status_transitions/.test(sql)) {
      const [from, to] = params as [string, string];
      return { rows: allowed.some(([f, t]) => f === from && t === to) ? [{ ok: 1 }] : [], rowCount: 0 };
    }
    if (/^UPDATE patients/.test(sql)) return { rows: [{ id: PID }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
}

describe('PatientService.moveStatus v2', () => {
  let service: PatientService;
  beforeEach(() => { jest.clearAllMocks(); service = new PatientService(); });

  it('1. ACTIVE → ON_HOLD com motivo: consulta a tabela, grava status + motivo + nota, set_config na transação, COMMIT', async () => {
    db('ACTIVE', [['ACTIVE', 'ON_HOLD']]);
    const r = await service.moveStatus(PID, 'ON_HOLD', { onHoldReason: 'INSURER', onHoldNote: 'obra social sin autorizar', changeSource: 'admin_panel' });
    expect(r).toEqual({ id: PID, status: 'ON_HOLD' });
    const c = calls();
    expect(c[0].sql).toBe('BEGIN');
    const setCfg = c.find((x) => /set_config\('app\.change_source'/.test(x.sql));
    expect(setCfg?.params).toEqual(['admin_panel']);
    const upd = c.find((x) => /^UPDATE patients/.test(x.sql));
    expect(upd?.sql).toMatch(/on_hold_reason/);
    expect(upd?.sql).toMatch(/on_hold_note/);
    expect(upd?.params).toEqual([PID, 'ON_HOLD', 'INSURER', 'obra social sin autorizar']);
    expect(c[c.length - 1].sql).toBe('COMMIT');
  });

  it('1b. transição AUSENTE da tabela → PatientStatusTransitionError com from/to, ROLLBACK, nenhum UPDATE', async () => {
    db('ACTIVE', [['ACTIVE', 'ON_HOLD']]);
    await expect(service.moveStatus(PID, 'SEARCHING', { changeSource: 'admin_panel' })).rejects.toMatchObject({
      name: 'PatientStatusTransitionError', code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED', from: 'ACTIVE', to: 'SEARCHING',
    });
    const c = calls();
    expect(c.some((x) => /^UPDATE patients/.test(x.sql))).toBe(false);
    expect(c[c.length - 1].sql).toBe('ROLLBACK');
  });

  it('2. ON_HOLD sem motivo → OnHoldReasonRequiredError antes de tocar o banco de escrita', async () => {
    db('ACTIVE', [['ACTIVE', 'ON_HOLD']]);
    await expect(service.moveStatus(PID, 'ON_HOLD', { changeSource: 'admin_panel' })).rejects.toBeInstanceOf(OnHoldReasonRequiredError);
    expect(calls().some((x) => /^UPDATE patients/.test(x.sql))).toBe(false);
  });

  it('2b. sair de ON_HOLD limpa motivo e nota (NULL explícito), mesmo que o chamador mande motivo', async () => {
    db('ON_HOLD', [['ON_HOLD', 'ACTIVE']]);
    await service.moveStatus(PID, 'ACTIVE', { onHoldReason: 'SCHOOL', onHoldNote: 'x', changeSource: 'admin_panel' });
    const upd = calls().find((x) => /^UPDATE patients/.test(x.sql));
    expect(upd?.params).toEqual([PID, 'ACTIVE', null, null]);
  });

  it('4. movimento DENTRO do funil (Kanban: SOLICITANTE → ADMISSION) não consulta a tabela e grava', async () => {
    db('SOLICITANTE', []);
    await service.moveStatus(PID, 'ADMISSION', { changeSource: 'kanban' });
    const c = calls();
    expect(c.some((x) => /patient_status_transitions/.test(x.sql))).toBe(false);
    expect(c.find((x) => /^UPDATE patients/.test(x.sql))?.params).toEqual([PID, 'ADMISSION', null, null]);
  });

  it('4b. saída do funil para ACTIVE (Kanban "Activo") passa pela tabela — o seed da 315 a permite', async () => {
    db('PENDING_ADMISSION', [['PENDING_ADMISSION', 'ACTIVE']]);
    await expect(service.moveStatus(PID, 'ACTIVE', { changeSource: 'kanban' })).resolves.toEqual({ id: PID, status: 'ACTIVE' });
    expect(calls().some((x) => /patient_status_transitions/.test(x.sql))).toBe(true);
  });

  it('paciente inexistente → "not found" (404 no controller); status inválido (DISCONTINUED) → erro antes do banco', async () => {
    db(undefined as unknown as string, []);
    await expect(service.moveStatus(PID, 'ACTIVE', { changeSource: 'admin_panel' })).rejects.toThrow(/not found/i);
    await expect(service.moveStatus(PID, 'DISCONTINUED' as never, { changeSource: 'admin_panel' })).rejects.toThrow(/Invalid patient status/);
  });

  it('5. o log da transição leva from/to/reason/source — NUNCA a nota', async () => {
    db('ACTIVE', [['ACTIVE', 'ON_HOLD']]);
    const NOTE = 'texto-clinico-que-nao-sai-9f1c';
    await service.moveStatus(PID, 'ON_HOLD', { onHoldReason: 'OTHER', onHoldNote: NOTE, changeSource: 'admin_panel' });
    const logged = JSON.stringify((functions.logger.info as jest.Mock).mock.calls);
    expect(logged).toContain('patient_status.moved');
    expect(logged).toContain('OTHER');
    expect(logged).not.toContain(NOTE);
  });

  it('ramos: ON_HOLD SEM a chave da nota não toca a coluna; `null` explícito APAGA; o erro a partir de status NULL diz "null"', async () => {
    // Chave ausente → `on_hold_note` fica FORA do SET (a nota clínica sobrevive a uma troca de motivo).
    db('ON_HOLD', [['ON_HOLD', 'ON_HOLD']]);
    await service.moveStatus(PID, 'ON_HOLD', { onHoldReason: 'SCHOOL', changeSource: 'admin_panel' });
    const semChave = calls().find((x) => /^UPDATE patients/.test(x.sql));
    expect(semChave?.sql).not.toMatch(/on_hold_note/);
    expect(semChave?.params).toEqual([PID, 'ON_HOLD', 'SCHOOL']);

    // `null` explícito continua sendo apagamento deliberado de quem PODE ler.
    jest.clearAllMocks();
    db('ON_HOLD', [['ON_HOLD', 'ON_HOLD']]);
    await service.moveStatus(PID, 'ON_HOLD', { onHoldReason: 'SCHOOL', onHoldNote: null, changeSource: 'admin_panel' });
    const comNull = calls().find((x) => /^UPDATE patients/.test(x.sql));
    expect(comNull?.sql).toMatch(/on_hold_note = \$4/);
    expect(comNull?.params).toEqual([PID, 'ON_HOLD', 'SCHOOL', null]);

    expect(new PatientStatusTransitionError(null, 'ACTIVE').message).toBe('Patient status transition not allowed: null → ACTIVE');
  });

  it('C5: DEMOÇÃO de estado clínico para o funil consulta a tabela e é RECUSADA (nada é gravado, nota intacta)', async () => {
    db('ACTIVE', [['ACTIVE', 'ON_HOLD']]); // o seed da 315 não tem ACTIVE → ADMISSION
    await expect(service.moveStatus(PID, 'ADMISSION', { changeSource: 'kanban' })).rejects.toMatchObject({
      name: 'PatientStatusTransitionError', code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED', from: 'ACTIVE', to: 'ADMISSION',
    });
    const c = calls();
    expect(c.some((x) => /patient_status_transitions/.test(x.sql))).toBe(true);
    expect(c.some((x) => /^UPDATE patients/.test(x.sql))).toBe(false);
    expect(c[c.length - 1].sql).toBe('ROLLBACK');
  });
});
