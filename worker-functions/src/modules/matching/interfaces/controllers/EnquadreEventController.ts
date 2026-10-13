import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { cellsOfRequest } from '@modules/identity/permissions';
import { actorUid, MissingActorError } from '@modules/conversation/interfaces/controllers/ConversationActor';
import { EnquadreConfigError, EnquadreGuestNotAllowedError } from '../../domain/enquadreCalendarConfig';
import { TactiqLinkRequiredError } from '../../application/ports/TactiqPorts';
import { HostNotInRosterError, InvalidSlotError } from '../../application/AdmissionSchedulingErrors';
import { CalendarCreateFailedError } from '../../application/admissionCalendarCreate';
import {
  EnquadreCalendarUpdateFailedError,
  EnquadreEventNotEndedError,
  EnquadreEventNotFoundError,
  EnquadreEventNotOpenError,
  EnquadreMoveRefusedError,
  EnquadreParticipantAlreadyMarkedError,
  EnquadreParticipantNotFoundError,
  EnquadreSlotInPastError,
  EnquadreVacancyNotFoundError,
  EnquadreWorkerEmailInvalidError,
  EnquadreWorkerNotAvailableError,
} from '../../application/EnquadreEventErrors';
import type { EnquadreEventService } from '../../application/EnquadreEventService';
import type { EnquadreEventMutations } from '../../application/EnquadreEventMutations';

/**
 * EnquadreEventController — rotas ADMIN do evento de enquadre na vaga (spec 052, Fase 2). `:vacancyId` é SEMPRE o id da vaga.
 *
 *   GET  /vacancies/:vacancyId/enquadre-events                               enquadre_event:read
 *   GET  /vacancies/:vacancyId/enquadre-events/available-workers             enquadre_event:create
 *   GET  /vacancies/:vacancyId/enquadre-events/hosts                         enquadre_event:create
 *   GET  /vacancies/:vacancyId/enquadre-events/hosts/:hostId/free-slots      enquadre_event:create
 *   GET  /vacancies/:vacancyId/enquadre-events/:eventId                      enquadre_event:read
 *   POST /vacancies/:vacancyId/enquadre-events                               enquadre_event:create
 *   POST /vacancies/:vacancyId/enquadre-events/:eventId/participants         enquadre_event:update  (acrescentar convocados)
 *   POST /vacancies/:vacancyId/enquadre-events/:eventId/participants/:participantId/remove  enquadre_event:update
 *   POST /vacancies/:vacancyId/enquadre-events/:eventId/cancel               enquadre_event:update
 *   PUT  /vacancies/:vacancyId/enquadre-events/:eventId/participants/:participantId/move   enquadre_result:update
 *   POST /vacancies/:vacancyId/enquadre-events/:eventId/close                enquadre_result:update
 *
 * Erro de domínio vira resposta com `code` ESTÁVEL (a tela traduz pelo `code`, nunca ecoa a mensagem); o resto vira 500
 * genérico, relatado só com ids — nunca e-mail, nome, telefone nem o corpo da requisição.
 */
