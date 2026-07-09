import {
  parseTitularesExigidos,
  classifyArmedCase,
  REQUIRED_SUBSTITUTES,
  type ArmedCaseInput,
} from '../armedCases';

const base: ArmedCaseInput = {
  providersNeeded: '2',
  selectedTotal: 0,
  selectedWithRole: 0,
  selecTitular: 0,
  selecSubstituto: 0,
};

describe('parseTitularesExigidos (cast defensivo)', () => {
  it.each([
    ['2', 2],
    ['10', 10],
    ['  3  ', 3],
    ['0', 0],
  ])('aceita inteiro puro %p → %p', (input, expected) => {
    expect(parseTitularesExigidos(input)).toBe(expected);
  });

  it.each([
    [null, null],
    ['', null],
    ['   ', null],
    ['dos', null],
    ['2 titulares', null],
    ['2.5', null],
    ['-1', null],
    ['1,5', null],
    ['N/A', null],
  ])('rejeita não-numérico %p → null', (input, expected) => {
    expect(parseTitularesExigidos(input as string | null)).toBe(expected);
  });
});

describe('classifyArmedCase (buckets honestos)', () => {
  it('SEM_CONFIG quando providers_needed não é numérico', () => {
    expect(classifyArmedCase({ ...base, providersNeeded: null })).toBe('SEM_CONFIG');
    expect(classifyArmedCase({ ...base, providersNeeded: 'sin dato' })).toBe('SEM_CONFIG');
  });

  it('PENDENTE_CLASSIFICACAO quando há selecionados mas nenhum com papel', () => {
    expect(
      classifyArmedCase({
        ...base,
        providersNeeded: '2',
        selectedTotal: 3,
        selectedWithRole: 0,
      }),
    ).toBe('PENDENTE_CLASSIFICACAO');
  });

  it('não é PENDENTE quando pelo menos um selecionado tem papel', () => {
    expect(
      classifyArmedCase({
        ...base,
        providersNeeded: '2',
        selectedTotal: 3,
        selectedWithRole: 1,
        selecTitular: 1,
        selecSubstituto: 0,
      }),
    ).toBe('POR_ARMAR');
  });

  it('ARMADA quando titular >= exigidos e substituto >= 10', () => {
    expect(
      classifyArmedCase({
        providersNeeded: '2',
        selectedTotal: 12,
        selectedWithRole: 12,
        selecTitular: 2,
        selecSubstituto: REQUIRED_SUBSTITUTES,
      }),
    ).toBe('ARMADA');
  });

  it('POR_ARMAR quando falta substituto (mesmo com titulares completos)', () => {
    expect(
      classifyArmedCase({
        providersNeeded: '2',
        selectedTotal: 11,
        selectedWithRole: 11,
        selecTitular: 2,
        selecSubstituto: 9,
      }),
    ).toBe('POR_ARMAR');
  });

  it('POR_ARMAR quando falta titular (mesmo com substitutos completos)', () => {
    expect(
      classifyArmedCase({
        providersNeeded: '3',
        selectedTotal: 12,
        selectedWithRole: 12,
        selecTitular: 2,
        selecSubstituto: 10,
      }),
    ).toBe('POR_ARMAR');
  });

  it('POR_ARMAR (não PENDENTE) quando numérico e sem nenhum selecionado', () => {
    expect(classifyArmedCase({ ...base, providersNeeded: '1' })).toBe('POR_ARMAR');
  });

  it('providers_needed = 0 arma com apenas os substitutos', () => {
    expect(
      classifyArmedCase({
        providersNeeded: '0',
        selectedTotal: 10,
        selectedWithRole: 10,
        selecTitular: 0,
        selecSubstituto: 10,
      }),
    ).toBe('ARMADA');
  });
});
