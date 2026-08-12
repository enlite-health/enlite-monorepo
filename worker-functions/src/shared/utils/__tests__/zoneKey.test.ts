import { resolveZoneKey, UNRESOLVED_ZONE_KEY, UNRESOLVED_ZONE_LABEL } from '../zoneKey';

describe('resolveZoneKey', () => {
  it('funde localidades diferentes na MESMA província (CABA/Palermo e CABA/Flores → 1 zona)', () => {
    const a = resolveZoneKey('CABA', 'Palermo');
    const b = resolveZoneKey('CABA', 'Flores');

    expect(a.key).toBe(b.key);
    expect(a.label).toBe('CABA');
    expect(b.label).toBe('CABA');
  });

  it('funde aliases de província (CABA vs Capital Federal) na mesma chave, independente da city', () => {
    const a = resolveZoneKey('CABA', 'Palermo');
    const b = resolveZoneKey('Capital Federal', 'Villa Crespo');

    expect(a.key).toBe(b.key);
  });

  it('desambigua "Buenos Aires" cru via city (CABA quando city=Buenos Aires, PBA caso contrário)', () => {
    const caba = resolveZoneKey('Buenos Aires', 'Buenos Aires');
    const pba = resolveZoneKey('Buenos Aires', 'Palermo');

    expect(caba.label).toBe('CABA');
    expect(pba.label).toBe('Provincia de Buenos Aires');
    expect(caba.key).not.toBe(pba.key);
  });

  it('homônimo de LOCALIDADE em províncias diferentes agora é IRRELEVANTE — chave é só a província', () => {
    // "San Miguel" existe em Buenos Aires e em Corrientes; como a chave não usa
    // mais a city, o que decide a zona é a província, não o nome da localidade.
    const sanMiguelBA = resolveZoneKey('Provincia de Buenos Aires', 'San Miguel');
    const sanMiguelCorrientes = resolveZoneKey('Corrientes', 'San Miguel');
    const otraCiudadBA = resolveZoneKey('Provincia de Buenos Aires', 'Otra Ciudad Cualquiera');

    // Províncias diferentes → zonas diferentes (correto).
    expect(sanMiguelBA.key).not.toBe(sanMiguelCorrientes.key);
    // MESMA província, cidade diferente → MESMA zona (a cidade não importa mais).
    expect(sanMiguelBA.key).toBe(otraCiudadBA.key);
  });

  it('cai no bucket "Não informado" quando state é nulo (mesmo com city presente)', () => {
    // canonicalProvince(null, city) retorna null SEMPRE que state é nulo — não
    // infere província a partir só da city. Comportamento real confirmado via
    // teste direto de canonicalProvince antes de escrever este arquivo.
    const result = resolveZoneKey(null, 'CABA');
    expect(result.key).toBe(UNRESOLVED_ZONE_KEY);
    expect(result.label).toBe(UNRESOLVED_ZONE_LABEL);
  });

  it('cai no bucket "Não informado" quando state e city são nulos', () => {
    const result = resolveZoneKey(null, null);
    expect(result.key).toBe(UNRESOLVED_ZONE_KEY);
    expect(result.label).toBe(UNRESOLVED_ZONE_LABEL);
  });

  it('cai no bucket "Não informado" quando a província resolvida é lixo (CPA postal, ex. "B1748 AEJ")', () => {
    // canonicalProvince NÃO retorna null para província desconhecida — devolve
    // o state cru ("resto → inalterado"). O guard isJunkLocation captura isso.
    const result = resolveZoneKey('B1748 AEJ', null);
    expect(result.key).toBe(UNRESOLVED_ZONE_KEY);
    expect(result.label).toBe(UNRESOLVED_ZONE_LABEL);
  });

  it('label é a própria província canônica — determinístico, não depende de "primeiro visto"', () => {
    const result = resolveZoneKey('Buenos Aires Province', null);
    expect(result.label).toBe('Provincia de Buenos Aires');

    const result2 = resolveZoneKey('Córdoba Province', null);
    expect(result2.label).toBe('Córdoba');
  });
});
