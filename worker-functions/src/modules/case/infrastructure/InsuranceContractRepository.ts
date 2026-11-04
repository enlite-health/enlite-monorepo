/**
 * InsuranceContractRepository — LEITURA e edição de cabeçalho do contrato com a obra social (E3, migration 535; spec 058 §3.2 §W).
 * Valor-hora e imposto NÃO moram aqui: são dos termos (`insuranceContractTermRead` lê, `insuranceContractTermWriter` escreve). `provider_code`
 * e `country` são imutáveis (trigger 535) — o PATCH só toca `name` e `scope_description`.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { mapUniqueViolation } from './InsuranceProviderRepository';
import type { Queryable, OfferedContract } from './insuranceContractTermRead';

export interface ContractHeader extends OfferedContract {
  providerCode: string;
}

export interface ContractPatch {
  name?: string;
  scopeDescription?: string | null;
}

interface Row {
  id: string;
  provider_code: string;
  name: string;
  country: string;
  scope_description: string | null;
}

const COLUMNS = `id, provider_code, name, country, scope_description`;

const headerOf = (r: Row): ContractHeader => ({ id: r.id, providerCode: r.provider_code, name: r.name, country: r.country, scopeDescription: r.scope_description });

export class InsuranceContractRepository {
  private poolMemo?: Pool;

  constructor(private readonly poolProvider?: () => Pool) {}

  private get pool(): Pool {
    this.poolMemo ??= this.poolProvider ? this.poolProvider() : DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async providerExists(code: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM insurance_providers WHERE code = $1`, [code]);
    return (r.rowCount ?? 0) > 0;
  }

  async get(id: string, q: Queryable = this.pool): Promise<ContractHeader | null> {
    const r = await q.query<Row>(`SELECT ${COLUMNS} FROM insurance_contracts WHERE id = $1`, [id]);
    return r.rows[0] ? headerOf(r.rows[0]) : null;
  }

  /** Contratos da obra social nos países do ESCOPO do ator (o filtro de país da T067 mora aqui: `country = ANY`). */
  async listForProvider(providerCode: string, countries: readonly string[]): Promise<ContractHeader[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM insurance_contracts
        WHERE provider_code = $1 AND country = ANY($2::text[])
        ORDER BY lower(name), id`,
      [providerCode, countries],
    );
    return r.rows.map(headerOf);
  }

  /** PATCH: ausente = não toca; `null` em `scopeDescription` = limpa. `null` devolvido = contrato inexistente. */
  async patch(id: string, patch: ContractPatch, actorUid: string): Promise<ContractHeader | null> {
    const sets: string[] = [];
    const params: unknown[] = [id, actorUid];
    if (patch.name !== undefined) {
      params.push(patch.name);
      sets.push(`name = $${params.length}`);
    }
    if (patch.scopeDescription !== undefined) {
      params.push(patch.scopeDescription);
      sets.push(`scope_description = $${params.length}`);
    }
    if (sets.length === 0) return this.get(id);
    try {
      const r = await this.pool.query<Row>(
        `UPDATE insurance_contracts SET ${sets.join(', ')}, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING ${COLUMNS}`,
        params,
      );
      return r.rows[0] ? headerOf(r.rows[0]) : null;
    } catch (err) {
      throw mapUniqueViolation(err) ?? err;
    }
  }
}
