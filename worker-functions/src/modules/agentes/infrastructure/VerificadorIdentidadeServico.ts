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

/**
 * Wiring: o verificador de teste só é aceito com USE_MOCK_AUTH=true (mesmo interruptor do e2e).
 * Fora disso, qualquer verificador injetado é ignorado e só o Google vale.
 */
export function criarVerificadorIdentidadeServico(
  verificadorDeTeste?: VerificadorIdentidadeServico,
  env: NodeJS.ProcessEnv = process.env,
): VerificadorIdentidadeServico {
  if (env.USE_MOCK_AUTH === 'true' && verificadorDeTeste) return verificadorDeTeste;
  return new GoogleVerificadorIdentidadeServico();
}
