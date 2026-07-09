/**
 * AdminWorkersController.test.ts
 *
 * Testes unitários para o método getWorkerById do AdminWorkersController.
 *
 * Cenários cobertos:
 *   1. Happy path — worker encontrado com todos os dados relacionados
 *   2. 404 — worker não encontrado (zero rows)
 *   3. 500 — erro de banco de dados
 *   4. 500 — erro de decryption
 *   5. Worker sem documentos (documents: null)
 *   6. Worker sem location (location: null)
 *   7. Worker sem encuadres (encuadres: [])
 *   8. Worker sem service areas (serviceAreas: [])
 *   9. Eligibility: isMatchable/isActive para cada status
 *  10. Platform mapping (talentum, enlite_app, planilla_operativa, etc.)
 *  11. Languages parsing (JSON válido, string simples, null)
 *  12. Encuadre patientName (first + last, somente first, null)
 *  13. Decrypt é chamado para todos os 15 campos PII
 */

const mockQuery = jest.fn();
const mockDecrypt = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  reportError: jest.fn(),
  loggingAls: {
    run: jest.fn((_, fn: () => unknown) => fn()),
  },
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
      }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn().mockResolvedValue('encrypted'),
    decrypt: mockDecrypt,
    encryptBatch: jest.fn().mockResolvedValue({}),
  })),
}));

jest.mock('../../../infrastructure/GCSStorageService', () => ({
  GCSStorageService: jest.fn().mockImplementation(() => ({
    generateViewSignedUrl: jest.fn().mockImplementation((path: string) =>
      Promise.resolve(`signed:${path}`),
    ),
  })),
}));

jest.mock('@shared/security/BlindIndexService', () => ({
  BlindIndexService: jest.fn().mockImplementation(() => ({
    generateSearchTrigramBidx: jest.fn().mockImplementation((term: string) => {
      const trimmed = term.trim();
      const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
      const valid = tokens.filter((t) => t.length >= 3);
      if (valid.length === 0) {
        return Promise.reject(new Error('Search term must have at least 3 characters'));
      }
      return Promise.resolve([Buffer.from('fakebidx')]);
    }),
    generateValueBidx: jest.fn().mockImplementation((value: string | null | undefined) => {
      if (!value || value.trim() === '') return Promise.resolve(null);
      return Promise.resolve(Buffer.from('fakevaluebidx'));
    }),
    generateValuesBidx: jest.fn().mockImplementation((values: string[] | null | undefined) => {
      if (!values || values.length === 0) return Promise.resolve([]);
      return Promise.resolve(values.map(() => Buffer.from('fakevaluebidx')));
    }),
    serializeForPg: jest.fn().mockImplementation((buffers: Buffer[]) => {
      if (!buffers || buffers.length === 0) return null;
      return '{"\\\\xfakebidx"}';
    }),
  })),
}));

import { AdminWorkersController } from '../AdminWorkersController';
import { AdminWorkersAuxController } from '../AdminWorkersAuxController';
import { Request, Response } from 'express';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReqRes(
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): [Request, Response] {
  const req = { params, query, body: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

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
    experience_types: ['TEA', 'DOWN'],
    years_experience: '5_10',
    preferred_types: ['TEA'],
    preferred_age_range: ['children'],
    hobbies: ['leitura'],
    diagnostic_preferences: ['TEA'],
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
    ...overrides,
  };
}

function makeDocRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    resume_cv_url: 'https://storage/cv.pdf',
    identity_document_url: 'https://storage/dni.pdf',
    criminal_record_url: null,
    professional_registration_url: null,
    liability_insurance_url: null,
    additional_certificates_urls: ['https://storage/cert1.pdf'],
    documents_status: 'submitted',
    review_notes: null,
    reviewed_by: null,
    reviewed_at: null,
    submitted_at: '2025-02-01T00:00:00Z',
    ...overrides,
  };
}

function makeServiceAreaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sa-1',
    address_line: 'Av. Corrientes 1234',
    latitude: '-34.60368',
    longitude: '-58.38159',
    radius_km: 10,
    ...overrides,
  };
}

function makeLocationRow(overrides: Record<string, unknown> = {}) {
  return {
    address: 'Calle Falsa 123',
    city: 'Buenos Aires',
    work_zone: 'Palermo',
    interest_zone: 'Belgrano',
    ...overrides,
  };
}

// Linha WJA como retornada por WorkerApplicationRepository.listEngagementsByWorker
// (aba de encuadre passou a ler WJA ∪ blocked, não mais a tabela encuadres direto).
function makeEncuadreRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enc-1',
    job_posting_id: 'jp-1',
    funnel_stage: 'SELECTED',
    source: 'talentum',
    case_number: 42,
    vacancy_number: 1,
    vacancy_status: 'ACTIVE',
    patient_first_name: 'Juan',
    patient_last_name: 'Perez',
    resultado: 'SELECCIONADO',
    interview_date: '2025-03-01',
    interview_time: '10:00',
    recruiter_name: 'Ana',
    coordinator_name: 'Carlos',
    rejection_reason: null,
    rejection_reason_category: null,
    attended: true,
    created_at: '2025-03-01T10:00:00Z',
    ...overrides,
  };
}

// Linha bruta como retornada por BlockedApplicationQueryRepository.listByWorker
// (tentativa bloqueada não-promovida). created_at chega como Date do pg — o mapper
// chama `.toISOString()`, então o mock DEVE passar um Date (não string).
function makeBlockedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'blk-1',
    job_posting_id: 'jp-800',
    case_number: 800,
    vacancy_number: 2,
    vacancy_status: 'BUSQUEDA',
    patient_first_name: 'Julia',
    patient_last_name: 'Blocked',
    blocked_reason: 'registration_incomplete',
    missing_fields: ['criminal_record', 'phone'],
    attempt_count: 2,
    // Mais recente que o WJA (2025-03-01) → deve vir PRIMEIRO na ordenação por createdAt desc.
    created_at: new Date('2025-06-01T10:00:00Z'),
    ...overrides,
  };
}

/**
 * Configura mockQuery para retornar os dados de getWorkerById.
 * Chamada 1: worker query
 * Chamadas 2-7: docs, serviceAreas, locations, encuadres, availability, tags (em Promise.all)
 */
