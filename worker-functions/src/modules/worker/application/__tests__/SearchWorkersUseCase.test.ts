import { SearchWorkersUseCase } from '../SearchWorkersUseCase';

const ROW = {
  id: 'w-1',
  email: 'ana@test.com',
  phone: '5491100000000',
  first_name_encrypted: 'enc-first',
  last_name_encrypted: 'enc-last',
  created_at: '2026-07-01T00:00:00Z',
  status: 'REGISTERED',
  documents_status: 'submitted',
};

function makeDeps() {
  const query = jest.fn();
  const encryption = {
    decrypt: jest.fn().mockImplementation((v: string | null) => {
      if (v === 'enc-first') return Promise.resolve('Ana');
      if (v === 'enc-last') return Promise.resolve('García');
      return Promise.resolve(null);
    }),
  };
  const blindIndex = {
    generateSearchTrigramBidx: jest.fn().mockResolvedValue([Buffer.from('x')]),
    serializeForPg: jest.fn().mockReturnValue('{"\\\\x78"}'),
  };
  const useCase = new SearchWorkersUseCase(
    { query } as never,
    encryption as never,
    blindIndex as never,
  );
  return { useCase, query, encryption, blindIndex };
}

describe('SearchWorkersUseCase', () => {
  it('listagem sem filtros: pagina via SQL e decripta nomes', async () => {
    const { useCase, query } = makeDeps();
    query
      .mockResolvedValueOnce({ rows: [{ total: '42' }] }) // count
      .mockResolvedValueOnce({ rows: [ROW] }); // page

    const result = await useCase.execute({ limit: 20, offset: 0 });

    expect(result.total).toBe(42);
    expect(result.workers).toEqual([
      expect.objectContaining({ id: 'w-1', name: 'Ana García', status: 'REGISTERED' }),
    ]);
    // count + page, sem query de candidatos
    expect(query).toHaveBeenCalledTimes(2);
    const pageSql = (query.mock.calls[1] as [string, unknown[]])[0];
    expect(pageSql).toContain('LIMIT');
    expect(pageSql).toContain('OFFSET');
  });

  it('filtro por status entra no WHERE parametrizado', async () => {
    const { useCase, query } = makeDeps();
    query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [ROW] });

    await useCase.execute({ status: 'REGISTERED', limit: 10, offset: 0 });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('w.status = $');
    expect(params).toContain('REGISTERED');
  });

  it('busca por nome: usa trigram bidx, filtra pós-decrypt e pagina em memória', async () => {
    const { useCase, query, blindIndex } = makeDeps();
    const otherRow = { ...ROW, id: 'w-2', email: 'outro@test.com', first_name_encrypted: null, last_name_encrypted: null };
    query.mockResolvedValueOnce({ rows: [ROW, otherRow] }); // candidatos

    const result = await useCase.execute({ search: 'ana gar', limit: 10, offset: 0 });

    expect(blindIndex.generateSearchTrigramBidx).toHaveBeenCalledWith('ana gar');
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('name_trgm_bidx @>');
    // só a Ana casa com "ana gar" pós-decrypt
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0].name).toBe('Ana García');
    expect(result.total).toBe(1);
  });

  it('busca por email usa ILIKE em w.email (sem bidx)', async () => {
    const { useCase, query, blindIndex } = makeDeps();
    query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [ROW] });

    await useCase.execute({ search: 'ana@test.com', limit: 10, offset: 0 });

    expect(blindIndex.generateSearchTrigramBidx).not.toHaveBeenCalled();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('w.email ILIKE $');
    expect(params).toContain('%ana@test.com%');
  });

  it('ciphertext inválido numa linha não derruba a busca (fallback pro email)', async () => {
    const { useCase, query, encryption } = makeDeps();
    (encryption.decrypt as jest.Mock).mockRejectedValue(new Error('Failed to decrypt data'));
    query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [ROW] });

    const result = await useCase.execute({ limit: 20, offset: 0 });

    expect(result.workers).toHaveLength(1);
    expect(result.workers[0].name).toBe('ana@test.com');
  });

  it('nunca expõe phone/dados encriptados no item retornado', async () => {
    const { useCase, query } = makeDeps();
    query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [ROW] });

    const result = await useCase.execute({ limit: 20, offset: 0 });
    const item = result.workers[0] as unknown as Record<string, unknown>;
    expect(item.phone).toBeUndefined();
    expect(item.first_name_encrypted).toBeUndefined();
  });
});
