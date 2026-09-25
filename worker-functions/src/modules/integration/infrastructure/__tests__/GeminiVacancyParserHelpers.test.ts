/**
 * GeminiVacancyParserHelpers.test.ts — T065.
 *
 * `parseFromTalentumDescriptionHelper` extrai `case_number` do título Talentum
 * (fonte da verdade — a IA NÃO decide esse valor). Cobre os dois formatos que
 * a spec 027 Fase 6 exige tolerar: "CASO N[-M]" (legado) e "EN N#M" / "N#M" (novo).
 */

const mockGenerateContentVertex = jest.fn();
jest.mock('../vertex-gemini', () => ({
  generateContentVertex: (...args: unknown[]) => mockGenerateContentVertex(...args),
}));

import {
  parseFromTalentumDescriptionHelper,
  detectMissingFields,
  retryMissingFields,
} from '../GeminiVacancyParserHelpers';
import type { ParsedVacancyResult } from '../GeminiVacancyParserService';

function mockGeminiJsonResponse(body: Record<string, unknown>) {
  mockGenerateContentVertex.mockResolvedValueOnce({
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }],
    }),
  });
}

const MINIMAL_VACANCY_BODY = {
  required_professions: ['AT'],
  required_sex: null,
  age_range_min: null,
  age_range_max: null,
  required_experience: null,
  worker_attributes: null,
  schedule: [],
  work_schedule: null,
  providers_needed: 1,
  salary_text: null,
  payment_day: null,
  daily_obs: null,
};

describe('parseFromTalentumDescriptionHelper — extração de case_number do título (T065)', () => {
  beforeEach(() => {
    mockGenerateContentVertex.mockReset();
  });

  it.each([
    ['CASO 729-5568', 729],
    ['CASO 230', 230],
    ['EN1234#01', 1234],
    ['729#03', 729],
    ['Recepcionista Zona Norte', null],
  ])('título "%s" → case_number=%s', async (title, expectedCaseNumber) => {
    mockGeminiJsonResponse(MINIMAL_VACANCY_BODY);

    const vacancy = await parseFromTalentumDescriptionHelper('gemini-test', 'descrição qualquer', title);

    expect(vacancy.case_number).toBe(expectedCaseNumber);
  });

  it('título no formato novo EN<N>#<M>, caso nativo (≥1000) → title "CASO EN<N>" (D422, 24/09/2026 — write path passa a formatar)', async () => {
    mockGeminiJsonResponse(MINIMAL_VACANCY_BODY);

    const vacancy = await parseFromTalentumDescriptionHelper('gemini-test', 'descrição', 'EN1234#01');

    expect(vacancy.title).toBe('CASO EN1234');
  });

  it('título "CASO 230" (legado, <1000) → title "CASO 230", sem prefixo (D412, inalterado)', async () => {
    mockGeminiJsonResponse(MINIMAL_VACANCY_BODY);

    const vacancy = await parseFromTalentumDescriptionHelper('gemini-test', 'descrição', 'CASO 230');

    expect(vacancy.title).toBe('CASO 230');
  });

  it('loga tokens (usageMetadata) quando o Gemini devolve promptTokenCount/candidatesTokenCount', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    mockGenerateContentVertex.mockResolvedValueOnce({
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(MINIMAL_VACANCY_BODY) }] } }],
        usageMetadata: { promptTokenCount: 111, candidatesTokenCount: 22 },
      }),
    });

    await parseFromTalentumDescriptionHelper('gemini-test', 'descrição', 'CASO 230');

    const lines = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('Talentum tokens: prompt=111 completion=22');
    logSpy.mockRestore();
  });

  it('lança erro quando o Gemini devolve resposta sem content (texto vazio)', async () => {
    mockGenerateContentVertex.mockResolvedValueOnce({
      json: async () => ({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
    });

    await expect(
      parseFromTalentumDescriptionHelper('gemini-test', 'descrição', 'CASO 230'),
    ).rejects.toThrow('Empty response from Gemini API');
  });

  it('required_professions vazio no parsed → fallback para ["AT"]', async () => {
    mockGeminiJsonResponse({ ...MINIMAL_VACANCY_BODY, required_professions: [] });

    const vacancy = await parseFromTalentumDescriptionHelper('gemini-test', 'descrição', 'CASO 230');

    expect(vacancy.required_professions).toEqual(['AT']);
  });

  it('providers_needed=0 (falsy) no parsed → fallback para 1', async () => {
    mockGeminiJsonResponse({ ...MINIMAL_VACANCY_BODY, providers_needed: 0 });

    const vacancy = await parseFromTalentumDescriptionHelper('gemini-test', 'descrição', 'CASO 230');

    expect(vacancy.providers_needed).toBe(1);
  });
});