function setupFullMocks(opts: {
  workerRow?: Record<string, unknown> | null;
  docRows?: Record<string, unknown>[];
  serviceAreaRows?: Record<string, unknown>[];
  locationRows?: Record<string, unknown>[];
  encuadreRows?: Record<string, unknown>[];
  blockedRows?: Record<string, unknown>[];
  availabilityRows?: Record<string, unknown>[];
  tagRows?: Record<string, unknown>[];
} = {}) {
  const workerRow = opts.workerRow === undefined ? makeWorkerRow() : opts.workerRow;

  mockQuery
    .mockResolvedValueOnce({ rows: workerRow ? [workerRow] : [] }) // worker
    .mockResolvedValueOnce({ rows: opts.docRows ?? [makeDocRow()] }) // docs
    .mockResolvedValueOnce({ rows: opts.serviceAreaRows ?? [makeServiceAreaRow()] }) // service areas
    .mockResolvedValueOnce({ rows: opts.locationRows ?? [makeLocationRow()] }) // locations
    .mockResolvedValueOnce({ rows: opts.encuadreRows ?? [makeEncuadreRow()] }) // WJA engagements
    .mockResolvedValueOnce({ rows: opts.blockedRows ?? [] }) // blocked (listByWorker)
    .mockResolvedValueOnce({ rows: opts.availabilityRows ?? [] }) // availability
    .mockResolvedValueOnce({ rows: opts.tagRows ?? [] }); // tags

  // Default decrypt: remove "enc_" prefix
  mockDecrypt.mockImplementation((val: string | null) =>
    Promise.resolve(val ? val.replace('enc_', '') : null),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// =============================================================================
// listWorkers
// =============================================================================

describe('AdminWorkersController — listWorkers', () => {
  let controller: AdminWorkersController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    controller = new AdminWorkersController();
    mockDecrypt.mockImplementation((val: string | null) =>
      Promise.resolve(val ? val.replace('enc_', '') : null),
    );
  });

  function makeListRow(overrides: Record<string, unknown> = {}) {
    return {
      id: WORKER_ID,
      email: 'maria@example.com',
      first_name_encrypted: 'enc_Maria',
      last_name_encrypted: 'enc_Garcia',
      data_sources: ['candidatos'],
      created_at: '2025-01-01T00:00:00Z',
      status: 'REGISTERED',
      documents_status: 'submitted',
      cases_count: '3',
      ...overrides,
    };
  }

  it('retorna 200 com dados paginados', async () => {
    // count query
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
    // data query
    mockQuery.mockResolvedValueOnce({ rows: [makeListRow()] });
    const [req, res] = mockReqRes({}, { limit: '10', offset: '0' } as any);

    await controller.listWorkers(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Maria Garcia');
    expect(body.data[0].casesCount).toBe(3);
    expect(body.data[0].documentsComplete).toBe(true);
    expect(body.data[0].platform).toBe('talentum');
  });

  it('aplica filtro platform=talentum', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({}, { platform: 'talentum' } as any);

    await controller.listWorkers(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Verifica que o SQL contém filtro de talentum (não usa parâmetro $1)
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("candidatos");
  });

  it('aplica filtro platform=enlite_app', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({}, { platform: 'enlite_app' } as any);

    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("data_sources IS NULL");
  });

  it('aplica filtro platform customizado via parâmetro', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({}, { platform: 'ana_care' } as any);

    await controller.listWorkers(req, res);

    // O parâmetro deve ser passado como $1 via bind
    expect(mockQuery.mock.calls[0][1]).toContain('ana_care');
  });

  it('aplica filtro docs_complete=complete', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({}, { docs_complete: 'complete' } as any);

    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("w.status = 'REGISTERED'");
  });

  it('aplica filtro docs_complete=incomplete', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({}, { docs_complete: 'incomplete' } as any);

    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("w.status = 'INCOMPLETE_REGISTER'");
  });

  it('aplica filtro docs_validated=all_validated', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({}, { docs_validated: 'all_validated' } as any);

    await controller.listWorkers(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('document_validations IS NOT NULL');
    expect(sql).toContain('jsonb_exists_all');
    expect(sql).not.toContain('NOT (');
  });

  it('aplica filtro docs_validated=pending_validation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({}, { docs_validated: 'pending_validation' } as any);

    await controller.listWorkers(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('NOT (');
    expect(sql).toContain('document_validations IS NOT NULL');
    expect(sql).toContain('jsonb_exists_all');
  });

  it('retorna 400 para docs_validated=true (valor legado inválido)', async () => {
    const [req, res] = mockReqRes({}, { docs_validated: 'true' } as any);

    await controller.listWorkers(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('retorna 400 para docs_validated=invalid', async () => {
    const [req, res] = mockReqRes({}, { docs_validated: 'invalid' } as any);

    await controller.listWorkers(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('usa email como fallback quando nome descriptografado é vazio', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [makeListRow({ first_name_encrypted: null, last_name_encrypted: null })],
    });
    mockDecrypt.mockResolvedValue(null);
    const [req, res] = mockReqRes({});

    await controller.listWorkers(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.data[0].name).toBe('maria@example.com');
  });

  it('retorna documentsComplete=false para status INCOMPLETE_REGISTER', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [makeListRow({ status: 'INCOMPLETE_REGISTER' })],
    });
    const [req, res] = mockReqRes({});

    await controller.listWorkers(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.data[0].documentsComplete).toBe(false);
  });

  it('trata total nulo do count como 0', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: null }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({});

    await controller.listWorkers(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.total).toBe(0);
  });

  it('trata cases_count nulo e data_sources nulo no row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [makeListRow({ cases_count: null, data_sources: null, status: 'INCOMPLETE_REGISTER', documents_status: 'rejected' })],
    });
    const [req, res] = mockReqRes({});

    await controller.listWorkers(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.data[0].casesCount).toBe(0);
    expect(body.data[0].platform).toBe('enlite_app');
    expect(body.data[0].documentsComplete).toBe(false);
  });

  it('retorna 500 em caso de erro', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db error'));
    const [req, res] = mockReqRes({});

    await controller.listWorkers(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Failed to list workers' }),
    );
  });

  // ─── Search filter ───────────────────────────────────────────────────────────

  describe('busca por nome, sobrenome ou email', () => {
    const JOHN_ID = 'john-snow-uuid';
    const ARYA_ID = 'arya-stark-uuid';

    function makeJohnRow() {
      return makeListRow({
        id: JOHN_ID,
        email: 'john.snow.21@gmail.com',
        first_name_encrypted: 'enc_John',
        last_name_encrypted: 'enc_Snow',
      });
    }

    function makeAryaRow() {
      return makeListRow({
        id: ARYA_ID,
        email: 'arya@winterfell.com',
        first_name_encrypted: 'enc_Arya',
        last_name_encrypted: 'enc_Stark',
      });
    }

    function setupSearchRows(rows: Record<string, unknown>[]) {
      mockQuery.mockResolvedValueOnce({ rows });
    }

    it('busca "Sno" — encontra John Snow pelo sobrenome (>= 3 chars)', async () => {
      setupSearchRows([makeJohnRow(), makeAryaRow()]);
      const [req, res] = mockReqRes({}, { search: 'Sno' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(JOHN_ID);
      expect(body.data[0].name).toBe('John Snow');
    });

    it('busca "Sn" (< 3 chars) — retorna 400', async () => {
      const [req, res] = mockReqRes({}, { search: 'Sn' } as any);

      await controller.listWorkers(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/3 characters/i);
    });

    it('busca "Joh" — encontra John Snow pelo primeiro nome (>= 3 chars)', async () => {
      setupSearchRows([makeJohnRow(), makeAryaRow()]);
      const [req, res] = mockReqRes({}, { search: 'Joh' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(JOHN_ID);
    });

    it('busca "Jo" (< 3 chars) — retorna 400', async () => {
      const [req, res] = mockReqRes({}, { search: 'Jo' } as any);

      await controller.listWorkers(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
    });

    it('busca "sno" — encontra John Snow pelo email parcial (domínio snow)', async () => {
      setupSearchRows([makeJohnRow(), makeAryaRow()]);
      const [req, res] = mockReqRes({}, { search: 'sno' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(JOHN_ID);
    });

    it('busca "21" (< 3 chars) — retorna 400', async () => {
      const [req, res] = mockReqRes({}, { search: '21' } as any);

      await controller.listWorkers(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
    });

    it('busca "gmail" — encontra John Snow pelo domínio do email', async () => {
      setupSearchRows([makeJohnRow(), makeAryaRow()]);
      const [req, res] = mockReqRes({}, { search: 'gmail' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(JOHN_ID);
    });

    it('busca é case-insensitive — "SNOW" encontra Snow', async () => {
      setupSearchRows([makeJohnRow()]);
      const [req, res] = mockReqRes({}, { search: 'SNOW' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
      expect(body.data[0].name).toBe('John Snow');
    });

    it('busca com espaços nas bordas é tratada (trim)', async () => {
      setupSearchRows([makeJohnRow()]);
      const [req, res] = mockReqRes({}, { search: '  Snow  ' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
    });

    it('busca sem resultado retorna lista vazia', async () => {
      setupSearchRows([makeJohnRow(), makeAryaRow()]);
      const [req, res] = mockReqRes({}, { search: 'Lannister' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.total).toBe(0);
      expect(body.data).toHaveLength(0);
    });

    it('busca genérica retorna múltiplos resultados quando há match', async () => {
      setupSearchRows([makeJohnRow(), makeAryaRow()]);
      const [req, res] = mockReqRes({}, { search: 'ark' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      // "ark" está em "Stark" (Arya) e "john.snow.21@gmail.com" não; só Arya matcha
      expect(body.success).toBe(true);
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(ARYA_ID);
    });

    it('busca com paginação respeita offset e limit', async () => {
      const rows = [makeJohnRow(), makeAryaRow()];
      setupSearchRows(rows);
      // ambos matcham "com" (gmail.com / winterfell.com) — pedir página 2 com limit=1
      const [req, res] = mockReqRes({}, { search: 'com', limit: '1', offset: '1' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(2);
      expect(body.data).toHaveLength(1);
      expect(body.offset).toBe(1);
      expect(body.limit).toBe(1);
    });

    it('não expõe campos internos (_firstName, _lastName) na resposta', async () => {
      setupSearchRows([makeJohnRow()]);
      const [req, res] = mockReqRes({}, { search: 'John' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      const worker = body.data[0];
      expect(worker).not.toHaveProperty('_firstName');
      expect(worker).not.toHaveProperty('_lastName');
    });

    it('busca multi-palavra — "John Snow" encontra pelo nome + sobrenome', async () => {
      setupSearchRows([makeJohnRow(), makeAryaRow()]);
      const [req, res] = mockReqRes({}, { search: 'John Snow' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
      expect(body.data[0].id).toBe(JOHN_ID);
    });

    it('busca multi-palavra — ordem invertida "Snow John" também encontra', async () => {
      setupSearchRows([makeJohnRow(), makeAryaRow()]);
      const [req, res] = mockReqRes({}, { search: 'Snow John' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
      expect(body.data[0].id).toBe(JOHN_ID);
    });

    it('busca ignora acentos/diacríticos — "jose" encontra "José"', async () => {
      mockDecrypt.mockImplementation((val: string | null) =>
        Promise.resolve(val ? val.replace('enc_', '') : null),
      );
      setupSearchRows([
        makeListRow({
          id: 'jose-uuid',
          email: 'jose@example.com',
          first_name_encrypted: 'enc_José',
          last_name_encrypted: 'enc_García',
        }),
      ]);
      const [req, res] = mockReqRes({}, { search: 'jose garcia' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
      expect(body.data[0].name).toBe('José García');
    });
  });
});

// =============================================================================
// getWorkerDateStats
// =============================================================================

describe('AdminWorkersAuxController — getWorkerDateStats', () => {
  let controller: AdminWorkersAuxController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    controller = new AdminWorkersAuxController();
  });

  it('retorna 200 com stats de hoje, ontem e últimos 7 dias', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ today: '5', yesterday: '3', seven_days_ago: '10' }],
    });
    const [req, res] = mockReqRes({});

    await controller.getWorkerDateStats(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { today: 5, yesterday: 3, sevenDaysAgo: 10 },
    });
  });

  it('SQL usa >= para contar registros dos últimos 7 dias (não apenas exatamente 7 dias atrás)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ today: '1', yesterday: '2', seven_days_ago: '15' }],
    });
    const [req, res] = mockReqRes({});

    await controller.getWorkerDateStats(req, res);

    const sql: string = mockQuery.mock.calls[0][0];
    // seven_days_ago deve usar >= (range dos últimos 7 dias), não = (dia exato)
    expect(sql).toMatch(/>=\s*\(CURRENT_TIMESTAMP.*::date\s*-\s*7/);
    // today e yesterday continuam usando = (dia exato)
    expect(sql).toMatch(/=\s*\(CURRENT_TIMESTAMP.*::date\)/);
    expect(sql).toMatch(/=\s*\(CURRENT_TIMESTAMP.*::date\s*-\s*1/);
  });

  it('retorna 500 em caso de erro', async () => {
    mockQuery.mockRejectedValueOnce(new Error('stats error'));
    const [req, res] = mockReqRes({});

    await controller.getWorkerDateStats(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Erro ao buscar estatísticas de workers',
      }),
    );
  });
});

// =============================================================================
// getWorkerById
// =============================================================================

describe('AdminWorkersController — getWorkerById', () => {
  let controller: AdminWorkersController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    controller = new AdminWorkersController();
  });

  // ── Cenário 1: Happy path ──────────────────────────────────────────────────

  describe('worker encontrado com dados completos', () => {
    it('retorna 200 com success: true', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });

    it('retorna todos os campos de identidade descriptografados', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.firstName).toBe('first');
      expect(data.lastName).toBe('last');
      expect(data.sex).toBe('sex');
      expect(data.gender).toBe('gender');
      expect(data.birthDate).toBe('birth');
      expect(data.documentNumber).toBe('doc');
      expect(data.profilePhotoUrl).toBe('photo');
      expect(data.whatsappPhone).toBe('whatsapp');
      expect(data.linkedinUrl).toBe('linkedin');
      expect(data.sexualOrientation).toBe('orientation');
      expect(data.race).toBe('race');
      expect(data.religion).toBe('religion');
      expect(data.weightKg).toBe('weight');
      expect(data.heightCm).toBe('height');
    });

    it('retorna campos de worker não-criptografados corretamente', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.id).toBe(WORKER_ID);
      expect(data.email).toBe('maria@example.com');
      expect(data.phone).toBe('+5491188888888');
      expect(data.country).toBe('AR');
      expect(data.status).toBe('REGISTERED');
      expect(data.profession).toBe('CAREGIVER');
      expect(data.occupation).toBe('AT');
      expect(data.experienceTypes).toEqual(['TEA', 'DOWN']);
      expect(data.hobbies).toEqual(['leitura']);
    });

    it('retorna documents com shape correto', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { documents } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(documents).not.toBeNull();
      expect(documents.id).toBe('doc-1');
      expect(documents.resumeCvUrl).toBe('signed:https://storage/cv.pdf');
      expect(documents.identityDocumentUrl).toBe('signed:https://storage/dni.pdf');
      expect(documents.criminalRecordUrl).toBeNull();
      expect(documents.additionalCertificatesUrls).toEqual(['signed:https://storage/cert1.pdf']);
      expect(documents.documentsStatus).toBe('submitted');
    });

    it('retorna serviceAreas com lat/lng parseados', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { serviceAreas } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(serviceAreas).toHaveLength(1);
      expect(serviceAreas[0].id).toBe('sa-1');
      expect(serviceAreas[0].address).toBe('Av. Corrientes 1234');
      expect(serviceAreas[0].lat).toBe(-34.60368);
      expect(serviceAreas[0].lng).toBe(-58.38159);
      expect(serviceAreas[0].serviceRadiusKm).toBe(10);
    });

    it('retorna location com shape correto', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { location } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(location).not.toBeNull();
      expect(location.address).toBe('Calle Falsa 123');
      expect(location.city).toBe('Buenos Aires');
      expect(location.workZone).toBe('Palermo');
      expect(location.interestZone).toBe('Belgrano');
    });

    it('retorna encuadres com patientName concatenado', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { encuadres } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(encuadres).toHaveLength(1);
      expect(encuadres[0].id).toBe('enc-1');
      expect(encuadres[0].patientName).toBe('Juan Perez');
      expect(encuadres[0].caseNumber).toBe(42);
      expect(encuadres[0].resultado).toBe('SELECCIONADO');
      expect(encuadres[0].attended).toBe(true);
    });

    // ── AC 86ajeu7vw: a aba de encuadre inclui casos BLOQUEADOS (WJA ∪ blocked) ──
    // O caso da "Júlia": clicou postular na vaga 800, foi BLOQUEADO (docs incompletos),
    // e por isso NÃO aparecia na lista de encuadres. Agora aparece, com a coluna de
    // estágio = coluna do Kanban (BLOQUEADO).
    it('inclui tentativas bloqueadas na lista de encuadres com estágio BLOQUEADO', async () => {
      setupFullMocks({
        encuadreRows: [makeEncuadreRow()], // 1 WJA (SELECTED)
        blockedRows: [makeBlockedRow()],   // 1 bloqueado (vaga 800 — caso Júlia)
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { encuadres } = (res.json as jest.Mock).mock.calls[0][0].data;
      // WJA ∪ blocked = 2 engajamentos (o bloqueado deixou de ser filtrado).
      expect(encuadres).toHaveLength(2);

      const blocked = encuadres.find((e: { id: string }) => e.id === 'blk-1');
      expect(blocked).toBeDefined();
      expect(blocked.isBlocked).toBe(true);
      expect(blocked.kanbanStage).toBe('BLOQUEADO');
      expect(blocked.caseNumber).toBe(800);
      expect(blocked.patientName).toBe('Julia Blocked');
      expect(blocked.blockedReason).toBe('registration_incomplete');
      expect(blocked.missingFields).toEqual(['criminal_record', 'phone']);
      expect(blocked.attemptCount).toBe(2);
      // Sem dados de encuadre (nunca virou WJA): sem entrevista/recrutador.
      expect(blocked.resultado).toBeNull();
      expect(blocked.recruiterName).toBeNull();
    });

    it('ordena encuadres (WJA ∪ blocked) por data desc — bloqueado mais novo vem primeiro', async () => {
      setupFullMocks({
        encuadreRows: [makeEncuadreRow()],          // 2025-03-01
        blockedRows: [makeBlockedRow()],            // 2025-06-01 (mais novo)
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { encuadres } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(encuadres[0].id).toBe('blk-1'); // bloqueado (jun) antes do WJA (mar)
      expect(encuadres[1].id).toBe('enc-1');
    });
  });

  // ── Cenário 2: 404 ────────────────────────────────────────────────────────

  describe('worker não encontrado', () => {
    it('retorna 404 com error message', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Worker not found',
      });
    });

    it('não executa queries de dados relacionados quando worker não existe', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      // Apenas a query do worker foi executada
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockDecrypt).not.toHaveBeenCalled();
    });
  });

  // ── Cenário 3: Erro de banco ──────────────────────────────────────────────

  describe('erro de banco de dados', () => {
    it('retorna 500 quando a query principal falha', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to get worker details',
          details: 'connection refused',
        }),
      );
    });

    it('retorna 500 quando query de dados relacionados falha', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeWorkerRow()] }) // worker OK
        .mockRejectedValueOnce(new Error('timeout on docs query')); // docs fail
      mockDecrypt.mockResolvedValue('decrypted');

      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── Cenário 4: Erro de decryption ─────────────────────────────────────────

  describe('erro de decryption KMS', () => {
    it('retorna 500 quando decrypt falha', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeWorkerRow()] });
      mockDecrypt.mockRejectedValue(new Error('KMS unavailable'));

      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          details: 'KMS unavailable',
        }),
      );
    });
  });

  // ── Cenário 5: Sem documentos ─────────────────────────────────────────────

  describe('worker sem documentos', () => {
    it('retorna documents: null quando não há registro em worker_documents', async () => {
      setupFullMocks({ docRows: [] });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { documents } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(documents).toBeNull();
    });
  });

  // ── Cenário 6: Sem location ───────────────────────────────────────────────

  describe('worker sem location', () => {
    it('retorna location: null quando não há registro em worker_service_areas', async () => {
      setupFullMocks({ locationRows: [] });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { location } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(location).toBeNull();
    });
  });

  // ── Cenário 7: Sem encuadres ──────────────────────────────────────────────

  describe('worker sem encuadres', () => {
    it('retorna encuadres: [] quando não há registros', async () => {
      setupFullMocks({ encuadreRows: [] });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { encuadres } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(encuadres).toEqual([]);
    });
  });

  // ── Cenário 8: Sem service areas ──────────────────────────────────────────

  describe('worker sem service areas', () => {
    it('retorna serviceAreas: [] quando não há registros', async () => {
      setupFullMocks({ serviceAreaRows: [] });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { serviceAreas } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(serviceAreas).toEqual([]);
    });
  });

  // ── Cenário 9: Eligibility ────────────────────────────────────────────────

  describe('isMatchable e isActive', () => {
    it('REGISTERED + não deletado → isMatchable=true, isActive=true', async () => {
      setupFullMocks({ workerRow: makeWorkerRow({ status: 'REGISTERED', deleted_at: null }) });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.isMatchable).toBe(true);
      expect(data.isActive).toBe(true);
    });

    it('INCOMPLETE_REGISTER → isMatchable=false, isActive=true', async () => {
      setupFullMocks({ workerRow: makeWorkerRow({ status: 'INCOMPLETE_REGISTER' }) });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.isMatchable).toBe(false);
      expect(data.isActive).toBe(true);
    });

    it('DISABLED → isMatchable=false, isActive=false', async () => {
      setupFullMocks({ workerRow: makeWorkerRow({ status: 'DISABLED' }) });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.isMatchable).toBe(false);
      expect(data.isActive).toBe(false);
    });

    it('REGISTERED + deleted_at presente → isMatchable=false, isActive=false', async () => {
      setupFullMocks({
        workerRow: makeWorkerRow({ status: 'REGISTERED', deleted_at: '2025-06-01T00:00:00Z' }),
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.isMatchable).toBe(false);
      expect(data.isActive).toBe(false);
    });
  });

  // ── Cenário 10: Platform mapping ──────────────────────────────────────────

  describe('platform mapping', () => {
    it.each([
      { dataSources: ['candidatos'], expected: 'talentum' },
      { dataSources: ['candidatos_no_terminaron'], expected: 'talentum' },
      { dataSources: ['planilla_operativa'], expected: 'planilla_operativa' },
      { dataSources: ['ana_care'], expected: 'ana_care' },
      { dataSources: ['talent_search'], expected: 'talent_search' },
      { dataSources: null, expected: 'enlite_app' },
      { dataSources: [], expected: 'enlite_app' },
      { dataSources: ['custom_source'], expected: 'custom_source' },
    ])('data_sources=$dataSources → platform=$expected', async ({ dataSources, expected }) => {
      setupFullMocks({ workerRow: makeWorkerRow({ data_sources: dataSources }) });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.platform).toBe(expected);
    });
  });

  // ── Cenário 11: Languages parsing ─────────────────────────────────────────

  describe('languages parsing', () => {
    it('parseia JSON array corretamente', async () => {
      setupFullMocks();
      mockDecrypt.mockImplementation((val: string | null) => {
        if (val === 'enc_langs') return Promise.resolve('["es","pt"]');
        return Promise.resolve(val ? val.replace('enc_', '') : null);
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.languages).toEqual(['es', 'pt']);
    });

    it('usa string como fallback quando JSON parsing falha', async () => {
      setupFullMocks();
      mockDecrypt.mockImplementation((val: string | null) => {
        if (val === 'enc_langs') return Promise.resolve('espanol');
        return Promise.resolve(val ? val.replace('enc_', '') : null);
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.languages).toEqual(['espanol']);
    });

    it('retorna array vazio quando languages é null', async () => {
      setupFullMocks();
      mockDecrypt.mockImplementation((val: string | null) => {
        if (val === 'enc_langs') return Promise.resolve(null);
        return Promise.resolve(val ? val.replace('enc_', '') : null);
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.languages).toEqual([]);
    });
  });

  // ── Cenário 12: patientName concatenation ─────────────────────────────────

  describe('encuadre patientName', () => {
    it('concatena first + last name do paciente', async () => {
      setupFullMocks({
        encuadreRows: [makeEncuadreRow({ patient_first_name: 'Ana', patient_last_name: 'Lopez' })],
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { encuadres } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(encuadres[0].patientName).toBe('Ana Lopez');
    });

    it('usa somente first name quando last é null', async () => {
      setupFullMocks({
        encuadreRows: [makeEncuadreRow({ patient_first_name: 'Ana', patient_last_name: null })],
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { encuadres } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(encuadres[0].patientName).toBe('Ana');
    });

    it('retorna null quando ambos nomes são null', async () => {
      setupFullMocks({
        encuadreRows: [makeEncuadreRow({ patient_first_name: null, patient_last_name: null })],
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { encuadres } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(encuadres[0].patientName).toBeNull();
    });
  });

  // ── Cenário 13: Decrypt chamado para todos os 15 campos ──────────────────

  describe('decrypt é chamado para todos os campos PII', () => {
    it('chama decrypt exatamente 15 vezes (um por campo PII)', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      expect(mockDecrypt).toHaveBeenCalledTimes(15);
      expect(mockDecrypt).toHaveBeenCalledWith('enc_first');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_last');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_birth');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_sex');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_gender');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_doc');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_photo');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_langs');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_whatsapp');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_linkedin');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_orientation');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_race');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_religion');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_weight');
      expect(mockDecrypt).toHaveBeenCalledWith('enc_height');
    });
  });

  // ── Cenário 14: Null coalescing para campos opcionais ─────────────────────

  describe('campos null do worker são retornados como null', () => {
    it('campos opcionais null não quebram o response', async () => {
      setupFullMocks({
        workerRow: makeWorkerRow({
          phone: null,
          data_sources: null,
          document_type: null,
          profession: null,
          occupation: null,
          knowledge_level: null,
          title_certificate: null,
          experience_types: null,
          years_experience: null,
          preferred_types: null,
          preferred_age_range: null,
          hobbies: null,
          diagnostic_preferences: null,
        }),
      });
      mockDecrypt.mockResolvedValue(null);
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.phone).toBeNull();
      expect(data.dataSources).toEqual([]);
      expect(data.platform).toBe('enlite_app');
      expect(data.profession).toBeNull();
      expect(data.occupation).toBeNull();
      expect(data.knowledgeLevel).toBeNull();
      expect(data.titleCertificate).toBeNull();
      expect(data.experienceTypes).toEqual([]);
      expect(data.yearsExperience).toBeNull();
      expect(data.preferredTypes).toEqual([]);
      expect(data.preferredAgeRange).toEqual([]);
      expect(data.hobbies).toEqual([]);
      expect(data.diagnosticPreferences).toEqual([]);
      expect(data.firstName).toBeNull();
      expect(data.lastName).toBeNull();
      expect(data.whatsappPhone).toBeNull();
      expect(data.linkedinUrl).toBeNull();
      expect(data.documentNumber).toBeNull();
      expect(data.documentType).toBeNull();
    });
  });

  // ── Cenário extra: documents com campos null ────────────────────────────────

  describe('documents com campos null', () => {
    it('usa defaults para documents_status e additional_certificates_urls', async () => {
      setupFullMocks({
        docRows: [makeDocRow({
          documents_status: null,
          additional_certificates_urls: null,
          resume_cv_url: null,
          identity_document_url: null,
          review_notes: null,
          reviewed_by: null,
          reviewed_at: null,
          submitted_at: null,
        })],
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { documents } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(documents.documentsStatus).toBe('pending');
      expect(documents.additionalCertificatesUrls).toEqual([]);
      expect(documents.resumeCvUrl).toBeNull();
      expect(documents.identityDocumentUrl).toBeNull();
      expect(documents.reviewNotes).toBeNull();
      expect(documents.reviewedBy).toBeNull();
      expect(documents.reviewedAt).toBeNull();
      expect(documents.submittedAt).toBeNull();
    });
  });

  // ── Cenário extra: documents com todos os campos presentes ────────────────

  describe('documents com campos opcionais preenchidos', () => {
    it('mapeia todos os campos de documents corretamente', async () => {
      setupFullMocks({
        docRows: [makeDocRow({
          review_notes: 'Tudo ok',
          reviewed_by: 'admin-1',
          reviewed_at: '2025-03-01T00:00:00Z',
          criminal_record_url: 'https://storage/ap.pdf',
          professional_registration_url: 'https://storage/reg.pdf',
          liability_insurance_url: 'https://storage/seg.pdf',
        })],
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { documents } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(documents.reviewNotes).toBe('Tudo ok');
      expect(documents.reviewedBy).toBe('admin-1');
      expect(documents.reviewedAt).toBe('2025-03-01T00:00:00Z');
      expect(documents.criminalRecordUrl).toBe('signed:https://storage/ap.pdf');
      expect(documents.professionalRegistrationUrl).toBe('signed:https://storage/reg.pdf');
      expect(documents.liabilityInsuranceUrl).toBe('signed:https://storage/seg.pdf');
    });
  });

  // ── Cenário extra: encuadre com campos null ───────────────────────────────

  describe('encuadre com campos opcionais null', () => {
    it('mapeia nulls corretamente', async () => {
      setupFullMocks({
        encuadreRows: [makeEncuadreRow({
          job_posting_id: null,
          case_number: null,
          resultado: null,
          interview_date: null,
          interview_time: null,
          recruiter_name: null,
          coordinator_name: null,
          rejection_reason: null,
          rejection_reason_category: null,
          attended: null,
        })],
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const enc = (res.json as jest.Mock).mock.calls[0][0].data.encuadres[0];
      expect(enc.jobPostingId).toBeNull();
      expect(enc.caseNumber).toBeNull();
      expect(enc.resultado).toBeNull();
      expect(enc.interviewDate).toBeNull();
      expect(enc.interviewTime).toBeNull();
      expect(enc.recruiterName).toBeNull();
      expect(enc.coordinatorName).toBeNull();
      expect(enc.rejectionReason).toBeNull();
      expect(enc.rejectionReasonCategory).toBeNull();
      expect(enc.attended).toBeNull();
    });
  });

  // ── Cenário 15: Service area com campos null ────────────────────────────

  describe('service area com campos null', () => {
    it('retorna lat/lng como null quando latitude/longitude são null', async () => {
      setupFullMocks({
        serviceAreaRows: [makeServiceAreaRow({
          latitude: null,
          longitude: null,
          address_line: null,
          radius_km: null,
        })],
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { serviceAreas } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(serviceAreas[0].lat).toBeNull();
      expect(serviceAreas[0].lng).toBeNull();
      expect(serviceAreas[0].address).toBeNull();
      expect(serviceAreas[0].serviceRadiusKm).toBeNull();
    });
  });

  // ── Cenário extra: location com campos null ───────────────────────────────

  describe('location com campos null', () => {
    it('retorna campos null quando location row tem nulls', async () => {
      setupFullMocks({
        locationRows: [makeLocationRow({
          address: null,
          city: null,
          work_zone: null,
          interest_zone: null,
        })],
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { location } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(location).not.toBeNull();
      expect(location.address).toBeNull();
      expect(location.city).toBeNull();
      expect(location.workZone).toBeNull();
      expect(location.interestZone).toBeNull();
    });
  });

  // ── Cenário 16: Múltiplos encuadres ───────────────────────────────────────

  describe('múltiplos encuadres', () => {
    it('retorna todos os encuadres na ordem recebida', async () => {
      setupFullMocks({
        encuadreRows: [
          makeEncuadreRow({ id: 'enc-1', resultado: 'SELECCIONADO' }),
          makeEncuadreRow({ id: 'enc-2', resultado: 'RECHAZADO', rejection_reason_category: 'DISTANCE' }),
        ],
      });
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      const { encuadres } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(encuadres).toHaveLength(2);
      expect(encuadres[0].resultado).toBe('SELECCIONADO');
      expect(encuadres[1].resultado).toBe('RECHAZADO');
      expect(encuadres[1].rejectionReasonCategory).toBe('DISTANCE');
    });
  });

  // ── Cenário 17: Query parametrizada com o id correto ──────────────────────

  describe('query usa o id do params', () => {
    it('passa o UUID correto para todas as queries', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({ id: WORKER_ID });

      await controller.getWorkerById(req, res);

      // Query 1: worker
      expect(mockQuery.mock.calls[0][1]).toEqual([WORKER_ID]);
      // Queries 2-7: related data (docs, service areas, locations, encuadres, availability, tags)
      expect(mockQuery.mock.calls[1][1]).toEqual([WORKER_ID]);
      expect(mockQuery.mock.calls[2][1]).toEqual([WORKER_ID]);
      expect(mockQuery.mock.calls[3][1]).toEqual([WORKER_ID]);
      expect(mockQuery.mock.calls[4][1]).toEqual([WORKER_ID]);
      expect(mockQuery.mock.calls[5][1]).toEqual([WORKER_ID]);
      expect(mockQuery.mock.calls[6][1]).toEqual([WORKER_ID]);
    });
  });
});

// =============================================================================
// getWorkerByPhone
// =============================================================================

describe('AdminWorkersController — getWorkerByPhone', () => {
  let controller: AdminWorkersController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    controller = new AdminWorkersController();
    mockDecrypt.mockImplementation((val: string | null) =>
      Promise.resolve(val ? val.replace('enc_', '') : null),
    );
  });

  // ── Cenário 1: 200 — worker encontrado ────────────────────────────────────

  describe('worker encontrado por telefone', () => {
    it('retorna 200 com success: true e dados completos', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({}, { phone: '+5491188888888' });

      await controller.getWorkerByPhone(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });

    it('retorna os mesmos campos que getWorkerById', async () => {
      setupFullMocks();
      const [req, res] = mockReqRes({}, { phone: '+5491188888888' });

      await controller.getWorkerByPhone(req, res);

      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data.id).toBe(WORKER_ID);
      expect(data.email).toBe('maria@example.com');
      expect(data.firstName).toBe('first');
      expect(data.lastName).toBe('last');
      expect(data.phone).toBe('+5491188888888');
      expect(data.documents).not.toBeNull();
      expect(data.serviceAreas).toHaveLength(1);
      expect(data.location).not.toBeNull();
      expect(data.encuadres).toHaveLength(1);
    });

    it('passa array de candidatos (ANY) como parâmetro da query SQL', async () => {
      setupFullMocks();
      const phone = '+5491188888888';
      const [req, res] = mockReqRes({}, { phone });

      await controller.getWorkerByPhone(req, res);

      // pool.query(sql, [candidates]) — o segundo arg é [candidatesArray]
      const queryParams = mockQuery.mock.calls[0][1] as string[][];
      const candidates = queryParams[0] as string[];
      expect(Array.isArray(candidates)).toBe(true);
      // Deve conter ao menos o canônico derivado de +5491188888888
      expect(candidates).toContain('5491188888888');
    });
  });

  // ── Cenário 2: 404 — worker não encontrado ─────────────────────────────────

  describe('worker não encontrado', () => {
    it('retorna 404 quando nenhuma row é retornada', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({}, { phone: '9999999999' });

      await controller.getWorkerByPhone(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Worker not found' });
    });

    it('não executa queries de dados relacionados quando worker não existe', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({}, { phone: '9999999999' });

      await controller.getWorkerByPhone(req, res);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockDecrypt).not.toHaveBeenCalled();
    });
  });

  // ── Cenário 3: 400 — phone ausente ────────────────────────────────────────

  describe('query param phone ausente', () => {
    it('retorna 400 quando phone não é fornecido', async () => {
      const [req, res] = mockReqRes({}, {});

      await controller.getWorkerByPhone(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Query parameter "phone" is required',
      });
    });

    it('não executa nenhuma query quando phone está ausente', async () => {
      const [req, res] = mockReqRes({}, {});

      await controller.getWorkerByPhone(req, res);

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // ── Cenário 4: 400 — phone vazio ──────────────────────────────────────────

  describe('query param phone vazio', () => {
    it('retorna 400 quando phone é string vazia', async () => {
      const [req, res] = mockReqRes({}, { phone: '' });

      await controller.getWorkerByPhone(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Query parameter "phone" is required',
      });
    });

    it('retorna 400 quando phone é somente espaços em branco', async () => {
      const [req, res] = mockReqRes({}, { phone: '   ' });

      await controller.getWorkerByPhone(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // ── Cenário 5: 500 — erro de banco ────────────────────────────────────────

  describe('erro de banco de dados', () => {
    it('retorna 500 quando a query principal falha', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      const [req, res] = mockReqRes({}, { phone: '+5491188888888' });

      await controller.getWorkerByPhone(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to get worker details',
          details: 'connection refused',
        }),
      );
    });

    it('retorna 500 quando query de dados relacionados falha', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeWorkerRow()] })
        .mockRejectedValueOnce(new Error('timeout on docs query'));
      mockDecrypt.mockResolvedValue('decrypted');
      const [req, res] = mockReqRes({}, { phone: '+5491188888888' });

      await controller.getWorkerByPhone(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── Cenário 6: 500 — erro de decryption ──────────────────────────────────

  describe('erro de decryption KMS', () => {
    it('retorna 500 quando decrypt falha', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeWorkerRow()] });
      mockDecrypt.mockRejectedValue(new Error('KMS unavailable'));
      const [req, res] = mockReqRes({}, { phone: '+5491188888888' });

      await controller.getWorkerByPhone(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          details: 'KMS unavailable',
        }),
      );
    });
  });
});

// =============================================================================
// listCaseOptions
// =============================================================================

describe('AdminWorkersAuxController — listCaseOptions', () => {
  let controller: AdminWorkersAuxController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    controller = new AdminWorkersAuxController();
  });

  it('retorna 200 com lista de casos formatada usando title', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'jp-1', case_number: 10, vacancy_number: 1, title: 'CASO 10-1', patient_first_name: 'Ana', patient_last_name: 'Lopez' },
        { id: 'jp-2', case_number: 9,  vacancy_number: 2, title: 'CASO 9-2',  patient_first_name: 'Carlos', patient_last_name: null },
        { id: 'jp-3', case_number: 8,  vacancy_number: 3, title: 'CASO 8-3',  patient_first_name: null, patient_last_name: null },
      ],
    });
    const [req, res] = mockReqRes({});

    await controller.listCaseOptions(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toEqual({ value: 'jp-1', label: 'CASO 10-1 — Ana Lopez' });
    expect(body.data[1]).toEqual({ value: 'jp-2', label: 'CASO 9-2 — Carlos' });
    expect(body.data[2]).toEqual({ value: 'jp-3', label: 'CASO 8-3' });
  });

  it('retorna lista vazia quando não há job_postings', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req, res] = mockReqRes({});

    await controller.listCaseOptions(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('usa apenas patient_first_name quando patient_last_name é null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'jp-1', case_number: 5, vacancy_number: 10, title: 'CASO 5-10', patient_first_name: 'Maria', patient_last_name: null }],
    });
    const [req, res] = mockReqRes({});

    await controller.listCaseOptions(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.data[0].label).toBe('CASO 5-10 — Maria');
  });

  it('retorna label sem nome quando ambos names são null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'jp-1', case_number: 3, vacancy_number: 7, title: 'CASO 3-7', patient_first_name: null, patient_last_name: null }],
    });
    const [req, res] = mockReqRes({});

    await controller.listCaseOptions(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.data[0].label).toBe('CASO 3-7');
  });

  it('retorna 500 em caso de erro de banco', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db error'));
    const [req, res] = mockReqRes({});

    await controller.listCaseOptions(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Failed to list case options' }),
    );
  });
});

