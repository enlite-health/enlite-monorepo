import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import {
  GetServiceTeamContactUseCase,
  RegisterServiceTeamContactUseCase,
  ServiceTeamContactNotFoundError,
  type ServiceTeamContactResult,
} from '../../application/ServiceTeamContactUseCase';
import { serviceTeamContactParamsSchema, serviceTeamContactBodySchema } from '../validators/serviceTeamContactSchemas';

/**
 * AdminServiceTeamContactController — modal do prestador (quadro C, rodada 2, decisão D).
 *
 *   GET  /api/admin/patients/:id/contracted-services/:sid/team/:workerId/contact
 *   POST /api/admin/patients/:id/contracted-services/:sid/team/:workerId/contact
 *
 * Router PRÓPRIO (`adminServiceTeamContactRoutes.ts`), não junto de `adminServiceTeamRoutes.ts`:
 * aquele router tem um teste que afirma "exatamente 3 rotas" (invariante 1, nenhum POST de
 * "adicionar" ao time) — este POST é outra coisa (registrar contato, não mover coluna), mas
 * misturar quebraria a contagem do teste sem precisar.
 *
 * ⚠️ `note` (Notas) NUNCA entra em `reportError` nem em qualquer log — só ids e o nome do método.
 * `emitirTrilhaDeContato` sai quando o telefone SAIU de verdade (mesma régua do quadro C: só
 * quem teve `displayName` não-nulo, aqui equivalente a "o ator tinha worker_contact:read").
 */
export class AdminServiceTeamContactController {
  constructor(
    private readonly getUseCase: GetServiceTeamContactUseCase = new GetServiceTeamContactUseCase(),
    private readonly registerUseCase: RegisterServiceTeamContactUseCase = new RegisterServiceTeamContactUseCase(),
  ) {}

  /** GET .../team/:workerId/contact */
  async get(req: Request, res: Response): Promise<void> {
    const params = serviceTeamContactParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const { id: patientId, sid: serviceId, workerId } = params.data;

    try {
      const result = await this.getUseCase.execute({ patientId, serviceId, workerId, cells: req.permissionCells ?? null });
      this.emitTrail(req, result);
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleError(err, res, 'get', patientId, serviceId, workerId);
    }
  }

  /** POST .../team/:workerId/contact */
  async register(req: Request, res: Response): Promise<void> {
    const params = serviceTeamContactParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = serviceTeamContactBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body' });
      return;
    }
    // Ator ausente é 401, nunca autor fantasma (mesma régua de AdminServiceTeamController.mark).
    const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!actorUid) {
      res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
      return;
    }
    const { id: patientId, sid: serviceId, workerId } = params.data;
    const { contacted, eventDate, note } = body.data;

    try {
      const result = await this.registerUseCase.execute({
        patientId, serviceId, workerId, contacted, eventDate, note: note ?? null, actorUid,
        cells: req.permissionCells ?? null,
      });
      this.emitTrail(req, result);
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleError(err, res, 'register', patientId, serviceId, workerId);
    }
  }

  /** Trilha de contato (C6) — só quando o telefone SAIU (displayName/phone não-nulos = célula presente). */
  private emitTrail(req: Request, result: ServiceTeamContactResult): void {
    if (result.displayName !== null || result.phone !== null) {
      emitirTrilhaDeContato(req, [result.workerId]);
    }
  }

  private handleError(err: unknown, res: Response, method: string, patientId: string, serviceId: string, workerId: string): void {
    if (err instanceof ServiceTeamContactNotFoundError) {
      res.status(404).json({ success: false, code: 'NOT_FOUND' });
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    // Nunca `note` aqui — só ids, molde AdminServiceTeamController.handleError.
    reportError(e, { source: `AdminServiceTeamContactController:${method}`, patientId, serviceId, workerId });
    res.status(500).json({ success: false, error: 'Failed to process service team contact request' });
  }
}
