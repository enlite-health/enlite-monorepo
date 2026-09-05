import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { InsuranceProviderRepository, InsuranceProviderExistsError, InsuranceProviderSortOrderTakenError } from '../../infrastructure/InsuranceProviderRepository';

/**
 * AdminInsuranceProvidersController — o catálogo de coberturas (spec 012, US-B3), SEM tela.
 *
 *   GET  /api/admin/catalogs/insurance-providers — staff (o select do drawer precisa dos códigos)
 *   POST /api/admin/catalogs/insurance-providers — admin (muda o vocabulário de TODOS os pacientes)
 *
 * Mesma forma de código dos CHECKs `insurance_providers_code_upper` (311): validar aqui é 400
 * legível; lá é a garantia de que nem um psql à mão fura. Sem PII.
 */
export const createInsuranceProviderSchema = z
  .object({
    code: z.string().trim().min(2).max(64).regex(/^[A-Z][A-Z0-9_]*$/, 'code: MAIÚSCULAS, dígitos e _ (ex.: SWISS_MEDICAL)'),
    sortOrder: z.number().int().positive().optional(),
    aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .strict();

export class AdminInsuranceProvidersController {
  constructor(private readonly repo: InsuranceProviderRepository = new InsuranceProviderRepository()) {}

  /** GET /api/admin/catalogs/insurance-providers */
  async list(_req: Request, res: Response): Promise<void> {
    try {
      const providers = await this.repo.listActive();
      res.status(200).json({ success: true, data: { providers } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminInsuranceProvidersController:list' });
      res.status(500).json({ success: false, error: 'Failed to list insurance providers' });
    }
  }

  /** POST /api/admin/catalogs/insurance-providers */
  async create(req: Request, res: Response): Promise<void> {
    const body = createInsuranceProviderSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: body.error.flatten() });
      return;
    }
    try {
      const created = await this.repo.create(body.data);
      res.status(201).json({ success: true, data: created });
    } catch (err: unknown) {
      if (err instanceof InsuranceProviderExistsError) {
        res.status(409).json({ success: false, error: 'Insurance provider already exists', code: err.code, details: { code: err.providerCode } });
        return;
      }
      // Conflito na OUTRA unique da 311: a posição está ocupada, o código continua livre.
      if (err instanceof InsuranceProviderSortOrderTakenError) {
        res.status(409).json({ success: false, error: 'Insurance provider sort_order already taken', code: err.code, details: { sortOrder: err.sortOrder } });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminInsuranceProvidersController:create' });
      res.status(500).json({ success: false, error: 'Failed to create insurance provider' });
    }
  }
}
