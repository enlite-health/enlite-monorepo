import { Request, Response } from 'express';
import type { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { currentDbContext } from '@shared/database/requestDbSession';
import { operationDateOf, buildAsOfByCountry, UnknownCountryError } from '@shared/locale/operationDate';
import { COUNTRY_TIMEZONE_MAP } from '@shared/locale/CountryTimezone';
import { resolveCountryScope, CountryScopeError } from '@modules/identity';
import { InsuranceProviderRepository } from '../../infrastructure/InsuranceProviderRepository';
import { providerPatientsRead } from '../../infrastructure/providerPatientsRead';
import { NameNotCodifiableError } from '../../infrastructure/deriveProviderCode';
import {
  createInsuranceProviderSchema,
  patchInsuranceProviderSchema,
  providerCodeParamSchema,
  listInsuranceProvidersQuerySchema,
  forServiceQuerySchema,
} from '../validators/insuranceProviderSchemas';
import { respondInsuranceError } from './insuranceErrorResponse';

export { createInsuranceProviderSchema };

/**
 * AdminInsuranceProvidersController — o cadastro de obras sociais (spec 012 US-B3; spec 058 §3.2 §W).
 *
 *   GET   /api/admin/catalogs/insurance-providers      — o select do drawer de cobertura (`patient_coverage:read`; devolve `name`)
 *   POST  /api/admin/catalogs/insurance-providers      — cria `{ name, code?, aliases? }` (`catalog_insurance_providers:create`)
 *   GET   /api/admin/insurance-providers[?search=]     — lista da página
 *   GET   /api/admin/insurance-providers/for-service   — cascata do serviço (sem `payerKind`; mantém o `selected`)
 *   GET   /api/admin/insurance-providers/:code         — Dados gerais
 *   PATCH /api/admin/insurance-providers/:code         — Dados gerais (`payerKind` reclassifica; `code` é imutável)
 *   GET   /api/admin/insurance-providers/:code/patients — §L: pacientes com vínculo vigente (`insurance_provider_patients:read`)
 *
 * Erros: `insuranceErrorResponse` (§K). Nenhum corpo de request vai para log/erro — só ids e nomes de campo.
 */
export class AdminInsuranceProvidersController {
  private dbMemo?: Pool;

  constructor(
    private readonly repo: InsuranceProviderRepository = new InsuranceProviderRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get db(): Pool {
    this.dbMemo ??= DatabaseConnection.getInstance().getPool();
    return this.dbMemo;
  }

  private fail(err: unknown, res: Response, source: string, message: string, ids: Record<string, unknown> = {}): void {
    if (err instanceof NameNotCodifiableError) {
      res.status(422).json({ success: false, error: err.message, code: err.code });
      return;
    }
    if (respondInsuranceError(err, res)) return;
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminInsuranceProvidersController:${source}`, ...ids });
    res.status(500).json({ success: false, error: message });
  }

  /** GET /api/admin/catalogs/insurance-providers */
  async list(_req: Request, res: Response): Promise<void> {
    try {
      const providers = await this.repo.listActive();
      res.status(200).json({ success: true, data: { providers } });
    } catch (err: unknown) {
      this.fail(err, res, 'list', 'Failed to list insurance providers');
    }
  }

  /** POST /api/admin/catalogs/insurance-providers */
  async create(req: Request, res: Response): Promise<void> {
    const body = createInsuranceProviderSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      const created = await this.repo.create(body.data);
      res.status(201).json({ success: true, data: created });
    } catch (err: unknown) {
      this.fail(err, res, 'create', 'Failed to create insurance provider');
    }
  }

  /** GET /api/admin/insurance-providers */
  async search(req: Request, res: Response): Promise<void> {
    const query = listInsuranceProvidersQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query' });
      return;
    }
    try {
      const items = await this.repo.list({ search: query.data.search, includeInactive: query.data.includeInactive === 'true' });
      res.status(200).json({ success: true, data: { items } });
    } catch (err: unknown) {
      this.fail(err, res, 'search', 'Failed to list insurance providers');
    }
  }

  /** GET /api/admin/insurance-providers/:code */
  async get(req: Request, res: Response): Promise<void> {
    const params = providerCodeParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    try {
      const provider = await this.repo.get(params.data.code);
      if (!provider) {
        res.status(404).json({ success: false, error: 'Insurance provider not found', code: 'PROVIDER_NOT_FOUND' });
        return;
      }
      res.status(200).json({ success: true, data: provider });
    } catch (err: unknown) {
      this.fail(err, res, 'get', 'Failed to get insurance provider', { providerCode: params.data.code });
    }
  }

  /** PATCH /api/admin/insurance-providers/:code — ausente = não toca; null = limpa (anulável); '' e `code` = 422. */
  async patch(req: Request, res: Response): Promise<void> {
    const params = providerCodeParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const raw = req.body as Record<string, unknown> | null;
    if (typeof raw === 'object' && raw !== null && Object.prototype.hasOwnProperty.call(raw, 'code')) {
      res.status(422).json({ success: false, error: 'code is immutable', code: 'CODE_IMMUTABLE' });
      return;
    }
    const body = patchInsuranceProviderSchema.safeParse(raw ?? {});
    if (!body.success) {
      res.status(422).json({ success: false, error: 'Invalid body', code: 'VALIDATION_FAILED', details: { fields: Object.keys(body.error.flatten().fieldErrors) } });
      return;
    }
    try {
      const updated = await this.repo.patch(params.data.code, body.data);
      if (!updated) {
        res.status(404).json({ success: false, error: 'Insurance provider not found', code: 'PROVIDER_NOT_FOUND' });
        return;
      }
      res.status(200).json({ success: true, data: updated });
    } catch (err: unknown) {
      this.fail(err, res, 'patch', 'Failed to update insurance provider', { providerCode: params.data.code });
    }
  }

  /** GET /api/admin/insurance-providers/for-service?country=&selected= — `{code, name}`, nunca `payerKind`. */
  async listForService(req: Request, res: Response): Promise<void> {
    const query = forServiceQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query' });
      return;
    }
    try {
      const asOf = operationDateOf(query.data.country, this.now());
      const providers = await this.repo.listForService(query.data.country, asOf, query.data.selected);
      res.status(200).json({ success: true, data: { providers, asOf } });
    } catch (err: unknown) {
      this.fail(err, res, 'listForService', 'Failed to list insurance providers for service');
    }
  }

  /** GET /api/admin/insurance-providers/:code/patients — §L (portão: `insurance_provider_patients:read`). */
  async listPatients(req: Request, res: Response): Promise<void> {
    const params = providerCodeParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    let countries: string[];
    try {
      countries = (await resolveCountryScope(this.db, currentDbContext()?.uid, req.query.country)).countries;
    } catch (err) {
      if (err instanceof CountryScopeError) {
        res.status(err.status).json({ success: false, error: err.code, detail: err.message });
        return;
      }
      this.fail(err, res, 'listPatients:scope', 'Failed to resolve country scope');
      return;
    }
    try {
      if (!(await this.repo.get(params.data.code))) {
        res.status(404).json({ success: false, error: 'Insurance provider not found', code: 'PROVIDER_NOT_FOUND' });
        return;
      }
      // Só os países do ESCOPO do ator entram no mapa: país fora dele não casa (providerPatientsRead) — o recorte é aqui, não no SQL.
      const inScope = Object.fromEntries(countries.filter((c) => c in COUNTRY_TIMEZONE_MAP).map((c) => [c, COUNTRY_TIMEZONE_MAP[c]]));
      const asOfByCountry = buildAsOfByCountry(inScope, this.now());
      const items = await withActorContext(this.db, (client) => providerPatientsRead(client, params.data.code, asOfByCountry));
      res.status(200).json({ success: true, data: { items } });
    } catch (err: unknown) {
      if (err instanceof UnknownCountryError) {
        res.status(422).json({ success: false, error: err.message, code: err.code });
        return;
      }
      this.fail(err, res, 'listPatients', 'Failed to list provider patients', { providerCode: params.data.code });
    }
  }
}
