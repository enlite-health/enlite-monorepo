import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { publicLeadSchema } from '../validators/publicLeadSchema';
import { CreateLeadUseCase } from '../../application/CreateLeadUseCase';
import { PatientService } from '../../application/PatientService';

/**
 * PublicLeadsController — unauthenticated B2C intake.
 *
 * Endpoint:
 *   POST /api/public/v1/leads — create a patient lead from the /admision form.
 *
 * No staff auth (rate-limited at route level, same pattern as public jobs).
 * Delegates all business logic to CreateLeadUseCase.
 */
export class PublicLeadsController {
  private readonly useCase: CreateLeadUseCase;

  constructor(useCase?: CreateLeadUseCase) {
    this.useCase = useCase ?? new CreateLeadUseCase(new PatientService());
  }

  /** POST /api/public/v1/leads */
  async createLead(req: Request, res: Response): Promise<void> {
    const parsed = publicLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const { id } = await this.useCase.execute(parsed.data);
      res.status(201).json({ success: true, data: { id } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));

      // Contact-channel invariant (should never trigger — we always have both
      // email and phone) surfaces as a clear 400 rather than a 500.
      if (/contato/i.test(e.message)) {
        res.status(400).json({
          success: false,
          error: 'Invalid contact',
          details: e.message,
        });
        return;
      }

      reportError(e, { source: 'PublicLeadsController:createLead' });
      res.status(500).json({ success: false, error: 'Failed to create lead' });
    }
  }
}
