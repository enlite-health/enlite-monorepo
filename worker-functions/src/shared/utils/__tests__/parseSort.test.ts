import { parseSort, SortParamError } from '../parseSort';

const allowlist = {
  completed: (r: { c: number }) => r.c,
  lastActionAt: (r: { c: number }) => r.c,
};

describe('parseSort', () => {
  it('sem sort e sem default devolve null', () => {
    expect(parseSort({}, allowlist)).toBeNull();
  });

  it('sem sort devolve o default declarado', () => {
    const r = parseSort({}, allowlist, { key: 'completed', order: 'desc' });
    expect(r).toMatchObject({ key: 'completed', order: 'desc' });
    expect(r!.value).toBe(allowlist.completed);
  });

  it('chave da allowlist + order válido devolve o extrator da allowlist', () => {
    const r = parseSort({ sort: 'lastActionAt', order: 'asc' }, allowlist);
    expect(r).toMatchObject({ key: 'lastActionAt', order: 'asc' });
    expect(r!.value).toBe(allowlist.lastActionAt);
  });

  it('sort sem order assume asc', () => {
    expect(parseSort({ sort: 'completed' }, allowlist)!.order).toBe('asc');
  });

  it.each([
    ['created_at;drop table x'],
    ['completed;drop'],
    ['case'],
    ['__proto__'],
    ['constructor'],
    ['toString'],
    [''],
  ])('sort fora da allowlist (%s) -> SortParamError', (sort) => {
    expect(() => parseSort({ sort }, allowlist)).toThrow(SortParamError);
  });

  it.each([['asc nulls first'], ['ASC'], ['desc;--'], ['up'], ['']])(
    'order inválido (%s) -> SortParamError',
    (order) => {
      expect(() => parseSort({ sort: 'completed', order }, allowlist)).toThrow(SortParamError);
    },
  );

  it('sort repetido (array) -> SortParamError', () => {
    expect(() => parseSort({ sort: ['completed', 'lastActionAt'] }, allowlist)).toThrow(SortParamError);
  });

  it('order sem sort -> SortParamError', () => {
    expect(() => parseSort({ order: 'desc' }, allowlist)).toThrow(SortParamError);
  });
});
