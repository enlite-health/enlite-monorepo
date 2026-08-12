/**
 * GeminiVacancyParserService.test.ts
 *
 * Cobertura completa do metodo parseFromTalentumDescription (Step 2 do sync)
 * e do metodo parseFromText existente.
 *
 * Cenarios:
 *  1. Parsing bem-sucedido de description Talentum
 *  2. Extrai case_number do titulo (nao do LLM)
 *  3. Defaults (status, providers_needed, required_professions)
 *  4. Titulo sem case_number → case_number null
 *  5. Erro de API Gemini
 *  6. Resposta vazia do Gemini
 *  7. parseFromText com prompt file
 *
 * Auth: as chamadas usam Vertex AI via ADC (google-auth-library), não API
 * key. O GoogleAuth é mockado para devolver token/projeto fixos; o fetch
 * subjacente continua mockado normalmente.
 */

// ── Mock do fetch global ─────────────────────────────────────────

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// Mock do GoogleAuth (ADC) para não bater no metadata server nos testes
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getAccessToken: jest.fn().mockResolvedValue('test-access-token'),
    getProjectId: jest.fn().mockResolvedValue('test-project'),
  })),
}));

// Mock do GoogleDocsPromptProvider para evitar chamadas ao Google Drive
jest.mock('../GoogleDocsPromptProvider', () => ({
  GoogleDocsPromptProvider: jest.fn().mockImplementation(() => ({
    getPrompt: jest.fn().mockResolvedValue('Prompt template para AT/CUIDADOR'),
    clearCache: jest.fn(),
  })),
}));

import { GeminiVacancyParserService } from '../GeminiVacancyParserService';

// ── Helpers ──────────────────────────────────────────────────────

function makeGeminiResponse(content: Record<string, any>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify(content) }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 500,
          candidatesTokenCount: 200,
        },
      }),
    text: () => Promise.resolve(''),
  };
}

