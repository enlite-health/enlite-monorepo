/**
 * insuranceContractTermWriter (§W) — escreve contrato e TERMOS (valor-hora + imposto, com vigência) da obra social (spec 058 §3.2, plan §1.3).
 *
 * Termo é imutável: nunca UPDATE de valor. Mudar preço = termo NOVO; substituir = marcar o vivo (só `superseded_by`/`superseded_reason`;
 * `superseded_at` é do TRIGGER do banco) e inserir o novo na MESMA transação. A conversão `daterange` <-> wire é só de `dateRangeWire.ts`.
 * Tudo roda em `withActorContext` + `withSerializationRetry`; o 1º termo nasce junto do contrato (uma transação). O "hoje" não entra aqui:
 * quem decide o início padrão é o chamador (`asOf` do país); este arquivo só grava o que recebe.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { withSerializationRetry } from '@shared/database/withSerializationRetry';
import { fromWire, toWire, reinsertClosed, isSameStart, type WireRange } from '../domain/dateRangeWire';
import { mapUniqueViolation } from './InsuranceProviderRepository';
import { SameStartUseCorrectionError, RangeInvalidError } from '../domain/rangeWriteErrors';

export { SameStartUseCorrectionError };

export interface TermInput {
  hourlyRate: number;
  taxRatePercent: number;
  validFrom: string;
  validTo: string | null;
}

export interface CreateContractInput {
  providerCode: string;
  name: string;
  country: string;
  scopeDescription: string | null;
  firstTerm: TermInput;
}

export type SupersedeReason = 'REPRICED' | 'CORRECTION';

export interface SupersedeTermInput {
  reason: SupersedeReason;
  hourlyRate: number;
  taxRatePercent: number;
  validFrom: string;
  /** `undefined` = herda o fim do termo substituído; `null` = sem fim. */
  validTo?: string | null;
}

abstract class TermWriteError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;
}

export class ProviderNotFoundError extends TermWriteError {
  readonly httpStatus = 404;
  readonly code = 'PROVIDER_NOT_FOUND';
  constructor() {
    super('Insurance provider not found');
    this.name = 'ProviderNotFoundError';
  }
}

export class ContractNotFoundError extends TermWriteError {
  readonly httpStatus = 404;
  readonly code = 'CONTRACT_NOT_FOUND';
  constructor() {
    super('Insurance contract not found');
    this.name = 'ContractNotFoundError';
  }
}

export class TermNotFoundError extends TermWriteError {
  readonly httpStatus = 404;
  readonly code = 'TERM_NOT_FOUND';
  constructor() {
    super('Contract term not found');
    this.name = 'TermNotFoundError';
  }
}

/** 409 — o termo já foi substituído (a leitura da tela estava velha). */
export class TermAlreadySupersededError extends TermWriteError {
  readonly httpStatus = 409;
  readonly code = 'TERM_ALREADY_SUPERSEDED';
  constructor() {
    super('Contract term already superseded');
    this.name = 'TermAlreadySupersededError';
  }
}

const INSERT_TERM_SQL = `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by)
                         VALUES ($1, $2, $3, $4, $5) RETURNING id`;

async function insertTerm(client: PoolClient, contractId: string, t: { hourlyRate: number; taxRatePercent: number; valid: string }, actorUid: string): Promise<string> {
  const r = await client.query<{ id: string }>(INSERT_TERM_SQL, [contractId, t.hourlyRate, t.taxRatePercent, t.valid, actorUid]);
  return r.rows[0].id;
}

export class InsuranceContractTermWriter {
  private poolMemo?: Pool;

  constructor(private readonly poolProvider?: () => Pool) {}

  private get pool(): Pool {
    this.poolMemo ??= this.poolProvider ? this.poolProvider() : DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  private run<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withSerializationRetry(() => withActorContext(this.pool, fn));
  }

