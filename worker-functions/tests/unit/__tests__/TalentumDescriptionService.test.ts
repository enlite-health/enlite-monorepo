/**
 * TalentumDescriptionService — Unit Tests
 *
 * Coverage: constructor (GEMINI_API_KEY validation), generateDescription
 * (DB query, Gemini API call, Marco text, DB save), callGemini (prompt
 * assembly, HTTP error, empty response), and all edge cases.
 *
 * Mocks: DatabaseConnection (singleton + Pool), global.fetch (Gemini API).
 */

// ── Mocks ────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockPool = { query: mockQuery };
const mockGetPrompt = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({
      getPool: () => mockPool,
    }),
  },
}));

jest.mock(
  '../../../src/modules/integration/infrastructure/GoogleDocsPromptProvider',
  () => ({
    GoogleDocsPromptProvider: jest.fn().mockImplementation(() => ({
      getPrompt: mockGetPrompt,
    })),
  }),
);

const originalFetch = global.fetch;
const mockFetch = jest.fn();

beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  mockFetch.mockReset();
  mockQuery.mockReset();
  mockGetPrompt.mockReset();
  // Default: every test gets a non-empty prompt unless it overrides this
  mockGetPrompt.mockResolvedValue(
    'Sos un especialista en redacción de propuestas. Generá Descripción de la Propuesta y Perfil Profesional Sugerido.',
  );
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Mocks a Gemini response. The service expects JSON-shaped output
 * (`{ propuesta, perfilProfesional }`). When the test passes a plain string
 * we use it as `propuesta` and fall back for `perfilProfesional` so the
 * service's JSON parsing always succeeds.
 *
 * Pass `{ rawText: '...' }` to bypass JSON wrapping (useful to test the
 * "Gemini returned non-JSON" error path).
 */
