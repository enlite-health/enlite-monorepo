/**
 * Lista do admin sem baja (29/10/2026): `exclude_discharged` é OPT-IN e vale para list E stats.
 * Sem o parâmetro o SQL/params são os de hoje — Kanban (coluna DISCHARGED) e dashboard não mudam.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: jest.fn(), decrypt: jest.fn() })),
}));
jest.mock('../PatientDetailQueryHelper', () => ({ fetchPatientDetail: jest.fn() }));

import { PatientQueryRepository } from '../PatientQueryRepository';
import { excludeDischargedSql } from '../patientListScopeSql';
import { adminPatientsListSchema, type AdminPatientsListParams } from '../../interfaces/validators/adminPatientsListSchema';

const filters = (o: Partial<AdminPatientsListParams> = {}) => ({ limit: 20, offset: 0, ...o }) as AdminPatientsListParams;
const STATS_ROW = { total: '0', complete: '0', needs_attention: '0', created_today: '0', created_yesterday: '0', created_last_7_days: '0' };
const FRAGMENT = (idx: number) => excludeDischargedSql(idx);

describe('exclude_discharged — list', () => {
  beforeEach(() => { mockPoolQuery.mockReset(); mockPoolQuery.mockResolvedValue({ rows: [] }); });

  it('com exclude_discharged=true: param $12 = true e o SQL carrega o fragmento (total_count sai do mesmo WHERE)', async () => {
    await new PatientQueryRepository().list(filters({ exclude_discharged: 'true' }));
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(params[11]).toBe(true);
    expect(sql).toContain(FRAGMENT(12));
    expect(sql).toContain('COUNT(*) OVER()');
  });

  it('sem o parâmetro (Kanban/dashboard): $12 = false → o fragmento é no-op; "false" explícito idem', async () => {
    await new PatientQueryRepository().list(filters());
    await new PatientQueryRepository().list(filters({ exclude_discharged: 'false' }));
    expect(mockPoolQuery.mock.calls[0][1][11]).toBe(false);
    expect(mockPoolQuery.mock.calls[1][1][11]).toBe(false);
  });

  it('o fragmento só deixa passar quando o param é true: não-baja sempre entra, DISCHARGED só sem o param', () => {
    expect(FRAGMENT(12)).toBe("($12::boolean IS NOT TRUE OR p.status IS DISTINCT FROM 'DISCHARGED')");
  });

  it('o schema aceita true/false e rejeita outro valor (400)', () => {
    expect(adminPatientsListSchema.safeParse({ exclude_discharged: 'true' }).success).toBe(true);
    expect(adminPatientsListSchema.safeParse({ exclude_discharged: 'sim' }).success).toBe(false);
  });
});

describe('exclude_discharged — stats', () => {
  beforeEach(() => { mockPoolQuery.mockReset(); mockPoolQuery.mockResolvedValue({ rows: [STATS_ROW] }); });

  it('com excludeDischarged=true: $2 = true e o SQL usa o MESMO fragmento da lista', async () => {
    await new PatientQueryRepository().stats(['AR'], true);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(params).toEqual([['AR'], true]);
    expect(sql).toContain(FRAGMENT(2));
  });

  it('sem o parâmetro: $2 = false → resultado igual ao de hoje (default não muda)', async () => {
    await new PatientQueryRepository().stats(['AR']);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([['AR'], false]);
  });
});
