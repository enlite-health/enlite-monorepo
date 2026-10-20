/**
 * InsuranceProviderRepository — o CADASTRO de obras sociais/prepagas (migration 311 + 532; spec 012 US-B3, spec 058 §3.2 §W).
 *
 * Molde: `device_types` (307) e o CRUD de papéis de chat (262). Catálogo é tabela para ser referenciável por FK e editável SEM deploy.
 * Desde a 058 cada linha tem `name` (NOT NULL), dados gerais opcionais e `payer_kind` (NULL = ainda não classificado).
 *
 * Erro de unicidade (23505) é despachado POR NOME DE CONSTRAINT (`mapUniqueViolation`): hoje a tabela tem 4 uniques (pkey do código,
 * `sort_order_unico`, `name_uq`, `tax_id_uq`) e o contrato tem `contracts_name_uq`; mapear "todo 23505 = esse código já existe" respondia
 * sobre um código que NÃO existe. Constraint desconhecida propaga crua (vira 500 + alarme), nunca um 409 chutado.
 *
 * Sem PII de pessoa: o cadastro da obra social é dado da empresa. Os contatos (pessoas) vivem em `InsuranceProviderContactRepository`.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { deriveProviderCode } from './deriveProviderCode';
import { providersWithOfferedContract } from './insuranceContractTermRead';

export type PayerKind = 'OBRA_SOCIAL' | 'PREPAGA' | 'PRIVATE';

/** Linha do catálogo que o select do drawer de cobertura consome (`GET /catalogs/insurance-providers`). */
export interface InsuranceProviderRow {
  code: string;
  name: string;
  sortOrder: number;
}

/** Item da lista da página de obras sociais. */
export interface InsuranceProviderListItem {
  code: string;
  name: string;
  payerKind: PayerKind | null;
  active: boolean;
}

/** Dados gerais (cartão 1 da página). */
export interface InsuranceProviderDetail extends InsuranceProviderListItem {
  legalName: string | null;
  taxId: string | null;
  address: string | null;
  managementChatId: string | null;
  sortOrder: number;
}

/** Opção do select da cascata do serviço: SEM `payerKind` (o tipo do pagador é do container `coverage`, §0 decisor 2). */
export interface ForServiceOption {
  code: string;
  name: string;
}

export interface CreateInsuranceProviderInput {
  name: string;
  /** Ausente → `deriveProviderCode(name)`. */
  code?: string;
  /** Ausente → max(sort_order)+1 (a 311 não tem DEFAULT de propósito), com retry na corrida. */
  sortOrder?: number;
  /** Rótulos do ClickUp que devem cair neste código (ConceptMap). */
  aliases?: string[];
}

/**
 * PATCH dos dados gerais. Ausente = não toca; `null` = limpa (só campo anulável); `''` nunca chega aqui (o zod recusa).
 * `code` não existe: é imutável.
 */
export interface InsuranceProviderPatch {
  name?: string;
  legalName?: string | null;
  taxId?: string | null;
  address?: string | null;
  managementChatId?: string | null;
  payerKind?: PayerKind | null;
  active?: boolean;
}

// ── erros de unicidade (todos 409; `httpStatus`/`code` são lidos por `insuranceErrorResponse`) ──────────────────────────────────

abstract class UniqueConflictError extends Error {
  readonly httpStatus = 409;
  abstract readonly code: string;
  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message);
  }
}

/** `insurance_providers_pkey` — o CÓDIGO já existe (inclusive o derivado do nome). Substitui `INSURANCE_PROVIDER_ALREADY_EXISTS`. */
export class InsuranceProviderExistsError extends UniqueConflictError {
  readonly code = 'INSURANCE_PROVIDER_CODE_EXISTS';
  constructor(readonly providerCode: string) {
    super('Insurance provider code already exists', { code: providerCode });
    this.name = 'InsuranceProviderExistsError';
  }
}

/** `insurance_providers_sort_order_unico` — a POSIÇÃO está ocupada, o código continua livre. */
export class InsuranceProviderSortOrderTakenError extends UniqueConflictError {
  readonly code = 'INSURANCE_PROVIDER_SORT_ORDER_TAKEN';
  constructor(readonly sortOrder: number) {
    super('Insurance provider sort_order already taken', { sortOrder });
    this.name = 'InsuranceProviderSortOrderTakenError';
  }
}

/** `insurance_providers_name_uq` — já há obra social com esse NOME (sem caixa/espaços das pontas). */
export class InsuranceProviderNameExistsError extends UniqueConflictError {
  readonly code = 'INSURANCE_PROVIDER_NAME_EXISTS';
  constructor() {
    super('Insurance provider name already exists', {});
    this.name = 'InsuranceProviderNameExistsError';
  }
}

