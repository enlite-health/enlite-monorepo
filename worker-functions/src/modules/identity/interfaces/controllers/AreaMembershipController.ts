/**
 * AreaMembershipController — rotas de staff do registro de vínculos de área (design §3 "Rotas de staff"; change
 * acesso-do-cliente-areas-e-login-unico, T111). Implementa `AreaMembershipHandlers` de `adminAreaMembershipRoutes.ts`.
 *
 *   GET  /api/admin/area-memberships?personId=|?uid=   → vínculos VIVOS da árvore (`uid` resolvido por `iam.resolve_person`)
 *   POST /api/admin/area-memberships {personId, area, role}   → 201
 *   POST /api/admin/area-memberships/:id/revoke {reason}      → 200 (motivo obrigatório → 400 sem ele)
 *
 * Toda regra de negócio (par válido, teto do claim, recálculo de `areas`+`pid`, revogação de sessão) mora nos use cases
 * `Grant/RevokeAreaMembershipUseCase`; aqui só entra a borda HTTP. O ator gravado é o uid do principal (`principalUid`).
 */
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { GrantAreaMembershipUseCase } from '../../application/GrantAreaMembershipUseCase';
import { RevokeAreaMembershipUseCase } from '../../application/RevokeAreaMembershipUseCase';
import { PgAreaMembershipRepository } from '../../infrastructure/PgAreaMembershipRepository';
import { PgAreaRegistryRepository } from '../../infrastructure/PgAreaRegistryRepository';
import { principalUid } from '../middleware/PermissionMiddleware';
import type { AreaMembershipHandlers } from '../adminAreaMembershipRoutes';

const listQuerySchema = z
  .object({ personId: z.string().uuid().optional(), uid: z.string().trim().min(1).optional() })
  .refine((q) => (q.personId === undefined) !== (q.uid === undefined), { message: 'informe personId OU uid' });

const grantBodySchema = z.object({
  personId: z.string().uuid(),
  area: z.string().trim().min(1),
  role: z.string().trim().min(1),
});

const revokeSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(1, 'reason é obrigatório'),
});

function invalid(res: Response, error: z.ZodError): void {
  res.status(400).json({ success: false, error: 'Invalid request', details: { fields: Object.keys(error.flatten().fieldErrors) } });
}

export class AreaMembershipController implements AreaMembershipHandlers {
  constructor(
    private readonly grantUseCase: GrantAreaMembershipUseCase,
    private readonly revokeUseCase: RevokeAreaMembershipUseCase,
    private readonly registry: PgAreaRegistryRepository,
    private readonly memberships: PgAreaMembershipRepository,
  ) {}

  static fromPool(pool: Pool): AreaMembershipController {
    const registry = new PgAreaRegistryRepository(pool);
    const memberships = new PgAreaMembershipRepository(pool);
    return new AreaMembershipController(
      new GrantAreaMembershipUseCase(memberships, registry, memberships),
      new RevokeAreaMembershipUseCase(memberships, registry, memberships),
      registry,
      memberships,
    );
  }

  async list(req: Request, res: Response): Promise<void> {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) return invalid(res, query.error);
    try {
      const personId = query.data.personId ?? (await this.registry.resolvePerson(query.data.uid as string));
      if (!personId) {
        res.status(404).json({ success: false, error: 'Pessoa não encontrada' });
        return;
      }
      const live = await this.memberships.liveByTree(personId);
      res.json({ success: true, data: { personId, memberships: live } });
    } catch (error) {
      logger.error({ err: error }, '[area-memberships] falha ao listar');
      res.status(500).json({ success: false, error: 'Falha ao listar os vínculos' });
    }
  }

  async grant(req: Request, res: Response): Promise<void> {
    const body = grantBodySchema.safeParse(req.body);
    if (!body.success) return invalid(res, body.error);
    const actorUid = principalUid(req);
    if (!actorUid) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    try {
      const result = await this.grantUseCase.execute({ pid: body.data.personId, area: body.data.area, role: body.data.role, actorUid });
      if (result.isFailure) {
        res.status(statusOfFailure(result.error as string)).json({ success: false, error: result.error });
        return;
      }
      res.status(201).json({ success: true, data: result.getValue() });
    } catch (error) {
      logger.error({ err: error }, '[area-memberships] falha ao conceder');
      res.status(500).json({ success: false, error: 'Falha ao conceder o vínculo' });
    }
  }

  async revoke(req: Request, res: Response): Promise<void> {
    const input = revokeSchema.safeParse({ id: req.params.id, reason: req.body?.reason });
    if (!input.success) return invalid(res, input.error);
    const actorUid = principalUid(req);
    if (!actorUid) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    try {
      const membership = await this.memberships.findLive(input.data.id);
      if (!membership) {
        res.status(404).json({ success: false, error: 'Vínculo vivo não encontrado' });
        return;
      }
      const result = await this.revokeUseCase.execute({
        pid: membership.personId,
        area: membership.area,
        role: membership.role,
        actorUid,
        reason: input.data.reason,
      });
      if (result.isFailure) {
        res.status(statusOfFailure(result.error as string)).json({ success: false, error: result.error });
        return;
      }
      res.json({ success: true, data: result.getValue() });
    } catch (error) {
      logger.error({ err: error }, '[area-memberships] falha ao revogar');
      res.status(500).json({ success: false, error: 'Falha ao revogar o vínculo' });
    }
  }
}

/** Recusas de negócio dos use cases chegam como texto: pessoa inexistente → 404; o resto (par inválido, teto, absorvida) → 422. */
function statusOfFailure(message: string): number {
  return message.includes('pessoa inexistente') ? 404 : 422;
}
