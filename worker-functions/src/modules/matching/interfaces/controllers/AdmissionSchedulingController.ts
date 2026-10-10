import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { isAdmissionCountry, type AdmissionCountry } from '../../domain/admissionCountries';
import {
  AdmissionSchedulingService,
  admissionSchedulingService,
  PatientNotFoundError,
  SlotTakenError,
} from '../../application/AdmissionSchedulingService';
import { NO_ELIGIBLE_HOST_MESSAGE } from '../../application/admissionHostEligibility';

/**
 * AdmissionSchedulingController — unauthenticated B2C admission scheduling.
 *
 *   GET  /api/public/v1/admission/slots?country=AR|BR  → available slots (no host names)
 *   POST /api/public/v1/admission/book                 → book a slot
 *
 * No staff auth (rate-limited at route level, same pattern as public leads).
 */
const bookSchema = z
  .object({
    patientId: z.string().uuid(),
    slotStartISO: z.string().min(1),
    country: z.enum(['AR', 'BR']),
  })
  .strict();

export class AdmissionSchedulingController {
  private readonly service: AdmissionSchedulingService;

  /** `noEligibleHost` (R-26): decide se a lista vazia leva a mensagem de contato. Sem ele (singleton sem gate) a resposta é só `{ slots }`. */
  constructor(
    service?: AdmissionSchedulingService,
    private readonly noEligibleHost: (country: AdmissionCountry) => Promise<boolean> = async () => false,
  ) {
    this.service = service ?? admissionSchedulingService;
  }

  /** GET /api/public/v1/admission/slots?country=AR|BR */
  async getSlots(req: Request, res: Response): Promise<void> {
    const country = req.query.country;
    if (!isAdmissionCountry(country)) {
      res.status(400).json({ success: false, error: 'Invalid or missing country (AR|BR)' });
      return;
    }

    try {
      const slots = await this.service.getAvailableSlots(country);
      const noHost = slots.length === 0 && (await this.noEligibleHost(country));
      res.status(200).json(noHost ? { slots, message: NO_ELIGIBLE_HOST_MESSAGE } : { slots });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdmissionSchedulingController:getSlots' });
      res.status(500).json({ success: false, error: 'Failed to load slots' });
    }
  }

  /** POST /api/public/v1/admission/book */
  async book(req: Request, res: Response): Promise<void> {
    const parsed = bookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await this.service.book(parsed.data);
      res.status(200).json({
        hostDisplayName: result.hostDisplayName,
        slotStartISO: result.slotStartISO,
        meetLink: result.meetLink,
      });
    } catch (err: unknown) {
      if (err instanceof SlotTakenError) {
        res.status(409).json({ success: false, error: 'SLOT_TAKEN' });
        return;
      }
      if (err instanceof PatientNotFoundError) {
        res.status(404).json({ success: false, error: 'PATIENT_NOT_FOUND' });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdmissionSchedulingController:book' });
      res.status(500).json({ success: false, error: 'Failed to book slot' });
    }
  }
}
