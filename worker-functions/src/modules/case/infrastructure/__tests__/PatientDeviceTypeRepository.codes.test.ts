/**
 * PatientDeviceTypeRepository.replaceCodesForPatient — o drawer clínico grava CÓDIGOS do catálogo
 * (spec 012, US-B4). Antes: texto livre em `patients.device_type`, que é FK desde a 308 → 23503.
 *   - código fora do catálogo ativo → DeviceTypeUnknownError (o controller devolve 422);
 *   - conjunto IGUAL ao persistido → nada é tocado (aceite: "re-salvar sem mudança não altera linhas");
 *   - conjunto diferente → DELETE + INSERT com source='admin_manual' (o escalar é o trigger da 310).
 */
const mockConnect = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: jest.fn() }) }) },
}));

import { PatientDeviceTypeRepository, DeviceTypeUnknownError } from '../PatientDeviceTypeRepository';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function cliente(existentes: string[]) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/FROM device_types/.test(sql) && /active/.test(sql)) return { rows: [{ code: 'HOME' }, { code: 'SCHOOL' }, { code: 'INPATIENT' }], rowCount: 3 };
    if (/FROM patient_device_types/.test(sql)) return { rows: existentes.map((device_type) => ({ device_type })), rowCount: existentes.length };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

describe('PatientDeviceTypeRepository.replaceCodesForPatient', () => {
  beforeEach(() => jest.clearAllMocks());

  it('HOME+SCHOOL num paciente sem dispositivo: DELETE + 2 INSERT com source=admin_manual', async () => {
    const { cli, chamadas } = cliente([]);
    const r = await new PatientDeviceTypeRepository().replaceCodesForPatient(PID, ['HOME', 'SCHOOL'], cli as never);
    expect(r).toEqual({ changed: true, codes: ['HOME', 'SCHOOL'] });
    const ins = chamadas.filter((c) => /^INSERT INTO patient_device_types/.test(c.sql));
    expect(ins.map((c) => c.params)).toEqual([[PID, 'HOME', 'admin_manual'], [PID, 'SCHOOL', 'admin_manual']]);
    expect(chamadas.some((c) => /^DELETE FROM patient_device_types/.test(c.sql))).toBe(true);
  });

  it('conjunto IGUAL (ordem diferente) → nenhuma escrita', async () => {
    const { cli, chamadas } = cliente(['SCHOOL', 'HOME']);
    const r = await new PatientDeviceTypeRepository().replaceCodesForPatient(PID, ['HOME', 'SCHOOL'], cli as never);
    expect(r).toEqual({ changed: false, codes: ['HOME', 'SCHOOL'] });
    expect(chamadas.some((c) => /^(DELETE|INSERT)/.test(c.sql))).toBe(false);
  });

  it('código fora do catálogo ativo → DeviceTypeUnknownError, sem escrever', async () => {
    const { cli, chamadas } = cliente([]);
    await expect(new PatientDeviceTypeRepository().replaceCodesForPatient(PID, ['HOME', 'CASA'], cli as never)).rejects.toBeInstanceOf(DeviceTypeUnknownError);
    expect(chamadas.some((c) => /^(DELETE|INSERT)/.test(c.sql))).toBe(false);
  });

  it('sem client injetado abre a própria transação (BEGIN/COMMIT), inclusive no caminho "igual"; erro → ROLLBACK e release', async () => {
    const { cli, chamadas } = cliente([]);
    mockConnect.mockResolvedValue(cli);
    await new PatientDeviceTypeRepository().replaceCodesForPatient(PID, ['HOME']);
    expect(chamadas[0].sql).toBe('BEGIN');
    expect(chamadas[chamadas.length - 1].sql).toBe('COMMIT');
    expect(cli.release).toHaveBeenCalled();
    const igual = cliente(['HOME']);
    mockConnect.mockResolvedValue(igual.cli);
    await expect(new PatientDeviceTypeRepository().replaceCodesForPatient(PID, ['HOME'])).resolves.toEqual({ changed: false, codes: ['HOME'] });
    expect(igual.chamadas[igual.chamadas.length - 1].sql).toBe('COMMIT');
    const erro = cliente([]);
    mockConnect.mockResolvedValue(erro.cli);
    await expect(new PatientDeviceTypeRepository().replaceCodesForPatient(PID, ['CASA'])).rejects.toBeInstanceOf(DeviceTypeUnknownError);
    expect(erro.chamadas[erro.chamadas.length - 1].sql).toBe('ROLLBACK');
    expect(erro.cli.release).toHaveBeenCalled();
  });

  it('findByPatientId lê o conjunto na ordem do catálogo; purgeForPatient apaga e conta (sem client → pool)', async () => {
    const poolQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ device_type: 'HOME' }, { device_type: 'SCHOOL' }] })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: undefined });
    (require('@shared/database/DatabaseConnection').DatabaseConnection.getInstance as jest.Mock).mockReturnValue({ getPool: () => ({ connect: mockConnect, query: poolQuery }) });
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const repo = new PatientDeviceTypeRepository();
      await expect(repo.findByPatientId(PID)).resolves.toEqual(['HOME', 'SCHOOL']);
      expect(String(poolQuery.mock.calls[0][0])).toMatch(/ORDER BY d.sort_order, d.code/);
      await expect(repo.purgeForPatient(PID)).resolves.toBe(2);
      await expect(repo.purgeForPatient(PID)).resolves.toBe(0);
      expect(JSON.stringify(info.mock.calls)).not.toMatch(/HOME|SCHOOL/);
    } finally { info.mockRestore(); }
  });

  it('sync (replaceForPatient) na própria transação: erro no INSERT → ROLLBACK, release e propaga', async () => {
    const chamadas: string[] = [];
    const cli = { query: jest.fn(async (sql: string) => {
      chamadas.push(sql);
      if (/device_type_aliases/.test(sql)) return { rows: [{ label: 'Domiciliario', code: 'HOME' }], rowCount: 1 };
      if (/^INSERT INTO patient_device_types/.test(sql)) throw new Error('23503');
      return { rows: [], rowCount: 0 };
    }), release: jest.fn() };
    mockConnect.mockResolvedValue(cli);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(new PatientDeviceTypeRepository().replaceForPatient({ patientId: PID, read: { readable: true, labels: ['Domiciliario'] } })).rejects.toThrow('23503');
    } finally { warn.mockRestore(); }
    expect(chamadas[chamadas.length - 1]).toBe('ROLLBACK');
    expect(cli.release).toHaveBeenCalled();
  });
});