function makeTalentumVacancyOutput(overrides: Record<string, any> = {}) {
  return {
    required_professions: overrides.required_professions ?? ['AT'],
    required_sex: overrides.required_sex ?? 'M',
    age_range_min: overrides.age_range_min ?? null,
    age_range_max: overrides.age_range_max ?? null,
    required_experience: overrides.required_experience ?? 'experiencia con TEA',
    worker_attributes: overrides.worker_attributes ?? null,
    schedule: overrides.schedule ?? [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
    work_schedule: overrides.work_schedule ?? 'part-time',
    pathology_types: overrides.pathology_types ?? 'TEA',
    dependency_level: overrides.dependency_level ?? null,
    providers_needed: overrides.providers_needed ?? 1,
    salary_text: overrides.salary_text ?? 'A convenir',
    payment_day: overrides.payment_day ?? null,
    daily_obs: overrides.daily_obs ?? null,
    status: overrides.status ?? 'SEARCHING',
  };
}

function makeFullParseOutput(overrides: Record<string, any> = {}) {
  return {
    vacancy: {
      case_number: overrides.case_number ?? 42,
      title: overrides.title ?? 'CASO 42',
      required_professions: ['AT'],
      required_sex: 'M',
      age_range_min: null,
      age_range_max: null,
      required_experience: 'experiencia',
      worker_attributes: null,
      schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
      work_schedule: 'part-time',
      pathology_types: 'TEA',
      dependency_level: null,
      providers_needed: 1,
      salary_text: 'A convenir',
      payment_day: null,
      daily_obs: null,
      status: 'SEARCHING',
    },
    prescreening: {
      questions: [
        {
          question: '¿Tenés experiencia con TEA?',
          responseType: ['text', 'audio'],
          desiredResponse: 'Apto: Si',
          weight: 8,
          required: true,
          analyzed: true,
          earlyStoppage: false,
        },
      ],
      faq: [{ question: '¿Cuál es el horario?', answer: 'Lunes a viernes 9-17hs' }],
    },
    description: {
      titulo_propuesta: 'CASO 42, AT - Recoleta',
      descripcion_propuesta: 'Se busca un profesional...',
      perfil_profesional: 'AT con experiencia...',
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('GeminiVacancyParserService', () => {
  let service: GeminiVacancyParserService;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    process.env = { ...originalEnv, GEMINI_MODEL: 'gemini-test' };
    service = new GeminiVacancyParserService();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  // ── parseFromTalentumDescription ─────────────────────────────

  describe('parseFromTalentumDescription', () => {
    it('deve retornar vacancy fields parseados corretamente', async () => {
      const geminiOutput = makeTalentumVacancyOutput();
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(geminiOutput));

      const result = await service.parseFromTalentumDescription(
        'Descripcion de la Propuesta: paciente adulto...',
        'CASO 42 - AT Recoleta',
      );

      expect(result.required_professions).toEqual(['AT']);
      expect(result.required_sex).toBe('M');
    });

    it('deve extrair case_number do titulo (nao do LLM)', async () => {
      const geminiOutput = makeTalentumVacancyOutput();
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(geminiOutput));

      const result = await service.parseFromTalentumDescription(
        'Descripcion...',
        'CASO 99 - AT Belgrano',
      );

      expect(result.case_number).toBe(99);
      expect(result.title).toBe('CASO 99');
    });

    it('deve retornar case_number null quando titulo nao tem CASO', async () => {
      const geminiOutput = makeTalentumVacancyOutput();
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(geminiOutput));

      const result = await service.parseFromTalentumDescription(
        'Descripcion...',
        'Proyecto generico',
      );

      expect(result.case_number).toBeNull();
      expect(result.title).toBe('Proyecto generico');
    });

    it('deve forcar status=SEARCHING', async () => {
      const geminiOutput = makeTalentumVacancyOutput({ status: 'CLOSED' });
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(geminiOutput));

      const result = await service.parseFromTalentumDescription('desc', 'CASO 1');

      expect(result.status).toBe('SEARCHING');
    });

    it('deve defaultar providers_needed=1 quando LLM retorna 0 ou undefined', async () => {
      const geminiOutput = makeTalentumVacancyOutput({ providers_needed: 0 });
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(geminiOutput));

      const result = await service.parseFromTalentumDescription('desc', 'CASO 1');

      expect(result.providers_needed).toBe(1);
    });

    it('deve defaultar required_professions=["AT"] quando LLM retorna array vazio', async () => {
      const geminiOutput = makeTalentumVacancyOutput({ required_professions: [] });
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(geminiOutput));

      const result = await service.parseFromTalentumDescription('desc', 'CASO 1');

      expect(result.required_professions).toEqual(['AT']);
    });

    it('deve manter required_professions quando LLM retorna valor', async () => {
      const geminiOutput = makeTalentumVacancyOutput({
        required_professions: ['CAREGIVER', 'NURSE'],
      });
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(geminiOutput));

      const result = await service.parseFromTalentumDescription('desc', 'CASO 1');

      expect(result.required_professions).toEqual(['CAREGIVER', 'NURSE']);
    });

    it('deve enviar titulo e description no user prompt', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeTalentumVacancyOutput()));

      await service.parseFromTalentumDescription('Texto da descricao XYZ', 'CASO 55 - AT');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userText = fetchBody.contents[0].parts[0].text;
      expect(userText).toContain('CASO 55 - AT');
      expect(userText).toContain('Texto da descricao XYZ');
    });

    it('deve usar responseMimeType=application/json', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeTalentumVacancyOutput()));

      await service.parseFromTalentumDescription('desc', 'CASO 1');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.generationConfig.responseMimeType).toBe('application/json');
    });

    it('deve usar temperature=0', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeTalentumVacancyOutput()));

      await service.parseFromTalentumDescription('desc', 'CASO 1');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.generationConfig.temperature).toBe(0);
    });

    it('deve usar maxOutputTokens=4096 (menor que parseFromText)', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeTalentumVacancyOutput()));

      await service.parseFromTalentumDescription('desc', 'CASO 1');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.generationConfig.maxOutputTokens).toBe(4096);
    });
  });

  // ── Erros ────────────────────────────────────────────────────

  describe('tratamento de erros', () => {
    it('deve lancar erro quando Gemini retorna HTTP error apos esgotar retries', async () => {
      // 429 is transient — fetchGeminiWithRetry retries up to MAX_ATTEMPTS (5) then throws.
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limit exceeded'),
      });

      await expect(
        service.parseFromTalentumDescription('desc', 'CASO 1'),
      ).rejects.toThrow('Gemini API error 429');
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('deve lancar erro quando Gemini retorna resposta vazia', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [{ content: { parts: [{ text: '' }] } }],
          }),
        text: () => Promise.resolve(''),
      });

      await expect(
        service.parseFromTalentumDescription('desc', 'CASO 1'),
      ).rejects.toThrow('Empty response from Gemini API');
    });

    it('deve lancar erro quando candidates array vazio', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ candidates: [] }),
        text: () => Promise.resolve(''),
      });

      await expect(
        service.parseFromTalentumDescription('desc', 'CASO 1'),
      ).rejects.toThrow('Empty response from Gemini API');
    });

    it('deve lancar erro quando JSON do Gemini e invalido', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [{ content: { parts: [{ text: 'not valid json{{{' }] } }],
          }),
        text: () => Promise.resolve(''),
      });

      await expect(
        service.parseFromTalentumDescription('desc', 'CASO 1'),
      ).rejects.toThrow();
    });
  });

  // ── parseFromPdf ─────────────────────────────────────────────

  describe('parseFromPdf', () => {
    it('deve retornar vacancy, prescreening e description', async () => {
      const fullOutput = makeFullParseOutput();
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(fullOutput));

      const result = await service.parseFromPdf('dGVzdCBwZGY=', 'AT');

      expect(result.vacancy).toBeDefined();
      expect(result.prescreening).toBeDefined();
      expect(result.description).toBeDefined();
      expect(result.vacancy.case_number).toBe(42);
      expect(result.prescreening.questions).toHaveLength(1);
    });

    it('deve enviar inlineData com mimeType application/pdf', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeFullParseOutput()));

      await service.parseFromPdf('dGVzdA==', 'AT');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userParts = fetchBody.contents[0].parts;
      expect(userParts).toHaveLength(1);
      expect(userParts[0].inlineData).toBeDefined();
      expect(userParts[0].inlineData.mimeType).toBe('application/pdf');
      expect(userParts[0].inlineData.data).toBe('dGVzdA==');
    });

    it('deve forcar status=SEARCHING', async () => {
      const output = makeFullParseOutput();
      output.vacancy.status = '';
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(output));

      const result = await service.parseFromPdf('dGVzdA==', 'AT');

      expect(result.vacancy.status).toBe('SEARCHING'); // GeminiVacancyParserService forces SEARCHING
    });

    it('deve defaultar providers_needed=1', async () => {
      const output = makeFullParseOutput();
      output.vacancy.providers_needed = 0;
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(output));

      const result = await service.parseFromPdf('dGVzdA==', 'AT');

      expect(result.vacancy.providers_needed).toBe(1);
    });

    it('deve defaultar professions para AT quando workerType=AT', async () => {
      const output = makeFullParseOutput();
      output.vacancy.required_professions = [];
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(output));

      const result = await service.parseFromPdf('dGVzdA==', 'AT');

      expect(result.vacancy.required_professions).toEqual(['AT']);
    });

    it('deve defaultar professions para CAREGIVER quando workerType=CUIDADOR', async () => {
      const output = makeFullParseOutput();
      output.vacancy.required_professions = [];
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(output));

      const result = await service.parseFromPdf('dGVzdA==', 'CUIDADOR');

      expect(result.vacancy.required_professions).toEqual(['CAREGIVER']);
    });

    it('deve usar maxOutputTokens=8192', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeFullParseOutput()));

      await service.parseFromPdf('dGVzdA==', 'AT');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.generationConfig.maxOutputTokens).toBe(8192);
    });

    it('deve chamar endpoint Vertex (ADC) com modelo correto', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeFullParseOutput()));

      await service.parseFromPdf('dGVzdA==', 'AT');

      const url = mockFetch.mock.calls[0][0] as string;
      const init = mockFetch.mock.calls[0][1];
      expect(url).toContain('aiplatform.googleapis.com');
      expect(url).toContain('models/gemini-test');
      expect(url).not.toContain('key=');
      expect(init.headers.Authorization).toBe('Bearer test-access-token');
    });

    it('deve incluir system prompt com instrucoes JSON', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeFullParseOutput()));

      await service.parseFromPdf('dGVzdA==', 'AT');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const systemPrompt = fetchBody.systemInstruction.parts[0].text;
      expect(systemPrompt).toContain('FORMATO DE RESPUESTA OBLIGATORIO');
      expect(systemPrompt).toContain('Prompt template para AT/CUIDADOR');
    });

    it('deve lancar erro quando Gemini retorna HTTP error apos esgotar retries', async () => {
      // 500 is transient — fetchGeminiWithRetry retries up to MAX_ATTEMPTS (5) then throws.
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      await expect(service.parseFromPdf('dGVzdA==', 'AT')).rejects.toThrow('Gemini API error 500');
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('deve lancar erro quando Gemini retorna resposta vazia', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
        text: () => Promise.resolve(''),
      });

      await expect(service.parseFromPdf('dGVzdA==', 'AT')).rejects.toThrow('Empty response from Gemini API');
    });

    it('nao deve enviar campo text nos parts (apenas inlineData)', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeFullParseOutput()));

      await service.parseFromPdf('dGVzdA==', 'AT');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userParts = fetchBody.contents[0].parts;
      expect(userParts[0].text).toBeUndefined();
    });
  });

  // ── parseFromText ────────────────────────────────────────────

  describe('parseFromText', () => {
    it('deve retornar vacancy, prescreening e description', async () => {
      const fullOutput = makeFullParseOutput();
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(fullOutput));

      const result = await service.parseFromText('Texto do caso completo...', 'AT');

      expect(result.vacancy).toBeDefined();
      expect(result.prescreening).toBeDefined();
      expect(result.description).toBeDefined();
      expect(result.vacancy.case_number).toBe(42);
      expect(result.prescreening.questions).toHaveLength(1);
    });

    it('deve forcar status=SEARCHING no parseFromText', async () => {
      const output = makeFullParseOutput();
      output.vacancy.status = '';
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(output));

      const result = await service.parseFromText('texto', 'AT');

      expect(result.vacancy.status).toBe('SEARCHING');
    });

    it('deve defaultar providers_needed=1', async () => {
      const output = makeFullParseOutput();
      output.vacancy.providers_needed = 0;
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(output));

      const result = await service.parseFromText('texto', 'AT');

      expect(result.vacancy.providers_needed).toBe(1);
    });

    it('deve defaultar professions para AT quando workerType=AT', async () => {
      const output = makeFullParseOutput();
      output.vacancy.required_professions = [];
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(output));

      const result = await service.parseFromText('texto', 'AT');

      expect(result.vacancy.required_professions).toEqual(['AT']);
    });

    it('deve defaultar professions para CAREGIVER quando workerType=CUIDADOR', async () => {
      const output = makeFullParseOutput();
      output.vacancy.required_professions = [];
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(output));

      const result = await service.parseFromText('texto', 'CUIDADOR');

      expect(result.vacancy.required_professions).toEqual(['CAREGIVER']);
    });

    it('deve usar maxOutputTokens=8192 no parseFromText', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeFullParseOutput()));

      await service.parseFromText('texto', 'AT');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.generationConfig.maxOutputTokens).toBe(8192);
    });

    it('deve chamar endpoint Vertex (ADC) com modelo correto', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeFullParseOutput()));

      await service.parseFromText('texto', 'AT');

      const url = mockFetch.mock.calls[0][0] as string;
      const init = mockFetch.mock.calls[0][1];
      expect(url).toContain('aiplatform.googleapis.com');
      expect(url).toContain('models/gemini-test');
      expect(url).not.toContain('key=');
      expect(init.headers.Authorization).toBe('Bearer test-access-token');
    });
  });

  // ── buildSystemPrompt ────────────────────────────────────────

  describe('buildSystemPrompt (via parseFromText)', () => {
    it('deve incluir instrucoes JSON no system prompt', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeFullParseOutput()));

      await service.parseFromText('texto', 'AT');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const systemPrompt = fetchBody.systemInstruction.parts[0].text;
      expect(systemPrompt).toContain('FORMATO DE RESPUESTA OBLIGATORIO');
    });

    it('deve incluir conteudo do prompt file quando disponivel', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeFullParseOutput()));

      await service.parseFromText('texto', 'AT');

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const systemPrompt = fetchBody.systemInstruction.parts[0].text;
      expect(systemPrompt).toContain('Prompt template para AT/CUIDADOR');
    });
  });

  // ── URL e configuracao ───────────────────────────────────────

  describe('configuracao', () => {
    it('deve usar modelo default gemini-2.5-pro quando GEMINI_MODEL nao definido', () => {
      delete process.env.GEMINI_MODEL;
      const svc = new GeminiVacancyParserService();

      // Acessar model via chamada
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeTalentumVacancyOutput()));
      svc.parseFromTalentumDescription('desc', 'CASO 1').then(() => {
        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toContain('gemini-2.5-pro');
      });
    });

    it('deve usar GEMINI_MODEL do env quando definido', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeTalentumVacancyOutput()));

      await service.parseFromTalentumDescription('desc', 'CASO 1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('gemini-test');
    });

    it('override do constructor precede o GEMINI_MODEL do env (modelo rápido)', async () => {
      mockFetch.mockResolvedValueOnce(makeGeminiResponse(makeTalentumVacancyOutput()));

      // process.env.GEMINI_MODEL = 'gemini-test', mas o override deve vencer.
      const svc = new GeminiVacancyParserService('gemini-2.5-flash');
      await svc.parseFromTalentumDescription('desc', 'CASO 1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('models/gemini-2.5-flash');
      expect(url).not.toContain('gemini-test');
    });
  });
});
