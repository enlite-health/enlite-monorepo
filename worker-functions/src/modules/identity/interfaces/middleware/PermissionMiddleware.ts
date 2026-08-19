/**
 * src/modules/identity/interfaces/middleware/PermissionMiddleware.ts
 *
 * O gate das rotas do painel (change `painel-grupos-permissao`, task 3.3) — a
 * metade do `AuthMiddleware` que decide O QUE o staff pode fazer, separada da
 * que decide QUEM ele é (design 6: split no mesmo PR da primeira família).
 *
 * Cada guard faz DUAS coisas indissociáveis (design 1b):
 *   1. DECIDE (célula do grupo × célula exigida), e
 *   2. DECLARA a célula no próprio handler (`markPermissionHandler`), que é o
 *      que o scanner do catálogo e o teste de rotas leem depois.
 * Declaração e enforcement são o mesmo objeto de propósito: não existe rota que
 * exija uma célula sem que ela apareça no catálogo, nem o contrário.
 *
 * ROLLOUT EM DUAS ALAVANCAS (design 6) — as duas precisam estar ligadas:
 *   · `PERMISSION_ENGINE_ENABLED=true`  — liga a decisão real no ambiente;
 *   · `PERMISSION_ENFORCED_ROUTES`      — lista `;` de FAMÍLIAS já provadas
 *     (`admin.users;admin.patients`). Família fora da lista continua exatamente
 *     como hoje (staff autenticado passa) e sai no log como pendência de
 *     rollout — o requisito "rota ainda não virada" da spec.
 *   · `PERMISSION_REPORT_ONLY=true`     — ensaio: loga o que NEGARIA e deixa
 *     passar. Serve para medir o estrago antes de virar, nunca como estado final.
 *
 * ⚠️ A ordem de checagem é parte do contrato, não estilo: status da conta ANTES
 * de célula (spec: "negada antes de qualquer checagem"), e falha ao resolver
 * NEGA (spec: "nunca libera por padrão").
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '@shared/logging';
import { parseEnvList } from '@shared/utils/envList';
import { isEnvFlagOn } from '@shared/utils/envFlag';
import { currentDbContext } from '@shared/database/requestDbSession';
import { PrincipalType } from '@modules/identity/domain/Auth';
import {
  cellKey,
  ENLITE_TENANT_ID,
  markPermissionHandler,
  type PermissionClient,
  type PermissionDecision,
  type ResolvedAuthz,
} from '@modules/identity/permissions';

/** Só o que o middleware usa da trilha — o repositório inteiro não sai do módulo. */
export interface PermissionAuditSink {
  record(entry: PermissionDecision): void;
}

export interface PermissionMiddlewareDeps {
  client: PermissionClient;
  audit: PermissionAuditSink;
  tenantId?: string;
  /** Injetável para o teste medir as flags sem mexer no processo. */
  env?: NodeJS.ProcessEnv;
}

/** Motivo estável da negativa — a tela de boas-vindas do grupo 4 lê isto. */
export type DenialCode = 'unauthenticated' | 'account_not_active' | 'no_group' | 'missing_cell' | 'resolve_failed';

/**
 * Recursos e ações cujo ACESSO PERMITIDO também vira linha na trilha (D-P4,
 * spec "Trilha de negativas e de acessos sensíveis"). Negativa é registrada
 * sempre; ALLOW só aqui, porque registrar todo GET de listagem encheria a
 * partição com ruído e esconderia justamente estes.
 */
const SENSITIVE_RESOURCES = new Set(['worker_pii', 'patient', 'worker_document']);
const SENSITIVE_ACTIONS = new Set(['delete', 'execute', 'export']);

function isSensitive(resource: string, action: string): boolean {
  return SENSITIVE_RESOURCES.has(resource) || SENSITIVE_ACTIONS.has(action);
}

export class PermissionMiddleware {
  private readonly client: PermissionClient;
  private readonly audit: PermissionAuditSink;
  private readonly tenantId: string;
  private readonly env: NodeJS.ProcessEnv;
  /** Famílias já avisadas como "não enforced" — 1 linha por boot, não por request. */
  private readonly pendingFamiliesLogged = new Set<string>();
  /** Células já avisadas como "atravessadas por serviço" — 1 linha por célula. */
  private readonly serviceCellsLogged = new Set<string>();

  constructor(deps: PermissionMiddlewareDeps) {
    this.client = deps.client;
    this.audit = deps.audit;
    this.tenantId = deps.tenantId ?? ENLITE_TENANT_ID;
    this.env = deps.env ?? process.env;
  }

