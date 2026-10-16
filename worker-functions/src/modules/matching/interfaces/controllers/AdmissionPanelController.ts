import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { actorUid, MissingActorError } from '@modules/conversation/interfaces/controllers/ConversationActor';
import { isAdmissionCountry } from '../../domain/admissionCountries';
import { ResendLimitReached, ResendNotAllowed } from '../../application/AdmissionMessagingErrors';
import {
  AppointmentNotCancellableError,
  AppointmentNotFoundError,
  PaidRehearsalAlreadyActiveError,
  PaidRehearsalNotAllowedError,
  ResendInProgressError,
  SummaryRetryLimitReachedError,
  SummaryRetryNotAllowedError,
} from '../../application/AdmissionPanelErrors';
import { TactiqLinkRequiredError } from '../../application/ports/TactiqPorts';
import { AdmissionPanelService } from '../../application/AdmissionPanelService';
import type { AdmissionSummaryRetryService } from '../../application/AdmissionSummaryRetryService';
import {
  AdmissionSchedulingService,
  HostNotInRosterError,
  InvalidSlotError,
  PatientNotFoundError,
  SlotInPastError,
  SlotTakenError,
} from '../../application/AdmissionSchedulingService';
import { CalendarCreateFailedError } from '../../application/admissionCalendarCreate';

/**
 * AdmissionPanelController — rotas ADMIN da aba Admissão (spec 049 F3). `:id` é SEMPRE o patient id.
 *
 *   GET  /patients/:id/admission-appointments                              patient_admission:read
 *   GET  /admission/hosts?country=AR|BR                                    patient_admission:create
 *   POST /patients/:id/admission-appointments                              patient_admission:create  (409 TACTIQ_LINK_REQUIRED se o responsável não tem vínculo vivo)
 *   POST /patients/:id/admission-appointments/:apptId/cancel               patient_admission:update
 *   POST /patients/:id/admission-appointments/:apptId/messages/:kind/resend patient_admission:resend_message
 *   POST /patients/:id/admission-appointments/:apptId/paid-rehearsal       patient_admission:release_paid_rehearsal  (spec 050 R-19: libera UMA reunião de teste por 48 h; 409 se o paciente não é de teste)
 *   POST /patients/:id/admission-appointments/:apptId/summary-retry        patient_admission:retry_summary  (spec 050 R-38: +1 rodada do resumo, teto de 2; 409 se `done`, terminal ou teto)
 *
 * Erros de domínio viram resposta com `code` estável; o resto vira 500 genérico, relatado só com ids (nunca telefone,
 * nome, e-mail nem corpo da requisição). 404 vale para paciente/reunião inexistente, de outro paciente ou de outro país.
 */
const patientParams = z.object({ id: z.string().uuid() });
const apptParams = z.object({ id: z.string().uuid(), apptId: z.string().uuid() });
const resendParams = z.object({ id: z.string().uuid(), apptId: z.string().uuid(), kind: z.enum(['confirmation', 'reminder_30min']) });
const bookBody = z.object({ hostEmail: z.string().email(), slotStartISO: z.string().min(1) }).strict();

const DOMAIN_STATUS: ReadonlyArray<readonly [new (...a: never[]) => Error, number]> = [
  [PatientNotFoundError, 404],
  [AppointmentNotFoundError, 404],
  [SlotTakenError, 409],
  [TactiqLinkRequiredError, 409],
  [AppointmentNotCancellableError, 409],
  [PaidRehearsalNotAllowedError, 409],
  [PaidRehearsalAlreadyActiveError, 409],
  [SummaryRetryNotAllowedError, 409],
  [SummaryRetryLimitReachedError, 409],
  [ResendNotAllowed, 409],
  [ResendLimitReached, 409],
  [ResendInProgressError, 409],
  [SlotInPastError, 422],
  [HostNotInRosterError, 422],
  [InvalidSlotError, 400],
  [CalendarCreateFailedError, 502],
  [MissingActorError, 401],
];

const CODE_BY_CLASS = new Map<Function, string>([
  [ResendNotAllowed, 'RESEND_NOT_ALLOWED'],
  [ResendLimitReached, 'RESEND_LIMIT_REACHED'],
]);

