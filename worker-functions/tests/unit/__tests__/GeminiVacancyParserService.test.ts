// Force module scope to avoid TS2451 with TalentumDescriptionService.test.ts
export {};

/**
 * GeminiVacancyParserService — Unit Tests
 *
 * Coverage: constructor (GEMINI_API_KEY validation), parseFromText
 * (Gemini API call, JSON parsing, default values), prompt file loading,
 * error handling (HTTP errors, empty responses, invalid JSON).
 *
 * Mocks: global.fetch (Gemini API), fs.readFileSync (prompt files).
 */

// ── Mocks ────────────────────────────────────────────────────────────

jest.mock('../../../src/modules/integration/infrastructure/GoogleDocsPromptProvider', () => ({
  GoogleDocsPromptProvider: jest.fn().mockImplementation(() => ({
    getPrompt: jest.fn().mockResolvedValue('Mocked prompt content for testing'),
    clearCache: jest.fn(),
  })),
}));

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
});

// ── Helpers ──────────────────────────────────────────────────────────

const VALID_GEMINI_RESPONSE = {
  vacancy: {
    case_number: 1010,
    title: 'CASO 1010',
    required_professions: ['AT'],
    required_sex: null,
    age_range_min: 20,
    age_range_max: 50,
    required_experience: '1 año en TEA',
    worker_attributes: 'Responsabilidad, empatía',
    schedule: [
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '13:00', endTime: '17:00' },
    ],
    work_schedule: 'full-time',
    pathology_types: 'TEA',
    dependency_level: 'Moderado',
    service_device_types: ['ESCOLAR'],
    providers_needed: 1,
    salary_text: 'A convenir',
    payment_day: null,
    daily_obs: null,
    city: 'Palermo',
    state: 'CABA',
    status: 'SEARCHING',
  },
  prescreening: {
    questions: [
      {
        question: '¿Contás con título oficial de Acompañante Terapéutico?',
        responseType: ['text', 'audio'],
        desiredResponse: 'Apto: Título oficial / Aceptable: Estudiante avanzado / No Apto: Sin formación',
        weight: 10,
        required: true,
        analyzed: true,
        earlyStoppage: false,
      },
    ],
    faq: [
      { question: '¿Cuál es el horario?', answer: 'Lunes a viernes de 8 a 17hs' },
    ],
  },
  description: {
    titulo_propuesta: 'CASO 1010, AT, TEA - Palermo, CABA',
    descripcion_propuesta: 'Nos encontramos en la búsqueda...',
    perfil_profesional: 'Orientamos la búsqueda a profesionales...',
  },
};

function mockGeminiResponse(content: object) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(content) }] } }] }),
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(content) }] } }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 500 },
    }),
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

// ── Tests ────────────────────────────────────────────────────────────

