import { sanitizeFilenamePart } from '../sanitizeFilenamePart';

describe('sanitizeFilenamePart (spec 032)', () => {
  it('remove acento (NFD) e mantém a caixa', () => {
    expect(sanitizeFilenamePart('José Núñez')).toBe('Jose_Nunez');
  });

  it('espaço vira _', () => {
    expect(sanitizeFilenamePart('Paciente Sintetico QA')).toBe('Paciente_Sintetico_QA');
  });

  it('remove o que está fora de [A-Za-z0-9_-]', () => {
    expect(sanitizeFilenamePart('Ana/María: "Test"?*<>|.xlsx')).toBe('AnaMaria_Testxlsx');
  });

  it('colapsa _ repetidos', () => {
    expect(sanitizeFilenamePart('Ana    María')).toBe('Ana_Maria');
  });

  it('apara _ nas pontas', () => {
    expect(sanitizeFilenamePart('  Ana María  ')).toBe('Ana_Maria');
    expect(sanitizeFilenamePart('__Ana__')).toBe('Ana');
  });

  it('rótulo Sin vínculo · ID 9660 → Sin_vinculo_ID_9660 (o · não deixa __)', () => {
    expect(sanitizeFilenamePart('Sin vínculo · ID 9660')).toBe('Sin_vinculo_ID_9660');
  });

  it('mantém o hífen do ID da fonte (AC-PAT-0) — o nome do arquivo legível do e2e', () => {
    expect(sanitizeFilenamePart('Sin vínculo · ID AC-PAT-0')).toBe('Sin_vinculo_ID_AC-PAT-0');
  });

  it('apara hífen e _ nas pontas', () => {
    expect(sanitizeFilenamePart('- Ana -')).toBe('Ana');
  });

  it('vazio → SIN_NOMBRE', () => {
    expect(sanitizeFilenamePart('')).toBe('SIN_NOMBRE');
  });

  it('só símbolos/espaços → SIN_NOMBRE', () => {
    expect(sanitizeFilenamePart('  ··· ¿?¡! ')).toBe('SIN_NOMBRE');
  });

  it('nome só com caracteres não latinos → SIN_NOMBRE (ASCII garantido)', () => {
    expect(sanitizeFilenamePart('日本語')).toBe('SIN_NOMBRE');
  });

  it('resultado é sempre ASCII seguro para cabeçalho HTTP', () => {
    expect(sanitizeFilenamePart('Ñandú "Ç" ü ·\n\t"x"')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