const vacancyParams = z.object({ vacancyId: z.string().uuid() });
const eventParams = z.object({ vacancyId: z.string().uuid(), eventId: z.string().uuid() });
const slotsParams = z.object({ vacancyId: z.string().uuid(), hostId: z.string().uuid() });
const duration = z.number().int().min(15).max(480);
const slotsQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().pipe(duration),
});
const createBody = z
  .object({
    hostId: z.string().uuid(),
    startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    durationMinutes: duration,
    workerIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();

const participantParams = z.object({ vacancyId: z.string().uuid(), eventId: z.string().uuid(), participantId: z.string().uuid() });
const addBody = z.object({ workerIds: z.array(z.string().uuid()).min(1).max(50) }).strict();
const moveBody = z
  .object({ column: z.enum(['CONVOKED', 'SELECTED', 'QUICK_RESPONSE_TEAM', 'REJECTED']), reason: z.string().min(1).max(100).optional() })
  .strict();

const DOMAIN_STATUS: ReadonlyArray<readonly [new (...a: never[]) => Error, number]> = [
  [EnquadreVacancyNotFoundError, 404],
  [EnquadreEventNotFoundError, 404],
  [EnquadreParticipantNotFoundError, 404],
  [EnquadreEventNotOpenError, 409],
  [EnquadreEventNotEndedError, 409],
  [EnquadreParticipantAlreadyMarkedError, 409],
  [EnquadreSlotInPastError, 400],
  [EnquadreCalendarUpdateFailedError, 502],
  [TactiqLinkRequiredError, 409],
  [EnquadreWorkerNotAvailableError, 409],
  [HostNotInRosterError, 422],
  [EnquadreWorkerEmailInvalidError, 422],
  [EnquadreGuestNotAllowedError, 422],
  [InvalidSlotError, 400],
  [CalendarCreateFailedError, 502],
  [EnquadreConfigError, 503],
  [MissingActorError, 401],
];

export class EnquadreEventController {
  constructor(
    private readonly service: EnquadreEventService,
    private readonly mutations: EnquadreEventMutations,
  ) {}

  async list(req: Request, res: Response): Promise<void> {
    const params = vacancyParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'list', params.data.vacancyId, async () => {
      res.status(200).json({ success: true, data: await this.service.listEvents(params.data.vacancyId) });
    });
  }

  async get(req: Request, res: Response): Promise<void> {
    const params = eventParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'get', params.data.vacancyId, async () => {
      const data = await this.service.getEvent(params.data.vacancyId, params.data.eventId, { cells: cellsOfRequest(req) });
      res.status(200).json({ success: true, data });
    });
  }

  async availableWorkers(req: Request, res: Response): Promise<void> {
    const params = vacancyParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'availableWorkers', params.data.vacancyId, async () => {
      const data = await this.service.listAvailableWorkers(params.data.vacancyId, { cells: cellsOfRequest(req) });
      res.status(200).json({ success: true, data });
    });
  }

  async hosts(req: Request, res: Response): Promise<void> {
    const params = vacancyParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'hosts', params.data.vacancyId, async () => {
      res.status(200).json({ success: true, data: await this.service.listHosts(params.data.vacancyId) });
    });
  }

  async freeSlots(req: Request, res: Response): Promise<void> {
    const params = slotsParams.safeParse(req.params);
    const query = slotsQuery.safeParse(req.query);
    if (!params.success || !query.success) return this.invalid(res);
    await this.run(res, 'freeSlots', params.data.vacancyId, async () => {
      const data = await this.service.listHostFreeSlots(params.data.vacancyId, params.data.hostId, query.data.date, query.data.durationMinutes);
      res.status(200).json({ success: true, data });
    });
  }

  async create(req: Request, res: Response): Promise<void> {
    const params = vacancyParams.safeParse(req.params);
    const body = createBody.safeParse(req.body);
    if (!params.success || !body.success) return this.invalid(res);
    await this.run(res, 'create', params.data.vacancyId, async () => {
      const data = await this.service.createEvent(params.data.vacancyId, body.data, { uid: actorUid(req), cells: cellsOfRequest(req) });
      res.status(201).json({ success: true, data });
    });
  }

  async addParticipants(req: Request, res: Response): Promise<void> {
    const params = eventParams.safeParse(req.params);
    const body = addBody.safeParse(req.body);
    if (!params.success || !body.success) return this.invalid(res);
    await this.run(res, 'addParticipants', params.data.vacancyId, async () => {
      const data = await this.mutations.addParticipants(params.data.vacancyId, params.data.eventId, body.data.workerIds, this.actor(req));
      res.status(200).json({ success: true, data });
    });
  }

  async removeParticipant(req: Request, res: Response): Promise<void> {
    const params = participantParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'removeParticipant', params.data.vacancyId, async () => {
      const data = await this.mutations.removeParticipant(params.data.vacancyId, params.data.eventId, params.data.participantId, this.actor(req));
      res.status(200).json({ success: true, data });
    });
  }

  async cancel(req: Request, res: Response): Promise<void> {
    const params = eventParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'cancel', params.data.vacancyId, async () => {
      res.status(200).json({ success: true, data: await this.mutations.cancelEvent(params.data.vacancyId, params.data.eventId, this.actor(req)) });
    });
  }

  async moveParticipant(req: Request, res: Response): Promise<void> {
    const params = participantParams.safeParse(req.params);
    const body = moveBody.safeParse(req.body);
    if (!params.success || !body.success) return this.invalid(res);
    await this.run(res, 'moveParticipant', params.data.vacancyId, async () => {
      const { vacancyId, eventId, participantId } = params.data;
      const data = await this.mutations.moveParticipant(vacancyId, eventId, participantId, body.data.column, body.data.reason, this.actor(req));
      res.status(200).json({ success: true, data });
    });
  }

  async close(req: Request, res: Response): Promise<void> {
    const params = eventParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'close', params.data.vacancyId, async () => {
      res.status(200).json({ success: true, data: await this.mutations.closeEvent(params.data.vacancyId, params.data.eventId, this.actor(req)) });
    });
  }

  private actor(req: Request): { uid: string; cells: string[] | null } {
    return { uid: actorUid(req), cells: cellsOfRequest(req) };
  }

  private invalid(res: Response): void {
    res.status(400).json({ success: false, error: 'Invalid params', code: 'INVALID_PARAMS' });
  }

  private async run(res: Response, source: string, vacancyId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
      // Recusa do miolo do estágio / prestador não elegível: status e corpo IDÊNTICOS aos do funil (a tela já os trata por `code`).
      if (err instanceof EnquadreMoveRefusedError) {
        res.status(err.status).json(err.body);
        return;
      }
      const hit = DOMAIN_STATUS.find(([cls]) => err instanceof cls);
      if (hit) {
        const code = (err as { code?: string }).code ?? 'DOMAIN_ERROR';
        res.status(hit[1]).json({ success: false, error: (err as Error).message, code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: `EnquadreEventController:${source}`, vacancyId });
      res.status(500).json({ success: false, error: 'Internal error', code: 'INTERNAL_ERROR' });
    }
  }
}
