import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { GetServiceTeamUseCase, ServiceTeamNotFoundError, type GetServiceTeamResult } from '../../application/GetServiceTeamUseCase';
import {
  ServiceTeamMarkUseCase,
  ServiceTeamWorkerAllocatedError,
  ServiceTeamNotSelectedError,
  ServiceTeamNotRejectedError,
  ServiceTeamAlreadyRejectedError,
} from '../../application/ServiceTeamMarkUseCase';
import { ServiceTeamReasonRequiredError, ServiceTeamReasonInvalidError } from '../../domain/serviceTeamReason';
import { serviceTeamParamsSchema, serviceTeamMarkBodySchema } from '../validators/serviceTeamSchemas';

/**
 * AdminServiceTeamController — quadro C (Servicio Contratado), Fase 10, DX-10.6/DX-10.7.
 *
 *   GET  /api/admin/patients/:id/contracted-services/:sid/team
 *   POST /api/admin/patients/:id/contracted-services/:sid/team/reject
 *   POST /api/admin/patients/:id/contracted-services/:sid/team/revert
 *
 * Sem lógica de negócio: os dois casos de uso (`GetServiceTeamUseCase`/`ServiceTeamMarkUseCase`)
 * decidem tudo — o controller só valida forma (zod), despacha e mapeia erro de domínio → HTTP
 * (molde `AdminPatientItineraryController.ts:21`, construtor não abre banco). `reasonCategory`
 * ausente/inválido nunca vira 400: é 422 do caso de uso (critérios 8/9 — a ordem é a régua da
 * sabotagem, DX-10.6). `WorkerAllocatedError` sai com a mensagem literal do critério 7 ("remova do
 * itinerário primeiro"). `reportError` nunca leva `workerId` (memória "nunca logar PII" — o id
 * sozinho não é PII, mas o log não precisa dele). Trilha (`emitirTrilhaDeContato`, o mesmo do
 * quadro B) sai no GET e nos dois POST, só com os `workerId` cujo `displayName` saiu não-nulo.
 */
export class AdminServiceTeamController {
  constructor(
    private readonly getServiceTeamUseCase: GetServiceTeamUseCase = new GetServiceTeamUseCase(),
    private readonly markUseCase: ServiceTeamMarkUseCase = new ServiceTeamMarkUseCase(),
  ) {}

  /** GET /api/admin/patients/:id/contracted-services/:sid/team */
  async get(req: Request, res: Response): Promise<void> {
    const params = serviceTeamParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const { id: patientId, sid: serviceId } = params.data;

    try {
      const team = await this.getServiceTeamUseCase.execute({ patientId, serviceId, cells: req.permissionCells ?? null });
      emitirTrilhaDeContato(req, this.workerIdsWithDisplayName(team));
      res.status(200).json({ success: true, data: team });
    } catch (err: unknown) {
      this.handleError(err, res, 'get', patientId, serviceId);
    }
  }

  /** POST /api/admin/patients/:id/contracted-services/:sid/team/reject */
  async reject(req: Request, res: Response): Promise<void> {
    await this.mark(req, res, 'reject');
  }

  /** POST /api/admin/patients/:id/contracted-services/:sid/team/revert */
  async revert(req: Request, res: Response): Promise<void> {
    await this.mark(req, res, 'revert');
  }

  private async mark(req: Request, res: Response, kind: 'reject' | 'revert'): Promise<void> {
    const params = serviceTeamParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = serviceTeamMarkBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body' });
      return;
    }
    // `rejected_by`/`reverted_by` são coluna de auditoria NOT NULL — gravar 'unknown' nela some com
    // a autoria em vez de falhar (achado #9 do gate). Ator ausente é erro de AUTENTICAÇÃO, não uma
    // forma alternativa de rodar a ação. Molde do ator: `AdminPatientContractedServicesController.ts:50`
    // (`AuthMiddleware.getAuthContext(req)?.principal.id`) — SEM o `?? 'unknown'` do irmão: aqui a
    // ausência é 401, nunca um autor fantasma (N5 do gate fecho).
    const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!actorUid) {
      res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
      return;
    }
    const { id: patientId, sid: serviceId } = params.data;
    const { workerId, reasonCategory } = body.data;

    try {
      const input = { patientId, serviceId, workerId, reasonCategory, actorUid, cells: req.permissionCells ?? null };
      const team = kind === 'reject' ? await this.markUseCase.reject(input) : await this.markUseCase.revert(input);
      emitirTrilhaDeContato(req, this.workerIdsWithDisplayName(team));
      res.status(200).json({ success: true, data: team });
    } catch (err: unknown) {
      this.handleError(err, res, kind, patientId, serviceId);
    }
  }

  /** Só os `workerId` cujo `displayName` saiu NÃO-nulo — `emitirTrilhaDeContato` já filtra `null`/`undefined`, mas aqui a decisão fica explícita. */
  private workerIdsWithDisplayName(team: GetServiceTeamResult): Array<string | null | undefined> {
    return [...team.selected, ...team.inService, ...team.rejected]
      .filter((member) => member.displayName !== null)
      .map((member) => member.workerId);
  }

  private handleError(err: unknown, res: Response, method: string, patientId: string, serviceId: string): void {
    if (err instanceof ServiceTeamReasonRequiredError) {
      res.status(422).json({ success: false, code: 'SERVICE_TEAM_REASON_REQUIRED' });
      return;
    }
    if (err instanceof ServiceTeamReasonInvalidError) {
      res.status(422).json({ success: false, code: 'SERVICE_TEAM_REASON_INVALID' });
      return;
    }
    if (err instanceof ServiceTeamWorkerAllocatedError) {
      res.status(422).json({ success: false, code: 'SERVICE_TEAM_WORKER_ALLOCATED', error: 'remova do itinerário primeiro' });
      return;
    }
    if (err instanceof ServiceTeamNotSelectedError) {
      res.status(422).json({ success: false, code: 'SERVICE_TEAM_NOT_SELECTED' });
      return;
    }
    if (err instanceof ServiceTeamNotRejectedError) {
      res.status(422).json({ success: false, code: 'SERVICE_TEAM_NOT_REJECTED' });
      return;
    }
    if (err instanceof ServiceTeamAlreadyRejectedError) {
      res.status(409).json({ success: false, code: 'SERVICE_TEAM_ALREADY_REJECTED' });
      return;
    }
    if (err instanceof ServiceTeamNotFoundError) {
      res.status(404).json({ success: false, code: 'NOT_FOUND' });
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminServiceTeamController:${method}`, patientId, serviceId });
    res.status(500).json({ success: false, error: 'Failed to process service team request' });
  }
}
