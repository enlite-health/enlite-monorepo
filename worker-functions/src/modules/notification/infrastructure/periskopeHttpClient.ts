import axios, { AxiosInstance } from 'axios';

/** Base da API do Periskope (https://docs.periskope.app). */
export const PERISKOPE_BASE_URL = 'https://api.periskope.app/v1';

/**
 * Base efetiva. `PERISKOPE_BASE_URL` no ambiente existe para o e2e apontar para
 * um servidor local que devolve o payload REAL capturado de produção — assim o
 * teste exercita a nossa API e o nosso Postgres de verdade sem chamar (nem
 * arriscar escrever em) o Periskope de produção. Em prod a variável não existe
 * e a constante vale.
 */
function resolveBaseUrl(): string {
  return process.env.PERISKOPE_BASE_URL || PERISKOPE_BASE_URL;
}

/**
 * Fábrica ÚNICA do cliente HTTP do Periskope.
 *
 * Os quatro serviços de Periskope (messaging, group notify, note, ticket) e a
 * leitura de chats montavam o mesmo `axios.create` copiado — mesma baseURL,
 * mesmo par de headers (`Authorization: Bearer <PERISKOPE_API_KEY>` +
 * `x-phone: <PERISKOPE_PHONE>`), mesmo timeout. Auth e base-url passam a viver
 * aqui: trocar a versão da API ou a forma de autenticar é um lugar só.
 *
 * Retorna `null` quando falta credencial — cada serviço decide o que fazer com
 * isso (todos degradam para no-op; nenhum lança no construtor).
 */
export interface PeriskopeClientOptions {
  /**
   * `true` (default) = manda `x-phone`, que **escopa a chamada a UM número
   * conectado**. É obrigatório para ENVIAR: o header escolhe de qual número a
   * mensagem sai.
   *
   * `false` = omite o header, e a API responde por **todos os números que o
   * token alcança**. É o que a LEITURA quer: a org tem mais de um número
   * conectado, e um grupo vinculável pode estar em qualquer um deles.
   *
   * ⚠️ Medido em 09/08/2026 contra a API real: com o header, `GET /chats`
   * devolvia **774** grupos; sem ele, **788** — os 14 do segundo número
   * (`5491127671720`, "Reclutamiento Enlite H") eram um ponto cego silencioso.
   * A própria doc do fornecedor confirma: o parâmetro de telefone é opcional e
   * "omit to return data across all phones the API token can access".
   */
  scopeToPhone?: boolean;
}

export function createPeriskopeHttpClient(
  timeoutMs = 15000,
  opts: PeriskopeClientOptions = {},
): AxiosInstance | null {
  const apiKey = process.env.PERISKOPE_API_KEY;
  // Número conectado no Periskope: DDI + número, só dígitos (ex: 5491122334455)
  const phone = process.env.PERISKOPE_PHONE;
  const scopeToPhone = opts.scopeToPhone ?? true;

  // Sem chave não há chamada. O NÚMERO só é exigido de quem escopa por número —
  // para a leitura da org inteira ele é irrelevante, e exigi-lo transformaria
  // uma variável de ENVIO em pré-requisito de LEITURA.
  if (!apiKey) return null;
  if (scopeToPhone && !phone) return null;

  return axios.create({
    baseURL: resolveBaseUrl(),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(scopeToPhone ? { 'x-phone': phone as string } : {}),
      'Content-Type': 'application/json',
    },
    timeout: timeoutMs,
  });
}
