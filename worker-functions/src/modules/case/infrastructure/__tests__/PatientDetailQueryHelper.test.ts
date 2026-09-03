/**
 * PatientDetailQueryHelper.fetchPatientDetail — unit tests.
 *
 * Had ZERO coverage before this file (20% lines, functions never invoked).
 * `pool` and `encryptionService` are passed directly as arguments (no
 * DatabaseConnection import in this module), so we mock them as plain
 * objects rather than jest.mock()'ing a module.
 *
 * Covers:
 *  1. patient not found (0 rows) → returns null, never queries related tables.
 *  2. full happy path: responsibles/addresses/professionals decrypted via KMS,
 *     vacancies mapped into ActiveVacancy for computeAddressAvailability,
 *     legacyChatIdAliases spread (familyChatId/providersChatId), lastCaseNumber
 *     coerced to Number.
 *  3. defensive `?? []` / `?? {}` / `?? false` / `!= null` fallback branches:
 *     chatIds null, attentionReasons null, lastCaseNumber null, isTeam
 *     undefined, address complement null, lat/lng null.
 */

import type { Pool } from 'pg';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { fetchPatientDetail } from '../PatientDetailQueryHelper';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makePool(queryImpl: jest.Mock): Pool {
  return { query: queryImpl } as unknown as Pool;
}

function makeEncryptionService(): KMSEncryptionService {
  const decrypt = jest.fn(async (v: string | null) => (v ? `dec(${v})` : null));
  return { decrypt, encrypt: jest.fn() } as unknown as KMSEncryptionService;
}

function basePatientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PATIENT_ID,
    clickupTaskId: 'CU-100',
    firstName: 'Juan',
    lastName: 'Pérez',
    birthDate: new Date('1990-01-01'),
    documentType: 'DNI',
    documentNumber: '11111111',
    affiliateId: null,
    sex: 'MALE',
    phoneWhatsapp: '+5491100000000',
    diagnosis: 'ASD',
    dependencyLevel: 'MODERATE',
    clinicalSpecialty: 'ASD',
    clinicalSegments: null,
    serviceType: ['AT'],
    deviceType: null,
    additionalComments: 'texto clínico',
    additionalCommentsUpdatedAt: new Date('2026-08-20T00:00:00Z'),
    additionalCommentsUpdatedBy: 'Fulano Staff',
    hasJudicialProtection: false,
    hasCud: true,
    hasConsent: true,
    insuranceInformed: 'OSDE',
    insuranceVerified: null,
    cityLocality: 'CABA',
    province: 'Buenos Aires',
    zoneNeighborhood: null,
    country: 'AR',
    chatIds: { FAMILY: 'family@g.us', PROVIDERS: 'providers@g.us' },
    status: 'ACTIVE',
    needsAttention: false,
    attentionReasons: ['MISSING_INFO'],
    lastCaseNumber: '766',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-06-01T00:00:00Z'),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fetchPatientDetail — patient not found', () => {
  it('1. retorna null quando a query principal não encontra linhas, sem consultar as tabelas relacionadas', async () => {
    const queryImpl = jest.fn().mockResolvedValueOnce({ rows: [] });
    const pool = makePool(queryImpl);
    const enc = makeEncryptionService();

    const result = await fetchPatientDetail(pool, enc, 'missing-id');

    expect(result).toBeNull();
    expect(queryImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchPatientDetail — happy path completo', () => {
  it('2. decripta responsáveis/profissionais via KMS, mapeia endereços com availability, aplica legacyChatIdAliases', async () => {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [basePatientRow()] }) // main patient query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'resp-1', first_name: 'María', last_name: 'López', relationship: 'Madre',
            phone_encrypted: 'enc-phone-r1', email_encrypted: 'enc-email-r1',
            document_number_encrypted: 'enc-doc-r1', document_type: 'DNI',
            is_primary: true, display_order: 1, source: 'admin_manual',
          },
        ],
      }) // responsibles
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'addr-1', address_type: 'primary', address_formatted: 'Av. Siempre Viva 742',
            address_raw: 'raw', complement: 'Depto 2B', display_order: 1, lat: '-34.6037', lng: '-58.3816',
          },
        ],
      }) // addresses
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'prof-1', name: 'Dr. García', phone_encrypted: 'enc-phone-p1',
            email_encrypted: 'enc-email-p1', display_order: 1, is_team: true,
          },
        ],
      }) // professionals
      .mockResolvedValueOnce({
        rows: [
          { id: 'vac-1', patient_address_id: 'addr-1', status: 'SEARCHING', schedule: null },
        ],
      }); // active vacancies

    const pool = makePool(queryImpl);
    const enc = makeEncryptionService();

    const result = await fetchPatientDetail(pool, enc, PATIENT_ID);

    expect(result).not.toBeNull();
    expect(queryImpl).toHaveBeenCalledTimes(5);

    // Identity/clinical passthrough
    expect(result!.id).toBe(PATIENT_ID);
    expect(result!.firstName).toBe('Juan');
    expect(result!.lastCaseNumber).toBe(766); // coerced to Number

    // chatIds + legacy aliases (D181-adjacent contract: alias mirrors the map)
    expect(result!.chatIds).toEqual({ FAMILY: 'family@g.us', PROVIDERS: 'providers@g.us' });
    expect(result!.familyChatId).toBe('family@g.us');
    expect(result!.providersChatId).toBe('providers@g.us');

    // Responsibles decrypted via KMS (never the ciphertext)
    expect(result!.responsibles).toHaveLength(1);
    expect(result!.responsibles[0]).toMatchObject({
      id: 'resp-1',
      firstName: 'María',
      lastName: 'López',
      phone: 'dec(enc-phone-r1)',
      email: 'dec(enc-email-r1)',
      documentNumber: 'dec(enc-doc-r1)',
      isPrimary: true,
    });

    // Professionals decrypted via KMS
    expect(result!.professionals).toHaveLength(1);
    expect(result!.professionals[0]).toMatchObject({
      id: 'prof-1',
      name: 'Dr. García',
      phone: 'dec(enc-phone-p1)',
      email: 'dec(enc-email-p1)',
      isTeam: true,
    });

    // Addresses mapped with parsed lat/lng and computed availability
    expect(result!.addresses).toHaveLength(1);
    const addr = result!.addresses[0];
    expect(addr.id).toBe('addr-1');
    expect(addr.isPrimary).toBe(true);
    expect(addr.complement).toBe('Depto 2B');
    expect(addr.lat).toBeCloseTo(-34.6037);
    expect(addr.lng).toBeCloseTo(-58.3816);
    expect(addr.availability).toMatchObject({ activeVacanciesCount: 1, hasUnknownSchedule: true });
  });
});

