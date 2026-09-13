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

// 417 bulkhead: o erro da tabela ausente é REPORTADO (nunca engolido) — o espião prova que ele saiu.
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: (...a: unknown[]) => mockReportError(...a),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
}));

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
      .mockResolvedValueOnce({ rows: [] }) // external contacts (spec 018, PR-2)
      .mockResolvedValueOnce({
        rows: [
          { id: 'vac-1', patient_address_id: 'addr-1', status: 'SEARCHING', schedule: null },
        ],
      }) // active vacancies
      .mockResolvedValueOnce({ rows: [] }) // contracted services (spec 013, bloco C)
      .mockResolvedValueOnce({ rows: [] }); // coverage emergency contacts (417)

    const pool = makePool(queryImpl);
    const enc = makeEncryptionService();

    const result = await fetchPatientDetail(pool, enc, PATIENT_ID);

    expect(result).not.toBeNull();
    expect(queryImpl).toHaveBeenCalledTimes(8);
    expect(result!.contractedServices).toEqual([]);

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

// Spec 013, bloco C: mapContractedServices/fetchContractedServiceChildren só rodam de verdade
// quando há ao menos 1 serviço — o teste 2 (contractedServices: []) não passa por aqui.
describe('fetchPatientDetail — serviços contratados (spec 013, bloco C)', () => {
  it('mapeia serviço + dispositivos + prestadores (nome decriptado via KMS), numéricos convertidos', async () => {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [basePatientRow()] }) // main patient query
      .mockResolvedValueOnce({ rows: [] }) // responsibles
      .mockResolvedValueOnce({ rows: [] }) // addresses
      .mockResolvedValueOnce({ rows: [] }) // professionals
      .mockResolvedValueOnce({ rows: [] }) // external contacts (spec 018, PR-2)
      .mockResolvedValueOnce({ rows: [] }) // active vacancies
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'svc-1', patient_id: PATIENT_ID, service_code: 'AT',
            professional_profile: 'perfil sintético', providers_needed: 2,
            authorized_hours: '20', weekly_hours: '20', care_location: 'HOME',
            hourly_value: '1500', start_date: '2026-09-01',
            contract_type: 'OBRA_SOCIAL', tax_condition: 'IVA_EXEMPT',
            supervision_frequency: 'DAYS_30', guard_shift: 'MORNING',
            active: true, ended_at: null, country: 'AR',
            created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
          },
        ],
      }) // contracted services (main list)
      .mockResolvedValueOnce({ rows: [] }) // coverage emergency contacts (417)
      .mockResolvedValueOnce({ rows: [{ service_id: 'svc-1', device_type: 'HOME' }] }) // devices
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'prov-1', service_id: 'svc-1', worker_id: 'w-1', weekly_hours: '20',
            active: true, ended_at: null, country: 'AR',
            created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
            first_name_encrypted: 'enc-first', last_name_encrypted: 'enc-last',
          },
        ],
      }) // providers
      // Spec 018, PR-6: vaga viva DESTE serviço — exercita o Map liveVacancyId (o outro teste da
      // suíte cobre o caso "nenhuma vaga viva").
      .mockResolvedValueOnce({ rows: [{ contracted_service_id: 'svc-1', id: 'vac-live-1' }] });

    const pool = makePool(queryImpl);
    const enc = makeEncryptionService();
    const result = await fetchPatientDetail(pool, enc, PATIENT_ID);

    expect(queryImpl).toHaveBeenCalledTimes(10);
    expect(result!.contractedServices).toHaveLength(1);
    const svc = result!.contractedServices[0];
    expect(svc).toMatchObject({
      id: 'svc-1', patientId: PATIENT_ID, serviceCode: 'AT',
      authorizedHours: 20, weeklyHours: 20, hourlyValue: 1500, // string → Number
      deviceTypes: ['HOME'],
      liveVacancyId: 'vac-live-1',
    });
    expect(svc.providers).toHaveLength(1);
    expect(svc.providers[0]).toMatchObject({
      id: 'prov-1', workerId: 'w-1', workerName: 'dec(enc-first) dec(enc-last)', weeklyHours: 20,
    });
  });

  it('provider sem nome (first/last vazios) → workerName null; service_id não bate → devices/providers ficam fora', async () => {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [basePatientRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // external contacts (spec 018, PR-2)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'svc-1', patient_id: PATIENT_ID, service_code: 'AT', professional_profile: null,
            providers_needed: null, authorized_hours: null, weekly_hours: null, care_location: null,
            hourly_value: null, start_date: null, contract_type: null, tax_condition: null,
            supervision_frequency: null, guard_shift: null, active: true, ended_at: null, country: 'AR',
            created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // coverage emergency contacts (417)
      .mockResolvedValueOnce({ rows: [{ service_id: 'svc-OUTRO', device_type: 'HOME' }] }) // service_id diferente
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'prov-1', service_id: 'svc-1', worker_id: 'w-1', weekly_hours: null,
            active: true, ended_at: null, country: 'AR',
            created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
            first_name_encrypted: null, last_name_encrypted: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // live vacancies (spec 018, PR-6) — nenhuma

    const pool = makePool(queryImpl);
    const enc = makeEncryptionService();
    const result = await fetchPatientDetail(pool, enc, PATIENT_ID);

    const svc = result!.contractedServices[0];
    expect(svc.deviceTypes).toEqual([]); // device de OUTRO serviço não vaza
    expect(svc.providers[0].workerName).toBeNull();
    expect(svc.providers[0].weeklyHours).toBeNull();
    expect(svc.hourlyValue).toBeNull();
    expect(svc.authorizedHours).toBeNull();
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
      .mockResolvedValueOnce(emptyRelated()) // external contacts (spec 018, PR-2)
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
      .mockResolvedValueOnce(emptyRelated()) // external contacts (spec 018, PR-2)
      .mockResolvedValueOnce(emptyRelated())
      .mockResolvedValueOnce(emptyRelated())
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
      .mockResolvedValueOnce(emptyRelated()) // external contacts (spec 018, PR-2)
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

// ── D286 / lex P3: a célula decide ANTES do KMS ───────────────────────────────
// A prova é o espião com ZERO chamadas — não uma leitura do código. É o mesmo
// desenho da C3 de prestador (`projectWorkerFields`): redigir DEPOIS de
// descriptografar não é redigir, o texto claro já existiu em memória.
describe('fetchPatientDetail — containers sem célula NÃO passam pelo KMS (D286, lex P3)', () => {
  function stackComTudo() {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [basePatientRow({ contactEmailEncrypted: 'enc-mail-p' })] })
      .mockResolvedValueOnce({ rows: [{ id: 'resp-1', first_name: 'María', last_name: 'López', relationship: 'Madre', phone_encrypted: 'enc-phone-r1', email_encrypted: 'enc-email-r1', document_number_encrypted: 'enc-doc-r1', document_type: 'DNI', is_primary: true, display_order: 1, source: 'admin_manual' }] })
      .mockResolvedValueOnce({ rows: [] }) // addresses
      .mockResolvedValueOnce({ rows: [{ id: 'prof-1', name: 'Dr. García', phone_encrypted: 'enc-phone-p1', email_encrypted: 'enc-email-p1', display_order: 1, is_team: true }] })
      .mockResolvedValueOnce({ rows: [] }) // external contacts (spec 018, PR-2)
      .mockResolvedValueOnce({ rows: [] }) // vacancies
      .mockResolvedValueOnce({ rows: [] }) // contracted services
      .mockResolvedValueOnce({ rows: [] }); // coverage emergency contacts (417)
    return makePool(queryImpl);
  }
  const reads = (on: string[]) => ({
    identity: on.includes('identity'), clinical: on.includes('clinical'), careTeam: on.includes('careTeam'),
    family: on.includes('family'), chat: on.includes('chat'), coverage: on.includes('coverage'),
    address: on.includes('address'), services: on.includes('services'), therapeuticProject: on.includes('therapeuticProject'),
  });

  it('🔴 sem familiares, equipe nem identidade: kms.decrypt tem 0 chamadas e os campos saem vazios', async () => {
    const enc = makeEncryptionService();
    const result = await fetchPatientDetail(stackComTudo(), enc, PATIENT_ID, reads([]));
    expect((enc.decrypt as jest.Mock)).toHaveBeenCalledTimes(0);
    expect(result?.responsibles).toEqual([]);
    expect(result?.professionals).toEqual([]);
    expect(result?.contactEmail).toBeNull();
  });

  it('só familiares: descriptografa os 3 campos do responsável e NADA da equipe nem do e-mail', async () => {
    const enc = makeEncryptionService();
    const result = await fetchPatientDetail(stackComTudo(), enc, PATIENT_ID, reads(['family']));
    const chamados = (enc.decrypt as jest.Mock).mock.calls.map((c) => c[0]);
    expect(chamados.sort()).toEqual(['enc-doc-r1', 'enc-email-r1', 'enc-phone-r1']);
    expect(result?.responsibles).toHaveLength(1);
    expect(result?.professionals).toEqual([]);
    expect(result?.contactEmail).toBeNull();
  });

  it('417 (D301) — cobertura: decifra SÓ os contatos de emergência da cobertura; o profissional direto exige TAMBÉM equipe (lex C3); sem a célula, 0 decrypt e []', async () => {
    const comContato = () => {
      const queryImpl = jest.fn();
      queryImpl
        .mockResolvedValueOnce({ rows: [basePatientRow({ contactEmailEncrypted: 'enc-mail-p' })] })
        .mockResolvedValueOnce({ rows: [{ id: 'resp-1', first_name: 'María', last_name: 'López', relationship: 'Madre', phone_encrypted: 'enc-phone-r1', email_encrypted: 'enc-email-r1', document_number_encrypted: 'enc-doc-r1', document_type: 'DNI', is_primary: true, display_order: 1, source: 'admin_manual' }] })
        .mockResolvedValueOnce({ rows: [] }) // addresses
        .mockResolvedValueOnce({ rows: [] }) // professionals
        .mockResolvedValueOnce({ rows: [] }) // external contacts (spec 018, PR-2)
        .mockResolvedValueOnce({ rows: [] }) // vacancies
        .mockResolvedValueOnce({ rows: [] }) // contracted services
        .mockResolvedValueOnce({ rows: [
          { id: 'c1', kind: 'AMBULANCE', name: 'Ambulancia', phone_encrypted: 'enc-cov-1', sort_order: 0 },
          { id: 'c2', kind: 'DIRECT_PROFESSIONAL', name: 'Dra. Pérez', phone_encrypted: 'enc-cov-2', sort_order: 1 },
        ] }); // coverage emergency contacts (417)
      return makePool(queryImpl);
    };
    // Só cobertura: a institucional sai; o profissional direto NÃO sai e NÃO é decifrado.
    const enc = makeEncryptionService();
    const soCobertura = await fetchPatientDetail(comContato(), enc, PATIENT_ID, reads(['coverage']));
    expect((enc.decrypt as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['enc-cov-1']);
    expect(soCobertura?.coverageEmergencyContacts).toEqual([{ id: 'c1', kind: 'AMBULANCE', name: 'Ambulancia', phone: 'dec(enc-cov-1)', sortOrder: 0 }]);
    expect(soCobertura?.responsibles).toEqual([]);
    expect(soCobertura?.coverageDirectProfessionalRedacted).toBe(true); // marcador constante: a lista NÃO é completa
    // Cobertura + equipe: os dois saem.
    const enc2 = makeEncryptionService();
    const ambos = await fetchPatientDetail(comContato(), enc2, PATIENT_ID, reads(['coverage', 'careTeam']));
    expect((enc2.decrypt as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['enc-cov-1', 'enc-cov-2']);
    expect(ambos?.coverageEmergencyContacts?.map((c) => c.kind)).toEqual(['AMBULANCE', 'DIRECT_PROFESSIONAL']);
    expect(ambos?.coverageDirectProfessionalRedacted).toBe(false);
    // Só família: nada da cobertura é decifrado.
    const enc3 = makeEncryptionService();
    const sem = await fetchPatientDetail(comContato(), enc3, PATIENT_ID, reads(['family']));
    expect((enc3.decrypt as jest.Mock).mock.calls.map((c) => c[0])).not.toContain('enc-cov-1');
    expect(sem?.coverageEmergencyContacts).toEqual([]);
    expect(sem?.coverageDirectProfessionalRedacted).toBe(false); // sem cobertura o campo inteiro é redigido pelo container
  });

  it('417 bulkhead (D167): a tabela de contatos ainda não existe (417 manual em prod) → a ficha NÃO cai, campo `[]` + `coverageEmergencyContactsUnavailable: true`, erro reportado', async () => {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [basePatientRow()] })
      .mockResolvedValueOnce({ rows: [] }) // responsibles
      .mockResolvedValueOnce({ rows: [] }) // addresses
      .mockResolvedValueOnce({ rows: [] }) // professionals
      .mockResolvedValueOnce({ rows: [] }) // external contacts (spec 018, PR-2)
      .mockResolvedValueOnce({ rows: [] }) // vacancies
      .mockResolvedValueOnce({ rows: [] }) // contracted services
      .mockRejectedValueOnce(new Error('relation "patient_coverage_emergency_contacts" does not exist')); // coverage contacts
    const result = await fetchPatientDetail(makePool(queryImpl), makeEncryptionService(), PATIENT_ID, reads(['coverage', 'careTeam']));
    expect(result?.coverageEmergencyContacts).toEqual([]);
    expect(result?.coverageEmergencyContactsUnavailable).toBe(true);
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ source: 'PatientDetailQueryHelper:coverageEmergencyContacts' }));
    // Rejeição que não é Error (driver antigo): vira Error no relato.
    const q2 = jest.fn();
    q2.mockResolvedValueOnce({ rows: [basePatientRow()] });
    for (let i = 0; i < 6; i++) q2.mockResolvedValueOnce({ rows: [] });
    q2.mockRejectedValueOnce('boom');
    mockReportError.mockClear();
    await fetchPatientDetail(makePool(q2), makeEncryptionService(), PATIENT_ID, reads(['coverage']));
    expect(mockReportError.mock.calls[0][0]).toBeInstanceOf(Error);
    // Caminho feliz: o marcador é false.
    const ok = await fetchPatientDetail(stackComTudo(), makeEncryptionService(), PATIENT_ID, reads(['coverage']));
    expect(ok?.coverageEmergencyContactsUnavailable).toBe(false);
  });

  it('só identidade: descriptografa o e-mail de contato e mais nada', async () => {
    const enc = makeEncryptionService();
    const result = await fetchPatientDetail(stackComTudo(), enc, PATIENT_ID, reads(['identity']));
    expect((enc.decrypt as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['enc-mail-p']);
    expect(result?.contactEmail).toBe('dec(enc-mail-p)');
  });

  it('sem o argumento (engine não decidiu) o comportamento é o de antes: tudo descriptografado', async () => {
    const enc = makeEncryptionService();
    const result = await fetchPatientDetail(stackComTudo(), enc, PATIENT_ID);
    expect((enc.decrypt as jest.Mock).mock.calls.length).toBe(6);
    expect(result?.responsibles).toHaveLength(1);
    expect(result?.professionals).toHaveLength(1);
  });
});

