/**
 * AdminWorkersDetailBuilder.test.ts
 *
 * Teste NOVO, escrito para a branch de hotfix de PRD
 * (hotfix/worker-document-view-url-dono-prd), compatível com a `main` — sem
 * nada de ABAC/células/`redacted` (isso só existe na `stage`, D286 fase 2;
 * `buildWorkerDetailResponse` aqui tem 4 parâmetros, sem `cells`).
 *
 * `AdminWorkersController.test.ts` já cobre o arquivo quase inteiro via
 * integração com o controller (worker completo, documentos ausentes,
 * encuadres, service areas, eligibilidade, todos os 15 campos PII etc.) —
 * medido ANTES desta rodada em 84.44 stmt / 95.49 branch / 81.81 func /
 * 83.33 line (`npx jest AdminWorkersController.test.ts --coverage
 * --collectCoverageFrom=".../AdminWorkersDetailBuilder.ts"`, linhas não
 * cobertas: 25-27, 66-67, 230-238). Este arquivo NÃO reexercita esse
 * caminho (ZERO código repetido) — cobre só os 3 gaps, todos ligados ao
 * hotfix:
 *
 *   1. `toSignedUrl` — o catch (25-27): o hotfix (rodada 2, R4) proíbe logar
 *      `filePath` e `err.message` (podem carregar o caminho do objeto GCS
 *      rejeitado); só workerId + NOME DA CLASSE do erro. Nenhum teste
 *      existente força `generateViewSignedUrl` a rejeitar.
 *   2. `buildDocumentsWithSignedUrls` — o loop de `document_validations`
 *      (66-67): nenhum teste existente passa `document_validations` não-nulo.
 *   3. `buildWorkerDetailResponse` — mapeamento de `availability` e `tags`
 *      (230-238): a suíte do controller sempre usa `rows: []` para essas duas
 *      queries, então as duas funções passadas a `.map` nunca são invocadas
 *      (a causa dos 81.81% de function coverage). Aproveitado para também
 *      provar, com uma linha real, que os documentos do worker SOBREVIVENTE
 *      passam a lista de absorvidos (o comportamento central deste hotfix)
 *      para `generateViewSignedUrl`.
 */

const mockQuery = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn((_ctx: unknown, fn: () => unknown) => fn()) },
}));

// WorkerApplicationRepository e BlockedApplicationQueryRepository (instanciados
// direto dentro de buildWorkerDetailResponse) pegam o pool por aqui.
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import type { Pool } from 'pg';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type { GCSStorageService } from '../../../infrastructure/GCSStorageService';
import {
  toSignedUrl,
  buildDocumentsWithSignedUrls,
  buildWorkerDetailResponse,
} from '../AdminWorkersDetailBuilder';

const WORKER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeWorkerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKER_ID,
    email: 'maria@example.com',
    phone: '+5491188888888',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    status: 'REGISTERED',
    data_sources: ['candidatos'],
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
    deleted_at: null,
    document_type: 'DNI',
    profession: 'CAREGIVER',
    occupation: 'AT',
    knowledge_level: 'UNIVERSITY',
    title_certificate: 'Diploma AT',
    experience_types: ['TEA'],
    years_experience: '5_10',
    preferred_types: ['TEA'],
    preferred_age_range: ['children'],
    hobbies: [],
    diagnostic_preferences: [],
    first_name_encrypted: 'enc_first',
    last_name_encrypted: 'enc_last',
    birth_date_encrypted: 'enc_birth',
    sex_encrypted: 'enc_sex',
    gender_encrypted: 'enc_gender',
    document_number_encrypted: 'enc_doc',
    profile_photo_url_encrypted: 'enc_photo',
    languages_encrypted: 'enc_langs',
    whatsapp_phone_encrypted: 'enc_whatsapp',
    linkedin_url_encrypted: 'enc_linkedin',
    sexual_orientation_encrypted: 'enc_orientation',
    race_encrypted: 'enc_race',
    religion_encrypted: 'enc_religion',
    weight_kg_encrypted: 'enc_weight',
    height_cm_encrypted: 'enc_height',
    is_test: false,
    ana_care_id: null,
    ana_care_synced_at: null,
    ...overrides,
  };
}