  /**
   * Guards de uma família de rotas (`admin.users`). A família é o que
   * `PERMISSION_ENFORCED_ROUTES` liga — por isso ela é fixada UMA vez, aqui, e
   * não repetida em cada rota (onde sairia de sincronia calada).
   */
  family(family: string): PermissionFamily {
    return {
      require: (resource: string, action: string, description?: string) =>
        this.buildGuard(family, resource, action, description),
    };
  }

  /**
   * Disponibilidade da feature no país da request (spec country-feature-
   * availability): indisponível é **404**, indistinguível de inexistente —
   * 403 aqui contaria que a tela existe em outro país.
   *
   * Sem país declarado (sistema, webhook, prestador) o guard não opina: quem
   * recorta esses fluxos é o contrato deles, não a matriz de país.
   */
  requireCountryFeature(featureKey: string): RequestHandler {
    return async (req, res, next) => {
      if (!isEnvFlagOn('PERMISSION_ENGINE_ENABLED', this.env)) return next();
      const context = currentDbContext();
      if (context?.kind !== 'staff' || !context.country) return next();

      try {
        if (await this.client.isFeatureAvailable(context.country, featureKey)) return next();
      } catch (err) {
        logger.error({ err, featureKey }, '[perm] falha ao ler disponibilidade da feature — tratando como indisponível');
      }
      logger.info(
        { featureKey, country: context.country, path: pathOf(req) },
        '[perm] feature indisponível no país da request',
      );
      res.status(404).json({ success: false, error: 'Not found' });
    };
  }

  // ── interno ────────────────────────────────────────────────────────────────

  private buildGuard(family: string, resource: string, action: string, description?: string): RequestHandler {
    const guard: RequestHandler = async (req, res, next) => {
      if (!isEnvFlagOn('PERMISSION_ENGINE_ENABLED', this.env)) return next();
      if (!this.isFamilyEnforced(family)) {
        this.logPendingFamily(family, resource, action);
        return next();
      }

      // ── Principal de SERVIÇO não é decisão de grupo (família admin.workers) ──
      // 4 rotas desta família são `requireStaffOrApiKey` e o triage-service (a
      // Luz) as consome por chave de API. Chave de API é serviço, não pessoa:
      // `principal.id` vale `service:<nome>`, que não existe em `users` — sem
      // este desvio o resolve devolveria "conta inexistente" e a virada da
      // família derrubaria a Luz em produção com 403 (o inventário 0.6 já
      // previa: "vai precisar de tratamento especial", route-permission-map §
      // achados). É o mesmo desvio que o `GroupPermissionEngine` faz para
      // não-staff (D119.1a), aqui pela porta das rotas.
      //
      // O predicado é POSITIVO de propósito — "é serviço" e não "não é staff".
      // A forma negativa liberaria qualquer principal cujo papel não fosse
      // reconhecido, o oposto de fail-closed; esta só libera quem a
      // autenticação já classificou como serviço.
      //
      // Não vai para `permission_audit_log`: aquela trilha responde "que
      // decisão o GRUPO de fulano produziu", e aqui não houve decisão de grupo.
      // O acesso do serviço tem trilha própria (`logResourceAccess`, e o log de
      // autenticação por chave). Misturar máquina com gente ali é justamente o
      // que cegaria a vista de auditoria do painel.
      if (req.authContext?.principal?.type === PrincipalType.SERVICE) {
        this.logServicePrincipal(family, resource, action);
        return next();
      }

      const uid = principalUid(req);
      if (!uid) {
        this.refuse(req, res, next, { uid: null, resource, action, code: 'unauthenticated' });
        return;
      }

      let resolved: ResolvedAuthz;
      try {
        resolved = await this.client.resolve(uid, this.tenantId);
      } catch (err) {
        logger.error({ err, uid, resource, action }, '[perm] falha ao resolver permissões — negando');
        this.refuse(req, res, next, { uid, resource, action, code: 'resolve_failed' });
        return;
      }

      const denial = denialFor(resolved, resource, action);
      if (denial) {
        this.refuse(req, res, next, { uid, resource, action, code: denial });
        return;
      }

      if (isSensitive(resource, action)) {
        this.record(uid, resource, action, 'ALLOW', req, null);
      }
      next();
    };

    return markPermissionHandler(guard, { resource, action, description: description ?? null });
  }

  private isFamilyEnforced(family: string): boolean {
    return parseEnvList(this.env.PERMISSION_ENFORCED_ROUTES).includes(family);
  }

