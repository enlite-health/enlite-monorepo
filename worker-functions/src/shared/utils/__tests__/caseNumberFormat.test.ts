import { formatCaseNumber, formatCaseLabel, formatCaseOrdinal } from '../caseNumberFormat';

describe('formatCaseNumber', () => {
  it('legado do ClickUp (828, < 1000) — sem prefixo', () => {
    expect(formatCaseNumber(828)).toBe('828');
  });

  it('início da sequence nativa (1000) — prefixo EN', () => {
    expect(formatCaseNumber(1000)).toBe('EN1000');
  });

  it('número alto da sequence nativa (99999) — prefixo EN', () => {
    expect(formatCaseNumber(99999)).toBe('EN99999');
  });

  it('null — sem regra própria, devolve null (fallback é do caller)', () => {
    expect(formatCaseNumber(null)).toBeNull();
  });
});

describe('formatCaseLabel', () => {
  it('case_number presente — ignora o fallback', () => {
    expect(formatCaseLabel(828, 5568)).toBe('828');
    expect(formatCaseLabel(1000, 5568)).toBe('EN1000');
  });

  it('case_number null — cai para vacancy_number global, sem prefixo', () => {
    expect(formatCaseLabel(null, 5568)).toBe('5568');
  });

  it('os dois null — devolve null', () => {
    expect(formatCaseLabel(null, null)).toBeNull();
  });
});

describe('formatCaseOrdinal', () => {
  it('zero-pad em 2 dígitos', () => {
    expect(formatCaseOrdinal(1)).toBe('#01');
    expect(formatCaseOrdinal(9)).toBe('#09');
  });

  it('não trunca acima de 2 dígitos', () => {
    expect(formatCaseOrdinal(23)).toBe('#23');
    expect(formatCaseOrdinal(150)).toBe('#150');
  });

  it('null passa direto', () => {
    expect(formatCaseOrdinal(null)).toBeNull();
  });
});
