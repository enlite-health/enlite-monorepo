import { describe, it, expect } from 'vitest';
import { parse, serialize, validateRange, EMPTY_FILTERS, type EnquadresListFilters } from '../enquadresListParams';

describe('enquadresListParams', () => {
  it('URL vazia = sem datas (a semana do servidor), página 1, 20 por página', () => {
    expect(parse(new URLSearchParams(''))).toEqual(EMPTY_FILTERS);
    expect(serialize(EMPTY_FILTERS).toString()).toBe('');
  });

  it('ida e volta: parse(serialize(x)) = x, inclusive page e pageSize', () => {
    const x: EnquadresListFilters = { from: '2026-10-26', to: '2026-11-01', status: ['open', 'closed'], host: 'Ana', country: 'BR', q: 'ENC-AB12', page: 3, pageSize: 50 };
    expect(parse(serialize(x))).toEqual(x);
    expect(serialize(x).get('page')).toBe('3');
  });

  it('data sozinha na URL é descartada (o par só existe junto); valores inválidos caem no padrão', () => {
    expect(parse(new URLSearchParams('from=2026-10-26')).from).toBe('');
    const f = parse(new URLSearchParams('from=2026-02-31&to=2026-03-01&status=open,zzz&page=-4&pageSize=7'));
    expect(f).toMatchObject({ from: '', to: '', status: ['open'], page: 1, pageSize: 20 });
  });

  it('validateRange: vazio e válido passam', () => {
    expect(validateRange('', '')).toBeNull();
    expect(validateRange('2026-10-26', '2026-10-26')).toBeNull();
  });

  it('🔴 to < from reprova com o code do servidor', () => {
    expect(validateRange('2026-11-01', '2026-10-26')).toBe('ENQUADRE_LIST_RANGE_INVERTED');
  });

  it('🔴 92 dias inclusivos passam e 93 reprovam (o mesmo limite do servidor)', () => {
    expect(validateRange('2026-01-01', '2026-04-02')).toBeNull(); // 92 dias de calendário
    expect(validateRange('2026-01-01', '2026-04-03')).toBe('ENQUADRE_LIST_RANGE_TOO_LONG'); // 93
  });

  it('uma só data reprova como incompleto', () => {
    expect(validateRange('2026-10-26', '')).toBe('ENQUADRE_LIST_RANGE_INCOMPLETE');
    expect(validateRange('', '2026-10-26')).toBe('ENQUADRE_LIST_RANGE_INCOMPLETE');
  });
});
