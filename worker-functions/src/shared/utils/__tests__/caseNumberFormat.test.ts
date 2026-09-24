import { formatCaseNumber, formatCaseLabel, formatCaseOrdinal, formatCaseTitle, formatCaseNumberTitle } from '../caseNumberFormat';

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

describe('formatCaseTitle', () => {
  it('caso nativo (>= 1000) — título leva o prefixo EN', () => {
    expect(formatCaseTitle(1041, 5597)).toBe('CASO EN1041-5597');
  });

  it('caso legado (< 1000) — título sem prefixo, formato inalterado (D412)', () => {
    expect(formatCaseTitle(828, 5597)).toBe('CASO 828-5597');
  });

  it('aceita vacancyNumber como string (ex.: já veio de parseInt/coluna)', () => {
    expect(formatCaseTitle(1041, '5597')).toBe('CASO EN1041-5597');
  });

  it('fronteira exata da sequence nativa (1000)', () => {
    expect(formatCaseTitle(1000, 1)).toBe('CASO EN1000-1');
  });

  it('caseNumber null — preserva o texto legado ("CASO null-{m}"), nenhum guard novo', () => {
    expect(formatCaseTitle(null, 5597)).toBe('CASO null-5597');
  });
});

describe('formatCaseNumberTitle', () => {
  it('caso nativo (>= 1000) — "CASO EN{n}", sem 2º número', () => {
    expect(formatCaseNumberTitle(1234)).toBe('CASO EN1234');
  });

  it('caso legado (< 1000) — "CASO {n}", sem prefixo', () => {
    expect(formatCaseNumberTitle(230)).toBe('CASO 230');
  });

  it('null — devolve null, sem fallback (quem chama decide)', () => {
    expect(formatCaseNumberTitle(null)).toBeNull();
  });
});
