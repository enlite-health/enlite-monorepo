import { OAuth2Client } from 'google-auth-library';

/** Audiência do ID token da SA do serviço das gestoras (constante dos dois lados; não é segredo). */
export const AUDIENCIA_ASSISTENTES = 'https://api.enlite.health/assistentes';

export interface IdentidadeServico {
  email?: string;
  email_verified?: boolean;
}

/** Porta: valida o token do serviço e devolve o payload; rejeita se inválido. */
export interface VerificadorIdentidadeServico {
  verificar(idToken: string): Promise<IdentidadeServico>;
}

/** Allowlist lida de GCP_PROJECT_ID (nenhuma env nova). Sem o projeto, lista vazia (fail-closed). */
export function lerAllowlistServico(env: NodeJS.ProcessEnv = process.env): string[] {
  const projeto = env.GCP_PROJECT_ID;
  if (!projeto) return [];
  return [`gestoras-service-sa@${projeto}.iam.gserviceaccount.com`];
}

/** Verificador real: Google OAuth2Client.verifyIdToken com a audiência fixa. */
export class GoogleVerificadorIdentidadeServico implements VerificadorIdentidadeServico {
  private readonly client = new OAuth2Client();

  async verificar(idToken: string): Promise<IdentidadeServico> {
    const ticket = await this.client.verifyIdToken({ idToken, audience: AUDIENCIA_ASSISTENTES });
    return ticket.getPayload() ?? {};
  }
}

/** Prefixo do token de teste (espelha o `mock_<base64>` da identidade da PESSOA, MockAuthMiddleware). */
export const PREFIXO_TOKEN_SERVICO_MOCK = 'mock_';

/**
 * Verificador de TESTE (e2e): lê `mock_<base64 de {email, email_verified, aud}>` e exige a audiência certa,
 * como o Google exigiria. Nunca é construído fora de USE_MOCK_AUTH=true (ver a fábrica).
 */
export class MockVerificadorIdentidadeServico implements VerificadorIdentidadeServico {
  async verificar(idToken: string): Promise<IdentidadeServico> {
    if (!idToken.startsWith(PREFIXO_TOKEN_SERVICO_MOCK)) throw new Error('token de teste malformado');
    const dados = JSON.parse(Buffer.from(idToken.slice(PREFIXO_TOKEN_SERVICO_MOCK.length), 'base64').toString());
    if (dados?.aud !== AUDIENCIA_ASSISTENTES) throw new Error('Wrong recipient');
    return { email: dados.email, email_verified: dados.email_verified };
  }
}

/**
 * Wiring: o verificador de teste (injetado ou o mock embutido) só vale com USE_MOCK_AUTH=true (mesmo interruptor
 * do e2e). Fora disso, qualquer verificador injetado é ignorado e só o Google vale.
 */
export function criarVerificadorIdentidadeServico(
  verificadorDeTeste?: VerificadorIdentidadeServico,
  env: NodeJS.ProcessEnv = process.env,
): VerificadorIdentidadeServico {
  if (env.USE_MOCK_AUTH === 'true') return verificadorDeTeste ?? new MockVerificadorIdentidadeServico();
  return new GoogleVerificadorIdentidadeServico();
}