/** `insurance_providers_tax_id_uq` — o CUIT/CNPJ já está em outra obra social. O valor NÃO volta na resposta. */
export class InsuranceProviderTaxIdExistsError extends UniqueConflictError {
  readonly code = 'INSURANCE_PROVIDER_TAX_ID_EXISTS';
  constructor() {
    super('Insurance provider tax id already exists', {});
    this.name = 'InsuranceProviderTaxIdExistsError';
  }
}

/** `insurance_contracts_name_uq` — a obra social já tem contrato com esse nome. */
export class InsuranceContractNameExistsError extends UniqueConflictError {
  readonly code = 'INSURANCE_CONTRACT_NAME_EXISTS';
  constructor() {
    super('Insurance contract name already exists for this provider', {});
    this.name = 'InsuranceContractNameExistsError';
  }
}

/** Nomes das constraints únicas que o banco nomeia no 23505 (`err.constraint`). */
export const UNIQUE_CONSTRAINTS = {
  providerPkey: 'insurance_providers_pkey',
  sortOrder: 'insurance_providers_sort_order_unico',
  providerName: 'insurance_providers_name_uq',
  providerTaxId: 'insurance_providers_tax_id_uq',
  contractName: 'insurance_contracts_name_uq',
} as const;

/** Contexto do INSERT/UPDATE que falhou — só o que a mensagem de cada constraint precisa. */
export interface UniqueViolationContext {
  code?: string;
  sortOrder?: number;
}

/**
 * Despacha um `23505` pelo NOME da constraint. `null` = não é 23505 OU é uma constraint que este mapa não conhece: o chamador propaga o
 * erro cru (nunca o disfarça de "já existe").
 */
export function mapUniqueViolation(err: unknown, ctx: UniqueViolationContext = {}): Error | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return null;
  switch (e.constraint) {
    case UNIQUE_CONSTRAINTS.providerPkey:
      return new InsuranceProviderExistsError(ctx.code ?? '');
    case UNIQUE_CONSTRAINTS.sortOrder:
      return new InsuranceProviderSortOrderTakenError(ctx.sortOrder ?? 0);
    case UNIQUE_CONSTRAINTS.providerName:
      return new InsuranceProviderNameExistsError();
    case UNIQUE_CONSTRAINTS.providerTaxId:
      return new InsuranceProviderTaxIdExistsError();
    case UNIQUE_CONSTRAINTS.contractName:
      return new InsuranceContractNameExistsError();
    default:
      return null;
  }
}

/** Corrida do MAX+1: o 23505 da posição é refeito (cada tentativa é uma transação nova). */
const SORT_ORDER_ATTEMPTS = 3;

interface DetailRow {
  code: string;
  name: string;
  payer_kind: PayerKind | null;
  active: boolean;
  legal_name: string | null;
  tax_id: string | null;
  address: string | null;
  management_chat_id: string | null;
  sort_order: number;
}

const DETAIL_COLUMNS = `code, name, payer_kind, active, legal_name, tax_id, address, management_chat_id, sort_order`;

function detailOf(r: DetailRow): InsuranceProviderDetail {
  return {
    code: r.code,
    name: r.name,
    payerKind: r.payer_kind,
    active: r.active,
    legalName: r.legal_name,
    taxId: r.tax_id,
    address: r.address,
    managementChatId: r.management_chat_id,
    sortOrder: Number(r.sort_order),
  };
}

/** Coluna do banco de cada chave do PATCH — a ÚNICA lista de campos editáveis (o `code` não está nela). */
const PATCH_COLUMNS: ReadonlyArray<readonly [keyof InsuranceProviderPatch, string]> = [
  ['name', 'name'],
  ['legalName', 'legal_name'],
  ['taxId', 'tax_id'],
  ['address', 'address'],
  ['managementChatId', 'management_chat_id'],
  ['payerKind', 'payer_kind'],
  ['active', 'active'],
];

export class InsuranceProviderRepository {
  private poolMemo?: Pool;

  /** Pool preguiçoso (mesma razão do PatientDeviceTypeRepository): construir tem de ser barato. */
  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /** Os ATIVOS, na ordem do catálogo — é o que o select do drawer de cobertura mostra (devolve `name`: o i18n do rótulo saiu). */
  async listActive(): Promise<InsuranceProviderRow[]> {
    const r = await this.pool.query<{ code: string; name: string; sortOrder: number }>(
      `SELECT code, name, sort_order AS "sortOrder"
         FROM insurance_providers
        WHERE active
        ORDER BY sort_order, code`,
    );
    return r.rows.map((x) => ({ code: x.code, name: x.name, sortOrder: Number(x.sortOrder) }));
  }

