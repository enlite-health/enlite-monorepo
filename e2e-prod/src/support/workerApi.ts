/**
 * workerApi.ts — helpers do papel WORKER contra a API de produção.
 *
 * Espelha `adminApi.ts`, MAS com uma diferença essencial de desenho (firmada em
 * decisoes.md 2026-07-13): o worker NÃO é uma conta fixa pré-criada. Cada run da
 * jornada faz um SIGNUP FRESCO de um alias único (`gabriel+e2e-worker-<run>@gmail.com`)
 * e obtém o idToken direto do signup — não há login por senha fixa como no admin.
 *
 * SEGURANÇA (idêntica ao adminApi):
 *  - Signup/delete usam o `fetch` GLOBAL do Node (fora do Playwright), então NENHUM
 *    artefato do Playwright (trace/vídeo/screenshot) captura a senha ou o idToken.
 *  - O idToken vive só em memória (variável local do teste) e vai como header Bearer.
 *  - Erros NUNCA logam o corpo da resposta do Firebase (poderia ecoar e-mail/token) —
 *    só o status HTTP.
 *  - A apiKey web do Firebase NÃO é segredo (já embarcada no bundle do front); o
 *    segredo é a senha, que é throwaway e só-de-teste.
 */
import { request, type APIRequestContext } from '@playwright/test';
import { PROD_API_URL } from './env';

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

export interface WorkerSignup {
  /** idToken Firebase do worker recém-criado — vai como Authorization: Bearer. */
  idToken: string;
  /** UID Firebase (accounts:signUp `localId`) — é o `authUid` do body do /api/workers/init. */
  localId: string;
}

/**
 * Cria uma conta Firebase FRESCA (accounts:signUp) e devolve idToken + localId.
 * Um alias novo por run garante zero colisão e zero estado herdado entre execuções.
 */
export async function signUpWorker(email: string, password: string): Promise<WorkerSignup> {
  if (!FIREBASE_API_KEY) {
    throw new Error(
      '[workerApi] FIREBASE_API_KEY ausente. Defina em .env.local (gitignored) ' +
        'ou no ambiente do Cloud Run Job.',
    );
  }

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );

  if (!res.ok) {
    // NUNCA logar o corpo (pode ecoar e-mail/detalhe do provedor) — só o status.
    throw new Error(`[workerApi] accounts:signUp falhou: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { idToken?: string; localId?: string };
  if (!data.idToken || !data.localId) {
    throw new Error('[workerApi] accounts:signUp não retornou idToken/localId.');
  }
  return { idToken: data.idToken, localId: data.localId };
}

/**
 * Autentica uma conta que JÁ existe (accounts:signInWithPassword) e devolve o idToken.
 * Usado quando a conta nasceu pela TELA de cadastro: a jornada por UI não devolve
 * token, e o teardown precisa dele para apagar a conta Firebase no fim.
 */
export async function signInWorker(email: string, password: string): Promise<WorkerSignup> {
  if (!FIREBASE_API_KEY) {
    throw new Error('[workerApi] FIREBASE_API_KEY ausente.');
  }
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  // NUNCA logar o corpo (pode ecoar e-mail/detalhe do provedor) — só o status.
  if (!res.ok) throw new Error(`[workerApi] accounts:signInWithPassword falhou: HTTP ${res.status}`);
  const data = (await res.json()) as { idToken?: string; localId?: string };
  if (!data.idToken || !data.localId) {
    throw new Error('[workerApi] accounts:signInWithPassword não retornou idToken/localId.');
  }
  return { idToken: data.idToken, localId: data.localId };
}

/**
 * Cria um APIRequestContext com baseURL na API de prod e o header Authorization: Bearer
 * já preenchido com o idToken DO WORKER (obtido no signup, não de login fixo).
 * O chamador é dono do ciclo de vida — deve chamar `ctx.dispose()` no fim (afterAll).
 */
export async function newWorkerApiContext(idToken: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: PROD_API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${idToken}` },
  });
}

/**
 * Teardown do lado Firebase: apaga a conta de auth do worker (accounts:delete).
 * Best-effort — nunca lança (afterAll não pode falhar por causa de teardown). Só o
 * status é observável; o corpo nunca é logado. Isso remove a CREDENCIAL; a linha do
 * worker no banco permanece marcada `is_test` (marcador do sweeper — ver report).
 */
export async function deleteWorkerAuthAccount(idToken: string): Promise<void> {
  if (!FIREBASE_API_KEY) return;
  try {
    await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
  } catch {
    // best-effort: falha de rede no teardown não deve derrubar o run.
  }
}