function makeDecrypt() {
  return jest.fn((v: string | null) => Promise.resolve(v ? String(v).replace('enc_', '') : null));
}

// ─── 1. toSignedUrl — catch (linhas 25-27) ─────────────────────────────────

describe('toSignedUrl — catch de generateViewSignedUrl', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('retorna null e loga workerId + CLASSE do erro — NUNCA filePath nem err.message', async () => {
    const filePath = 'workers/absorvido-x/identity_document.pdf';
    const boom = new Error(`objeto ${filePath} não encontrado no bucket`);
    const gcs = { generateViewSignedUrl: jest.fn().mockRejectedValue(boom) } as unknown as GCSStorageService;

    const result = await toSignedUrl(gcs, filePath, ['worker-vivo-1', 'absorvido-x']);

    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = consoleErrorSpy.mock.calls[0].map(String).join(' | ');
    expect(logged).toContain('worker-vivo-1');
    expect(logged).toContain('Error');
    expect(logged).not.toContain(filePath);
    expect(logged).not.toContain(boom.message);
  });

  it('rejeição sem ser instância de Error usa typeof (branch não-Error do ternário)', async () => {
    const gcs = { generateViewSignedUrl: jest.fn().mockRejectedValue('boom-string-plano') } as unknown as GCSStorageService;

    const result = await toSignedUrl(gcs, 'x.pdf', ['worker-vivo-1']);

    expect(result).toBeNull();
    const logged = consoleErrorSpy.mock.calls[0].map(String).join(' | ');
    expect(logged).toContain('worker-vivo-1');
    expect(logged).toContain('string');
    expect(logged).not.toContain('boom-string-plano');
  });

  it('filePath null: devolve null sem chamar o GCS (guard já coberto, aqui só ancora o contrato)', async () => {
    const gcs = { generateViewSignedUrl: jest.fn() } as unknown as GCSStorageService;
    const result = await toSignedUrl(gcs, null, ['worker-vivo-1']);
    expect(result).toBeNull();
    expect(gcs.generateViewSignedUrl).not.toHaveBeenCalled();
  });
});

// ─── 2. buildDocumentsWithSignedUrls — loop de document_validations (66-67) ─

describe('buildDocumentsWithSignedUrls — document_validations', () => {
  function makeGcs() {
    return {
      generateViewSignedUrl: jest.fn((p: string) => Promise.resolve(`signed:${p}`)),
    } as unknown as GCSStorageService;
  }

  function baseDoc(overrides: Record<string, unknown> = {}) {
    return {
      id: 'doc-1',
      resume_cv_url: null,
      identity_document_url: null,
      identity_document_back_url: null,
      criminal_record_url: null,
      professional_registration_url: null,
      liability_insurance_url: null,
      monotributo_certificate_url: null,
      at_certificate_url: null,
      additional_certificates_urls: [],
      documents_status: null,
      document_validations: null,
      review_notes: null,
      reviewed_by: null,
      reviewed_at: null,
      submitted_at: null,
      ...overrides,
    };
  }

  it('mapeia validated_by/validated_at (snake_case) para validatedBy/validatedAt (camelCase), uma entrada por chave', async () => {
    const doc = baseDoc({
      document_validations: {
        resume_cv: { validated_by: 'admin-1', validated_at: '2026-09-01T00:00:00Z' },
        identity_document: { validated_by: 'admin-2', validated_at: '2026-09-02T00:00:00Z' },
      },
    });

    const result = await buildDocumentsWithSignedUrls(makeGcs(), doc, ['w-1']);

    expect(result.documentValidations).toEqual({
      resume_cv: { validatedBy: 'admin-1', validatedAt: '2026-09-01T00:00:00Z' },
      identity_document: { validatedBy: 'admin-2', validatedAt: '2026-09-02T00:00:00Z' },
    });
  });

  it('document_validations null vira objeto vazio, sem rodar o loop', async () => {
    const result = await buildDocumentsWithSignedUrls(makeGcs(), baseDoc(), ['w-1']);
    expect(result.documentValidations).toEqual({});
    expect(result.documentsStatus).toBe('pending');
  });
});

// ─── 3. buildWorkerDetailResponse — availability/tags com linha real (230-238)
//        + comportamento central do hotfix: doc do sobrevivente usa allowedWorkerIds
//        vindo de findAbsorbedWorkerIds ─────────────────────────────────────

