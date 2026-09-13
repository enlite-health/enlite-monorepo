/**
 * PatientRepository (shim) — `PatientAddress.addressType` contract (spec 019, task 2.5).
 *
 * `addressType` deixou de ser um campo obrigatório da interface `PatientAddress` (B4): a coluna
 * `address_type` nasce NULL, e valor só entra via PATCH (`AdminPatientAddressesController`).
 * Nenhum caller de produção grava `addressType` mais (confirmado pelo grep da task 0.4), mas a
 * interface em si não tinha NENHUM teste que prendesse essa forma — uma reversão silenciosa
 * (`addressType` voltando a `required`) não quebraria nenhum teste em tempo de execução, porque o
 * campo nunca é lido por nada aqui.
 *
 * Esta suíte prova o contrato do jeito que é observável para este arquivo: TypeScript. O preset
 * `ts-jest` deste projeto NÃO roda com `isolatedModules` (checado em `jest.config.js` — ausente),
 * então cada arquivo de teste é type-checado por completo antes de rodar. Um objeto literal
 * `PatientAddress` sem `addressType` só compila enquanto o campo for opcional — se alguém
 * remover o `?` em `PatientRepository.ts`, este arquivo para de compilar (TS2741 "Property
 * 'addressType' is missing"), e a suíte inteira falha antes de qualquer `it` rodar.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({ query: mockPoolQuery })) })) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn().mockResolvedValue(null),
    decrypt: jest.fn().mockResolvedValue(null),
  })),
}));

import type { PatientAddress } from '../PatientRepository';
import { PatientRepository } from '../PatientRepository';

describe('PatientAddress.addressType (interface contract)', () => {
  it('permite montar um PatientAddress sem addressType — o campo é opcional (B4)', () => {
    const address: PatientAddress = {
      addressFormatted: 'Av. Corrientes 1234',
      addressRaw: null,
      displayOrder: 1,
      state: 'CABA',
      city: 'CABA',
      neighborhood: 'Balvanera',
      lat: -34.6,
      lng: -58.4,
      // addressType OMITIDO de propósito — é o que este teste prova.
    };

    expect(address.addressType).toBeUndefined();
    expect(address.displayOrder).toBe(1);
  });

  it('ainda aceita addressType quando um caller legado o fornece (compat, não obrigatório)', () => {
    const address: PatientAddress = {
      addressType: 'primary',
      displayOrder: 2,
    };

    expect(address.addressType).toBe('primary');
  });
});

/**
 * K7 (revisão do PR) — `PatientRepository` é `@deprecated`/shim: `grep -rn "new PatientRepository("
 * worker-functions/src | grep -v "__tests__\|\.test\.ts"` devolve ZERO ocorrências — nenhum caller
 * de produção instancia a classe (só a interface `PatientAddress`/`PatientProfessional` são
 * importadas como TIPO por `PatientRelatedWriter.ts`, já cobertas por outra suíte). Classe morta:
 * o escopo deste teste é só o que o DIFF da spec 019 tocou em `replaceAddresses` (remoção de
 * `address_type`/`addressType` do INSERT, ver `git diff origin/main -- .../PatientRepository.ts`),
 * não os 271 linhas inteiras do arquivo (upsertFromClickUp/replaceProfessionals não mudaram nesta
 * spec e não são exercitados aqui).
 */
describe('PatientRepository.replaceAddresses — trecho tocado pelo diff da spec 019 (B4)', () => {
  const geocoder = {
    geocode: jest.fn().mockResolvedValue(null),
    geocodeBatch: jest.fn().mockResolvedValue([]),
  } as unknown as import('../../services/GeocodingService').GeocodingService;

  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it('INSERT nunca contém address_type — nem a coluna, nem o valor — mesmo quando o caller ainda manda addressType', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT (coordenadas conhecidas)
      .mockResolvedValueOnce(undefined)    // DELETE
      .mockResolvedValueOnce(undefined);   // INSERT

    const repo = new PatientRepository(geocoder);
    await repo.replaceAddresses('patient-1', [
      { addressType: 'primary', addressFormatted: 'Av. Corrientes 1234', displayOrder: 1 },
    ]);

    const insertCall = mockPoolQuery.mock.calls[2];
    expect(insertCall[0]).toContain('INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, display_order, lat, lng)');
    expect(insertCall[0]).not.toMatch(/address_type/);
    // patient_id, address_formatted, address_raw, display_order, lat, lng — 6 valores, 'primary' não aparece.
    expect(insertCall[1]).toEqual(['patient-1', 'Av. Corrientes 1234', null, 1, null, null]);
    expect(insertCall[1]).not.toContain('primary');
  });

  it('sem endereço válido (nem addressFormatted nem addressRaw): DELETE roda, INSERT não', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT
      .mockResolvedValueOnce(undefined);   // DELETE

    const repo = new PatientRepository(geocoder);
    await repo.replaceAddresses('patient-2', [{ displayOrder: 1 }]);

    expect(mockPoolQuery).toHaveBeenCalledTimes(2); // SELECT + DELETE, sem INSERT
  });
});
