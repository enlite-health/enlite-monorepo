/**
 * gcp.ts — tokens do Google para a suíte, SEM dependência nova e SEM chave de SA.
 *
 * Dois tokens diferentes, dois usos:
 *
 *   • accessToken()  → a própria identidade do runner. Usado para ler Cloud
 *     Logging (o job precisa de roles/logging.viewer).
 *
 *   • dwdToken(subject) → token com Domain-Wide Delegation, para LER a agenda de
 *     admissão como `enlite@enlite.health`. Sem arquivo de chave: no Cloud Run
 *     assina o JWT via `iamcredentials:signJwt` com a própria SA (mesmo padrão
 *     keyless que o backend já usa em GoogleCalendarEventFinder). Local, cai no
 *     `gcloud auth print-access-token` / GOOGLE_APPLICATION_CREDENTIALS.
 *
 * Por que não `google-auth-library`: a imagem do runner é enxuta de propósito e
 * o padrão keyless do backend já é conhecido e auditado aqui dentro. Menos
 * superfície, mesma garantia.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1';
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' };

/**
 * Escopo do Calendar usado pelo monitor.
 *
 * ⚠️ É o `calendar` completo, e não `calendar.readonly`, porque a Domain-Wide
 * Delegation do Workspace autoriza por LISTA DE ESCOPOS e hoje só o completo
 * está lá (verificado: readonly e events.readonly devolvem `unauthorized_client`).
 * Reduzir para readonly exige ação de admin do Workspace (Marcel) — está anotado
 * como pendência. O código deste helper só faz `events.get`; a restrição real
 * hoje é de comportamento, não de token. Não escreva nada com este token.
 */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

function isCloudRun(): boolean {
  return !!process.env.K_SERVICE || !!process.env.CLOUD_RUN_JOB;
}

/** Token da identidade do próprio runner (Cloud Logging etc.). */
export async function accessToken(): Promise<string> {
  if (isCloudRun()) {
    const res = await fetch(`${METADATA_BASE}/instance/service-accounts/default/token`, {
      headers: METADATA_HEADERS,
    });
    if (!res.ok) throw new Error(`metadata token ${res.status}`);
    const { access_token } = (await res.json()) as { access_token: string };
    return access_token;
  }
  // Local (dev): usa a credencial do gcloud do próprio operador.
  try {
    return execFileSync('gcloud', ['auth', 'print-access-token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(
      'Sem credencial Google. Em Cloud Run usa a SA do job; local, rode `gcloud auth login`.',
    );
  }
}

/** Troca uma assertion JWT por access_token no endpoint OAuth do Google. */
async function exchangeJwt(assertion: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Caminho LOCAL: chave de SA em GOOGLE_APPLICATION_CREDENTIALS assina o JWT aqui. */
async function localDwdToken(subject: string, scope: string): Promise<string | null> {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath || !existsSync(keyPath)) return null;

  const key = JSON.parse(readFileSync(keyPath, 'utf8')) as {
    client_email?: string;
    private_key?: string;
  };
  if (!key.client_email || !key.private_key) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: subject,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(key.private_key));

  return exchangeJwt(`${header}.${claims}.${signature}`);
}

/**
 * SA que ASSINA o JWT de DWD. Precisa ser uma SA já autorizada na Domain-Wide
 * Delegation do Workspace — hoje só `enlite-functions-sa@` está (a do backend).
 *
 * Por que assinar como OUTRA SA em vez de autorizar a do runner: autorizar uma SA
 * nova na DWD é ação de admin do Workspace (Marcel). Encadear por impersonação
 * (`e2e-prod-runtime` com roles/iam.serviceAccountTokenCreator SÓ nesta SA) resolve
 * hoje, sem ampliar o que a SA do runner pode fazer no projeto: ela não ganha
 * banco, nem secrets — só o direito de pedir um token para esta identidade.
 */
const DWD_SIGNER_SA =
  process.env.DWD_SIGNER_SA ?? 'enlite-functions-sa@enlite-prd.iam.gserviceaccount.com';

/**
 * Token DWD impersonando `subject`. Em Cloud Run: token da própria SA →
 * `signJwt` na SA assinante (keyless) → troca por access_token.
 */
export async function dwdToken(
  subject: string,
  scope: string = CALENDAR_SCOPE,
): Promise<string> {
  const local = await localDwdToken(subject, scope);
  if (local) return local;

  const callerToken = await accessToken();

  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iss: DWD_SIGNER_SA,
    sub: subject,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });

  const signRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${DWD_SIGNER_SA}:signJwt`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${callerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    },
  );
  if (!signRes.ok) {
    throw new Error(`signJwt ${signRes.status}: ${await signRes.text().catch(() => '')}`);
  }
  const { signedJwt } = (await signRes.json()) as { signedJwt: string };
  return exchangeJwt(signedJwt);
}
