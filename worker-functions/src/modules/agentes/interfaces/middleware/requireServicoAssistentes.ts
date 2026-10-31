import { Request, Response, NextFunction } from 'express';
import {
  VerificadorIdentidadeServico,
  criarVerificadorIdentidadeServico,
  lerAllowlistServico,
} from '../../infrastructure/VerificadorIdentidadeServico';

export const HEADER_SERVICO = 'x-enlite-servico';

function negar(res: Response): void {
  res.status(401).json({ error: 'SERVICO_NAO_AUTENTICADO' });
}

/**
 * Identidade do SERVIÇO (SA das gestoras): header próprio `X-Enlite-Servico: Bearer <Google ID token>`.
 * Verifica audiência (no verificador), email_verified e e-mail na allowlist derivada de GCP_PROJECT_ID.
 * A identidade da PESSOA (Authorization) é verificada à parte por requireStaff.
 */
export function requireServicoAssistentes(verificadorInjetado?: VerificadorIdentidadeServico) {
  // Resolvido preguiçosamente (na 1ª chamada), nunca no import; a fábrica só aceita dublê com USE_MOCK_AUTH=true.
  let padrao: VerificadorIdentidadeServico | undefined;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const bruto = req.headers[HEADER_SERVICO];
    const header = Array.isArray(bruto) ? bruto[0] : bruto;
    if (!header || !header.startsWith('Bearer ') || header.length <= 7) return negar(res);

    let payload;
    try {
      const verificador = verificadorInjetado ?? (padrao ??= criarVerificadorIdentidadeServico());
      payload = await verificador.verificar(header.slice(7));
    } catch {
      return negar(res);
    }

    if (payload?.email_verified !== true) return negar(res);
    const email = payload.email;
    if (!email || !lerAllowlistServico().includes(email)) return negar(res);
    next();
  };
}
