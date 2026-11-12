import { suppress, suppressResult } from '../countSuppression';
import { validateCountRequest, CountRequestError } from '../countRequestValidation';
import { buildCountResponse } from '../countResponseShape';

function err(input: unknown): CountRequestError {
  const r = validateCountRequest(input);
  if (r.ok) throw new Error('esperava erro');
  return r.error;
}
function okReq(input: unknown) {
  const r = validateCountRequest(input);
  if (!r.ok) throw new Error(`esperava ok: ${JSON.stringify(r.error)}`);
  return r.request;
}

describe('supressão', () => {
  it('4 -> lt5, 5 -> 5, 0 -> 0, 1 -> lt5', () => {
    expect(suppress(4)).toEqual({ lt: 5 });
    expect(suppress(5)).toEqual({ value: 5 });
    expect(suppress(0)).toEqual({ value: 0 });
    expect(suppress(1)).toEqual({ lt: 5 });
  });
  it('grupo de 4 + total 123 -> total {gte:120}', () => {
    const r = suppressResult(123, [{ key: 'a', count: 4 }, { key: 'b', count: 119 }]);
    expect(r.total).toEqual({ gte: 120 });
    expect(r.groups[0].count).toEqual({ lt: 5 });
    expect(r.groups[1].count).toEqual({ value: 119 });
  });
  it('sem grupo suprimido -> total exato; total 3 sem grupos -> lt5', () => {
    expect(suppressResult(123, [{ key: 'a', count: 100 }, { key: 'b', count: 23 }]).total).toEqual({ value: 123 });
    expect(suppressResult(3, []).total).toEqual({ lt: 5 });
  });
});

describe('validação', () => {
  it('campo inválido -> valid_fields', () => {
    expect(err({ entity: 'workers', filters: [{ field: 'nombre', values: ['x'] }] })).toEqual({
      code: 'invalid_field', field: 'nombre', valid_fields: ['registration', 'zone', 'has_phone', 'apto'],
    });
  });
  it('entidade desconhecida -> erro', () => {
    expect(err({ entity: 'pets' }).code).toBe('invalid_entity');
  });
  it('valor de zona desconhecido -> valid_values', () => {
    const e = err({ entity: 'workers', filters: [{ field: 'zone', values: ['Atlantida'] }] });
    expect(e.code).toBe('invalid_value');
    if (e.code === 'invalid_value') {
      expect(e.value).toBe('Atlantida');
      expect(e.valid_values.length).toBeGreaterThan(5);
    }
  });
  it('zona passa por canonicalProvince', () => {
    const r = okReq({ entity: 'workers', filters: [{ field: 'zone', values: ['Buenos Aires Province'] }] });
    expect(r.filters[0].values).toEqual(['Provincia de Buenos Aires']);
  });
  it('atalho admisión expande e não conta como literal', () => {
    const r = okReq({ entity: 'patients', filters: [{ field: 'stage', values: ['admisión'] }] });
    expect(r.filters[0].values.length).toBeGreaterThan(1);
    expect(r.filters[0].literalValues).toEqual([]);
  });
  it('ALTA literal marca literal; en atención (que inclui ALTA) não marca', () => {
    const lit = okReq({ entity: 'patients', filters: [{ field: 'stage', values: ['ALTA'] }] });
    expect(lit.filters[0].literalValues).toEqual(['ALTA']);
    const via = okReq({ entity: 'patients', filters: [{ field: 'stage', values: ['en atención'] }] });
    expect(via.filters[0].values).toContain('ALTA');
    expect(via.filters[0].literalValues).not.toContain('ALTA');
  });
  it('group_by array, não-campo, campo repetido e values vazio -> erro', () => {
    expect(err({ entity: 'workers', group_by: ['zone'] }).code).toBe('invalid_group_by');
    expect(err({ entity: 'workers', group_by: 'nope' }).code).toBe('invalid_group_by');
    expect(err({ entity: 'workers', filters: [{ field: 'apto', values: ['true'] }, { field: 'apto', values: ['false'] }] }).code).toBe('duplicate_field');
    expect(err({ entity: 'workers', filters: [{ field: 'apto', values: [] }] }).code).toBe('empty_values');
  });
  it('forma canônica: filtros ordenados, valores únicos e ordenados', () => {
    const r = okReq({
      entity: 'workers', group_by: 'zone',
      filters: [{ field: 'registration', values: ['REGISTERED', 'DISABLED', 'REGISTERED'] }, { field: 'apto', values: ['true'] }],
    });
    expect(r.filters.map((f) => f.field)).toEqual(['apto', 'registration']);
    expect(r.filters[1].values).toEqual(['DISABLED', 'REGISTERED']);
    expect(r.group_by).toBe('zone');
  });
});

describe('shape fechado', () => {
  it('chave extra (id) da entrada não aparece na saída', () => {
    const input = {
      entity: 'workers', filters: [{ field: 'apto', values: ['true'], id: 'F-1' }], group_by: 'zone',
      total: { value: 10, id: 'T' }, groups: [{ key: 'CABA', count: { value: 7, id: 'G-1' }, id: 'G-2', phone: '+54' }],
      scope: 'x', as_of: '2026-11-03', id: 'uuid-1', phone: '+54911',
    };
    const out = buildCountResponse(input as never);
    expect(Object.keys(out).sort()).toEqual(['as_of', 'entity', 'filters', 'group_by', 'groups', 'scope', 'total']);
    expect(JSON.stringify(out)).not.toMatch(/uuid-1|F-1|G-1|G-2|\+54|"id"|phone/);
    expect(out.groups[0]).toEqual({ key: 'CABA', value: 7 });
    expect(out.total).toEqual({ value: 10 });
  });
});
