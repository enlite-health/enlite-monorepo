import {
  normalizeProvince,
  stripPostalCodePrefix,
  cleanNullLiteral,
  isPureArgentinePostalCode,
} from '../argentinaLocationNormalizer';

describe('cleanNullLiteral', () => {
  it.each(['null', 'NULL', 'Null', '', '   '])(
    'retorna null para literal/vazio "%s"',
    (input) => {
      expect(cleanNullLiteral(input)).toBeNull();
    },
  );

  it('retorna null para null/undefined', () => {
    expect(cleanNullLiteral(null)).toBeNull();
    expect(cleanNullLiteral(undefined)).toBeNull();
  });

  it('preserva e trima valor válido', () => {
    expect(cleanNullLiteral('  Florida  ')).toBe('Florida');
  });
});

describe('stripPostalCodePrefix', () => {
  it('remove prefixo de CP argentino (letra+4digitos+sufixo)', () => {
    expect(stripPostalCodePrefix('B1602 Florida')).toBe('Florida');
    expect(stripPostalCodePrefix('V9410 Ushuaia')).toBe('Ushuaia');
  });

  it('remove prefixo de CP sem letra (4 digitos)', () => {
    expect(stripPostalCodePrefix('1602 Florida')).toBe('Florida');
  });

  it('não altera string sem prefixo de CP', () => {
    expect(stripPostalCodePrefix('Florida')).toBe('Florida');
  });

  it('preserva espaços internos após remover o prefixo (não colapsa multi-espaço em nome composto)', () => {
    expect(stripPostalCodePrefix('B1846    Adrogué')).toBe('Adrogué');
  });

  it('retorna null quando o valor é SÓ um CEP puro, sem nome de localidade (bug real de prod)', () => {
    expect(stripPostalCodePrefix('C1126ABC')).toBeNull();
    expect(stripPostalCodePrefix('B1602')).toBeNull();
    expect(stripPostalCodePrefix('1602')).toBeNull();
  });

  it('retorna null para literal "null"/vazio/null/undefined', () => {
    expect(stripPostalCodePrefix('null')).toBeNull();
    expect(stripPostalCodePrefix('')).toBeNull();
    expect(stripPostalCodePrefix(null)).toBeNull();
    expect(stripPostalCodePrefix(undefined)).toBeNull();
  });
});

describe('normalizeProvince', () => {
  it.each(['Ciudad Autónoma de Buenos Aires', 'Capital Federal', 'CABA', 'caba'])(
    'mapeia "%s" para CABA',
    (input) => {
      expect(normalizeProvince(input)).toBe('CABA');
    },
  );

  it.each(['Buenos Aires', 'Buenos Aires Province', 'Provincia de Buenos Aires', 'PBA', 'GBA'])(
    'mapeia "%s" para Provincia de Buenos Aires',
    (input) => {
      expect(normalizeProvince(input)).toBe('Provincia de Buenos Aires');
    },
  );

  it('mapeia "CORDOBA" (sem acento, caixa alta) para Córdoba', () => {
    expect(normalizeProvince('CORDOBA')).toBe('Córdoba');
  });

  it('mapeia "Mendoza Province" (sufixo inglês) para Mendoza', () => {
    expect(normalizeProvince('Mendoza Province')).toBe('Mendoza');
  });

  it.each([
    ['santa fe', 'Santa Fe'],
    ['ENTRE RIOS', 'Entre Ríos'],
    ['tucuman', 'Tucumán'],
    ['TIERRA DEL FUEGO', 'Tierra del Fuego'],
    ['neuquen', 'Neuquén'],
    ['RIO NEGRO', 'Río Negro'],
    ['santiago del estero', 'Santiago del Estero'],
  ])('normaliza "%s" para "%s"', (input, expected) => {
    expect(normalizeProvince(input)).toBe(expected);
  });

  it('retorna null para "B1846 Adrogué" (cidade com CEP, não província)', () => {
    expect(normalizeProvince('B1846 Adrogué')).toBeNull();
  });

  it('retorna null para "San Salvador de Jujuy" (cidade, não província)', () => {
    expect(normalizeProvince('San Salvador de Jujuy')).toBeNull();
  });

  it('retorna null para literal "null"/vazio/lixo', () => {
    expect(normalizeProvince('null')).toBeNull();
    expect(normalizeProvince('')).toBeNull();
    expect(normalizeProvince('asdkjaskjd')).toBeNull();
  });

  it('retorna null para null/undefined', () => {
    expect(normalizeProvince(null)).toBeNull();
    expect(normalizeProvince(undefined)).toBeNull();
  });
});

describe('isPureArgentinePostalCode', () => {
  it.each(['C1126ABC', 'B1602', '1602', 'V9410'])(
    'reconhece "%s" como CEP puro (sem nome de localidade)',
    (input) => {
      expect(isPureArgentinePostalCode(input)).toBe(true);
    },
  );

  it.each(['B1602 Florida', 'Florida', 'Buenos Aires', 'C1126ABC Palermo'])(
    'NÃO reconhece "%s" como CEP puro (tem texto além do CEP)',
    (input) => {
      expect(isPureArgentinePostalCode(input)).toBe(false);
    },
  );
});