describe('buildWorkerDetailResponse — availability, tags e absorvidos', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('availability e tags vêm mapeados (camelCase) quando as queries trazem linha; documentos do sobrevivente assinam com [próprio, ...absorvidos]', async () => {
    const enc = { decrypt: makeDecrypt() } as unknown as KMSEncryptionService;
    const gcs = {
      generateViewSignedUrl: jest.fn((p: string) => Promise.resolve(`signed:${p}`)),
    } as unknown as GCSStorageService;

    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'doc-1',
          // Caminho gravado com o prefixo do worker ABSORVIDO — o cenário que o
          // hotfix existe para resolver (merge reparenta a linha, não o objeto GCS).
          resume_cv_url: 'workers/absorvido-1/cv.pdf',
          identity_document_url: null, identity_document_back_url: null,
          criminal_record_url: null, professional_registration_url: null,
          liability_insurance_url: null, monotributo_certificate_url: null,
          at_certificate_url: null, additional_certificates_urls: [],
          documents_status: 'approved', document_validations: null,
          review_notes: null, reviewed_by: null, reviewed_at: null, submitted_at: null,
        }],
      }) // docs
      .mockResolvedValueOnce({ rows: [] }) // serviceAreas
      .mockResolvedValueOnce({ rows: [] }) // location
      .mockResolvedValueOnce({ rows: [] }) // WJA (listEngagementsByWorker)
      .mockResolvedValueOnce({ rows: [] }) // blocked (listByWorker)
      .mockResolvedValueOnce({
        rows: [{
          id: 'av-1', day_of_week: 1, start_time: '08:00', end_time: '12:00',
          timezone: 'America/Argentina/Buenos_Aires', crosses_midnight: false,
        }],
      }) // availability
      .mockResolvedValueOnce({
        rows: [{ id: 'tag-1', name: 'VIP', color: '#000000', description: 'prioridade alta' }],
      }) // tags
      .mockResolvedValueOnce({ rows: [{ id: 'absorvido-1' }] }); // findAbsorbedWorkerIds

    const db = { query: mockQuery } as unknown as Pool;
    const result = await buildWorkerDetailResponse(db, enc, gcs, makeWorkerRow());

    expect(result.availability).toEqual([{
      id: 'av-1', dayOfWeek: 1, startTime: '08:00', endTime: '12:00',
      timezone: 'America/Argentina/Buenos_Aires', crossesMidnight: false,
    }]);
    expect(result.tags).toEqual([{ id: 'tag-1', name: 'VIP', color: '#000000', description: 'prioridade alta' }]);

    // O núcleo do hotfix: allowedWorkerIds = [próprio, ...absorvidos achados].
    expect(gcs.generateViewSignedUrl).toHaveBeenCalledWith(
      'workers/absorvido-1/cv.pdf',
      [WORKER_ID, 'absorvido-1'],
    );
  });

  it('tags sem description vira undefined (branch `?? undefined`)', async () => {
    const enc = { decrypt: makeDecrypt() } as unknown as KMSEncryptionService;
    const gcs = { generateViewSignedUrl: jest.fn() } as unknown as GCSStorageService;

    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // docs (sem documento -> não chama findAbsorbedWorkerIds)
      .mockResolvedValueOnce({ rows: [] }) // serviceAreas
      .mockResolvedValueOnce({ rows: [] }) // location
      .mockResolvedValueOnce({ rows: [] }) // WJA
      .mockResolvedValueOnce({ rows: [] }) // blocked
      .mockResolvedValueOnce({ rows: [] }) // availability
      .mockResolvedValueOnce({ rows: [{ id: 'tag-2', name: 'Sem descrição', color: '#fff', description: null }] }); // tags

    const db = { query: mockQuery } as unknown as Pool;
    const result = await buildWorkerDetailResponse(db, enc, gcs, makeWorkerRow());

    expect(result.tags).toEqual([{ id: 'tag-2', name: 'Sem descrição', color: '#fff', description: undefined }]);
    expect(result.documents).toBeNull();
    expect(gcs.generateViewSignedUrl).not.toHaveBeenCalled();
  });
});
