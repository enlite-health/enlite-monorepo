import { Request, Response } from 'express';
import type { ZodError } from 'zod';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { clinicalCellsOf } from '../../application/patientClinicalAccess';
import { InsuranceProviderContactRepository, type ContactWriteOutcome } from '../../infrastructure/InsuranceProviderContactRepository';
import {
  createInsuranceContactSchema,
  patchInsuranceContactSchema,
  contactParamsSchema,
  DOCUMENT_PAIR_INCOMPLETE,
} from '../validators/insuranceContactSchemas';
import { providerCodeParamSchema } from '../validators/insuranceProviderSchemas';
import { respondInsuranceError } from './insuranceErrorResponse';

/** A célula que decide se o ator vê telefone, e-mail e número do documento do contato (nasce `untilEnforced: 'admin'`). */
export const CONTACTS_READ_CELL = 'insurance_provider_contacts:read';

/**
 * AdminInsuranceProviderContactsController — cartão Empregados da obra social (spec 058 §3.2).
 *
 *   GET   /api/admin/insurance-providers/:code/contacts               (`insurance_provider_contacts:read`)
 *   POST  /api/admin/insurance-providers/:code/contacts               (`…:create`)
 *   PATCH /api/admin/insurance-providers/:code/contacts/:contactId    (`…:update`)
 *   POST  /api/admin/insurance-providers/:code/contacts/:contactId/retire (`…:update`)
 *
 * PII: telefone, e-mail e número do documento só saem DECIFRADOS para o ator que lê a célula acima (as escritas devolvem a linha
 * redigida a quem não lê). NENHUM valor do corpo entra em log ou resposta de erro — o `reportError` leva só ids e nomes de campo.
 */
export class AdminInsuranceProviderContactsController {
  constructor(private readonly repo: InsuranceProviderContactRepository = new InsuranceProviderContactRepository()) {}

  /** `cells` é lista (o engine decidiu) → só com a célula; `null` (família fora do enforcement) → só o papel `admin`, como `untilEnforced`. */
  private canRead(req: Request): boolean {
    const cells = clinicalCellsOf(req);
    if (cells !== null) return cells.includes(CONTACTS_READ_CELL);
    const roles = (req as Request & { user?: { roles?: readonly string[] } }).user?.roles ?? req.authContext?.principal?.roles;
    return roles === undefined || roles === null || roles.includes('admin');
  }

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  private invalidBody(error: ZodError, res: Response, status: 400 | 422): void {
    const pairIssue = error.issues.some((i) => i.message === DOCUMENT_PAIR_INCOMPLETE);
    if (pairIssue) {
      res.status(422).json({ success: false, error: DOCUMENT_PAIR_INCOMPLETE, code: DOCUMENT_PAIR_INCOMPLETE });
      return;
    }
    const fields = Object.keys(error.flatten().fieldErrors);
    res.status(status).json({ success: false, error: 'Invalid body', ...(status === 422 ? { code: 'VALIDATION_FAILED' } : {}), details: { fields } });
  }

  private fail(err: unknown, res: Response, source: string, ids: Record<string, unknown>): void {
    if (respondInsuranceError(err, res)) return;
    // Só ids e o NOME da operação: nunca req.body, nunca o texto do erro do driver (pode ecoar a linha — PII).
    const e = err instanceof Error ? new Error(err.name) : new Error('unknown error');
    reportError(e, { source: `AdminInsuranceProviderContactsController:${source}`, ...ids });
    res.status(500).json({ success: false, error: 'Failed to process insurance provider contact' });
  }

  private answer(outcome: ContactWriteOutcome, res: Response, okStatus: 200 | 201): void {
    if (outcome.outcome === 'ok') {
      res.status(okStatus).json({ success: true, data: outcome.contact });
      return;
    }
    if (outcome.outcome === 'retired') {
      res.status(409).json({ success: false, error: 'Contact is retired', code: 'CONTACT_RETIRED' });
      return;
    }
    res.status(404).json({ success: false, error: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
  }

  async list(req: Request, res: Response): Promise<void> {
    const params = providerCodeParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    try {
      const items = await this.repo.list(params.data.code, { decrypt: this.canRead(req), includeRetired: req.query.includeRetired === 'true' });
      res.status(200).json({ success: true, data: { items } });
    } catch (err: unknown) {
      this.fail(err, res, 'list', { providerCode: params.data.code });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    const params = providerCodeParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = createInsuranceContactSchema.safeParse(req.body);
    if (!body.success) {
      this.invalidBody(body.error, res, 400);
      return;
    }
    try {
      const contact = await this.repo.create(params.data.code, body.data, this.actorUid(req), this.canRead(req));
      res.status(201).json({ success: true, data: contact });
    } catch (err: unknown) {
      this.fail(err, res, 'create', { providerCode: params.data.code });
    }
  }

  async patch(req: Request, res: Response): Promise<void> {
    const params = contactParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = patchInsuranceContactSchema.safeParse(req.body ?? {});
    if (!body.success) {
      this.invalidBody(body.error, res, 422);
      return;
    }
    try {
      const outcome = await this.repo.patch(params.data.code, params.data.contactId, body.data, this.actorUid(req), this.canRead(req));
      this.answer(outcome, res, 200);
    } catch (err: unknown) {
      this.fail(err, res, 'patch', { providerCode: params.data.code, contactId: params.data.contactId });
    }
  }

  async retire(req: Request, res: Response): Promise<void> {
    const params = contactParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    try {
      const outcome = await this.repo.retire(params.data.code, params.data.contactId, this.actorUid(req), this.canRead(req));
      this.answer(outcome, res, 200);
    } catch (err: unknown) {
      this.fail(err, res, 'retire', { providerCode: params.data.code, contactId: params.data.contactId });
    }
  }
}
