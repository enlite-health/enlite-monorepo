import { isHttpUrl } from '@presentation/utils/isHttpUrl';
import type { Job } from './jobsConstants';

/**
 * Para onde "Ver Detalles" leva. `detailLink` só vale se for URL http(s); se vier inválido
 * (ex.: JSON cru do feed antigo), cai na rota interna `/vacantes/:id` (App.tsx), que aceita o
 * UUID da vaga. Sem nenhum dos dois (scraper legado sem id), devolve `null` e o botão fica
 * desabilitado — nunca se abre uma aba com texto inválido.
 */
export function resolveJobDetailUrl(job: Pick<Job, 'detailLink' | 'id'>): string | null {
  if (isHttpUrl(job.detailLink)) return job.detailLink;
  if (job.id) return `/vacantes/${encodeURIComponent(job.id)}`;
  return null;
}