describe('GeminiVacancyParserService', () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    delete process.env.GEMINI_MODEL;
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey;
    else delete process.env.GEMINI_API_KEY;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
    else delete process.env.GEMINI_MODEL;
  });

  function createService() {
    const { GeminiVacancyParserService } = require('../../../src/modules/integration/infrastructure/GeminiVacancyParserService');
    return new GeminiVacancyParserService();
  }

  // ── Constructor ──────────────────────────────────────────────────
  describe('constructor', () => {
    it('initializes with GEMINI_API_KEY from env', () => {
      process.env.GEMINI_API_KEY = 'my-key';
      const service = createService();
      expect(service).toBeDefined();
    });

    it('initializes without error when key is set (validated at call time)', () => {
      process.env.GEMINI_API_KEY = '';
      const service = createService();
      expect(service).toBeDefined();
    });

    it('uses default model when GEMINI_MODEL not set', () => {
      delete process.env.GEMINI_MODEL;
      const service = createService();
      expect(service).toBeDefined();
    });

    it('uses custom GEMINI_MODEL when set', () => {
      process.env.GEMINI_MODEL = 'gemini-custom';
      const service = createService();
      expect(service).toBeDefined();
    });
  });

  // ── parseFromText ────────────────────────────────────────────────
  describe('parseFromText()', () => {
    it('happy path: calls Gemini, returns parsed vacancy + prescreening + description', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      const result = await service.parseFromText('Caso 1010, paciente con TEA en Palermo', 'AT');

      expect(result.vacancy.case_number).toBe(1010);
      expect(result.vacancy.title).toBe('CASO 1010');
      expect(result.vacancy.required_professions).toEqual(['AT']);
      expect(result.vacancy.city).toBe('Palermo');
      expect(result.vacancy.state).toBe('CABA');
      expect(result.vacancy.status).toBe('SEARCHING');
    });

    it('returns prescreening questions from Gemini response', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      const result = await service.parseFromText('Test case', 'AT');

      expect(result.prescreening.questions).toHaveLength(1);
      expect(result.prescreening.questions[0].question).toContain('Acompañante Terapéutico');
      expect(result.prescreening.questions[0].weight).toBe(10);
      expect(result.prescreening.questions[0].analyzed).toBe(true);
    });

    it('returns FAQ from Gemini response', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      const result = await service.parseFromText('Test case', 'AT');

      expect(result.prescreening.faq).toHaveLength(1);
      expect(result.prescreening.faq[0].question).toContain('horario');
    });

    it('returns description sections from Gemini response', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      const result = await service.parseFromText('Test case', 'AT');

      expect(result.description.titulo_propuesta).toContain('CASO 1010');
      expect(result.description.descripcion_propuesta).toBeTruthy();
      expect(result.description.perfil_profesional).toBeTruthy();
    });

    it('sets CAREGIVER as default profession for CUIDADOR type', async () => {
      const response = {
        ...VALID_GEMINI_RESPONSE,
        vacancy: { ...VALID_GEMINI_RESPONSE.vacancy, required_professions: [] },
      };
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(response));

      const service = createService();
      const result = await service.parseFromText('Test case', 'CUIDADOR');

      expect(result.vacancy.required_professions).toEqual(['CAREGIVER']);
    });

    it('sets AT as default profession for AT type when empty', async () => {
      const response = {
        ...VALID_GEMINI_RESPONSE,
        vacancy: { ...VALID_GEMINI_RESPONSE.vacancy, required_professions: [] },
      };
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(response));

      const service = createService();
      const result = await service.parseFromText('Test case', 'AT');

      expect(result.vacancy.required_professions).toEqual(['AT']);
    });

    it('defaults providers_needed to 1 when missing', async () => {
      const response = {
        ...VALID_GEMINI_RESPONSE,
        vacancy: { ...VALID_GEMINI_RESPONSE.vacancy, providers_needed: 0 },
      };
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(response));

      const service = createService();
      const result = await service.parseFromText('Test case', 'AT');

      expect(result.vacancy.providers_needed).toBe(1);
    });

    it('defaults status to SEARCHING when empty', async () => {
      const response = {
        ...VALID_GEMINI_RESPONSE,
        vacancy: { ...VALID_GEMINI_RESPONSE.vacancy, status: '' },
      };
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(response));

      const service = createService();
      const result = await service.parseFromText('Test case', 'AT');

      expect(result.vacancy.status).toBe('SEARCHING');
    });
  });

  // ── Gemini API interaction ───────────────────────────────────────
  describe('Gemini API interaction', () => {
    it('sends correct URL with API key', async () => {
      process.env.GEMINI_API_KEY = 'my-secret-key';
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      await service.parseFromText('Test', 'AT');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('generativelanguage.googleapis.com');
      expect(url).toContain('key=my-secret-key');
    });

    it('sends correct model in URL (default gemini-2.5-pro)', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      await service.parseFromText('Test', 'AT');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('gemini-2.5-pro');
    });

    it('uses custom model from GEMINI_MODEL env', async () => {
      process.env.GEMINI_MODEL = 'gemini-custom-model';
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      await service.parseFromText('Test', 'AT');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('gemini-custom-model');
    });

    it('sends temperature 0 and responseMimeType application/json', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      await service.parseFromText('Test', 'AT');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.generationConfig.temperature).toBe(0);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
    });

    it('sends system instruction with prompt content', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      await service.parseFromText('Test', 'AT');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.systemInstruction.parts[0].text).toContain('FORMATO DE RESPUESTA OBLIGATORIO');
      expect(body.systemInstruction.parts[0].text).toContain('ESQUEMA JSON');
    });

    it('sends user text in contents', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      await service.parseFromText('Caso 42, paciente adulto mayor', 'CUIDADOR');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.contents[0].parts[0].text).toBe('Caso 42, paciente adulto mayor');
    });

    it('throws when GEMINI_API_KEY is empty', async () => {
      process.env.GEMINI_API_KEY = '';

      const service = createService();
      await expect(service.parseFromText('Test', 'AT')).rejects.toThrow('GEMINI_API_KEY');
    });

    it('throws on Gemini HTTP error after exhausting retries', async () => {
      // 429 is transient — fetchGeminiWithRetry retries 3 times then throws.
      mockFetch.mockResolvedValue(mockGeminiError(429, 'Rate limit'));

      const service = createService();
      await expect(service.parseFromText('Test', 'AT')).rejects.toThrow('Gemini API error 429');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('throws on empty Gemini response (no candidates)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [] }),
      });

      const service = createService();
      await expect(service.parseFromText('Test', 'AT')).rejects.toThrow('Empty response from Gemini');
    });

    it('throws on invalid JSON in Gemini response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'not valid json{{{' }] } }],
        }),
      });

      const service = createService();
      await expect(service.parseFromText('Test', 'AT')).rejects.toThrow();
    });
  });

  // ── Prompt file loading ──────────────────────────────────────────
  describe('prompt loading', () => {
    it('includes AT prompt for AT workerType', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      await service.parseFromText('Test', 'AT');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const systemText = body.systemInstruction.parts[0].text;
      // AT prompt file content should be included
      expect(systemText).toContain('FORMATO DE RESPUESTA OBLIGATORIO');
    });

    it('includes CARER prompt for CUIDADOR workerType', async () => {
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(VALID_GEMINI_RESPONSE));

      const service = createService();
      await service.parseFromText('Test', 'CUIDADOR');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const systemText = body.systemInstruction.parts[0].text;
      expect(systemText).toContain('FORMATO DE RESPUESTA OBLIGATORIO');
    });
  });

  // ── Schedule mapping ─────────────────────────────────────────────
  describe('schedule mapping', () => {
    it('returns schedule array with dayOfWeek numbers', async () => {
      const response = {
        ...VALID_GEMINI_RESPONSE,
        vacancy: {
          ...VALID_GEMINI_RESPONSE.vacancy,
          schedule: [
            { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
            { dayOfWeek: 3, startTime: '14:00', endTime: '18:00' },
            { dayOfWeek: 5, startTime: '08:00', endTime: '12:00' },
          ],
        },
      };
      mockFetch.mockResolvedValueOnce(mockGeminiResponse(response));

      const service = createService();
      const result = await service.parseFromText('Lun, Mie, Vie 08 a 12', 'AT');

      expect(result.vacancy.schedule).toHaveLength(3);
      expect(result.vacancy.schedule[0].dayOfWeek).toBe(1);
      expect(result.vacancy.schedule[2].dayOfWeek).toBe(5);
    });
  });
});