// Spec 018, PR-2: contatos externos + marca de emergência — mesma régua dos responsáveis (family).
describe('fetchPatientDetail — contatos externos e marca de emergência (spec 018, PR-2)', () => {
  const reads = (on: string[]) => ({
    identity: on.includes('identity'), clinical: on.includes('clinical'), careTeam: on.includes('careTeam'),
    family: on.includes('family'), chat: on.includes('chat'), coverage: on.includes('coverage'),
    address: on.includes('address'), services: on.includes('services'), therapeuticProject: on.includes('therapeuticProject'),
  });

  function stackComContatoExterno(overrides: Record<string, unknown> = {}) {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [basePatientRow({ emergencyResponsibleId: null, emergencyExternalContactId: 'x1', ...overrides })] })
      .mockResolvedValueOnce({ rows: [] }) // responsibles
      .mockResolvedValueOnce({ rows: [] }) // addresses
      .mockResolvedValueOnce({ rows: [] }) // professionals
      .mockResolvedValueOnce({ rows: [{ id: 'x1', relation: 'TEACHER', name: 'Prof. Gómez', phone_encrypted: 'enc-ext-1', sort_order: 0 }] }) // external contacts
      .mockResolvedValueOnce({ rows: [] }) // vacancies
      .mockResolvedValueOnce({ rows: [] }) // contracted services
      .mockResolvedValueOnce({ rows: [] }); // coverage emergency contacts
    return makePool(queryImpl);
  }

  it('com patient_family:read: decifra o contato externo e projeta emergencyContactRef apontando para ele', async () => {
    const enc = makeEncryptionService();
    const result = await fetchPatientDetail(stackComContatoExterno(), enc, PATIENT_ID, reads(['family']));
    expect(result?.externalContacts).toEqual([{ id: 'x1', relation: 'TEACHER', name: 'Prof. Gómez', phone: 'dec(enc-ext-1)', active: true }]);
    expect(result?.emergencyContactRef).toEqual({ kind: 'EXTERNAL', id: 'x1' });
    expect((enc.decrypt as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['enc-ext-1']);
  });

  it('sem patient_family:read: 0 decrypt, externalContacts [] e emergencyContactRef null (D113/lex C3 — não vaza nem QUAL contato é a marca)', async () => {
    const enc = makeEncryptionService();
    const result = await fetchPatientDetail(stackComContatoExterno(), enc, PATIENT_ID, reads([]));
    expect(result?.externalContacts).toEqual([]);
    expect(result?.emergencyContactRef).toBeNull();
    expect(enc.decrypt).not.toHaveBeenCalled();
  });

  it('marca apontando para um RESPONSIBLE: emergencyContactRef reflete a coluna certa', async () => {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [basePatientRow({ emergencyResponsibleId: 'r1', emergencyExternalContactId: null })] })
      .mockResolvedValueOnce({ rows: [] }) // responsibles
      .mockResolvedValueOnce({ rows: [] }) // addresses
      .mockResolvedValueOnce({ rows: [] }) // professionals
      .mockResolvedValueOnce({ rows: [] }) // external contacts
      .mockResolvedValueOnce({ rows: [] }) // vacancies
      .mockResolvedValueOnce({ rows: [] }) // contracted services
      .mockResolvedValueOnce({ rows: [] }); // coverage emergency contacts
    const result = await fetchPatientDetail(makePool(queryImpl), makeEncryptionService(), PATIENT_ID, reads(['family']));
    expect(result?.emergencyContactRef).toEqual({ kind: 'RESPONSIBLE', id: 'r1' });
  });

  it('sem marca definida (as duas colunas NULL): emergencyContactRef null mesmo com a célula', async () => {
    const queryImpl = jest.fn();
    queryImpl
      .mockResolvedValueOnce({ rows: [basePatientRow({ emergencyResponsibleId: null, emergencyExternalContactId: null })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await fetchPatientDetail(makePool(queryImpl), makeEncryptionService(), PATIENT_ID, reads(['family']));
    expect(result?.emergencyContactRef).toBeNull();
  });
});
