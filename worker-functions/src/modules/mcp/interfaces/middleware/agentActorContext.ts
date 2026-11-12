import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { logger, loggingAls } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { isCountryCode, setDbContext, type CountryCode } from '@shared/database/requestDbSession';
import { createPermissionsModule } from '@modules/identity/permissions';
import { AGENT_ALLOWED_CAPABILITIES, AGENT_IDENTITY_HEADER, AGENT_TENANT_ID } from '../../domain/AgentCapabilityCells';
import { ServicePrincipal } from '../../domain/ServicePrincipal';
import { AgentCallGate, type AgentCallInput } from '../../application/AgentCallGate';
import { AgentCellGuard } from '../../application/AgentCellGuard';
import { PgAgentAuditRepository } from '../../infrastructure/PgAgentAuditRepository';
import { PgAgentWriteLimiter } from '../../infrastructure/PgAgentWriteLimiter';
import { PgAgentUserRepository, type AgentUserRepository } from '../../infrastructure/AgentUserRepository';
import type { AgentIdentityVerifier } from '../../infrastructure/AgentIdentityVerifier';
import { requireAgentPrincipal } from './requireAgentPrincipal';

/** Ajustes de teste da porta do agente (produção usa os defaults). */
export interface AgentPortOverrides {
  users?: AgentUserRepository;
  /** Só vale com `USE_MOCK_AUTH=true` (a fábrica do verificador ignora fora disso). */
  verifier?: AgentIdentityVerifier;
  gate?: AgentCallGate;
}

/** A porta do agente é a requisição que traz o header próprio — e SÓ ela (header presente => só este caminho). */
export function isAgentRequest(req: Request): boolean {
  return req.headers[AGENT_IDENTITY_HEADER] !== undefined;
}

/** Gate de produção: célula pelo `PermissionService` real, limitador e trilha no banco (pool da request, contexto do ator). */
export function buildAgentGate(pool: Pool): AgentCallGate {
  const permissions = createPermissionsModule({ pool, systemPool: DatabaseConnection.getInstance().getSystemPool() });
  return new AgentCallGate({
    guard: new AgentCellGuard(permissions.client),
    limiter: new PgAgentWriteLimiter(pool),
    audit: new PgAgentAuditRepository(pool),
  });
}

/**
 * Passo 2 da porta do agente (contrato §3): o banco vê `agent:luz`, nunca o sistema.
 * Contexto de banco `staff` com o uid do agente e `app.system_context` VAZIO (não passa por `systemContextMiddleware`); o país não vem
 * de claim: a RLS chama `iam.effective_countries(uid)`, e aqui só registramos os países concedidos (origem da trilha). O ator do ALS
 * (`changed_by`) é `agent:luz`. Monta também o principal sintético com a allowlist das capabilities do agente.
 */
export function agentActorContext(pool: Pick<Pool, 'query'>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const agent = req.agentPrincipal;
    if (!agent) {
      res.status(401).json({ code: 'AGENT_IDENTITY_INVALID' });
      return;
    }
    // O contexto vai ANTES da consulta de países: a leitura sai como o próprio agente, sem aviso de "request sem contexto".
    setDbContext({ kind: 'staff', uid: agent.uid });
    let countries: CountryCode[];
    try {
      const r = await pool.query<{ countries: string[] | null }>(`SELECT iam.effective_countries($1, $2) AS countries`, [agent.uid, AGENT_TENANT_ID]);
      countries = (r.rows[0]?.countries ?? []).filter(isCountryCode);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.name : 'error' }, '[mcp-agente] falha ao resolver os países do agente');
      res.status(503).json({ code: 'AGENT_AUTH_UNAVAILABLE' });
      return;
    }
    setDbContext({ kind: 'staff', uid: agent.uid, countries });
    const store = loggingAls?.getStore?.();
    if (store) store.actor = { source: 'luz_conversation', id: agent.uid };
    req.servicePrincipal = new ServicePrincipal({
      name: agent.uid,
      allowedCapabilities: [...AGENT_ALLOWED_CAPABILITIES],
      tokenHashes: ['agent-identity'], // exigido pelo domínio; a identidade do agente é o ID token, não um token estático
    });
    next();
  };
}

/** Entrada completa da porta do agente: identidade + status sem cache + ator. Falha = resposta final (nunca cai no caminho legado). */
export function createAgentEntry(pool: Pool, overrides: AgentPortOverrides = {}): RequestHandler {
  const principal = requireAgentPrincipal({
    users: overrides.users ?? new PgAgentUserRepository(pool),
    ...(overrides.verifier !== undefined ? { verifier: overrides.verifier } : {}),
  });
  const actor = agentActorContext(pool);
  return (req, res, next) => {
    void principal(req, res, (err?: unknown) => {
      if (err) return next(err);
      void actor(req, res, next);
    });
  };
}

/** O que a trilha precisa da requisição do agente (headers opcionais; só ID, nunca texto). */
export function agentCallOf(req: Request): Omit<AgentCallInput, 'capability'> | undefined {
  const agent = req.agentPrincipal;
  if (!agent) return undefined;
  const h = (name: string): string | undefined => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  return {
    uid: agent.uid,
    resourceId: h('x-on-behalf-of-worker-id') ?? null,
    gatilhoId: h('x-enlite-gatilho-id') ?? null,
    registroVersao: h('x-enlite-registro-versao') ?? null,
    ip: req.ip ?? null,
  };
}
