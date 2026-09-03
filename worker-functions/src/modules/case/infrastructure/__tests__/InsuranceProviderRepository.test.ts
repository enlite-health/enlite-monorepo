/**
 * InsuranceProviderRepository — o catálogo de coberturas (migration 311; spec 012, US-B3).
 *   listActive → códigos ativos na ordem do catálogo (o select do drawer);
 *   create → código novo + aliases opcionais numa transação; duplicado → InsuranceProviderExistsError;
 *   sort_order ausente → max+1 (a 311 não tem DEFAULT de propósito).
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }) },
}));

import { InsuranceProviderRepository, InsuranceProviderExistsError } from '../InsuranceProviderRepository';

function cliente(opts: { dup?: boolean } = {}) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/SELECT COALESCE\(MAX\(sort_order\)/.test(sql)) return { rows: [{ next: 34 }], rowCount: 1 };
    if (/^INSERT INTO insurance_providers/.test(sql)) {
      if (opts.dup) { const e = new Error('dup') as Error & { code: string }; e.code = '23505'; throw e; }
      return { rows: [{ code: params[0], active: true, sort_order: params[1] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

describe('InsuranceProviderRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  it('listActive: só ativos, ordenados por sort_order, code', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ code: 'API', sortOrder: 1 }, { code: 'OSDE', sortOrder: 15 }] });
    const rows = await new InsuranceProviderRepository().listActive();
    expect(rows).toEqual([{ code: 'API', sortOrder: 1 }, { code: 'OSDE', sortOrder: 15 }]);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/WHERE active/);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/ORDER BY sort_order, code/);
  });

  it('create: INSERT do código + aliases, sort_order = max+1 quando ausente, COMMIT', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const r = await new InsuranceProviderRepository().create({ code: 'NUEVA_OS', aliases: ['Nueva OS'] });
    expect(r).toEqual({ code: 'NUEVA_OS', active: true, sortOrder: 34 });
    expect(chamadas[0].sql).toBe('BEGIN');
    const ins = chamadas.find((c) => /^INSERT INTO insurance_providers/.test(c.sql));
    expect(ins?.params).toEqual(['NUEVA_OS', 34]);
    const alias = chamadas.find((c) => /^INSERT INTO insurance_provider_aliases/.test(c.sql));
    expect(alias?.params).toEqual(['clickup', 'Nueva OS', 'NUEVA_OS']);
    expect(chamadas[chamadas.length - 1].sql).toBe('COMMIT');
  });

  it('create: código duplicado → InsuranceProviderExistsError e ROLLBACK', async () => {
    const { cli, chamadas } = cliente({ dup: true });
    mockConnect.mockResolvedValue(cli);
    await expect(new InsuranceProviderRepository().create({ code: 'OSDE', sortOrder: 15 })).rejects.toBeInstanceOf(InsuranceProviderExistsError);
    expect(chamadas[chamadas.length - 1].sql).toBe('ROLLBACK');
  });

  it('create: erro genérico do banco → propaga (não é 409), ROLLBACK', async () => {
    const { cli } = cliente();
    (cli.query as jest.Mock).mockImplementationOnce(async () => ({ rows: [], rowCount: 0 })).mockImplementationOnce(async () => { throw new Error('boom'); });
    mockConnect.mockResolvedValue(cli);
    await expect(new InsuranceProviderRepository().create({ code: 'X', sortOrder: 99 })).rejects.toThrow('boom');
  });

  it('create sem aliases: só o INSERT do código', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    await new InsuranceProviderRepository().create({ code: 'SEM_ALIAS', sortOrder: 40 });
    expect(chamadas.some((c) => /insurance_provider_aliases/.test(c.sql))).toBe(false);
    expect(chamadas.some((c) => /SELECT COALESCE\(MAX\(sort_order\)/.test(c.sql))).toBe(false);
  });
});
