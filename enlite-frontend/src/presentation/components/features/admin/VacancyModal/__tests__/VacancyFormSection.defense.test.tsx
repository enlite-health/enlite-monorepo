/**
 * handlePublishedVacancyForbidden — defesa do 403 "Forbidden fields".
 *
 * Função pura usada pelo `VacancyFormSection.onSubmit`. Quando o backend
 * rejeita o PUT da vaga publicada com 403, redirecionamos o operador para o
 * detalhe (caminho correto de edição localizada) em vez de exibir a mensagem
 * técnica do backend.
 *
 * Cenários:
 *   - 403 com mensagem "Forbidden fields" → navigate (true)
 *   - 403 com outra mensagem → não intercepta (false)
 *   - Erro genérico (não-ApiError) → não intercepta (false)
 *   - ApiError com outro status → não intercepta (false)
 *   - vacancyId ausente → não intercepta (false)
 */

import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '@infrastructure/http/ApiError';
import { handlePublishedVacancyForbidden } from '../vacancyFormDefense';

const VACANCY_ID = 'vac-defense-1';
const FORBIDDEN_MESSAGE =
  'Forbidden fields for vacancy in status "ACTIVE": case_number, title, patient_id. Only schedule and status can be edited.';

describe('handlePublishedVacancyForbidden', () => {
  it('navigates to detail and returns true when 403 has "Forbidden fields" message', () => {
    const navigate = vi.fn();
    const err = new ApiError(
      { success: false, error: FORBIDDEN_MESSAGE },
      403,
    );

    const intercepted = handlePublishedVacancyForbidden(err, navigate, VACANCY_ID);

    expect(intercepted).toBe(true);
    expect(navigate).toHaveBeenCalledWith(
      `/admin/vacancies/${VACANCY_ID}`,
      { state: { publishedVacancyRedirect: true } },
    );
  });

  it('returns false for 403 with unrelated message', () => {
    const navigate = vi.fn();
    const err = new ApiError(
      { success: false, error: 'Insufficient permissions' },
      403,
    );

    const intercepted = handlePublishedVacancyForbidden(err, navigate, VACANCY_ID);

    expect(intercepted).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns false for ApiError with non-403 status', () => {
    const navigate = vi.fn();
    const err = new ApiError(
      { success: false, error: FORBIDDEN_MESSAGE },
      500, // status diferente
    );

    const intercepted = handlePublishedVacancyForbidden(err, navigate, VACANCY_ID);

    expect(intercepted).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns false for generic Error (non-ApiError)', () => {
    const navigate = vi.fn();
    const err = new Error(FORBIDDEN_MESSAGE);

    const intercepted = handlePublishedVacancyForbidden(err, navigate, VACANCY_ID);

    expect(intercepted).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns false for non-Error value (string, null, undefined)', () => {
    const navigate = vi.fn();

    expect(handlePublishedVacancyForbidden('error string', navigate, VACANCY_ID)).toBe(false);
    expect(handlePublishedVacancyForbidden(null, navigate, VACANCY_ID)).toBe(false);
    expect(handlePublishedVacancyForbidden(undefined, navigate, VACANCY_ID)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns false when vacancyId is undefined', () => {
    const navigate = vi.fn();
    const err = new ApiError(
      { success: false, error: FORBIDDEN_MESSAGE },
      403,
    );

    const intercepted = handlePublishedVacancyForbidden(err, navigate, undefined);

    expect(intercepted).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
