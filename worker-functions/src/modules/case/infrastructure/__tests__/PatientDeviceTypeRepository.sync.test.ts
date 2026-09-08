/**
 * PatientDeviceTypeRepository.replaceForPatient — o caminho do SYNC (ClickUp): sem client injetado a
 * transação é do `withActorContext` (LISTA spec 017: `pool.connect()` cru chegava sem `app.user_country`
 * e a policy de país recusava). Pool e KMS na fronteira; o efeito no Postgres real (RLS, isolamento por
 * origem) está em tests/e2e/patient-device-type-source-isolation.e2e.test.ts.
 */
const mockConnect = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: jest.fn() }) }) },
}));

import { PatientDeviceTypeRepository } from '../PatientDeviceTypeRepository';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function cliente() {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/FROM device_type_aliases/.test(sql)) return { rows: [{ label: 'Domicilio', code: 'HOME' }, { label: 'Escuela', code: 'SCHOOL' }], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

describe('PatientDeviceTypeRepository.replaceForPatient (sync)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { jest.clearAllMocks(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('origem ILEGÍVEL → nada gravado, nada apagado, sem abrir conexão (D167/F41)', async () => {
    const r = await new PatientDeviceTypeRepository().replaceForPatient({ patientId: PID, read: { readable: false, reason: 'field_missing' } as never });
    expect(r).toEqual({ outcome: 'skipped-unreadable', received: 0, accepted: [], rejected: [], quarantined: 0 });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('ILEGÍVEL');
  });

  it('sem client: transação própria (BEGIN…COMMIT, release) com lock por paciente; rótulo mapeado grava, desconhecido vai à quarentena, branco/duplicado é recusado — e o log só conta', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const r = await new PatientDeviceTypeRepository().replaceForPatient({
      patientId: PID,
      read: { readable: true, labels: ['Domicilio', 'Domicilio', '', 'Nuevo dispositivo X'] } as never,
    });
    expect(r).toEqual({ outcome: 'written', received: 4, accepted: ['HOME'], rejected: [{ reason: 'duplicate' }, { reason: 'blank' }, { reason: 'unmapped' }], quarantined: 1 });
    expect(chamadas[0].sql).toBe('BEGIN');
    expect(chamadas.at(-1)?.sql).toBe('COMMIT');
    expect(chamadas.some((c) => /pg_advisory_xact_lock/.test(c.sql) && String(c.params[0]) === `device_type:${PID}`)).toBe(true);
    expect(chamadas.find((c) => /^DELETE FROM patient_device_types/.test(c.sql))?.params).toEqual([PID, 'clickup']);
    expect(chamadas.filter((c) => /^INSERT INTO patient_device_types/.test(c.sql)).map((c) => c.params)).toEqual([[PID, 'HOME', 'clickup']]);
    const quarentena = chamadas.find((c) => /INSERT INTO patient_source_labels/.test(c.sql));
    expect(quarentena?.params).toEqual([PID, 1, 'Nuevo dispositivo X', 'clickup-quarentena']);
    expect(cli.release).toHaveBeenCalled();
    // C1: o log de recusa traz contagem por motivo, nunca o rótulo.
    const log = JSON.stringify(warn.mock.calls);
    expect(log).toContain('byReason');
    expect(log).not.toContain('Nuevo dispositivo X');
  });

  it('com client injetado roda NELE (sem BEGIN/COMMIT próprios, sem release) e respeita `source`', async () => {
    const { cli, chamadas } = cliente();
    const r = await new PatientDeviceTypeRepository().replaceForPatient(
      { patientId: PID, source: 'admin_manual', read: { readable: true, labels: ['Escuela'] } as never },
      cli as never,
    );
    expect(r.outcome).toBe('written');
    expect(chamadas.some((c) => c.sql === 'BEGIN' || c.sql === 'COMMIT')).toBe(false);
    expect(cli.release).not.toHaveBeenCalled();
    expect(chamadas.find((c) => /^DELETE FROM patient_device_types/.test(c.sql))?.params).toEqual([PID, 'admin_manual']);
    expect(warn).not.toHaveBeenCalled(); // nada recusado: nada logado
  });
});
