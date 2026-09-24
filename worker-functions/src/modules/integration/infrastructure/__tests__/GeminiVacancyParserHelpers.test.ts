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

import { parseFromTalentumDescriptionHelper } from '../GeminiVacancyParserHelpers';

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
});