export class AdmissionPanelController {
  constructor(
    private readonly scheduling: AdmissionSchedulingService,
    private readonly panel: AdmissionPanelService,
    private readonly summaryRetry?: AdmissionSummaryRetryService,
  ) {}

  async list(req: Request, res: Response): Promise<void> {
    const params = patientParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'list', params.data.id, async () => {
      const rows = await this.panel.list(params.data.id);
      // Spec 050 F11: o botão "Reintentar resumen" — só as reuniões com falha de resumo levam o campo (as outras: `summaryRetry: null`).
      const views = await this.summaryRetry?.viewsFor(params.data.id);
      res.status(200).json({ success: true, data: views ? rows.map((r) => ({ ...r, summaryRetry: views.get(r.id) ?? null })) : rows });
    });
  }

  async listHosts(req: Request, res: Response): Promise<void> {
    const country = req.query.country;
    if (!isAdmissionCountry(country)) {
      res.status(400).json({ success: false, error: 'Invalid or missing country (AR|BR)' });
      return;
    }
    await this.run(res, 'listHosts', '-', async () => {
      const hosts = await this.panel.listHosts(country);
      res.status(200).json({ success: true, data: hosts.map((h) => ({ email: h.email, displayName: h.displayName, linked: h.linked, linkState: h.linkState })) });
    });
  }

  async book(req: Request, res: Response): Promise<void> {
    const params = patientParams.safeParse(req.params);
    const body = bookBody.safeParse(req.body);
    if (!params.success || !body.success) return this.invalid(res);
    await this.run(res, 'book', params.data.id, async () => {
      const out = await this.scheduling.bookForHost({
        patientId: params.data.id,
        hostEmail: body.data.hostEmail,
        slotStartISO: body.data.slotStartISO,
        actorUid: actorUid(req),
      });
      res.status(201).json({ success: true, data: out });
    });
  }

  async cancel(req: Request, res: Response): Promise<void> {
    const params = apptParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'cancel', params.data.id, async () => {
      const out = await this.panel.cancel({ patientId: params.data.id, appointmentId: params.data.apptId, actorUid: actorUid(req) });
      res.status(200).json({ success: true, data: out });
    });
  }

  async resend(req: Request, res: Response): Promise<void> {
    const params = resendParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'resend', params.data.id, async () => {
      const out = await this.panel.resend({
        patientId: params.data.id,
        appointmentId: params.data.apptId,
        kind: params.data.kind,
        actorUid: actorUid(req),
      });
      res.status(200).json({ success: true, data: out });
    });
  }

  async releasePaidRehearsal(req: Request, res: Response): Promise<void> {
    const params = apptParams.safeParse(req.params);
    if (!params.success) return this.invalid(res);
    await this.run(res, 'releasePaidRehearsal', params.data.id, async () => {
      const out = await this.panel.releasePaidRehearsal({ patientId: params.data.id, appointmentId: params.data.apptId, actorUid: actorUid(req) });
      res.status(201).json({ success: true, data: out });
    });
  }

  async retrySummary(req: Request, res: Response): Promise<void> {
    const params = apptParams.safeParse(req.params);
    if (!params.success || !this.summaryRetry) return this.invalid(res);
    const retry = this.summaryRetry;
    await this.run(res, 'retrySummary', params.data.id, async () => {
      const out = await retry.retry({ patientId: params.data.id, appointmentId: params.data.apptId, actorUid: actorUid(req) });
      res.status(200).json({ success: true, data: out });
    });
  }

  private invalid(res: Response): void {
    res.status(400).json({ success: false, error: 'Invalid params' });
  }

  private async run(res: Response, source: string, patientId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
      const hit = DOMAIN_STATUS.find(([cls]) => err instanceof cls);
      if (hit) {
        const code = (err as { code?: string }).code ?? CODE_BY_CLASS.get(hit[0]) ?? 'DOMAIN_ERROR';
        res.status(hit[1]).json({ success: false, error: (err as Error).message, code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: `AdmissionPanelController:${source}`, patientId });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }
}
