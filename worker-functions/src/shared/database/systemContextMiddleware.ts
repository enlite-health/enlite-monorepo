/**
 * src/shared/database/systemContextMiddleware.ts
 *
 * Declara o contexto de banco das requests que NÃO são de staff (ABAC país
 * Fase 1, task 3.3). A borda é quem sabe o que está falando — o repositório
 * embaixo é o mesmo para os dois caminhos (os 31 `mixed` do inventário 1.3).
 *
 * Duas famílias, mesma mecânica no banco (`app.system_context`), rótulos
 * diferentes para a trilha:
 *   - SISTEMA: cron/Cloud Tasks (`/api/internal`), webhooks de parceiro,
 *     capabilities MCP. Rótulo `job:<nome>` / `webhook:<parceiro>` / `mcp:<x>`.
 *   - PÚBLICO: rotas sem auth nenhuma, só rate-limit (leads, slots de admissão,
 *     vaga pública). Rótulo `public:<rota>` — design, decisão 9: são estreitas e
 *     não listam dado pessoal, então rodam como sistema declarado em vez de
 *     ganharem a jurisdição de um staff que não existe ali.
 *
 * O atalho de sistema da policy (migration 271) exige DUAS coisas: este GUC E
 * ser membro de `app_system`. Então um `set_config` que escape para o caminho de
 * staff não fura nada — a role de lá (`app_runtime`) segue confinada ao país.
 */

import type { RequestHandler } from 'express';
import { setDbContext } from './requestDbSession';

/** Cron, Cloud Tasks, webhook, capability MCP. Rótulo obrigatório e específico. */
export function systemContextMiddleware(label: string): RequestHandler {
  assertLabel(label);
  return (_req, _res, next) => {
    setDbContext({ kind: 'system', systemContext: label });
    next();
  };
}

/** Rota pública anônima (sem auth, só rate-limit). */
export function publicContextMiddleware(label: string): RequestHandler {
  assertLabel(label);
  return (_req, _res, next) => {
    setDbContext({ kind: 'public', systemContext: label });
    next();
  };
}

function assertLabel(label: string): void {
  if (!label.trim()) {
    throw new Error('[abac] contexto de sistema exige rótulo (ex.: "job:outbox", "public:/leads")');
  }
}
