/**
 * Tokens REAIS do Firebase Auth (emulador) — sem `mock_`, sem `USE_MOCK_AUTH`.
 *
 * O fluxo é o mesmo do produto: a conta nasce no Identity Platform (`accounts:signUp`),
 * o claim é gravado pela API administrativa (`accounts:update`, o que `mergeCustomClaims`
 * faz em produção) e o ID token sai de um login por senha. A API sob teste roda com
 * `USE_MOCK_AUTH=false` e valida o token contra o emulador (`FIREBASE_AUTH_EMULATOR_HOST`).
 *
 * ⚠️ Sem probe, sem fallback: se o emulador não responde, quem chama FALHA. Um teste de
 * fronteira que "pula" quando o instrumento falta aprova o defeito por ausência.
 */
import axios from 'axios';

export const EMULATOR = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}`;
export const EMULATOR_PROJECT = process.env.FIREBASE_EMULATOR_PROJECT ?? 'demo-no-project';
export const API_REAL_URL = process.env.API_REAL_URL ?? 'http://localhost:8081';
const PASSWORD = 'enlite-real-auth-e2e';

export interface RealAccount {
  uid: string;
  email: string;
  token: string;
}

/** Cria (ou reaproveita) a conta no emulador, grava os claims e devolve um ID token NOVO. */
export async function realAccount(email: string, claims: Record<string, string>): Promise<RealAccount> {
  const signUp = await axios.post(
    `${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`,
    { email, password: PASSWORD, returnSecureToken: true },
    { validateStatus: () => true },
  );
  const first = signUp.status === 200 ? signUp : await signIn(email);
  const uid = first.data.localId as string;

  await axios.post(
    `${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`,
    { localId: uid, customAttributes: JSON.stringify(claims) },
    { headers: { Authorization: 'Bearer owner' } },
  );
  // Claim entra no PRÓXIMO token — como em produção (refresh).
  const fresh = await signIn(email);
  return { uid, email, token: fresh.data.idToken as string };
}

async function signIn(email: string) {
  return axios.post(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    email,
    password: PASSWORD,
    returnSecureToken: true,
  });
}

/** Os claims que a API vai ler, decodificados do PRÓPRIO token (prova de que o claim viajou). */
export function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
}

/** Exige que a API real e o emulador estejam de pé — senão o teste é inválido, não "verde". */
export async function exigirStackReal(): Promise<void> {
  const emu = await axios.get(EMULATOR, { timeout: 3000, validateStatus: () => true }).catch(() => null);
  if (!emu) throw new Error(`Emulador do Firebase não responde em ${EMULATOR} — o teste de fronteira exige token REAL`);
  const api = await axios.get(`${API_REAL_URL}/health`, { timeout: 3000, validateStatus: () => true }).catch(() => null);
  if (!api || api.status !== 200) throw new Error(`API real não responde em ${API_REAL_URL}/health`);
}
