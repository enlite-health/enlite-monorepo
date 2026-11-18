import { PgTherapeuticCatalogCascade } from '../PgTherapeuticCatalogCascade';

const OBJ = 'therapeutic_objective_icd_categories';

function fakePool(responses: Array<{ rows: unknown[] }>) {
  const query = jest.fn();
  responses.forEach((r) => query.mockResolvedValueOnce(r));
  return { query } as unknown as { query: jest.Mock };
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('PgTherapeuticCatalogCascade', () => {
  const objRows = {
    rows: [
      { category_code: '6A02', id: 'o2', label: 'B', description: null },
      { category_code: '6A02', id: 'o1', label: 'A', description: 'd' },
      { category_code: '6A05', id: 'o1', label: 'A', description: 'd' },
    ],
  };
  const actRows = {
    rows: [
      { category_code: '6A02', objective_id: 'o1', id: 'a1', label: 'x', description: null, suggested_frequency: '2x' },
      { category_code: '6A05', objective_id: 'o1', id: 'a2', label: 'y', description: 'dd', suggested_frequency: null },
    ],
  };

  it('filtra ativos, serviço e categoria nas duas tabelas e ordena por DD-4', async () => {
    const pool = fakePool([objRows, actRows]);
    await new PgTherapeuticCatalogCascade(pool).catalogFor('AT', ['6A02', '6A05']);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [objSql, objParams] = pool.query.mock.calls[0];
    const [actSql, actParams] = pool.query.mock.calls[1];
    const o = norm(objSql);
    const a = norm(actSql);
    expect(o).toContain(`FROM ${OBJ}`);
    expect(o).toContain('item.active');
    expect(o).toContain('item.service_code = $1');
    expect(o).toContain('link.category_code = ANY($2::text[])');
    expect(o).toContain('ORDER BY link.sort_order NULLS LAST, lower(item.label)');
    expect(a).toContain('FROM therapeutic_activity_icd_categories');
    expect(a).toContain('item.active AND obj.active');
    expect(a).toContain('obj.service_code = $1');
    expect(a).toContain('link.category_code = ANY($2::text[])');
    expect(a).toContain('ORDER BY link.sort_order NULLS LAST, lower(item.label)');
    expect(objParams).toEqual(['AT', ['6A02', '6A05']]);
    expect(actParams).toEqual(['AT', ['6A02', '6A05']]);
  });

  it('monta o Map por categoria preservando a ordem do banco e aninhando atividades', async () => {
    const pool = fakePool([objRows, actRows]);
    const map = await new PgTherapeuticCatalogCascade(pool).catalogFor('AT', ['6A02', '6A05', 'XXXX']);
    expect(map.get('6A02')!.map((o) => o.id)).toEqual(['o2', 'o1']);
    expect(map.get('6A02')![1].activities).toEqual([
      { id: 'a1', label: 'x', description: null, suggestedFrequency: '2x' },
    ]);
    expect(map.get('6A05')![0].activities.map((x) => x.id)).toEqual(['a2']);
    expect(map.get('XXXX')).toEqual([]);
  });

  it('sem categorias não consulta o banco', async () => {
    const pool = fakePool([]);
    const map = await new PgTherapeuticCatalogCascade(pool).catalogFor('AT', []);
    expect(map.size).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('hasCatalog consulta objetivo ativo do serviço', async () => {
    const pool = fakePool([{ rows: [{ has_catalog: true }] }, { rows: [{ has_catalog: false }] }]);
    const cascade = new PgTherapeuticCatalogCascade(pool);
    expect(await cascade.hasCatalog('AT')).toBe(true);
    expect(await cascade.hasCatalog('X')).toBe(false);
    const sql = norm(pool.query.mock.calls[0][0]);
    expect(sql).toContain('active AND service_code = $1');
    expect(pool.query.mock.calls[0][1]).toEqual(['AT']);
  });
});
