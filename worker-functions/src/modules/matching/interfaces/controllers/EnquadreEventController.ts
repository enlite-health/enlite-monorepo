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
  EnquadreEventNotFoundError,
  EnquadreVacancyNotFoundError,
  EnquadreWorkerEmailInvalidError,
  EnquadreWorkerNotAvailableError,
} from '../../application/EnquadreEventErrors';
import type { EnquadreEventService } from '../../application/EnquadreEventService';

/**
 * EnquadreEventController — rotas ADMIN do evento de enquadre na vaga (spec 052, Fase 2). `:vacancyId` é SEMPRE o id da vaga.
 *
 *   GET  /vacancies/:vacancyId/enquadre-events                               enquadre_event:read
 *   GET  /vacancies/:vacancyId/enquadre-events/available-workers             enquadre_event:create
 *   GET  /vacancies/:vacancyId/enquadre-events/hosts                         enquadre_event:create
 *   GET  /vacancies/:vacancyId/enquadre-events/hosts/:hostId/free-slots      enquadre_event:create
 *   GET  /vacancies/:vacancyId/enquadre-events/:eventId                      enquadre_event:read
 *   POST /vacancies/:vacancyId/enquadre-events                               enquadre_event:create
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

const DOMAIN_STATUS: ReadonlyArray<readonly [new (...a: never[]) => Error, number]> = [
  [EnquadreVacancyNotFoundError, 404],
  [EnquadreEventNotFoundError, 404],
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
  constructor(private readonly service: EnquadreEventService) {}

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

  private invalid(res: Response): void {
    res.status(400).json({ success: false, error: 'Invalid params', code: 'INVALID_PARAMS' });
  }

  private async run(res: Response, source: string, vacancyId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
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
