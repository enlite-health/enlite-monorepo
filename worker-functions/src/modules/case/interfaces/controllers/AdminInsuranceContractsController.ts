import { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { ZodError } from 'zod';
import { reportError } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { currentDbContext } from '@shared/database/requestDbSession';
import { operationDateOf } from '@shared/locale/operationDate';
import { AuthMiddleware, resolveCountryScope, CountryScopeError } from '@modules/identity';
import { hourlyValueActorOf, redactTermForActor, type HourlyValueActor, type RedactedPrice } from '../../application/contractedServiceHourlyValueAccess';
import { InsuranceContractRepository, type ContractHeader } from '../../infrastructure/InsuranceContractRepository';
import { InsuranceContractTermWriter } from '../../infrastructure/insuranceContractTermWriter';
import { offeredContractsOf, termsOfContracts, termView, type ContractTerms, type TermPrice, type TermRow } from '../../infrastructure/insuranceContractTermRead';
import {
  createContractBodySchema,
  patchContractBodySchema,
  supersedeTermBodySchema,
  termBodySchema,
  contractIdParamSchema,
  termParamsSchema,
  listContractsQuerySchema,
  IMMUTABLE_CONTRACT_KEYS,
} from '../validators/insuranceContractSchemas';
import { providerCodeParamSchema } from '../validators/insuranceProviderSchemas';
import { respondInsuranceError } from './insuranceErrorResponse';

/** Termo como a API devolve: o `price` passa por `redactTermForActor` (1º dos 2 chamadores); o imposto NÃO é redigido. */
export type ContractTermItem =
  | { state: 'NO_TERM' }
  | { state: 'OK'; termId: string; validFrom: string; validTo: string | null; taxRatePercent: number; price: TermPrice | RedactedPrice };

export interface ContractItem {
  id: string;
  name: string;
  country: string;
  scopeDescription: string | null;
  asOf: string;
  currentTerm: ContractTermItem;
  futureTerms: ContractTermItem[];
}

function termItem(term: TermRow | null, actor: HourlyValueActor): ContractTermItem {
  const view = termView(term);
  if (view.state === 'NO_TERM') return view;
  return { ...view, price: redactTermForActor(view.price, actor) };
}

export function contractItem(header: ContractHeader, terms: ContractTerms, asOf: string, actor: HourlyValueActor): ContractItem {
  return {
    id: header.id,
    name: header.name,
    country: header.country,
    scopeDescription: header.scopeDescription,
    asOf,
    currentTerm: termItem(terms.current, actor),
    futureTerms: terms.future.map((t) => termItem(t, actor)),
  };
}

/**
 * AdminInsuranceContractsController — contrato e termos da obra social (spec 058 §3.2 §W/§T).
 *
 *   GET   /api/admin/insurance-providers/:code/contracts[?offered=true&country=]  (`insurance_contracts:read`)
 *   POST  /api/admin/insurance-providers/:code/contracts                          (`insurance_contracts:create` + `patient_contract_value:create`)
 *   PATCH /api/admin/insurance-contracts/:id                                     (`insurance_contracts:update`)
 *   POST  /api/admin/insurance-contracts/:id/terms                               (`patient_contract_value:create`)
 *   POST  /api/admin/insurance-contracts/:id/terms/:termId/supersede             (`patient_contract_value:create`)
 *
 * "Hoje" é o do PAÍS do contrato (`operationDateOf`), capturado UMA vez por requisição. O preço só sai a quem lê
 * `patient_contract_value:read` (`redactTermForActor`); a lista é recortada pelo escopo de país do ator (`resolveCountryScope`).
 * Nenhum relógio em SQL deste arquivo (D-43).
 */
export class AdminInsuranceContractsController {
  private dbMemo?: Pool;

  constructor(
    private readonly repo: InsuranceContractRepository = new InsuranceContractRepository(),
    private readonly writer: InsuranceContractTermWriter = new InsuranceContractTermWriter(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private get db(): Pool {
    this.dbMemo ??= DatabaseConnection.getInstance().getPool();
    return this.dbMemo;
  }

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  private invalidBody(error: ZodError, res: Response): void {
    res.status(422).json({ success: false, error: 'Invalid body', code: 'VALIDATION_FAILED', details: { fields: Object.keys(error.flatten().fieldErrors) } });
  }

  private fail(err: unknown, res: Response, source: string, ids: Record<string, unknown> = {}): void {
    if (respondInsuranceError(err, res)) return;
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminInsuranceContractsController:${source}`, ...ids });
    res.status(500).json({ success: false, error: 'Failed to process insurance contract' });
  }

  /** Um contrato recém-escrito, relido com os termos do país dele. */
  private async itemOf(id: string, req: Request): Promise<ContractItem | null> {
    const header = await this.repo.get(id);
    if (!header) return null;
    const asOf = operationDateOf(header.country, this.clock());
    const terms = await termsOfContracts(this.db, [id], asOf);
    return contractItem(header, terms.get(id) ?? { current: null, future: [] }, asOf, hourlyValueActorOf(req));
  }

  /** GET …/:code/contracts */
  async list(req: Request, res: Response): Promise<void> {
    const params = providerCodeParamSchema.safeParse(req.params);
    const query = listContractsQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) {
      res.status(400).json({ success: false, error: 'Invalid request' });
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
      this.fail(err, res, 'list:scope');
      return;
    }
    try {
      if (!(await this.repo.providerExists(params.data.code))) {
        res.status(404).json({ success: false, error: 'Insurance provider not found', code: 'PROVIDER_NOT_FOUND' });
        return;
      }
      const requestNow = this.clock();
      const asOfOf = (country: string): string => operationDateOf(country, requestNow);
      // País do escopo é a ÚNICA fonte da lista: um ator só-AR nunca vê contrato BR (T067).
      const headers: ContractHeader[] =
        query.data.offered === 'true'
          ? (await Promise.all(countries.map((c) => offeredContractsOf(this.db, params.data.code, c, asOfOf(c)))))
              .flat()
              .map((o) => ({ ...o, providerCode: params.data.code }))
              .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
          : await this.repo.listForProvider(params.data.code, countries);
      const actor = hourlyValueActorOf(req);
      const items: ContractItem[] = [];
      for (const country of countries) {
        const ofCountry = headers.filter((h) => h.country === country);
        const terms = await termsOfContracts(this.db, ofCountry.map((h) => h.id), asOfOf(country));
        for (const h of ofCountry) items.push(contractItem(h, terms.get(h.id) ?? { current: null, future: [] }, asOfOf(country), actor));
      }
      items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
      res.status(200).json({ success: true, data: { items } });
    } catch (err: unknown) {
      this.fail(err, res, 'list', { providerCode: params.data.code });
    }
  }

  /** POST …/:code/contracts — contrato + 1º termo (valor e imposto) na mesma transação. */
  async create(req: Request, res: Response): Promise<void> {
    const params = providerCodeParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = createContractBodySchema.safeParse(req.body);
    if (!body.success) {
      this.invalidBody(body.error, res);
      return;
    }
    try {
      const { firstTerm } = body.data;
      const { contractId } = await this.writer.createContract(
        {
          providerCode: params.data.code,
          name: body.data.name,
          country: body.data.country,
          scopeDescription: body.data.scopeDescription ?? null,
          firstTerm: { ...firstTerm, validTo: firstTerm.validTo ?? null },
        },
        this.actorUid(req),
      );
      res.status(201).json({ success: true, data: await this.itemOf(contractId, req) });
    } catch (err: unknown) {
      this.fail(err, res, 'create', { providerCode: params.data.code });
    }
  }

  /** PATCH /insurance-contracts/:id — só `name`/`scopeDescription`; país e pagador → 422 `IMMUTABLE_FIELD`. */
  async patch(req: Request, res: Response): Promise<void> {
    const params = contractIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const immutable = IMMUTABLE_CONTRACT_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
    if (immutable.length > 0) {
      res.status(422).json({ success: false, error: 'Immutable field', code: 'IMMUTABLE_FIELD', details: { fields: immutable } });
      return;
    }
    const body = patchContractBodySchema.safeParse(raw);
    if (!body.success) {
      this.invalidBody(body.error, res);
      return;
    }
    try {
      const updated = await this.repo.patch(params.data.id, body.data, this.actorUid(req));
      if (!updated) {
        res.status(404).json({ success: false, error: 'Insurance contract not found', code: 'CONTRACT_NOT_FOUND' });
        return;
      }
      res.status(200).json({ success: true, data: await this.itemOf(updated.id, req) });
    } catch (err: unknown) {
      this.fail(err, res, 'patch', { contractId: params.data.id });
    }
  }

  /** POST /insurance-contracts/:id/terms — termo novo (nunca UPDATE de valor). */
  async addTerm(req: Request, res: Response): Promise<void> {
    const params = contractIdParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = termBodySchema.safeParse(req.body);
    if (!body.success) {
      this.invalidBody(body.error, res);
      return;
    }
    try {
      await this.writer.addTerm(params.data.id, { ...body.data, validTo: body.data.validTo ?? null }, this.actorUid(req));
      res.status(201).json({ success: true, data: await this.itemOf(params.data.id, req) });
    } catch (err: unknown) {
      this.fail(err, res, 'addTerm', { contractId: params.data.id });
    }
  }

  /** POST /insurance-contracts/:id/terms/:termId/supersede — `REPRICED` ou `CORRECTION`. */
  async supersedeTerm(req: Request, res: Response): Promise<void> {
    const params = termParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = supersedeTermBodySchema.safeParse(req.body);
    if (!body.success) {
      this.invalidBody(body.error, res);
      return;
    }
    try {
      await this.writer.supersedeTerm(params.data.id, params.data.termId, body.data, this.actorUid(req));
      res.status(200).json({ success: true, data: await this.itemOf(params.data.id, req) });
    } catch (err: unknown) {
      this.fail(err, res, 'supersedeTerm', { contractId: params.data.id, termId: params.data.termId });
    }
  }
}