function mockGeminiResponse(
  payload:
    | { propuesta?: string; perfilProfesional?: string }
    | { rawText: string }
    | string,
) {
  let text: string;
  if (typeof payload === 'string') {
    text = JSON.stringify({
      propuesta: payload,
      perfilProfesional: 'Perfil sugerido por defecto.',
    });
  } else if ('rawText' in payload) {
    text = payload.rawText;
  } else {
    text = JSON.stringify({
      propuesta: payload.propuesta ?? 'Resumen objetivo del caso.',
      perfilProfesional: payload.perfilProfesional ?? 'Perfil sugerido.',
    });
  }
  const body = {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function mockGeminiError(status: number, body: string) {
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  };
}

function makeVacancyRow(overrides: Record<string, any> = {}) {
  return {
    case_number: 747,
    title: 'Caso 747',
    worker_profile_sought: 'AT con experiencia en adultos mayores',
    required_professions: ['Psicóloga', 'AT'],
    required_sex: 'Femenino',
    required_experience: null,
    schedule: null,
    city: 'Palermo',
    state: 'CABA',
    pathology_types: null,
    dependency_level: 'MODERADA',
    service_device_types: null,
    ...overrides,
  };
}

const MARCO_EXPECTED = 'El Marco de Acompañamiento:\nEnLite Health Solutions ofrece a los prestadores un marco de trabajo';

// ── Tests ────────────────────────────────────────────────────────────

describe('TalentumDescriptionService', () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;
  const origDocAt = process.env.PROMPT_DOC_ID_AT;
  const origDocCuid = process.env.PROMPT_DOC_ID_CUIDADOR;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    delete process.env.GEMINI_MODEL;
    process.env.PROMPT_DOC_ID_AT = 'test-at-doc-id';
    process.env.PROMPT_DOC_ID_CUIDADOR = 'test-cuidador-doc-id';
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey;
    else delete process.env.GEMINI_API_KEY;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
    else delete process.env.GEMINI_MODEL;
    if (origDocAt !== undefined) process.env.PROMPT_DOC_ID_AT = origDocAt;
    else delete process.env.PROMPT_DOC_ID_AT;
    if (origDocCuid !== undefined) process.env.PROMPT_DOC_ID_CUIDADOR = origDocCuid;
    else delete process.env.PROMPT_DOC_ID_CUIDADOR;
  });

  // Need fresh import after mocks
  function createService() {
    // Re-require to pick up env var changes
    const { TalentumDescriptionService } = require('../../../src/modules/integration/infrastructure/TalentumDescriptionService');
    return new TalentumDescriptionService();
  }

  // ── Constructor ──────────────────────────────────────────────────
  describe('constructor', () => {
    it('initializes with GEMINI_API_KEY from env', () => {
      process.env.GEMINI_API_KEY = 'my-api-key';
      const service = createService();
      expect(service).toBeDefined();
    });

    it('throws when GEMINI_API_KEY is missing', () => {
      delete process.env.GEMINI_API_KEY;
      expect(() => createService()).toThrow('GEMINI_API_KEY');
    });

    it('throws when GEMINI_API_KEY is empty string', () => {
      process.env.GEMINI_API_KEY = '';
      expect(() => createService()).toThrow('GEMINI_API_KEY');
    });

    it('uses default model when GEMINI_MODEL not set', () => {
      delete process.env.GEMINI_MODEL;
      const service = createService();
      expect(service).toBeDefined();
      // Internal model defaults to 'gemini-2.5-flash' — verified via URL check
    });

    it('uses custom GEMINI_MODEL when set', () => {
      process.env.GEMINI_MODEL = 'gemini-2.5-pro';
      const service = createService();
      expect(service).toBeDefined();
    });
  });

  // ── generateDescription ──────────────────────────────────────────
  describe('generateDescription()', () => {
    it('happy path: fetches vacancy, calls Gemini, appends Marco, saves to DB, returns result', async () => {
      const vacancyRow = makeVacancyRow();
      mockQuery
        .mockResolvedValueOnce({ rows: [vacancyRow] }) // SELECT vacancy
        .mockResolvedValueOnce({ rows: [] }); // UPDATE talentum_description

      const llmOutput = 'Descripción de la Propuesta:\nSe busca...\n\nPerfil Profesional Sugerido:\nMujer...';
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(llmOutput));

      const service = createService();
      const result = await service.generateDescription('job-123');

      expect(result.title).toBe('Caso 747');
      expect(result.description).toContain('Descripción de la Propuesta:');
      expect(result.description).toContain('Perfil Profesional Sugerido:');
      expect(result.description).toContain(MARCO_EXPECTED);
    });

    it('always appends Marco text as section 3 (CA-3.2)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow()] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('Section 1\n\nSection 2'));

      const service = createService();
      const result = await service.generateDescription('job-1');

      // Marco text is the last section
      const parts = result.description.split('\n\n');
      const lastSection = parts[parts.length - 1];
      expect(lastSection).toContain('El Marco de Acompañamiento:');
      expect(lastSection).toContain('bienestar del paciente.');
    });

    it('saves description to job_postings.talentum_description (CA-3.6)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow()] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('Generated text'));

      const service = createService();
      await service.generateDescription('job-save');

      // Verify UPDATE query was called
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE job_postings SET talentum_description');
      expect(updateCall[1][0]).toContain('Generated text');
      expect(updateCall[1][0]).toContain('El Marco de Acompañamiento:');
      expect(updateCall[1][1]).toBe('job-save');
    });

    it('throws when job posting not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const service = createService();
      await expect(service.generateDescription('missing-id'))
        .rejects.toThrow('Job posting missing-id not found');
    });

    it('handles vacancy without patient data (LEFT JOIN nulls)', async () => {
      const rowNoPatient = makeVacancyRow({
        required_professions: null,
        required_sex: null,
        city: null,
        state: null,
        dependency_level: null,
      });

      mockQuery
        .mockResolvedValueOnce({ rows: [rowNoPatient] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('No patient data description'));

      const service = createService();
      const result = await service.generateDescription('job-no-patient');

      expect(result.description).toBeTruthy();
      // Verify prompt includes 'No especificado' for missing fields
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      const userContent = body.contents[0].parts[0].text;
      expect(userContent).toContain('No especificado');
    });

    it('uses title fallback when title is null', async () => {
      const rowNoTitle = makeVacancyRow({ title: null, case_number: 999 });
      mockQuery
        .mockResolvedValueOnce({ rows: [rowNoTitle] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('Description'));

      const service = createService();
      const result = await service.generateDescription('job-no-title');

      expect(result.title).toBe('Caso 999');
    });

    it('handles profession as array (joins with comma)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow({ required_professions: ['AT', 'Enfermera'] })] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-prof');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userContent = body.contents[0].parts[0].text;
      expect(userContent).toContain('AT, Enfermera');
    });

    it('handles profession as non-array (shows No especificado)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow({ required_professions: null })] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-no-prof');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userContent = body.contents[0].parts[0].text;
      expect(userContent).toContain('Tipo de Profesional: No especificado');
    });
  });

  // ── callGemini ────────────────────────────────────────────────────
  describe('callGemini (Gemini API interaction)', () => {
    it('sends correct generationConfig (CA-3.5)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow()] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-model');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('gemini-2.5-flash');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.generationConfig.temperature).toBe(0.3);
      expect(body.generationConfig.maxOutputTokens).toBe(2048);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      // Schema forces structured output with the two fields we control
      expect(body.generationConfig.responseSchema.required).toEqual([
        'propuesta',
        'perfilProfesional',
      ]);
    });

    it('sends custom model from GEMINI_MODEL env', async () => {
      process.env.GEMINI_MODEL = 'gemini-2.5-pro';
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow()] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-custom-model');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('gemini-2.5-pro');
    });

    it('puts API key in URL query string', async () => {
      process.env.GEMINI_API_KEY = 'my-secret-key';
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow()] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-auth');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('key=my-secret-key');
    });

    it('sends system prompt in Spanish about Talentum description', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow()] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-prompt');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const sysText = body.systemInstruction.parts[0].text as string;
      expect(sysText).toContain('Descripción de la Propuesta');
      expect(sysText).toContain('Perfil Profesional Sugerido');
    });

    it('loads PROMPT_DOC_ID_AT when professions does not include CAREGIVER', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow({ required_professions: ['AT'] })] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-at');

      expect(mockGetPrompt).toHaveBeenCalledWith('test-at-doc-id');
    });

    it('loads PROMPT_DOC_ID_CUIDADOR when professions includes CAREGIVER', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [makeVacancyRow({ required_professions: ['CAREGIVER'] })],
        })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-cuidador');

      expect(mockGetPrompt).toHaveBeenCalledWith('test-cuidador-doc-id');
    });

    it('throws on Gemini HTTP error', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeVacancyRow()] });
      mockFetch.mockResolvedValueOnce(mockGeminiError(429, 'Rate limit exceeded'));

      const service = createService();
      await expect(service.generateDescription('job-rate-limit'))
        .rejects.toThrow('Gemini API error 429');
    });

    it('throws on empty Gemini response (no content)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeVacancyRow()] });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
      });

      const service = createService();
      await expect(service.generateDescription('job-empty'))
        .rejects.toThrow('Empty response from Gemini API');
    });

    it('throws on empty candidates array', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeVacancyRow()] });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [] }),
      });

      const service = createService();
      await expect(service.generateDescription('job-no-choices'))
        .rejects.toThrow('Empty response from Gemini API');
    });

    it('trims propuesta/perfilProfesional from LLM JSON before assembling', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow()] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(
        mockGeminiResponse({
          propuesta: '  resumen del caso  \n\n',
          perfilProfesional: '\n\n  perfil sugerido  ',
        }),
      );

      const service = createService();
      const result = await service.generateDescription('job-trim');

      // Headers added by the service, no double-newline gaps from leftover ws
      expect(result.description).toMatch(/Descripción de la Propuesta:\nresumen del caso\n\nPerfil Profesional Sugerido:\nperfil sugerido\n\nEl Marco/);
    });

    it('includes zone from city + state combined', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow({ city: 'Palermo', state: 'CABA' })] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-zone');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userContent = body.contents[0].parts[0].text;
      expect(userContent).toContain('Zona: Palermo, CABA');
    });

    it('handles zone with only city (no state)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow({ city: 'Belgrano', state: null })] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-city-only');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.contents[0].parts[0].text).toContain('Zona: Belgrano');
    });

    it('handles zone with neither city nor state', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow({ city: null, state: null })] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-no-zone');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.contents[0].parts[0].text).toContain('Zona: No especificado');
    });

    it('includes pathology_types in prompt when provided', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeVacancyRow({ pathology_types: 'Alzheimer leve' })] })
        .mockResolvedValueOnce({ rows: [] });
      mockFetch.mockResolvedValueOnce(mockGeminiResponse('text'));

      const service = createService();
      await service.generateDescription('job-pathology');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.contents[0].parts[0].text).toContain('Patologías: Alzheimer leve');
    });
  });
});
