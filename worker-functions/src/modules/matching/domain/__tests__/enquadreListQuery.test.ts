import {
  EnquadreListRangeError,
  MAX_RANGE_DAYS,
  parseEnquadreListRange,
  parseEnquadreSearch,
} from '../enquadreListQuery';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof EnquadreListRangeError ? e.code : 'OUTRO';
  }
  return undefined;
}

describe('parseEnquadreListRange', () => {
  it('sem datas = null (semana atual, resolvida pelo servidor)', () => {
    expect(parseEnquadreListRange()).toBeNull();
    expect(parseEnquadreListRange('', '')).toBeNull();
  });

  it('o limite é 92 dias de calendário inclusivos (91 de diferença passa)', () => {
    expect(MAX_RANGE_DAYS).toBe(92);
    expect(parseEnquadreListRange('2026-01-01', '2026-04-02')).toEqual({ from: '2026-01-01', to: '2026-04-02' });
  });

  it('92 dias de diferença reprova com TOO_LONG', () => {
    expect(codeOf(() => parseEnquadreListRange('2026-01-01', '2026-04-03'))).toBe('ENQUADRE_LIST_RANGE_TOO_LONG');
  });

  it('o mesmo dia passa', () => {
    expect(parseEnquadreListRange('2026-10-27', '2026-10-27')).toEqual({ from: '2026-10-27', to: '2026-10-27' });
  });

  it('to antes de from reprova com INVERTED', () => {
    expect(codeOf(() => parseEnquadreListRange('2026-10-28', '2026-10-27'))).toBe('ENQUADRE_LIST_RANGE_INVERTED');
  });

  it('só um dos lados reprova com INCOMPLETE', () => {
    expect(codeOf(() => parseEnquadreListRange('2026-10-27', undefined))).toBe('ENQUADRE_LIST_RANGE_INCOMPLETE');
    expect(codeOf(() => parseEnquadreListRange(undefined, '2026-10-27'))).toBe('ENQUADRE_LIST_RANGE_INCOMPLETE');
  });
});

describe('parseEnquadreSearch', () => {
  it('ENC-ab12 vira eventCode em maiúsculas', () => {
    expect(parseEnquadreSearch('ENC-ab12')).toEqual({ eventCode: 'ENC-AB12' });
  });

  it('EN1234#02 vira digits=1234 e ordinal=2', () => {
    expect(parseEnquadreSearch('EN1234#02')).toEqual({ digits: '1234', ordinal: 2 });
  });

  it('número puro vira digits', () => {
    expect(parseEnquadreSearch(' 960001 ')).toEqual({ digits: '960001' });
  });

  it('# sem dígito é ignorado', () => {
    expect(parseEnquadreSearch('#')).toEqual({});
    expect(parseEnquadreSearch('EN1234#')).toEqual({ digits: '1234' });
  });

  it('texto livre (pode ser nome) nunca vira predicado', () => {
    expect(parseEnquadreSearch('Ficticio 01')).toEqual({});
    expect(parseEnquadreSearch('')).toEqual({});
    expect(parseEnquadreSearch(undefined)).toEqual({});
  });
});
