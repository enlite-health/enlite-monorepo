/**
 * InsuranceProviderRepository — o cadastro de obras sociais (migration 311 + 532; spec 012 US-B3, spec 058 §3.2 §W).
 *   listActive → ativos na ordem do catálogo, com `name`;
 *   create → `{ name, code?, sortOrder?, aliases? }` numa transação; sem `code` deriva do nome; sem `sort_order` = max+1 com retry na corrida;
 *   23505 despachado POR NOME de constraint (pkey, sort_order_unico, name_uq, tax_id_uq; contracts_name_uq no mesmo mapa);
 *   patch → ausente não toca, null limpa; listForService → {code,name} (sem payerKind) e mantém o `selected`.
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }) },
}));
const mockActorClientQuery = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn(async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ query: mockActorClientQuery })),
}));

import {
  InsuranceProviderRepository,
  InsuranceProviderExistsError,
  InsuranceProviderSortOrderTakenError,
  InsuranceProviderNameExistsError,
  InsuranceProviderTaxIdExistsError,
  InsuranceContractNameExistsError,
  mapUniqueViolation,
} from '../InsuranceProviderRepository';

function pgError(code: string, constraint?: string): Error {
  const e = new Error('pg') as Error & { code: string; constraint?: string };
  e.code = code;
  if (constraint !== undefined) e.constraint = constraint;
  return e;
}

/** Cliente de transação falso. `insertFailures` = erros que os INSERTs sucessivos do provedor levantam (um por tentativa). */
function cliente(opts: { insertFailures?: unknown[]; erroCru?: unknown; nomeExistente?: boolean } = {}) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const falhas = [...(opts.insertFailures ?? [])];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/lower\(btrim\(name\)\) = lower\(btrim\(\$1\)\)/.test(sql)) return opts.nomeExistente ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/SELECT COALESCE\(MAX\(sort_order\)/.test(sql)) return { rows: [{ next: 34 + (opts.insertFailures?.length ?? 0) - falhas.length }], rowCount: 1 };
    if (/^INSERT INTO insurance_providers/.test(sql)) {
      if (opts.erroCru !== undefined) throw opts.erroCru;
      if (falhas.length > 0) throw falhas.shift();
      return { rows: [{ code: params[0], name: params[1], active: true, sort_order: params[2] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

describe('InsuranceProviderRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockReset();
  });

  it('listActive: só ativos, ordenados por sort_order, code — e com `name`', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ code: 'API', name: 'API', sortOrder: 1 }, { code: 'OSDE', name: 'OSDE', sortOrder: 15 }] });
    const rows = await new InsuranceProviderRepository().listActive();
    expect(rows).toEqual([{ code: 'API', name: 'API', sortOrder: 1 }, { code: 'OSDE', name: 'OSDE', sortOrder: 15 }]);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/WHERE active/);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/ORDER BY sort_order, code/);
  });

  it('create: INSERT de código + nome + aliases, sort_order = max+1 quando ausente, COMMIT', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const r = await new InsuranceProviderRepository().create({ name: 'Nueva OS', code: 'NUEVA_OS', aliases: ['Nueva OS'] });
    expect(r).toEqual({ code: 'NUEVA_OS', name: 'Nueva OS', active: true, sortOrder: 34 });
    expect(chamadas[0].sql).toBe('BEGIN');
    const ins = chamadas.find((c) => /^INSERT INTO insurance_providers/.test(c.sql));
    expect(ins?.params).toEqual(['NUEVA_OS', 'Nueva OS', 34]);
    const alias = chamadas.find((c) => /^INSERT INTO insurance_provider_aliases/.test(c.sql));
    expect(alias?.params).toEqual(['clickup', 'Nueva OS', 'NUEVA_OS']);
    expect(chamadas[chamadas.length - 1].sql).toBe('COMMIT');
  });

  it('create sem `code`: o código é derivado do nome (deriveProviderCode)', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    const r = await new InsuranceProviderRepository().create({ name: 'Obra Social Nº 7' });
    expect(r.code).toBe('OBRA_SOCIAL_N_7');
    expect(chamadas.find((c) => /^INSERT INTO insurance_providers/.test(c.sql))?.params[0]).toBe('OBRA_SOCIAL_N_7');
  });

  it('create sem aliases: só o INSERT do código', async () => {
    const { cli, chamadas } = cliente();
    mockConnect.mockResolvedValue(cli);
    await new InsuranceProviderRepository().create({ name: 'Sem Alias', code: 'SEM_ALIAS', sortOrder: 40 });
    expect(chamadas.some((c) => /insurance_provider_aliases/.test(c.sql))).toBe(false);
    expect(chamadas.some((c) => /SELECT COALESCE\(MAX\(sort_order\)/.test(c.sql))).toBe(false);
  });

  // ── 23505 despachado por NOME de constraint ────────────────────────────────
  it('create: 23505 na pkey do código → InsuranceProviderExistsError (INSURANCE_PROVIDER_CODE_EXISTS) e ROLLBACK', async () => {
    const { cli, chamadas } = cliente({ insertFailures: [pgError('23505', 'insurance_providers_pkey')] });
    mockConnect.mockResolvedValue(cli);
    const err = await new InsuranceProviderRepository().create({ name: 'OSDE', code: 'OSDE', sortOrder: 15 }).catch((e) => e);
    expect(err).toBeInstanceOf(InsuranceProviderExistsError);
    expect(err.code).toBe('INSURANCE_PROVIDER_CODE_EXISTS');
    expect(err.httpStatus).toBe(409);
    expect(err.details).toEqual({ code: 'OSDE' });
    expect(chamadas[chamadas.length - 1].sql).toBe('ROLLBACK');
  });

  it('create: 23505 em sort_order_unico (posição explícita) → SortOrderTaken, nunca "código já existe"', async () => {
    const { cli } = cliente({ insertFailures: [pgError('23505', 'insurance_providers_sort_order_unico')] });
    mockConnect.mockResolvedValue(cli);
    const err = await new InsuranceProviderRepository().create({ name: 'Nova OS', code: 'NOVA_OS', sortOrder: 15 }).catch((e) => e);
    expect(err).toBeInstanceOf(InsuranceProviderSortOrderTakenError);
    expect(err).not.toBeInstanceOf(InsuranceProviderExistsError);
    expect(err.sortOrder).toBe(15);
    expect(err.code).toBe('INSURANCE_PROVIDER_SORT_ORDER_TAKEN');
    expect(err.message).not.toContain('NOVA_OS');
  });

  it('create: 23505 em name_uq → InsuranceProviderNameExistsError (409 INSURANCE_PROVIDER_NAME_EXISTS)', async () => {
    const { cli } = cliente({ insertFailures: [pgError('23505', 'insurance_providers_name_uq')] });
    mockConnect.mockResolvedValue(cli);
    const err = await new InsuranceProviderRepository().create({ name: 'osde ', code: 'OSDE_2', sortOrder: 99 }).catch((e) => e);
    expect(err).toBeInstanceOf(InsuranceProviderNameExistsError);
    expect(err.code).toBe('INSURANCE_PROVIDER_NAME_EXISTS');
    expect(err.httpStatus).toBe(409);
  });

  it('patch: 23505 em tax_id_uq → InsuranceProviderTaxIdExistsError, sem ecoar o CUIT', async () => {
    mockActorClientQuery.mockRejectedValueOnce(pgError('23505', 'insurance_providers_tax_id_uq'));
    const err = await new InsuranceProviderRepository().patch('OSDE', { taxId: '30-11111111-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(InsuranceProviderTaxIdExistsError);
    expect(err.code).toBe('INSURANCE_PROVIDER_TAX_ID_EXISTS');
    expect(JSON.stringify([err.message, err.details])).not.toContain('30-11111111-1');
  });

  it('mapUniqueViolation: contracts_name_uq → InsuranceContractNameExistsError; constraint desconhecida e outro código de erro → null (propaga cru)', () => {
    expect(mapUniqueViolation(pgError('23505', 'insurance_contracts_name_uq'))).toBeInstanceOf(InsuranceContractNameExistsError);
    expect(mapUniqueViolation(pgError('23505', 'alguma_outra_unique'))).toBeNull();
    expect(mapUniqueViolation(pgError('23505'))).toBeNull();
    expect(mapUniqueViolation(pgError('23P01', 'insurance_contract_terms_sem_sobreposicao'))).toBeNull();
    expect(mapUniqueViolation('rejeição crua')).toBeNull();
    expect(mapUniqueViolation(null)).toBeNull();
  });

  it('mapUniqueViolation: sem contexto, pkey e sort_order caem nos defaults (código vazio, posição 0) — nunca lançam', () => {
    expect(mapUniqueViolation(pgError('23505', 'insurance_providers_pkey'))).toBeInstanceOf(InsuranceProviderExistsError);
    expect(mapUniqueViolation(pgError('23505', 'insurance_providers_sort_order_unico'))).toBeInstanceOf(InsuranceProviderSortOrderTakenError);
  });

  it('list() sem opções lista só as ativas; get() de código inexistente → null', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await new InsuranceProviderRepository().list()).toEqual([]);
    expect(mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1][0]).toContain('WHERE active');
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await new InsuranceProviderRepository().get('NAO_EXISTE')).toBeNull();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ code: 'OSDE', name: 'OSDE', payer_kind: 'PREPAGA', active: true, legal_name: null, tax_id: null, address: null, management_chat_id: '120@g.us', sort_order: '15' }] });
    expect(await new InsuranceProviderRepository().get('OSDE')).toEqual({
      code: 'OSDE', name: 'OSDE', payerKind: 'PREPAGA', active: true, legalName: null, taxId: null, address: null, managementChatId: '120@g.us', sortOrder: 15,
    });
  });

  it('create: nome já existente (pré-checagem lower(btrim)) → NameExists, ANTES do INSERT — nunca CODE_EXISTS pelo código derivado', async () => {
    const { cli, chamadas } = cliente({ nomeExistente: true });
    mockConnect.mockResolvedValue(cli);
    const err = await new InsuranceProviderRepository().create({ name: '  osde  ' }).catch((e) => e);
    expect(err).toBeInstanceOf(InsuranceProviderNameExistsError);
    expect(err.code).toBe('INSURANCE_PROVIDER_NAME_EXISTS');
    expect(chamadas.some((c) => /^INSERT INTO insurance_providers/.test(c.sql))).toBe(false);
    expect(chamadas[chamadas.length - 1].sql).toBe('ROLLBACK');
  });

  it('create: unique desconhecida propaga o erro CRU (500 + alarme), nunca vira "já existe"', async () => {
    const crua = pgError('23505', 'unique_que_ninguem_mapeou');
    const { cli } = cliente({ insertFailures: [crua] });
    mockConnect.mockResolvedValue(cli);
    await expect(new InsuranceProviderRepository().create({ name: 'X Y', code: 'X_Y', sortOrder: 99 })).rejects.toBe(crua);
  });

  it('create: corrida do MAX+1 (posição derivada ocupada) refaz a transação com o número novo e dá certo', async () => {
    const { cli, chamadas } = cliente({ insertFailures: [pgError('23505', 'insurance_providers_sort_order_unico')] });
    mockConnect.mockResolvedValue(cli);
    const r = await new InsuranceProviderRepository().create({ name: 'Corrida', code: 'CORRIDA' });
    expect(r.sortOrder).toBe(35);
    expect(chamadas.filter((c) => c.sql === 'BEGIN')).toHaveLength(2);
    expect(chamadas.filter((c) => c.sql === 'ROLLBACK')).toHaveLength(1);
    expect(chamadas[chamadas.length - 1].sql).toBe('COMMIT');
  });

  it('create: a corrida do MAX+1 desiste na 3ª tentativa e devolve SortOrderTaken', async () => {
    const f = () => pgError('23505', 'insurance_providers_sort_order_unico');
    const { cli } = cliente({ insertFailures: [f(), f(), f()] });
    mockConnect.mockResolvedValue(cli);
    await expect(new InsuranceProviderRepository().create({ name: 'Corrida', code: 'CORRIDA' })).rejects.toBeInstanceOf(InsuranceProviderSortOrderTakenError);
    expect(cli.query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(3);
  });

  it('create: erro genérico do banco → propaga (não é 409), ROLLBACK', async () => {
    const { cli, chamadas } = cliente();
    (cli.query as jest.Mock).mockImplementationOnce(async () => ({ rows: [], rowCount: 0 })).mockImplementationOnce(async () => { throw new Error('boom'); });
    mockConnect.mockResolvedValue(cli);
    await expect(new InsuranceProviderRepository().create({ name: 'X', code: 'XX', sortOrder: 99 })).rejects.toThrow('boom');
    expect(chamadas[chamadas.length - 1].sql).toBe('ROLLBACK');
  });

  it('create: erro que NÃO é objeto (driver exótico) ou null propaga cru — nunca vira 409', async () => {
    mockConnect.mockResolvedValue(cliente({ erroCru: 'rejeição crua' }).cli);
    await expect(new InsuranceProviderRepository().create({ name: 'X', code: 'XX', sortOrder: 99 })).rejects.toBe('rejeição crua');
    mockConnect.mockResolvedValue(cliente({ erroCru: null }).cli);
    await expect(new InsuranceProviderRepository().create({ name: 'X', code: 'XX', sortOrder: 99 })).rejects.toBeNull();
  });

  // ── PATCH: ausente não toca, null limpa ────────────────────────────────────
  it('patch: só as chaves presentes viram SET; `null` limpa; `code` nem entra', async () => {
    mockActorClientQuery.mockResolvedValueOnce({
      rows: [{ code: 'OSDE', name: 'OSDE', payer_kind: 'PREPAGA', active: true, legal_name: null, tax_id: null, address: null, management_chat_id: null, sort_order: 15 }],
    });
    const r = await new InsuranceProviderRepository().patch('OSDE', { legalName: null, payerKind: 'PREPAGA' });
    const [sql, params] = mockActorClientQuery.mock.calls[0];
    expect(sql).toMatch(/SET legal_name = \$2, payer_kind = \$3 WHERE code = \$1/);
    expect(params).toEqual(['OSDE', null, 'PREPAGA']);
    expect(sql).not.toMatch(/\bname = /);
    expect(r?.payerKind).toBe('PREPAGA');
  });

  it('patch: sem nenhuma chave não escreve (devolve a leitura); código inexistente → null', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await new InsuranceProviderRepository().patch('NAO_EXISTE', {})).toBeNull();
    expect(mockActorClientQuery).not.toHaveBeenCalled();
    mockActorClientQuery.mockResolvedValueOnce({ rows: [] });
    expect(await new InsuranceProviderRepository().patch('NAO_EXISTE', { active: false })).toBeNull();
  });

  it('patch: P0001 do trigger (PAYER_KIND_CANNOT_UNSET) propaga cru para o mapa de erros', async () => {
    const e = Object.assign(new Error('PAYER_KIND_CANNOT_UNSET'), { code: 'P0001' });
    mockActorClientQuery.mockRejectedValueOnce(e);
    await expect(new InsuranceProviderRepository().patch('OSDE', { payerKind: null })).rejects.toBe(e);
  });

  // ── lista e cascata ────────────────────────────────────────────────────────
  it('list: busca por nome escapa % e _ e respeita includeInactive', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ code: 'OSDE', name: 'OSDE', payer_kind: null, active: true }] });
    const r = await new InsuranceProviderRepository().list({ search: '50%_x' });
    expect(r).toEqual([{ code: 'OSDE', name: 'OSDE', payerKind: null, active: true }]);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE active AND name ILIKE \$1/);
    expect(params).toEqual(['%50\\%\\_x%']);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await new InsuranceProviderRepository().list({ includeInactive: true });
    expect(mockPoolQuery.mock.calls[1][0]).not.toMatch(/WHERE/);
  });

  it('for-service sem payerKind: devolve só {code, name}, mesmo que a linha do banco traga mais', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'OSDE' }] })
      .mockResolvedValueOnce({ rows: [{ code: 'OSDE', name: 'OSDE', payer_kind: 'PREPAGA' }] });
    const r = await new InsuranceProviderRepository().listForService('AR', '2026-10-19');
    expect(r).toEqual([{ code: 'OSDE', name: 'OSDE' }]);
    expect(JSON.stringify(r)).not.toMatch(/payer/i);
    expect(mockPoolQuery.mock.calls[1][0]).not.toMatch(/payer_kind/);
  });

  it('for-service mantém o escolhido: o `selected` entra mesmo sem contrato oferecido (ou inativo)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ code: 'OSDE' }] }) // providersWithOfferedContract
      .mockResolvedValueOnce({ rows: [{ code: 'OSDE', name: 'OSDE' }, { code: 'GALENO', name: 'Galeno' }] });
    const r = await new InsuranceProviderRepository().listForService('AR', '2026-10-19', 'GALENO');
    expect(mockPoolQuery.mock.calls[1][1]).toEqual([['OSDE', 'GALENO']]);
    expect(r.map((x) => x.code)).toContain('GALENO');
  });

  it('for-service: nenhuma oferta e nenhum `selected` → [] sem a 2ª consulta', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await new InsuranceProviderRepository().listForService('BR', '2026-10-19')).toEqual([]);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});
