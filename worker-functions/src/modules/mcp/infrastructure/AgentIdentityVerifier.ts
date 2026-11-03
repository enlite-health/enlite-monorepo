import { OAuth2Client } from 'google-auth-library';
import { logger } from '@shared/logging';
import { AGENT_AUDIENCE } from '../domain/AgentCapabilityCells';

/** Payload mínimo do ID token de SA que a porta do agente lê. */
export interface AgentTokenPayload {
  email?: string;
  email_verified?: boolean;
}

/** Porta: valida o ID token e devolve o payload; rejeita (throw) se inválido. */
export interface AgentIdentityVerifier {
  verify(idToken: string): Promise<AgentTokenPayload>;
}

/** O pedaço do `OAuth2Client` que usamos (permite dublê no teste sem rede). */
export interface IdTokenClient {
  verifyIdToken(opts: { idToken: string; audience: string }): Promise<{ getPayload(): AgentTokenPayload | undefined }>;
}

/** Verificador real: assinatura e audiência offline contra as chaves públicas do Google, com a audiência FIXA. */
export class GoogleAgentIdentityVerifier implements AgentIdentityVerifier {
  constructor(private readonly client: IdTokenClient = new OAuth2Client() as unknown as IdTokenClient) {}

  async verify(idToken: string): Promise<AgentTokenPayload> {
    const ticket = await this.client.verifyIdToken({ idToken, audience: AGENT_AUDIENCE });
    return ticket.getPayload() ?? {};
  }
}

export const MOCK_AGENT_TOKEN_PREFIX = 'mock_';

/**
 * Verificador de TESTE: lê `mock_<base64 de {email, email_verified, aud}>` e exige a audiência certa, como o Google faria.
 * Nunca é construído fora de `USE_MOCK_AUTH=true` (ver `createAgentIdentityVerifier`).
 */
export class MockAgentIdentityVerifier implements AgentIdentityVerifier {
  async verify(idToken: string): Promise<AgentTokenPayload> {
    if (!idToken.startsWith(MOCK_AGENT_TOKEN_PREFIX)) throw new Error('malformed test token');
    const data = JSON.parse(Buffer.from(idToken.slice(MOCK_AGENT_TOKEN_PREFIX.length), 'base64').toString());
    if (data?.aud !== AGENT_AUDIENCE) throw new Error('Wrong recipient');
    return { email: data.email, email_verified: data.email_verified };
  }
}

/** O verificador de teste só conta com `USE_MOCK_AUTH=true` (mesma chave dos e2e). Fora disso só o Google conta. */
export function createAgentIdentityVerifier(
  testVerifier?: AgentIdentityVerifier,
  env: NodeJS.ProcessEnv = process.env,
): AgentIdentityVerifier {
  if (env.USE_MOCK_AUTH === 'true') return testVerifier ?? new MockAgentIdentityVerifier();
  return new GoogleAgentIdentityVerifier();
}

/** Sufixo do e-mail de conta de serviço do projeto. Sem `GCP_PROJECT_ID`: string vazia (fail-closed). */
export function agentEmailSuffix(env: NodeJS.ProcessEnv = process.env): string {
  const project = env.GCP_PROJECT_ID;
  return project ? `@${project}.iam.gserviceaccount.com` : '';
}

/**
 * Verifica o ID token e devolve o e-mail da SA, ou `null` (qualquer falha). NUNCA lança.
 * Só o NOME do erro vai ao log: a mensagem/stack do verificador pode ecoar o token, e o e-mail não entra em log.
 */
export async function verifyAgentToken(
  verifier: AgentIdentityVerifier,
  idToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  // O header chega como `Bearer <ID token>` (triage, lote 5); o token puro também vale.
  const token = idToken.startsWith('Bearer ') ? idToken.slice(7).trim() : idToken;
  let payload: AgentTokenPayload;
  try {
    payload = await verifier.verify(token);
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.name : 'error' }, '[mcp-agente] verificação da identidade do agente falhou');
    return null;
  }
  const suffix = agentEmailSuffix(env);
  const email = payload?.email;
  if (payload?.email_verified !== true || !email || suffix === '' || !email.endsWith(suffix)) return null;
  return email;
}
