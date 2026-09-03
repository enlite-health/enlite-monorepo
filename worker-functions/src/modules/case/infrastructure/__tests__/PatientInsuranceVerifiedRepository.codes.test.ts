/**
 * PatientInsuranceVerifiedRepository — o CÓDIGO ao lado do cru (spec 012, US-B3; migration 312).
 *   1. sync (replaceForPatient): cada rótulo é traduzido pelo ConceptMap no momento da escrita —
 *      `provider_code` vai no INSERT (NULL quando não há alias); apaga SÓ as linhas da própria
 *      `source` (o painel não pode ser apagado pelo próximo webhook — lição do QA 🔴1 do bloco A);
 *   2. painel (replaceCodesForPatient): grava por CÓDIGO (source='admin_manual'), valida contra o
 *      catálogo (código fora → InsuranceProviderUnknownError), ordinal a partir de 1000 (não colide
 *      com o ordinal 1..N do sync), `ON CONFLICT (patient_id, raw_label) DO NOTHING` quando o
 *      ClickUp já trouxe a mesma cobertura;
 *   3. findCodesByPatientId: os códigos distintos, na ordem do catálogo.
 *   C1 do lex: nenhum rótulo/código em log — só contagem.
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }) },
}));

import { PatientInsuranceVerifiedRepository, InsuranceProviderUnknownError } from '../PatientInsuranceVerifiedRepository';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ALIASES = [{ label: 'Swiss Medical', code: 'SWISS_MEDICAL' }, { label: 'OSDE', code: 'OSDE' }];
const CATALOG = [{ code: 'OSDE' }, { code: 'SWISS_MEDICAL' }, { code: 'GALENO' }];

function cliente() {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/insurance_provider_aliases/.test(sql)) return { rows: ALIASES, rowCount: 2 };
    if (/FROM insurance_providers/.test(sql)) return { rows: CATALOG, rowCount: 3 };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

describe('PatientInsuranceVerifiedRepository — códigos', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { jest.clearAllMocks(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('1. sync: traduz por alias no INSERT (provider_code) e apaga só source=clickup', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientInsuranceVerifiedRepository();
    const r = await repo.replaceForPatient({ patientId: PID, read: { readable: true, labels: ['Swiss Medical', 'Rótulo Novo'] } });
    expect(r.outcome).toBe('written');
    expect(r.accepted).toEqual(['Swiss Medical', 'Rótulo Novo']);
    const del = chamadas.find((c) => /^DELETE FROM patient_insurance_verified/.test(c.sql));
    expect(del?.sql).toMatch(/source = \$2/);
    expect(del?.params).toEqual([PID, 'clickup']);
    const ins = chamadas.filter((c) => /^INSERT INTO patient_insurance_verified/.test(c.sql));
    expect(ins).toHaveLength(2);
    expect(ins[0].sql).toMatch(/provider_code/);
    expect(ins[0].params).toEqual([PID, 1, 'Swiss Medical', 'clickup', 'SWISS_MEDICAL']);
    expect(ins[1].params).toEqual([PID, 2, 'Rótulo Novo', 'clickup', null]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Rótulo Novo');
  });

  it('2. painel: grava por código com source=admin_manual, ordinal ≥ 1000, ON CONFLICT DO NOTHING; código fora do catálogo → erro', async () => {
    const { cli, chamadas } = cliente();
    const repo = new PatientInsuranceVerifiedRepository();
    await repo.replaceCodesForPatient(PID, ['SWISS_MEDICAL', 'OSDE'], cli as never);
    const del = chamadas.find((c) => /^DELETE FROM patient_insurance_verified/.test(c.sql));
    expect(del?.params).toEqual([PID, 'admin_manual']);
    const ins = chamadas.filter((c) => /^INSERT INTO patient_insurance_verified/.test(c.sql));
    expect(ins.map((c) => c.params)).toEqual([[PID, 1000, 'SWISS_MEDICAL', 'admin_manual', 'SWISS_MEDICAL'], [PID, 1001, 'OSDE', 'admin_manual', 'OSDE']]);
    expect(ins[0].sql).toMatch(/ON CONFLICT \(patient_id, raw_label\) DO NOTHING/);
    // sem transação própria quando o client é injetado
    expect(chamadas.some((c) => c.sql === 'BEGIN')).toBe(false);

    await expect(repo.replaceCodesForPatient(PID, ['NAO_EXISTE'], cli as never)).rejects.toBeInstanceOf(InsuranceProviderUnknownError);
  });

  it('2b. painel com lista vazia apaga as linhas admin_manual e não insere nada', async () => {
    const { cli, chamadas } = cliente();
    const repo = new PatientInsuranceVerifiedRepository();
    await repo.replaceCodesForPatient(PID, [], cli as never);
    expect(chamadas.some((c) => /^DELETE/.test(c.sql))).toBe(true);
    expect(chamadas.some((c) => /^INSERT/.test(c.sql))).toBe(false);
  });

  it('3. findCodesByPatientId devolve códigos distintos ordenados pelo catálogo', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ provider_code: 'OSDE' }, { provider_code: 'SWISS_MEDICAL' }] });
    const repo = new PatientInsuranceVerifiedRepository();
    await expect(repo.findCodesByPatientId(PID)).resolves.toEqual(['OSDE', 'SWISS_MEDICAL']);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/DISTINCT|GROUP BY/);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/sort_order/);
  });

  it('origem ILEGÍVEL (readable:false) não escreve nem apaga; rótulos em branco/duplicados são recusados com contagem, sem rótulo no log', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientInsuranceVerifiedRepository();
    const r0 = await repo.replaceForPatient({ patientId: PID, read: { readable: false, reason: 'field-missing' } });
    expect(r0).toEqual({ outcome: 'skipped-unreadable', received: 0, accepted: [], rejected: [] });
    expect(chamadas).toHaveLength(0);
    const r1 = await repo.replaceForPatient({ patientId: PID, read: { readable: true, labels: ['OSDE', '', 'OSDE', 42] } });
    expect(r1.accepted).toEqual(['OSDE']);
    expect(r1.rejected).toEqual([{ reason: 'blank' }, { reason: 'duplicate' }, { reason: 'blank' }]);
    expect(chamadas[0].sql).toBe('BEGIN');
    expect(chamadas[chamadas.length - 1].sql).toBe('COMMIT');
    expect(JSON.stringify(warn.mock.calls)).toMatch(/byReason/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('"OSDE"');
  });

  it('transação própria com erro → ROLLBACK (sync e painel); painel sem client abre BEGIN/COMMIT', async () => {
    const { cli, chamadas } = cliente();
    (cli.query as jest.Mock).mockImplementation(async (sql: string, params: unknown[] = []) => { chamadas.push({ sql, params }); if (/^DELETE/.test(sql)) throw new Error('boom'); if (/insurance_provider_aliases/.test(sql)) return { rows: ALIASES }; if (/FROM insurance_providers/.test(sql)) return { rows: CATALOG }; return { rows: [] }; });
    mockConnect.mockResolvedValue(cli);
    const repo = new PatientInsuranceVerifiedRepository();
    await expect(repo.replaceForPatient({ patientId: PID, read: { readable: true, labels: ['OSDE'] } })).rejects.toThrow('boom');
    expect(chamadas[chamadas.length - 1].sql).toBe('ROLLBACK');
    await expect(repo.replaceCodesForPatient(PID, ['OSDE'])).rejects.toThrow('boom');
    expect(chamadas[chamadas.length - 1].sql).toBe('ROLLBACK');
    const ok = cliente();
    mockConnect.mockResolvedValue(ok.cli);
    await repo.replaceCodesForPatient(PID, ['OSDE']);
    expect(ok.chamadas[0].sql).toBe('BEGIN');
    expect(ok.chamadas[ok.chamadas.length - 1].sql).toBe('COMMIT');
  });

  it('findByPatientId mapeia as linhas; purgeForPatient apaga e conta (rowCount ausente → 0)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ patient_id: PID, ordinal: 1, raw_label: 'OSDE', source: 'clickup' }] })
      .mockResolvedValueOnce({ rowCount: 3 }).mockResolvedValueOnce({});
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const repo = new PatientInsuranceVerifiedRepository();
      await expect(repo.findByPatientId(PID)).resolves.toEqual([{ patientId: PID, ordinal: 1, rawLabel: 'OSDE', source: 'clickup' }]);
      await expect(repo.purgeForPatient(PID)).resolves.toBe(3);
      await expect(repo.purgeForPatient(PID)).resolves.toBe(0);
    } finally { info.mockRestore(); }
  });
});
