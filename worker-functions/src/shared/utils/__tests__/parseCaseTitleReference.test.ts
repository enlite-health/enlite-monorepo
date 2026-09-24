import { parseCaseTitleReference } from '../parseCaseTitleReference';

/**
 * T063 — teste de tabela: os 3 formatos que o Talentum pode enviar + 1 título
 * sem caso. Ver o parser para por que "CASO 230-42" e "EN1234#01" têm
 * significados diferentes para o segundo número.
 */
describe('parseCaseTitleReference', () => {
  it.each([
    ['CASO 729-5568', { caseNumber: 729, ordinal: 5568 }],
    ['EN1234#01', { caseNumber: 1234, ordinal: 1 }],
    ['729#03', { caseNumber: 729, ordinal: 3 }],
    ['Recepcionista Zona Norte', { caseNumber: null, ordinal: null }],
    // Rodada de fecho do gate: BARE_PATTERN sem âncora casava texto livre com
    // número no meio do título e vinculava o worker ao caso errado (WJA + encuadre),
    // sem erro nem log — ver o comentário do parser para a medição de 68%.
    ['Turno 8-14', { caseNumber: null, ordinal: null }],
    ['Cuidador 2026-09', { caseNumber: null, ordinal: null }],
  ])('%s → %o', (title, expected) => {
    expect(parseCaseTitleReference(title)).toEqual(expected);
  });

  // ── Casos adicionais, fora da tabela obrigatória — cobrem variações reais ──
  it('CASO N sem ordinal (nova vacante)', () => {
    expect(parseCaseTitleReference('CASO 230')).toEqual({ caseNumber: 230, ordinal: null });
  });

  it('CASO com texto extra ao redor (título completo do Talentum)', () => {
    expect(parseCaseTitleReference('CASO 42 - AT Recoleta')).toEqual({ caseNumber: 42, ordinal: null });
  });

  it('EN minúsculo (case-insensitive)', () => {
    expect(parseCaseTitleReference('en1234#01')).toEqual({ caseNumber: 1234, ordinal: 1 });
  });

  it('EN sem ordinal', () => {
    expect(parseCaseTitleReference('EN1234')).toEqual({ caseNumber: 1234, ordinal: null });
  });

  it('número solto SEM separador não é falso-positivo (ex.: "VACANTE 55")', () => {
    expect(parseCaseTitleReference('VACANTE 55')).toEqual({ caseNumber: null, ordinal: null });
  });

  it('string vazia', () => {
    expect(parseCaseTitleReference('')).toEqual({ caseNumber: null, ordinal: null });
  });
});