// =============================================================================
// listWorkers — filtro case_id e busca por phone
// =============================================================================

describe('AdminWorkersController — listWorkers filtro case_id e busca por phone', () => {
  let controller: AdminWorkersController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    controller = new AdminWorkersController();
    mockDecrypt.mockImplementation((val: string | null) =>
      Promise.resolve(val ? val.replace('enc_', '') : null),
    );
  });

  function makeListRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'worker-uuid',
      email: 'worker@example.com',
      phone: '+5491177777777',
      first_name_encrypted: 'enc_Pedro',
      last_name_encrypted: 'enc_Alves',
      data_sources: [],
      created_at: '2025-01-01T00:00:00Z',
      status: 'REGISTERED',
      documents_status: 'submitted',
      cases_count: '1',
      ...overrides,
    };
  }

  describe('filtro case_id', () => {
    it('inclui cláusula EXISTS com job_posting_id quando case_id é passado', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
      mockQuery.mockResolvedValueOnce({ rows: [makeListRow()] });
      const [req, res] = mockReqRes({}, { case_id: 'jp-uuid-123' } as any);

      await controller.listWorkers(req, res);

      const countSql = mockQuery.mock.calls[0][0] as string;
      expect(countSql).toContain('EXISTS');
      expect(countSql).toContain('e2.job_posting_id');
      // case_id deve ser passado como parâmetro bind
      expect(mockQuery.mock.calls[0][1]).toContain('jp-uuid-123');
    });

    it('retorna workers filtrados pelo caso', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
      mockQuery.mockResolvedValueOnce({ rows: [makeListRow()] });
      const [req, res] = mockReqRes({}, { case_id: 'jp-uuid-123' } as any);

      await controller.listWorkers(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.total).toBe(1);
    });

    it('combina case_id com outros filtros (platform)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({}, { case_id: 'jp-uuid-123', platform: 'ana_care' } as any);

      await controller.listWorkers(req, res);

      const sql = mockQuery.mock.calls[0][0] as string;
      // Ambos os filtros devem estar presentes
      expect(sql).toContain('EXISTS');
      expect(sql).toContain("ANY(w.data_sources)");
      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params).toContain('ana_care');
      expect(params).toContain('jp-uuid-123');
    });
  });

  describe('busca por telefone (search)', () => {
    it('usa fast path SQL (phone ILIKE) quando search é só dígitos', async () => {
      const PHONE_WORKER_ID = 'phone-worker-uuid';
      // fast path: count + data queries
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [makeListRow({ id: PHONE_WORKER_ID, phone: '+5491155551234', email: 'a@a.com',
          first_name_encrypted: 'enc_X', last_name_encrypted: 'enc_Y' })],
      });
      const [req, res] = mockReqRes({}, { search: '5551234' } as any);

      await controller.listWorkers(req, res);

      const countSql = mockQuery.mock.calls[0][0] as string;
      expect(countSql).toContain('w.phone ILIKE');
      const countParams = mockQuery.mock.calls[0][1] as unknown[];
      expect(countParams).toContain('%5551234%');
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
      expect(body.data[0].id).toBe(PHONE_WORKER_ID);
    });

    it('retorna total=0 quando ILIKE não bate', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({}, { search: '9999999' } as any);

      await controller.listWorkers(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(0);
    });

    it('normaliza espaços/+/- no telefone antes do ILIKE', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({}, { search: '+54 9 11 5555-1234' } as any);

      await controller.listWorkers(req, res);

      const countParams = mockQuery.mock.calls[0][1] as unknown[];
      expect(countParams).toContain('%5491155551234%');
    });

    it('search curto (<3 chars, não phone, não email) retorna 400', async () => {
      // "21" tem 2 chars: não é phone (< 4 dígitos), não é email (sem @) — blind index rejeita
      const [req, res] = mockReqRes({}, { search: '21' } as any);

      await controller.listWorkers(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockQuery).not.toHaveBeenCalled();
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
    });
  });

  describe('busca por email (search)', () => {
    it('usa fast path SQL (email ILIKE) quando search contém "@"', async () => {
      const TARGET_ID = 'email-target-uuid';
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [makeListRow({ id: TARGET_ID, email: 'soledadperezj11@gmail.com' })],
      });
      const [req, res] = mockReqRes({}, { search: 'soledadperezj11@gmail.com' } as any);

      await controller.listWorkers(req, res);

      const countSql = mockQuery.mock.calls[0][0] as string;
      expect(countSql).toContain('w.email ILIKE');
      const countParams = mockQuery.mock.calls[0][1] as unknown[];
      expect(countParams).toContain('%soledadperezj11@gmail.com%');
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(1);
      expect(body.data[0].id).toBe(TARGET_ID);
    });

    it('email ILIKE é case-insensitive (normalizado para lowercase)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({}, { search: 'Foo@BAR.com' } as any);

      await controller.listWorkers(req, res);

      const countParams = mockQuery.mock.calls[0][1] as unknown[];
      expect(countParams).toContain('%foo@bar.com%');
    });

    it('fast path respeita paginação via SQL LIMIT/OFFSET', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '5' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({}, { search: 'test@x.com', limit: '10', offset: '20' } as any);

      await controller.listWorkers(req, res);

      const dataSql = mockQuery.mock.calls[1][0] as string;
      expect(dataSql).toContain('LIMIT');
      expect(dataSql).toContain('OFFSET');
      const dataParams = mockQuery.mock.calls[1][1] as unknown[];
      expect(dataParams).toContain(10);
      expect(dataParams).toContain(20);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(5);
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(20);
    });
  });

  describe('SELECT shape', () => {
    it('inclui w.phone no SELECT do baseQuery', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const [req, res] = mockReqRes({}, {} as any);

      await controller.listWorkers(req, res);

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('w.phone');
    });
  });
});

