/**
 * staffAuth — um `Authorization` de STAFF que funciona nos DOIS stacks do e2e:
 *   - emulador do Firebase de pé (docker-compose.firebase.yml → API com USE_MOCK_AUTH=false):
 *     cria/loga o usuário no emulador, grava a claim `role` (é dela que o AuthMiddleware tira
 *     `principal.roles`) e devolve o idToken REAL;
 *   - sem emulador (CI: USE_MOCK_AUTH=true): devolve o `mock_<base64>` que o MockAuthMiddleware lê.
 * Sondagem, não flag: o teste não sabe como a API foi levantada, e o token errado vira 403 mudo.
 * Sem PII: e-mails sintéticos `<uid>@e2e.local`.
 */
import axios from 'axios';

const EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST
  ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`
  : 'http://localhost:9099';
const EMULATOR_PROJECT = process.env.FIREBASE_EMULATOR_PROJECT || 'demo-no-project';
const PASSWORD = 'enlite-e2e-password';

let emulatorUp: boolean | null = null;

async function probeEmulator(): Promise<boolean> {
  if (emulatorUp !== null) return emulatorUp;
  try {
    await axios.get(EMULATOR, { timeout: 1500 });
    emulatorUp = true;
  } catch {
    emulatorUp = false;
  }
  return emulatorUp;
}

function mockToken(uid: string, role: string): string {
  return 'mock_' + Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role })).toString('base64');
}

async function emulatorToken(uid: string, role: string): Promise<{ token: string; uid: string }> {
  const email = `${uid}@e2e.local`;
  const signUp = await axios.post(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`,
    { email, password: PASSWORD, returnSecureToken: true }, { validateStatus: () => true });
  const auth = signUp.status === 200
    ? signUp
    : await axios.post(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`,
      { email, password: PASSWORD, returnSecureToken: true });
  const localId = auth.data.localId as string;
  await axios.post(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`,
    { localId, customAttributes: JSON.stringify({ role }) }, { headers: { Authorization: 'Bearer owner' } });
  // Claim nova só entra no PRÓXIMO idToken: loga de novo.
  const fresh = await axios.post(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`,
    { email, password: PASSWORD, returnSecureToken: true });
  // O uid EFETIVO é o localId do emulador (não o pedido): quem grava autoria grava este.
  return { token: fresh.data.idToken as string, uid: localId };
}

export interface StaffAuth {
  headers: { Authorization: string };
  /** O uid que a API vai enxergar (localId do emulador, ou o pedido no modo mock). */
  uid: string;
}

/** `{ headers: { Authorization }, uid }` pronto para o axios, com a role pedida. */
export async function staffAuth(uid: string, role: 'admin' | 'recruiter' | 'community_manager'): Promise<StaffAuth> {
  if (await probeEmulator()) {
    const real = await emulatorToken(uid, role);
    return { headers: { Authorization: `Bearer ${real.token}` }, uid: real.uid };
  }
  return { headers: { Authorization: `Bearer ${mockToken(uid, role)}` }, uid };
}
