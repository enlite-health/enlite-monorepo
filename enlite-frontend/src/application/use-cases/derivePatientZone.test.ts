/**
 * Paridade front×servidor da derivação de Zona/Barrio (spec Localizaciones
 * Fase 1, T1). Lê o MESMO arquivo de fixtures que o teste do servidor
 * (worker-functions/.../locationHelpers/__tests__/fixtures/neighborhood-parity.fixtures.json)
 * por caminho relativo — ver o comentário de `derivePatientZone.ts` para o
 * porquê da regra portada.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { derivePatientZone, type PatientZoneAddressComponent } from './derivePatientZone';

interface FixtureCase {
  id: string;
  description: string;
  addressComponents: PatientZoneAddressComponent[];
  expected: string | null;
}

const FIXTURE_PATH = resolve(
  __dirname,
  '../../../../worker-functions/src/modules/integration/infrastructure/clickup/helpers/__tests__/fixtures/neighborhood-parity.fixtures.json',
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as { cases: FixtureCase[] };

describe('derivePatientZone — paridade com o servidor (T1)', () => {
  it('lê o arquivo de fixtures compartilhado com o teste do worker-functions', () => {
    expect(fixture.cases.length).toBe(5);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))('caso %s: %s', (_id, c) => {
    expect(derivePatientZone(c.addressComponents)).toBe(c.expected);
  });

  it('undefined/null vira null (endereço sem escolha ainda)', () => {
    expect(derivePatientZone(undefined)).toBeNull();
    expect(derivePatientZone(null)).toBeNull();
  });

  it('componente com types ausente/não-array é ignorado, não quebra', () => {
    expect(
      derivePatientZone([{ long_name: 'X', types: undefined as unknown as string[] }]),
    ).toBeNull();
  });

  it('usa short_name quando long_name está ausente', () => {
    expect(
      derivePatientZone([{ short_name: 'Recoleta', types: ['sublocality_level_1'] }]),
    ).toBe('Recoleta');
  });

  it('candidato "null" literal (artefato legado) vira null', () => {
    expect(
      derivePatientZone([{ long_name: 'null', types: ['neighborhood'] }]),
    ).toBeNull();
  });

  it('candidato em branco é ignorado na coleta (não vira candidato vazio)', () => {
    expect(
      derivePatientZone([
        { long_name: '   ', types: ['neighborhood'] },
        { long_name: 'Palermo', types: ['sublocality_level_1'] },
      ]),
    ).toBe('Palermo');
  });
});
