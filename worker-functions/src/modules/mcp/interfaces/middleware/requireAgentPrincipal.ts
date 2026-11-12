import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '@shared/logging';
import { AGENT_IDENTITY_HEADER } from '../../domain/AgentCapabilityCells';
import type { AgentUserRepository } from '../../infrastructure/AgentUserRepository';
import {
  createAgentIdentityVerifier,
  verifyAgentToken,
  type AgentIdentityVerifier,
} from '../../infrastructure/AgentIdentityVerifier';

export interface AgentPrincipal {
  uid: string;
  email: string;
}

interface Options {
  users: AgentUserRepository;
  /** Dublê de teste: só vale com `USE_MOCK_AUTH=true` (a fábrica ignora fora disso). */
  verifier?: AgentIdentityVerifier;
  env?: NodeJS.ProcessEnv;
}

/**
 * Porta do agente, passo 1 (contrato §2). Header presente => SÓ este caminho: falha aqui é 401 final.
 *  - identidade inválida / e-mail sem linha / `account_type <> 'agent'` => 401 AGENT_IDENTITY_INVALID (mesma resposta);
 *  - `users.status <> 'ACTIVE'` => 401 AGENT_DISABLED, lido do banco A CADA request (nenhum cache: é o botão de pânico).
 * Header ausente => não é a porta do agente; segue.
 */
export function requireAgentPrincipal({ users, verifier, env = process.env }: Options): RequestHandler {
  let resolved: AgentIdentityVerifier | undefined;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = req.headers[AGENT_IDENTITY_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (header === undefined) return next();

    const invalid = (): void => {
      res.status(401).json({ code: 'AGENT_IDENTITY_INVALID' });
    };
    if (!header.trim()) return invalid();

    resolved ??= createAgentIdentityVerifier(verifier, env);
    const email = await verifyAgentToken(resolved, header.trim(), env);
    if (!email) return invalid();

    let rows;
    try {
      rows = await users.findByEmail(email);
    } catch (err) {
      // fail-closed: sem leitura de `users` não há como saber o status. Só o NOME do erro (e-mail/uid fora do log).
      logger.error({ error: err instanceof Error ? err.name : 'error' }, '[mcp-agente] falha ao ler users');
      res.status(503).json({ code: 'AGENT_AUTH_UNAVAILABLE' });
      return;
    }
    if (rows.length !== 1 || rows[0].accountType !== 'agent') return invalid();
    if (rows[0].status !== 'ACTIVE') {
      res.status(401).json({ code: 'AGENT_DISABLED' });
      return;
    }
    req.agentPrincipal = { uid: rows[0].uid, email } satisfies AgentPrincipal;
    next();
  };
}
