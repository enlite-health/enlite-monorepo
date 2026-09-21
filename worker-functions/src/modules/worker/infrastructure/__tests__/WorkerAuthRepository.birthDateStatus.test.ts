/**
 * WorkerAuthRepository.birthDateStatus.test.ts
 *
 * Spec 025, decisão do Gabriel 21/09 (opção A): `findByAuthUid` precisa
 * devolver um sinal explícito (`birthDateStatus`) porque `birthDate` sozinho
 * é ambíguo — string inválida vira `Invalid Date`, que serializa como `null`,
 * o MESMO `null` de "nunca cadastrou" (ver docs `vazio-ambiguo-nao-e-informacao-de-ausencia`).
 *
 * Contrato testado:
 * - vazio → 'missing', birthDate undefined
 * - ISO válida → 'ok', birthDate populado
 * - lixo não-ISO (ex.: herdado do Defeito 1, PUT sem validação em runtime) →
 *   'invalid', birthDate undefined, e o valor CRU nunca aparece em lugar
 *   nenhum do objeto devolvido (nem serializado).
 */

import { Pool } from 'pg';
import { findByAuthUid } from '../WorkerAuthRepository';
import { Worker } from '../../domain/Worker';

describe('WorkerAuthRepository.findByAuthUid — birthDateStatus', () => {
  const INVALID_RAW = '25/31/985';

  function fakeRow(birthDateEnc: string | null) {
    return {
      id: 'worker-1',
      authUid: 'auth-1',
      email: 'worker@example.com',
      phone: null,
      mergedIntoId: null,
      whatsappPhoneEnc: null,
      lgpdConsentAt: null,
      firstNameEnc: 'enc:firstName',
      lastNameEnc: 'enc:lastName',
      sexEnc: null,
      genderEnc: null,
      birthDateEnc,
      documentType: null,
      documentNumberEnc: null,
      profilePhotoUrlEnc: null,
      languagesEnc: null,
      profession: null,
      knowledgeLevel: null,
      titleCertificate: null,
      experienceTypes: null,
      yearsExperience: null,
      preferredTypes: null,
      preferredAgeRange: null,
      country: 'AR',
      timezone: 'America/Argentina/Buenos_Aires',
      status: 'REGISTERED',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      serviceAddress: null,
      serviceAddressComplement: null,
      serviceCity: null,
      serviceState: null,
      serviceCountry: null,
      servicePostalCode: null,
      serviceRadiusKm: null,
      serviceLat: null,
      serviceLng: null,
      serviceNeighborhood: null,
    };
  }

  function buildPoolAndEncryption(birthDateEnc: string | null, birthDatePlain: string) {
    const query = jest.fn().mockResolvedValue({ rows: [fakeRow(birthDateEnc)] });
    const pool = { query } as unknown as Pool;

    const decrypt = jest.fn(async (ciphertext: string) => {
      if (ciphertext === birthDateEnc) return birthDatePlain;
      if (ciphertext === 'enc:firstName') return 'João';
      if (ciphertext === 'enc:lastName') return 'Silva';
      return '';
    });
    const encryptionService = { decrypt } as unknown as import('@shared/security/KMSEncryptionService').KMSEncryptionService;

    return { pool, encryptionService, query };
  }

  it('sem data cadastrada → missing, birthDate undefined', async () => {
    const { pool, encryptionService } = buildPoolAndEncryption(null, '');
    const result = await findByAuthUid(pool, encryptionService, 'auth-1');

    expect(result.isFailure).toBe(false);
    const worker = result.getValue() as Worker;
    expect(worker.birthDateStatus).toBe('missing');
    expect(worker.birthDate).toBeUndefined();
  });

  it('ISO válida → ok, birthDate populado', async () => {
    const { pool, encryptionService } = buildPoolAndEncryption('enc:birthDate', '1990-05-15');
    const result = await findByAuthUid(pool, encryptionService, 'auth-1');

    const worker = result.getValue() as Worker;
    expect(worker.birthDateStatus).toBe('ok');
    expect(worker.birthDate).toBeInstanceOf(Date);
    expect(worker.birthDate?.toISOString().slice(0, 10)).toBe('1990-05-15');
  });

  it('lixo não-ISO → invalid, birthDate undefined, valor cru nunca aparece na resposta', async () => {
    const { pool, encryptionService } = buildPoolAndEncryption('enc:birthDate', INVALID_RAW);
    const result = await findByAuthUid(pool, encryptionService, 'auth-1');

    const worker = result.getValue() as Worker;
    expect(worker.birthDateStatus).toBe('invalid');
    expect(worker.birthDate).toBeUndefined();

    // Evidência dura: o valor inválido decifrado não pode escapar em NENHUM
    // campo do objeto devolvido — nem cru, nem dentro de outra propriedade.
    const serialized = JSON.stringify(worker);
    expect(serialized).not.toContain(INVALID_RAW);
    expect(Object.values(worker)).not.toContain(INVALID_RAW);
  });

  it('data futura (ISO mas não-real por regra de negócio) → invalid', async () => {
    const futureYear = new Date().getUTCFullYear() + 5;
    const { pool, encryptionService } = buildPoolAndEncryption('enc:birthDate', `${futureYear}-01-01`);
    const result = await findByAuthUid(pool, encryptionService, 'auth-1');

    const worker = result.getValue() as Worker;
    expect(worker.birthDateStatus).toBe('invalid');
    expect(worker.birthDate).toBeUndefined();
  });
});