// =============================================================================
// listWorkers — 9 new profile filters
// =============================================================================

describe('AdminWorkersController — listWorkers novos filtros de perfil', () => {
  let controller: AdminWorkersController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    controller = new AdminWorkersController();
    mockDecrypt.mockImplementation((val: string | null) =>
      Promise.resolve(val ? val.replace('enc_', '') : null),
    );
  });

  function setupCount(total = '0') {
    mockQuery.mockResolvedValueOnce({ rows: [{ total }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
  }

  // ── profession ──────────────────────────────────────────────────────────────

  it('profession=AT adiciona ANY($n::text[]) no WHERE', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { profession: 'AT' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('w.profession = ANY(');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContainEqual(['AT']);
  });

  it('profession=AT,CAREGIVER envia array com ambas as profissões', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { profession: 'AT,CAREGIVER' } as any);
    await controller.listWorkers(req, res);

    const params = mockQuery.mock.calls[0][1] as unknown[];
    const profArray = params.find((p) => Array.isArray(p) && (p as string[]).includes('AT'));
    expect(profArray).toEqual(['AT', 'CAREGIVER']);
  });

  it('profession com valor inválido é ignorado silenciosamente', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { profession: 'INVALID' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    // Invalid profession filtered out — no profession clause
    expect(sql).not.toContain('w.profession = ANY(');
  });

  // ── preferred_age_range ─────────────────────────────────────────────────────

  it('preferred_age_range=children adiciona = ANY(w.preferred_age_range)', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { preferred_age_range: 'children' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('= ANY(w.preferred_age_range)');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('children');
  });

  // ── experience_type ─────────────────────────────────────────────────────────

  it('experience_type=TEA adiciona = ANY(w.experience_types)', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { experience_type: 'TEA' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('= ANY(w.experience_types)');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('TEA');
  });

  // ── preferred_type ──────────────────────────────────────────────────────────

  it('preferred_type=home adiciona = ANY(w.preferred_types)', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { preferred_type: 'home' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('= ANY(w.preferred_types)');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('home');
  });

  // ── state (province) ───────────────────────────────────────────────────────

  it('state=Buenos Aires adiciona EXISTS em worker_service_areas.state', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { state: 'Buenos Aires' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('worker_service_areas');
    expect(sql).toContain('wsa.state ILIKE');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('Buenos Aires');
  });

  // ── city ────────────────────────────────────────────────────────────────────

  it('city=Palermo adiciona EXISTS em worker_service_areas.city', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { city: 'Palermo' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('worker_service_areas');
    expect(sql).toContain('wsa.city ILIKE');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('Palermo');
  });

  // ── days ────────────────────────────────────────────────────────────────────

  it('days=1,3,5 adiciona EXISTS em worker_availability.day_of_week', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { days: '1,3,5' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('worker_availability');
    expect(sql).toContain('av.day_of_week = ANY(');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContainEqual([1, 3, 5]);
  });

  it('days com valores fora de 0-6 são ignorados', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { days: '1,7,8' } as any);
    await controller.listWorkers(req, res);

    const params = mockQuery.mock.calls[0][1] as unknown[];
    const dayArray = params.find((p) => Array.isArray(p) && (p as number[]).every(
      (n) => typeof n === 'number',
    )) as number[] | undefined;
    // Only day 1 is valid (0-6)
    expect(dayArray).toEqual([1]);
  });

  // ── sex (blind index) ───────────────────────────────────────────────────────

  it('sex=male adiciona w.sex_bidx = $n no WHERE', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { sex: 'male' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('w.sex_bidx = $');
  });

  it('sex=female também adiciona w.sex_bidx = $n no WHERE', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { sex: 'female' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('w.sex_bidx = $');
  });

  it('sex inválido (ex: BOTH) não adiciona cláusula sex_bidx', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { sex: 'BOTH' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain('sex_bidx');
  });

  // ── language (blind index) ──────────────────────────────────────────────────

  it('language=es adiciona w.languages_bidx @> no WHERE', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, { language: 'es' } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('w.languages_bidx @>');
  });

  // ── combined filters ────────────────────────────────────────────────────────

  it('múltiplos filtros combinados geram WHERE composto', async () => {
    setupCount();
    const [req, res] = mockReqRes({}, {
      profession: 'AT',
      state: 'Buenos Aires',
      days: '1,2',
    } as any);
    await controller.listWorkers(req, res);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('w.profession = ANY(');
    expect(sql).toContain('wsa.state ILIKE');
    expect(sql).toContain('worker_availability');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // ── filter-options endpoint ─────────────────────────────────────────────────

  describe('AdminWorkersAuxController — getFilterOptions', () => {
    let auxController: AdminWorkersAuxController;

    beforeEach(() => {
      jest.clearAllMocks();
      mockQuery.mockReset();
      auxController = new AdminWorkersAuxController();
    });

    it('retorna 200 com states, cities, experienceTypes e preferredTypes', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ state: 'Buenos Aires' }, { state: 'Córdoba' }] })
        .mockResolvedValueOnce({ rows: [{ city: 'Palermo' }, { city: 'Recoleta' }] })
        .mockResolvedValueOnce({ rows: [{ val: 'TEA' }, { val: 'DOWN' }] })
        .mockResolvedValueOnce({ rows: [{ val: 'home' }, { val: 'institutional' }] });

      const [req, res] = mockReqRes({});
      await auxController.getFilterOptions(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.states).toEqual(['Buenos Aires', 'Córdoba']);
      expect(body.data.cities).toEqual(['Palermo', 'Recoleta']);
      expect(body.data.experienceTypes).toEqual(['TEA', 'DOWN']);
      expect(body.data.preferredTypes).toEqual(['home', 'institutional']);
    });

    it('retorna listas vazias quando não há dados', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const [req, res] = mockReqRes({});
      await auxController.getFilterOptions(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.states).toEqual([]);
      expect(body.data.cities).toEqual([]);
      expect(body.data.experienceTypes).toEqual([]);
      expect(body.data.preferredTypes).toEqual([]);
    });

    it('retorna 500 em caso de erro de banco', async () => {
      mockQuery.mockRejectedValueOnce(new Error('db error'));

      const [req, res] = mockReqRes({});
      await auxController.getFilterOptions(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'Failed to fetch filter options' }),
      );
    });
  });
});
