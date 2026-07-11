/**
 * api.ts — helper de APIRequestContext apontando pra API de produção (read-only).
 *
 * Camada 1 (smoke) usa isto pra bater GETs de health/feed diretamente na API, sem
 * navegador. Regra da suíte: NADA de mock/page.route — é prod real. Aqui só GET.
 *
 * Sem header custom: um APIRequestContext bate direto na API (não passa por CORS de
 * browser), mas mantemos paridade com o browser — nenhum header sintético que o
 * backend não honra.
 */
import { request, type APIRequestContext } from '@playwright/test';
import { PROD_API_URL } from './env';

/**
 * Cria um APIRequestContext com baseURL na API de prod. O chamador é dono do ciclo
 * de vida — deve chamar `ctx.dispose()` no fim (tipicamente em afterAll).
 */
export async function newApiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: PROD_API_URL,
  });
}
