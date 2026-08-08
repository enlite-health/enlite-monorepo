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
export function createPeriskopeHttpClient(timeoutMs = 15000): AxiosInstance | null {
  const apiKey = process.env.PERISKOPE_API_KEY;
  // Número conectado no Periskope: DDI + número, só dígitos (ex: 5491122334455)
  const phone = process.env.PERISKOPE_PHONE;

  if (!apiKey || !phone) return null;

  return axios.create({
    baseURL: resolveBaseUrl(),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'x-phone': phone,
      'Content-Type': 'application/json',
    },
    timeout: timeoutMs,
  });
}
