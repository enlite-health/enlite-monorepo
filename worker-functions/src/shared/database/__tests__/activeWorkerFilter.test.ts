import {
  DISABLED_WORKER_STATUS,
  excludeDisabledWorkersSql,
  workerNotDisabledSql,
} from '../activeWorkerFilter';
import { buildWorkerListWhereClause } from '../../../modules/worker/interfaces/controllers/AdminWorkersListHelpers';

describe('activeWorkerFilter', () => {
  it('excludeDisabledWorkersSql usa o alias pedido e o status canônico', () => {
    expect(excludeDisabledWorkersSql('w')).toBe(`COALESCE(w.status, '') <> 'DISABLED'`);
    expect(excludeDisabledWorkersSql('wk')).toContain('wk.status');
    expect(DISABLED_WORKER_STATUS).toBe('DISABLED');
  });

  it('excludeDisabledWorkersSql é NULL-safe (LEFT JOIN sem worker continua aparecendo)', () => {
    // COALESCE é o que garante isso: sem ele, `NULL <> 'DISABLED'` é NULL
    // (falso no WHERE) e a linha sumiria junto com os desativados.
    expect(excludeDisabledWorkersSql('w')).toContain('COALESCE(');
  });

  it('workerNotDisabledSql monta um NOT EXISTS sobre a expressão de worker_id', () => {
    const sql = workerNotDisabledSql('wja.worker_id');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('FROM workers w_disabled_chk');
    expect(sql).toContain('w_disabled_chk.id = wja.worker_id');
    expect(sql).toContain(`status = 'DISABLED'`);
  });
});

describe('buildWorkerListWhereClause — recorte de status', () => {
  const base = { limit: '20', offset: '0' };

  it('sem filtro de status: exclui quem deu baixa na conta', () => {
    const { whereClause, params } = buildWorkerListWhereClause({ ...base });
    expect(whereClause).toContain(`COALESCE(w.status, '') <> 'DISABLED'`);
    // O recorte é literal no SQL — não gasta placeholder nem desalinha $n.
    expect(params).toHaveLength(0);
  });

  it('status explícito manda — inclusive DISABLED (é como o admin acha quem deu baixa)', () => {
    const { whereClause, params } = buildWorkerListWhereClause({
      ...base,
      status: 'DISABLED',
    });
    expect(whereClause).toContain('AND w.status = $1');
    expect(whereClause).not.toContain(`<> 'DISABLED'`);
    expect(params).toEqual(['DISABLED']);
  });

  it('status explícito REGISTERED não reintroduz o recorte redundante', () => {
    const { whereClause, params } = buildWorkerListWhereClause({
      ...base,
      status: 'REGISTERED',
    });
    expect(whereClause).toContain('AND w.status = $1');
    expect(whereClause).not.toContain('COALESCE(w.status');
    expect(params).toEqual(['REGISTERED']);
  });

  it('status vazio/whitespace conta como ausente (cai no recorte padrão)', () => {
    const { whereClause, params } = buildWorkerListWhereClause({ ...base, status: '   ' });
    expect(whereClause).toContain(`COALESCE(w.status, '') <> 'DISABLED'`);
    expect(params).toHaveLength(0);
  });

  it('o recorte não atrapalha a numeração dos outros filtros', () => {
    const { whereClause, params, paramIndex } = buildWorkerListWhereClause({
      ...base,
      profession: 'CAREGIVER',
    });
    expect(whereClause).toContain(`COALESCE(w.status, '') <> 'DISABLED'`);
    expect(whereClause).toContain('w.profession = ANY($1::text[])');
    expect(params).toEqual([['CAREGIVER']]);
    expect(paramIndex).toBe(2);
  });
});