  /** Contrato + 1º termo na mesma transação. T5 (`PAYER_KIND_REQUIRED`), `name_uq` e a FK do pagador chegam como erro tipado. */
  async createContract(input: CreateContractInput, actorUid: string): Promise<{ contractId: string; termId: string }> {
    return this.run(async (client) => {
      const exists = await client.query(`SELECT 1 FROM insurance_providers WHERE code = $1`, [input.providerCode]);
      if (exists.rowCount === 0) throw new ProviderNotFoundError();
      let contractId: string;
      try {
        const c = await client.query<{ id: string }>(
          `INSERT INTO insurance_contracts (provider_code, country, name, scope_description, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
          [input.providerCode, input.country, input.name, input.scopeDescription, actorUid],
        );
        contractId = c.rows[0].id;
      } catch (err) {
        throw mapUniqueViolation(err) ?? err;
      }
      const t = input.firstTerm;
      const termId = await insertTerm(client, contractId, { hourlyRate: t.hourlyRate, taxRatePercent: t.taxRatePercent, valid: fromWire({ validFrom: t.validFrom, validTo: t.validTo }) }, actorUid);
      return { contractId, termId };
    });
  }

  /** Termo novo num contrato existente. Sobreposição com termo vivo = `23P01` (409). */
  async addTerm(contractId: string, term: TermInput, actorUid: string): Promise<{ termId: string }> {
    return this.run(async (client) => {
      const exists = await client.query(`SELECT 1 FROM insurance_contracts WHERE id = $1`, [contractId]);
      if (exists.rowCount === 0) throw new ContractNotFoundError();
      const termId = await insertTerm(client, contractId, { hourlyRate: term.hourlyRate, taxRatePercent: term.taxRatePercent, valid: fromWire({ validFrom: term.validFrom, validTo: term.validTo }) }, actorUid);
      return { termId };
    });
  }

  /**
   * Substitui um termo VIVO. `REPRICED`: o novo vale a partir de `validFrom`; o trecho anterior `[início, validFrom)` é re-inserido com os
   * valores antigos (`reinsertClosed`); `validFrom` = início do vivo → `SAME_START_USE_CORRECTION` (antes do banco). `CORRECTION`: o novo
   * toma o lugar do vivo inteiro (sem reinsert). Em ambos o vivo é marcado só com `superseded_by`/`superseded_reason`.
   */
  async supersedeTerm(contractId: string, termId: string, input: SupersedeTermInput, actorUid: string): Promise<{ termId: string }> {
    return this.run(async (client) => {
      const cur = await client.query<{ hourly_rate: string; tax_rate_percent: string; valid: string; superseded_at: Date | null }>(
        `SELECT hourly_rate, tax_rate_percent, valid::text AS valid, superseded_at
           FROM insurance_contract_terms WHERE id = $1 AND contract_id = $2 FOR UPDATE`,
        [termId, contractId],
      );
      const old = cur.rows[0];
      if (!old) throw new TermNotFoundError();
      if (old.superseded_at !== null) throw new TermAlreadySupersededError();
      const oldWire = toWire(old.valid);
      const newTo = input.validTo === undefined ? oldWire.validTo : input.validTo;
      if (newTo !== null && newTo < input.validFrom) throw new RangeInvalidError('TERM_RANGE_INVALID');
      const next: WireRange = { validFrom: input.validFrom, validTo: newTo };

      let reinsert: string | null = null;
      if (input.reason === 'REPRICED') {
        if (isSameStart(oldWire.validFrom, input.validFrom)) throw new SameStartUseCorrectionError();
        if (input.validFrom < oldWire.validFrom || (oldWire.validTo !== null && input.validFrom > oldWire.validTo)) throw new RangeInvalidError('TERM_RANGE_INVALID');
        reinsert = reinsertClosed(oldWire.validFrom, input.validFrom);
      }

      await client.query(
        `UPDATE insurance_contract_terms SET superseded_by = $2, superseded_reason = $3 WHERE id = $1`,
        [termId, actorUid, input.reason],
      );
      if (reinsert !== null) {
        await insertTerm(client, contractId, { hourlyRate: Number(old.hourly_rate), taxRatePercent: Number(old.tax_rate_percent), valid: reinsert }, actorUid);
      }
      const newId = await insertTerm(client, contractId, { hourlyRate: input.hourlyRate, taxRatePercent: input.taxRatePercent, valid: fromWire(next) }, actorUid);
      return { termId: newId };
    });
  }
}