  /** Lista da página (busca por nome; `includeInactive` mostra as aposentadas). */
  async list(opts: { search?: string; includeInactive?: boolean } = {}): Promise<InsuranceProviderListItem[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (!opts.includeInactive) where.push('active');
    if (opts.search !== undefined && opts.search.trim() !== '') {
      params.push(`%${opts.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`name ILIKE $${params.length}`);
    }
    const r = await this.pool.query<DetailRow>(
      `SELECT code, name, payer_kind, active FROM insurance_providers
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY lower(name), code`,
      params,
    );
    return r.rows.map((x) => ({ code: x.code, name: x.name, payerKind: x.payer_kind, active: x.active }));
  }

  /** Dados gerais de UMA obra social, ou `null`. */
  async get(code: string): Promise<InsuranceProviderDetail | null> {
    const r = await this.pool.query<DetailRow>(`SELECT ${DETAIL_COLUMNS} FROM insurance_providers WHERE code = $1`, [code]);
    return r.rows[0] ? detailOf(r.rows[0]) : null;
  }

  /**
   * Opções da cascata do serviço: só ATIVAS com ≥1 contrato oferecido no país (`providersWithOfferedContract`, §T) MAIS o pagador já
   * vinculado (`selected`, mesmo inativo/sem oferta) — para o select não perder o valor escolhido. Devolve `{code, name}`, nunca `payerKind`.
   */
  async listForService(country: string, asOf: string, selected?: string): Promise<ForServiceOption[]> {
    const offered = await providersWithOfferedContract(this.pool, country, asOf);
    const codes = selected !== undefined && !offered.includes(selected) ? [...offered, selected] : offered;
    if (codes.length === 0) return [];
    const r = await this.pool.query<{ code: string; name: string }>(
      `SELECT code, name FROM insurance_providers WHERE code = ANY($1::text[]) ORDER BY sort_order, code`,
      [codes],
    );
    return r.rows.map((x) => ({ code: x.code, name: x.name }));
  }

  /** Cria o cadastro (+ aliases) numa transação. Unicidade violada → erro 409 tipado, por constraint. */
  async create(input: CreateInsuranceProviderInput): Promise<{ code: string; name: string; active: boolean; sortOrder: number }> {
    const code = input.code ?? deriveProviderCode(input.name);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.createOnce(code, input);
      } catch (err) {
        const racedSortOrder =
          input.sortOrder === undefined &&
          attempt < SORT_ORDER_ATTEMPTS &&
          err instanceof InsuranceProviderSortOrderTakenError;
        if (!racedSortOrder) throw err;
      }
    }
  }

  private async createOnce(
    code: string,
    input: CreateInsuranceProviderInput,
  ): Promise<{ code: string; name: string; active: boolean; sortOrder: number }> {
    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const next = await cli.query<{ next: number }>('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM insurance_providers');
        sortOrder = Number(next.rows[0].next);
      }
      let created: { code: string; name: string; active: boolean; sort_order: number };
      try {
        const ins = await cli.query<{ code: string; name: string; active: boolean; sort_order: number }>(
          `INSERT INTO insurance_providers (code, name, sort_order) VALUES ($1, $2, $3) RETURNING code, name, active, sort_order`,
          [code, input.name, sortOrder],
        );
        created = ins.rows[0];
      } catch (err) {
        throw mapUniqueViolation(err, { code, sortOrder }) ?? err;
      }
      for (const label of input.aliases ?? []) {
        await cli.query(
          `INSERT INTO insurance_provider_aliases (source, label, code) VALUES ($1, $2, $3) ON CONFLICT (source, label) DO NOTHING`,
          ['clickup', label, code],
        );
      }
      await cli.query('COMMIT');
      return { code: created.code, name: created.name, active: created.active, sortOrder: Number(created.sort_order) };
    } catch (err) {
      await cli.query('ROLLBACK');
      throw err;
    } finally {
      cli.release();
    }
  }

  /**
   * PATCH dos dados gerais em `withActorContext` (a classificação `payer_kind` carimba o rastro com `app.current_uid`). Ausente = não
   * toca; `null` = limpa. Devolve o cadastro atualizado, ou `null` se o código não existe. `payerKind: null` num classificado é recusado
   * pelo banco (T6′, P0001 `PAYER_KIND_CANNOT_UNSET`).
   */
  async patch(code: string, patch: InsuranceProviderPatch): Promise<InsuranceProviderDetail | null> {
    const sets: string[] = [];
    const params: unknown[] = [code];
    for (const [key, column] of PATCH_COLUMNS) {
      if (patch[key] === undefined) continue;
      params.push(patch[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length === 0) return this.get(code);
    return withActorContext(this.pool, async (client: PoolClient) => {
      try {
        const r = await client.query<DetailRow>(
          `UPDATE insurance_providers SET ${sets.join(', ')} WHERE code = $1 RETURNING ${DETAIL_COLUMNS}`,
          params,
        );
        return r.rows[0] ? detailOf(r.rows[0]) : null;
      } catch (err) {
        throw mapUniqueViolation(err, { code }) ?? err;
      }
    });
  }
}