  /** 1 linha por célula, não por request — o volume da Luz encheria o log. */
  private logServicePrincipal(family: string, resource: string, action: string): void {
    const chave = `${family}:${cellKey(resource, action)}`;
    if (this.serviceCellsLogged.has(chave)) return;
    this.serviceCellsLogged.add(chave);
    logger.info(
      { family, cell: cellKey(resource, action) },
      '[perm] principal de serviço — célula não avaliada (chave de API não tem grupo)',
    );
  }

  private logPendingFamily(family: string, resource: string, action: string): void {
    if (this.pendingFamiliesLogged.has(family)) return;
    this.pendingFamiliesLogged.add(family);
    logger.info(
      { family, cell: cellKey(resource, action) },
      '[perm] rota não enforced — família fora de PERMISSION_ENFORCED_ROUTES',
    );
  }

  /**
   * Negativa: trilha SEMPRE (spec) e resposta explícita. Em `REPORT_ONLY` a
   * trilha continua (é o dado do ensaio) e a request segue — por isso o
   * `next()` sai daqui, e não de um `if` antes da checagem: o modo de ensaio
   * precisa exercitar exatamente o mesmo caminho de decisão.
   */
  private refuse(
    req: Request,
    res: Response,
    next: NextFunction,
    entry: { uid: string | null; resource: string; action: string; code: DenialCode },
  ): void {
    const { uid, resource, action, code } = entry;
    // (lex C16) Só o uid vai para a trilha; sem uid não há a quem atribuir e a
    // linha viraria ruído anônimo. A spec diz "toda negativa é registrada" — a
    // exceção é esta, e ela é a ausência de sujeito, não uma dispensa.
    if (uid) this.record(uid, resource, action, 'DENY', req, code);

    // ANTES do REPORT_ONLY de propósito: o modo de ensaio existe para medir
    // negativa de PERMISSÃO, não para relaxar autenticação.
    if (code === 'unauthenticated') {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    if (isEnvFlagOn('PERMISSION_REPORT_ONLY', this.env)) {
      logger.warn(
        { uid, cell: cellKey(resource, action), code, path: pathOf(req) },
        '[perm] REPORT_ONLY — negaria, mas seguiu',
      );
      next();
      return;
    }
    res.status(403).json({
      success: false,
      error: 'Access denied',
      code,
      reason: reasonFor(code, resource, action),
    });
  }

  private record(
    uid: string,
    resource: string,
    action: string,
    decision: 'ALLOW' | 'DENY',
    req: Request,
    code: DenialCode | null,
  ): void {
    this.audit.record({
      tenantId: this.tenantId,
      userId: uid,
      resource,
      action,
      decision,
      // id do ALVO, quando a rota tem um — nunca nome/telefone/documento (lex C16).
      resourceId: req.params?.id ?? null,
      reason: code,
    });
  }
}

export interface PermissionFamily {
  /** Guard que exige `recurso:ação` e declara a célula para o catálogo. */
  require(resource: string, action: string, description?: string): RequestHandler;
}

/**
 * Caminho COMPLETO da request. `req.path` dentro de um router montado é
 * relativo ao ponto de montagem (`/users/abc`, não `/api/admin/users/abc`) — e
 * é justamente este campo que o relatório do `PERMISSION_REPORT_ONLY` usa para
 * decidir se uma família pode virar. Sem a query string (pode carregar dado).
 */
export function pathOf(req: Request): string {
  return (req.originalUrl || req.path).split('?')[0];
}

/** uid do principal autenticado (`requireAuth`/`requireStaff` já rodaram). */
function principalUid(req: Request): string | null {
  return req.authContext?.principal?.id ?? (req as { user?: { uid?: string } }).user?.uid ?? null;
}

/** `null` = permitido. A ORDEM é contrato: status → grupo → célula. */
function denialFor(resolved: ResolvedAuthz, resource: string, action: string): DenialCode | null {
  if (resolved.status !== 'ACTIVE') return 'account_not_active';
  if (resolved.groups.length === 0) return 'no_group';
  if (!resolved.permissions.includes(cellKey(resource, action))) return 'missing_cell';
  return null;
}

function reasonFor(code: DenialCode, resource: string, action: string): string {
  switch (code) {
    case 'account_not_active':
      return 'Sua conta ainda não está ativa. Fale com o administrador.';
    case 'no_group':
      return 'Sua conta ainda não tem grupo de permissão. Fale com o administrador.';
    case 'resolve_failed':
      return 'Não foi possível verificar suas permissões agora. Tente de novo.';
    default:
      return `Seu grupo não concede ${cellKey(resource, action)}.`;
  }
}
