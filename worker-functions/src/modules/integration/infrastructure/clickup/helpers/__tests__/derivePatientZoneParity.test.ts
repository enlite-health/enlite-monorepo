/**
 * Paridade servidor×front da derivação de Zona/Barrio (spec Localizaciones
 * Fase 1, T1). Lê o MESMO arquivo de fixtures que o teste do frontend
 * (enlite-frontend/src/application/use-cases/derivePatientZone.test.ts) por
 * caminho relativo, e roda cada caso contra a função REAL do servidor —
 * `extractNeighborhoodFromLocation` — sem duplicar a regra.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractNeighborhoodFromLocation } from '../locationHelpers';

interface FixtureAddressComponent {
  long_name?: string;
  short_name?: string;
  types: string[];
}

interface FixtureCase {
  id: string;
  description: string;
  addressComponents: FixtureAddressComponent[];
  expected: string | null;
}

const FIXTURE_PATH = resolve(__dirname, 'fixtures/neighborhood-parity.fixtures.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as { cases: FixtureCase[] };

describe('extractNeighborhoodFromLocation — paridade com o frontend (T1)', () => {
  it('lê o arquivo de fixtures compartilhado com o teste do frontend', () => {
    expect(fixture.cases.length).toBe(5);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))('caso %s: %s', (_id, c) => {
    const location = { address_components: c.addressComponents };
    expect(extractNeighborhoodFromLocation(location)).toBe(c.expected);
  });
});