// ── detectMissingFields ─────────────────────────────────────────────

function makeVacancy(overrides: Partial<ParsedVacancyResult['vacancy']> = {}): ParsedVacancyResult['vacancy'] {
  return {
    case_number: 230,
    title: 'CASO 230',
    required_professions: ['AT'],
    required_sex: 'F',
    age_range_min: 20,
    age_range_max: 60,
    required_experience: 'Con experiencia',
    worker_attributes: null,
    schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '16:00' }],
    work_schedule: 'Diurno',
    providers_needed: 1,
    salary_text: '$100.000',
    payment_day: '10',
    daily_obs: null,
    status: 'SEARCHING',
    ...overrides,
  };
}

describe('detectMissingFields', () => {
  it('vacancy completa (todos os campos críticos presentes + schedule não-vazio) → sem faltantes', () => {
    const missing = detectMissingFields(makeVacancy());
    expect(missing).toEqual([]);
  });

  it('campos críticos null → cada um vira faltante', () => {
    const vacancy = makeVacancy({
      age_range_min: null,
      required_sex: null,
      salary_text: null,
    });

    const missing = detectMissingFields(vacancy);

    expect(missing).toEqual(expect.arrayContaining(['age_range_min', 'required_sex', 'salary_text']));
    expect(missing).not.toContain('age_range_max');
  });

  it('campo crítico undefined (não só null) também vira faltante', () => {
    const vacancy = makeVacancy();
    (vacancy as Record<string, unknown>).work_schedule = undefined;

    const missing = detectMissingFields(vacancy);

    expect(missing).toContain('work_schedule');
  });

  it('schedule vazio ([]) → "schedule" entra na lista de faltantes', () => {
    const vacancy = makeVacancy({ schedule: [] });

    const missing = detectMissingFields(vacancy);

    expect(missing).toContain('schedule');
  });

  it('schedule com itens → "schedule" NÃO entra na lista de faltantes', () => {
    const vacancy = makeVacancy({ schedule: [{ dayOfWeek: 2, startTime: '09:00', endTime: '17:00' }] });

    const missing = detectMissingFields(vacancy);

    expect(missing).not.toContain('schedule');
  });
});

// ── retryMissingFields ──────────────────────────────────────────────

describe('retryMissingFields', () => {
  beforeEach(() => {
    mockGenerateContentVertex.mockReset();
  });

  it('aplica só os campos que vieram preenchidos (não-null/undefined) no patch, ignora o resto', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const vacancy = makeVacancy({ salary_text: null, required_sex: null });
    mockGenerateContentVertex.mockResolvedValueOnce({
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify({ salary_text: '$200.000', required_sex: null }) }],
          },
        }],
      }),
    });

    const result = await retryMissingFields('gemini-test', vacancy, 'texto original', ['salary_text', 'required_sex']);

    expect(result.salary_text).toBe('$200.000');
    expect(result.required_sex).toBeNull(); // patch trouxe null → não aplica, mantém original
    const lines = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('Retry patched 1/2 fields');
    logSpy.mockRestore();
  });

  it('resposta sem content → devolve a vacancy original intocada', async () => {
    const vacancy = makeVacancy({ salary_text: null });
    mockGenerateContentVertex.mockResolvedValueOnce({
      json: async () => ({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
    });

    const result = await retryMissingFields('gemini-test', vacancy, 'texto original', ['salary_text']);

    expect(result).toBe(vacancy);
    expect(result.salary_text).toBeNull();
  });

  it('generateContentVertex lança erro → captura, loga warning e devolve a vacancy original (keep original)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const vacancy = makeVacancy({ salary_text: null });
    mockGenerateContentVertex.mockRejectedValueOnce(new Error('Vertex indisponível'));

    const result = await retryMissingFields('gemini-test', vacancy, 'texto original', ['salary_text']);

    expect(result).toBe(vacancy);
    expect(result.salary_text).toBeNull();
    const lines = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('Retry failed, keeping original');
    warnSpy.mockRestore();
  });
});