describe('fetchPatientDetail — defensive fallback branches', () => {
  const emptyRelated = () => ({ rows: [] });

  it('3. chatIds nulo → {} e aliases null; attentionReasons nulo → []; lastCaseNumber nulo → null', async () => {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({
        rows: [basePatientRow({ chatIds: null, attentionReasons: null, lastCaseNumber: null })],
      })
      .mockResolvedValueOnce(emptyRelated())
      .mockResolvedValueOnce(emptyRelated())
      .mockResolvedValueOnce(emptyRelated())
      .mockResolvedValueOnce(emptyRelated());

    const pool = makePool(queryImpl);
    const enc = makeEncryptionService();

    const result = await fetchPatientDetail(pool, enc, PATIENT_ID);

    expect(result!.chatIds).toEqual({});
    expect(result!.familyChatId).toBeNull();
    expect(result!.providersChatId).toBeNull();
    expect(result!.attentionReasons).toEqual([]);
    expect(result!.lastCaseNumber).toBeNull();
    expect(result!.responsibles).toEqual([]);
    expect(result!.addresses).toEqual([]);
    expect(result!.professionals).toEqual([]);
  });

  it('4. isTeam ausente → false (?? false); complement/lat/lng ausentes → null', async () => {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [basePatientRow()] })
      .mockResolvedValueOnce(emptyRelated())
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'addr-2', address_type: 'secondary', address_formatted: 'Sin coords',
            address_raw: null, complement: null, display_order: 2, lat: null, lng: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'prof-2', name: 'Equipo sin marca', phone_encrypted: null, email_encrypted: null, display_order: 1, is_team: undefined },
        ],
      })
      .mockResolvedValueOnce(emptyRelated());

    const pool = makePool(queryImpl);
    const enc = makeEncryptionService();

    const result = await fetchPatientDetail(pool, enc, PATIENT_ID);

    expect(result!.professionals[0].isTeam).toBe(false);
    expect(result!.addresses[0].complement).toBeNull();
    expect(result!.addresses[0].lat).toBeNull();
    expect(result!.addresses[0].lng).toBeNull();
    expect(result!.addresses[0].isPrimary).toBe(false); // address_type !== 'primary'
  });
});

// ── Spec 011 bloco A (A3 / A4) ────────────────────────────────────────────────

describe('fetchPatientDetail — cobertura e e-mail do paciente (spec 011, A3/A4)', () => {
  const emptyRelated = () => ({ rows: [] });

  function runWithRow(row: Record<string, unknown>) {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce(emptyRelated())
      .mockResolvedValueOnce(emptyRelated())
      .mockResolvedValueOnce(emptyRelated())
      .mockResolvedValueOnce(emptyRelated());
    const enc = makeEncryptionService();
    return { queryImpl, enc, run: () => fetchPatientDetail(makePool(queryImpl), enc, PATIENT_ID) };
  }

  it('A3 (lex caminho a) — a ficha lê COALESCE(insurance_informed, health_insurance_name): o painel grava na coluna protegida, o sync do ClickUp sobrescreve a outra', async () => {
    const { queryImpl, run } = runWithRow(basePatientRow());
    await run();
    const mainSql = String(queryImpl.mock.calls[0][0]);
    expect(mainSql).toMatch(/COALESCE\(\s*p?\.?insurance_informed\s*,\s*p?\.?health_insurance_name\s*\)\s+AS\s+"insuranceInformed"/);
  });

  it('A4 (lex C4.1) — seleciona contact_email_encrypted e descriptografa via KMS: exatamente 1 decrypt a mais, com o ciphertext certo', async () => {
    const { queryImpl, enc, run } = runWithRow(basePatientRow({ contactEmailEncrypted: 'enc-contact-email' }));
    const result = await run();
    expect(String(queryImpl.mock.calls[0][0])).toContain('contact_email_encrypted');
    expect(result!.contactEmail).toBe('dec(enc-contact-email)');
    // Espião: sem responsáveis nem profissionais, o ÚNICO decrypt desta carga é o do e-mail.
    const decrypt = enc.decrypt as jest.Mock;
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(decrypt).toHaveBeenCalledWith('enc-contact-email');
  });

  it('A4 — paciente sem e-mail: contactEmail null (nunca "" — o `decrypt("")` do passthrough devolve string vazia)', async () => {
    const { run } = runWithRow(basePatientRow({ contactEmailEncrypted: null }));
    const result = await run();
    expect(result!.contactEmail).toBeNull();
  });
});
