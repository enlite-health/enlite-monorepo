import { resolveCountryScope, CountryScopeError } from '../resolveCountryScope';

function mockDb(effectiveCountries: string[], documented = false): { query: jest.Mock } {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('iam.effective_countries')) {
      return Promise.resolve({ rows: [{ countries: effectiveCountries }] });
    }
    if (sql.includes('documented')) {
      return Promise.resolve({ rows: [{ documented }] });
    }
    throw new Error(`SQL inesperado no mock: ${sql}`);
  });
  return { query };
}

describe('resolveCountryScope', () => {
  it('país específico dentro do escopo do ator → scope = [country]', async () => {
    const db = mockDb(['AR']);
    const result = await resolveCountryScope(db as never, 'u1', 'AR');
    expect(result).toEqual({ countries: ['AR'], requested: 'AR' });
  });

  it('país específico FORA do escopo do ator → 403 COUNTRY_SCOPE_REQUIRED (FR-731)', async () => {
    const db = mockDb(['AR']);
    await expect(resolveCountryScope(db as never, 'u1', 'BR')).rejects.toMatchObject({
      status: 403,
      code: 'COUNTRY_SCOPE_REQUIRED',
    });
  });

  it('country inválido (fora de AR|BR|ALL) → 400 INVALID_COUNTRY, nunca 403', async () => {
    const db = mockDb(['AR']);
    await expect(resolveCountryScope(db as never, 'u1', 'US')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_COUNTRY',
    });
    expect(db.query).not.toHaveBeenCalled(); // 400 de forma não consulta o banco
  });

  it('ausente e string vazia normalizam para ALL, igual a "ALL" explícito', async () => {
    const db = mockDb(['AR']);
    expect(await resolveCountryScope(db as never, 'u1', undefined)).toEqual({
      countries: ['AR'],
      requested: 'ALL',
    });
    expect(await resolveCountryScope(db as never, 'u1', '')).toEqual({
      countries: ['AR'],
      requested: 'ALL',
    });
    expect(await resolveCountryScope(db as never, 'u1', 'ALL')).toEqual({
      countries: ['AR'],
      requested: 'ALL',
    });
  });

  it('ALL com 1 só país do ator → união trivial, sem exigir grant documentado', async () => {
    const db = mockDb(['BR']);
    const result = await resolveCountryScope(db as never, 'u1', 'ALL');
    expect(result).toEqual({ countries: ['BR'], requested: 'ALL' });
  });

  it('ALL com 2 países do ator E grant documentado → união dos dois (L9-5)', async () => {
    const db = mockDb(['AR', 'BR'], true);
    const result = await resolveCountryScope(db as never, 'u1', 'ALL');
    expect(result.countries.sort()).toEqual(['AR', 'BR']);
    expect(result.requested).toBe('ALL');
  });

  it('ALL com 2 países SEM grant documentado (granted_by/reason) → 403 (D113, L9-5)', async () => {
    const db = mockDb(['AR', 'BR'], false);
    await expect(resolveCountryScope(db as never, 'u1', 'ALL')).rejects.toMatchObject({
      status: 403,
      code: 'COUNTRY_SCOPE_REQUIRED',
    });
  });

  it('ator sem NENHUM país concedido → 403, mesmo pedindo um país específico', async () => {
    const db = mockDb([]);
    await expect(resolveCountryScope(db as never, 'u1', 'AR')).rejects.toMatchObject({
      status: 403,
      code: 'COUNTRY_SCOPE_REQUIRED',
    });
  });

  it('sem uid → 403 sem consultar o banco (não há a quem perguntar)', async () => {
    const db = mockDb(['AR']);
    await expect(resolveCountryScope(db as never, undefined, 'AR')).rejects.toMatchObject({
      status: 403,
      code: 'COUNTRY_SCOPE_REQUIRED',
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('consulta a MESMA fonte da RLS/guard: iam.effective_countries, nunca uma segunda escrita do predicado', async () => {
    const db = mockDb(['AR']);
    await resolveCountryScope(db as never, 'u1', 'AR');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('iam.effective_countries'), ['u1']);
  });

  it('resposta SEM linha nenhuma de iam.effective_countries (rows=[]) é tratada como zero países (fail-closed)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    await expect(resolveCountryScope({ query } as never, 'u1', 'AR')).rejects.toMatchObject({
      status: 403,
      code: 'COUNTRY_SCOPE_REQUIRED',
    });
  });

  it('erro é instância de CountryScopeError (o controller decide o status a partir dele)', async () => {
    const db = mockDb([]);
    await expect(resolveCountryScope(db as never, 'u1', 'AR')).rejects.toBeInstanceOf(CountryScopeError);
  });
});
