/**
 * adminApi.ts — APIRequestContext AUTENTICADO como ADMIN contra a API de produção.
 *
 * Por que existe: os specs de caminho-de-erro da superfície admin batem endpoints
 * `/api/admin/*` que exigem token de staff/admin. O jeito honesto (zero mock, regra da
 * suíte) de obter esse token é logar de verdade no Firebase Auth de prod com a conta
 * dedicada de teste (E2E_ADMIN_EMAIL/PASSWORD, já promovida a admin) via o endpoint REST
 * `accounts:signInWithPassword`, e mandar o idToken resultante como `Authorization: Bearer`.
 *
 * SEGURANÇA:
 *  - O login usa o `fetch` global do Node (fora do Playwright), então NENHUM artefato do
 *    Playwright (trace/vídeo/screenshot) captura a senha ou o idToken na troca de credencial.
 *  - O idToken vive só em memória (cache de módulo) e vai como header. O projeto `admin` roda
 *    com retries=0 → trace desligado → o header Bearer também não é gravado em artefato.
 *  - Erros NUNCA logam corpo da resposta do Firebase (poderia ecoar e-mail/token) — só o status.
 */
import { request, type APIRequestContext } from '@playwright/test';
import { PROD_API_URL } from './env';

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

let cachedToken: string | null = null;

/**
 * Obtém (e cacheia) o idToken Firebase da conta admin de teste via signInWithPassword.
 * A apiKey web do Firebase NÃO é segredo (já embarcada no bundle do front); o segredo é a senha.
 */
export async function getAdminIdToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (!FIREBASE_API_KEY || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      '[adminApi] FIREBASE_API_KEY / E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD ausentes. ' +
        'Defina em .env.local (gitignored) ou no ambiente do Cloud Run Job.',
    );
  }

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, returnSecureToken: true }),
    },
  );

  if (!res.ok) {
    // NUNCA logar o corpo (pode ecoar e-mail/detalhe do provedor) — só o status.
    throw new Error(`[adminApi] signInWithPassword falhou: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { idToken?: string };
  if (!data.idToken) {
    throw new Error('[adminApi] signInWithPassword não retornou idToken.');
  }
  cachedToken = data.idToken;
  return cachedToken;
}

/**
 * Cria um APIRequestContext com baseURL na API de prod e o header Authorization: Bearer
 * já preenchido com o idToken admin. O chamador é dono do ciclo de vida — deve chamar
 * `ctx.dispose()` no fim (tipicamente em afterAll).
 */
export async function newAdminApiContext(): Promise<APIRequestContext> {
  const idToken = await getAdminIdToken();
  return request.newContext({
    baseURL: PROD_API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${idToken}` },
  });
}
