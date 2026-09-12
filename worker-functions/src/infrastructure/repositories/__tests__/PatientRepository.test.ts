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
import type { PatientAddress } from '../PatientRepository';

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
