import type { NavigateFunction } from 'react-router-dom';
import { ApiError } from '@infrastructure/http/ApiError';

/**
 * Defesa contra o caso "operador com bundle JS antigo abriu o modal grande
 * pra uma vaga já publicada (is_draft=false)".
 *
 * O backend responde 403 com mensagem específica
 *   `Forbidden fields for vacancy in status "X": …. Only schedule and status can be edited.`
 * (ver `worker-functions/.../vacancyCrudHelpers.ts`).
 *
 * Em vez de mostrar essa mensagem técnica para o operador, redirecionamos para
 * o detalhe da vaga (`/admin/vacancies/{id}`), onde o caminho correto de edição
 * localizada (`VacancyScheduleEditModal` + `VacancyStatusEditor`) vive.
 *
 * Retorna `true` quando interceptou o erro (chamador deve dar return),
 * `false` quando deixou passar (chamador segue o tratamento de erro normal).
 */
export function handlePublishedVacancyForbidden(
  err: unknown,
  navigate: NavigateFunction,
  vacancyId: string | undefined,
): boolean {
  if (!vacancyId) return false;
  if (!(err instanceof ApiError)) return false;
  if (err.status !== 403) return false;
  if (!err.message.includes('Forbidden fields')) return false;

  navigate(`/admin/vacancies/${vacancyId}`, {
    state: { publishedVacancyRedirect: true },
  });
  return true;
}
