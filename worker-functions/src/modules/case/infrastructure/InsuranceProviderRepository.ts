/**
 * InsuranceProviderRepository — o CATÁLOGO de coberturas (migration 311; spec 012, US-B3).
 *
 * Molde: `device_types` (307) e o CRUD de papéis de chat (262). Catálogo é tabela para ser
 * referenciável por FK e editável SEM deploy: `POST /api/admin/catalogs/insurance-providers`
 * cria a opção e ela aparece no select da ficha no mesmo instante (o drawer lê `listActive`).
 *
 * Sem PII: cobertura é vocabulário do pagador, não dado de pessoa. O que gruda no paciente
 * (`patient_insurance_verified`) é sensível (lex C3.1) e vive em `PatientInsuranceVerifiedRepository`.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export interface InsuranceProviderRow {
  code: string;
  sortOrder: number;
}

export interface CreateInsuranceProviderInput {
  code: string;
  /** Ausente → max(sort_order)+1 (a 311 não tem DEFAULT de propósito). */
  sortOrder?: number;
  /** Rótulos do ClickUp que devem cair neste código (ConceptMap). */
  aliases?: string[];
}

export class InsuranceProviderExistsError extends Error {
  readonly code = 'INSURANCE_PROVIDER_ALREADY_EXISTS';
  constructor(readonly providerCode: string) {
    super(`Insurance provider already exists: ${providerCode}`);
    this.name = 'InsuranceProviderExistsError';
  }
}

/**
 * A OUTRA restrição única da 311: `insurance_providers_sort_order_unico UNIQUE (sort_order)`.
 *
 * Existe porque mapear todo 23505 para "esse código já existe" respondia sobre um código que NÃO
 * existe — o admin lia que o catálogo já tinha a cobertura e desistia de cadastrá-la. A mensagem
 * agora diz a verdade: a POSIÇÃO está ocupada, o código continua livre.
 */
export class InsuranceProviderSortOrderTakenError extends Error {
  readonly code = 'INSURANCE_PROVIDER_SORT_ORDER_TAKEN';
  constructor(readonly sortOrder: number) {
    super(`Insurance provider sort_order already taken: ${sortOrder}`);
    this.name = 'InsuranceProviderSortOrderTakenError';
  }
}

/** Nome da constraint da 311 — é ele que diz QUAL unicidade o banco recusou. */
const SORT_ORDER_CONSTRAINT = 'insurance_providers_sort_order_unico';

function uniqueViolationConstraint(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return null;
  return e.constraint ?? '';
}

export class InsuranceProviderRepository {
  private poolMemo?: Pool;

  /** Pool preguiçoso (mesma razão do PatientDeviceTypeRepository): construir tem de ser barato. */
  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /** Os códigos ATIVOS, na ordem do catálogo — é o que o select do drawer mostra. */
  async listActive(): Promise<InsuranceProviderRow[]> {
    const r = await this.pool.query<InsuranceProviderRow>(
      `SELECT code, sort_order AS "sortOrder"
         FROM insurance_providers
        WHERE active
        ORDER BY sort_order, code`,
    );
    return r.rows.map((x) => ({ code: x.code, sortOrder: Number(x.sortOrder) }));
  }

  /** Cria o código (+ aliases) numa transação. Duplicado → InsuranceProviderExistsError. */
  async create(input: CreateInsuranceProviderInput): Promise<{ code: string; active: boolean; sortOrder: number }> {
    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const next = await cli.query<{ next: number }>('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM insurance_providers');
        sortOrder = Number(next.rows[0].next);
      }
      let created: { code: string; active: boolean; sort_order: number };
      try {
        const ins = await cli.query<{ code: string; active: boolean; sort_order: number }>(
          `INSERT INTO insurance_providers (code, sort_order) VALUES ($1, $2) RETURNING code, active, sort_order`,
          [input.code, sortOrder],
        );
        created = ins.rows[0];
      } catch (err) {
        // A tabela tem DUAS uniques; quem decide a mensagem é a constraint que o banco nomeou,
        // não o palpite de que "23505 aqui só pode ser o código".
        const constraint = uniqueViolationConstraint(err);
        if (constraint === SORT_ORDER_CONSTRAINT) throw new InsuranceProviderSortOrderTakenError(sortOrder);
        if (constraint !== null) throw new InsuranceProviderExistsError(input.code);
        throw err;
      }
      for (const label of input.aliases ?? []) {
        await cli.query(
          `INSERT INTO insurance_provider_aliases (source, label, code) VALUES ($1, $2, $3) ON CONFLICT (source, label) DO NOTHING`,
          ['clickup', label, input.code],
        );
      }
      await cli.query('COMMIT');
      return { code: created.code, active: created.active, sortOrder: Number(created.sort_order) };
    } catch (err) {
      await cli.query('ROLLBACK');
      throw err;
    } finally {
      cli.release();
    }
  }
}
