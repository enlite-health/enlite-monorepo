/**
 * AreaMembershipController — rotas de staff do registro de vínculos de área (design §3 "Rotas de staff"; change
 * acesso-do-cliente-areas-e-login-unico, T111). Implementa `AreaMembershipHandlers` de `adminAreaMembershipRoutes.ts`.
 *
 *   GET  /api/admin/area-memberships?personId=|?uid=   → vínculos VIVOS da árvore (`uid` resolvido por `iam.resolve_person`)
 *   GET  /api/admin/area-memberships/people?search&type&withMembership&limit&offset   → lista paginada de pessoas (aba)
 *   GET  /api/admin/area-memberships/people/by-email?email=   → a mesma forma de item (Firebase), ou 404
 *   POST /api/admin/area-memberships {personId|uid, area, role}   → 201 (com `uid`: `ensure_person` + conceder)
 *   POST /api/admin/area-memberships/:id/revoke {reason}      → 200 (motivo obrigatório → 400 sem ele)
 *
 * Toda regra de negócio (par válido, teto do claim, recálculo de `areas`+`pid`, revogação de sessão) mora nos use cases
 * `Grant/RevokeAreaMembershipUseCase`; aqui só entra a borda HTTP. O ator gravado é o uid do principal (`principalUid`).
 */
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { logger, safeErrorFields } from '@shared/logging';
import { GrantAreaMembershipUseCase } from '../../application/GrantAreaMembershipUseCase';
import { RevokeAreaMembershipUseCase } from '../../application/RevokeAreaMembershipUseCase';
import { ListAreaPeopleUseCase } from '../../application/ListAreaPeopleUseCase';
import { FindAreaPersonByEmailUseCase } from '../../application/FindAreaPersonByEmailUseCase';
import { FirebaseLookupError, PEOPLE_DEFAULT_LIMIT, PeopleSearchError } from '../../application/AreaPeople';
import { FirebaseUserDirectory } from '../../infrastructure/FirebaseUserDirectory';
import { PgPeopleDirectoryRepository } from '../../infrastructure/PgPeopleDirectoryRepository';
import { PgAreaMembershipRepository } from '../../infrastructure/PgAreaMembershipRepository';
import { PgAreaRegistryRepository } from '../../infrastructure/PgAreaRegistryRepository';
import { principalUid } from '../middleware/PermissionMiddleware';
import type { AreaMembershipHandlers } from '../adminAreaMembershipRoutes';

const listQuerySchema = z
  .object({ personId: z.string().uuid().optional(), uid: z.string().trim().min(1).optional() })
  .refine((q) => (q.personId === undefined) !== (q.uid === undefined), { message: 'informe personId OU uid' });

const grantBodySchema = z
  .object({
    personId: z.string().uuid().optional(),
    uid: z.string().trim().min(1).optional(),
    area: z.string().trim().min(1),
    role: z.string().trim().min(1),
  })
  .refine((b) => (b.personId === undefined) !== (b.uid === undefined), { message: 'informe personId OU uid' });

const peopleQuerySchema = z.object({
  search: z.string().optional(),
  type: z.enum(['all', 'staff', 'worker', 'account']).default('all'),
  withMembership: z.enum(['true', 'false']).optional(),
  // acima do teto (100) o use case fatia em 100 e devolve `limit: 100` — o cliente vê o que valeu
  limit: z.coerce.number().int().default(PEOPLE_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

const byEmailQuerySchema = z.object({ email: z.string().trim().email() });

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
    private readonly listPeople?: ListAreaPeopleUseCase,
    private readonly findByEmail?: FindAreaPersonByEmailUseCase,
  ) {}

  static fromPool(pool: Pool): AreaMembershipController {
    const registry = new PgAreaRegistryRepository(pool);
    const memberships = new PgAreaMembershipRepository(pool);
    const directory = new PgPeopleDirectoryRepository(pool);
    const firebase = new FirebaseUserDirectory();
    return new AreaMembershipController(
      new GrantAreaMembershipUseCase(memberships, registry, memberships, registry, firebase),
      new RevokeAreaMembershipUseCase(memberships, registry, memberships),
      registry,
      memberships,
      new ListAreaPeopleUseCase(directory, new KMSEncryptionService(), new BlindIndexService(), firebase),
      new FindAreaPersonByEmailUseCase(directory, firebase),
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

  /** Erros esperados da aba de pessoas → status; log SÓ com `errorName`/`code` (a mensagem pode carregar valor: PII). */
  private peopleFailure(res: Response, error: unknown, what: string): void {
    if (error instanceof PeopleSearchError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    logger.error({ ...safeErrorFields(error) }, `[area-memberships] falha ${what}`);
    if (error instanceof FirebaseLookupError) {
      res.status(502).json({ success: false, error: 'Falha ao consultar o Firebase' });
      return;
    }
    res.status(500).json({ success: false, error: `Falha ${what}` });
  }

  async people(req: Request, res: Response): Promise<void> {
    const query = peopleQuerySchema.safeParse(req.query);
    if (!query.success) return invalid(res, query.error);
    if (!this.listPeople) {
      res.status(501).json({ error: 'not_implemented' });
      return;
    }
    try {
      const { withMembership, ...rest } = query.data;
      const data = await this.listPeople.execute({ ...rest, ...(withMembership ? { withMembership: withMembership === 'true' } : {}) });
      res.json({ success: true, data });
    } catch (error) {
      this.peopleFailure(res, error, 'ao listar as pessoas');
    }
  }

  async peopleByEmail(req: Request, res: Response): Promise<void> {
    const query = byEmailQuerySchema.safeParse(req.query);
    if (!query.success) return invalid(res, query.error);
    if (!this.findByEmail) {
      res.status(501).json({ error: 'not_implemented' });
      return;
    }
    try {
      const item = await this.findByEmail.execute(query.data.email);
      if (!item) {
        res.status(404).json({ success: false, error: 'Pessoa não encontrada' });
        return;
      }
      res.json({ success: true, data: item });
    } catch (error) {
      this.peopleFailure(res, error, 'ao buscar a pessoa');
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
      const { personId, uid, area, role } = body.data;
      const result = personId
        ? await this.grantUseCase.execute({ pid: personId, area, role, actorUid })
        : await this.grantUseCase.executeForUid({ uid: uid as string, area, role, actorUid });
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
  if (message === new FirebaseLookupError().message) return 502; // o Firebase caiu ao conferir o login: nada foi gravado
  return message.includes('pessoa inexistente') ? 404 : 422;
}
