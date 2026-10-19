/**
 * contractedServiceContractLinkWriter (§E) — escreve o VÍNCULO serviço contratado -> contrato da obra social (E5; spec 058 §3.2 §E, plan §1.3.1).
 *
 * Tudo em `withActorContext` + `withSerializationRetry` (3 tentativas em 40001/40P01, depois 409), sob o lock do paciente
 * (`pg_advisory_xact_lock(hashtext('contract-link:patient:'||patient_id))` — a MESMA chave das triggers T1/T2/T3). Quem decide o que o banco
 * aceita são as triggers; este arquivo só fixa a ORDEM de escrita que elas esperam e recusa antes do banco o que ficaria vazio:
 *
 *   create    — INSERT do vínculo novo (a T1 aplica as regras literais: `REQUIRES_NEW_SERVICE` / `USE_CORRECTION`).
 *   end       — marca a viva `ENDED` (só `superseded_by`/`superseded_reason`; `superseded_at` e `superseded_xact` são do trigger) e re-insere o trecho
 *               `[início, fim]` fechado do MESMO contrato.
 *   supersede — marca a viva `CORRECTION|SWITCHED`; `SWITCHED` re-insere o trecho anterior `[início, validFrom)` (se `validFrom` = início:
 *               `SAME_START_USE_CORRECTION`, recusado AQUI antes do banco); `CORRECTION` troca a linha inteira (sem reinsert); depois INSERT do novo.
 *
 * Nenhum relógio neste arquivo (D-43): o carimbo de tempo é do banco (trigger); a data de início vem do chamador (`asOf` do país).
 * Conversão de `daterange` só por `dateRangeWire.ts`.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { withSerializationRetry } from '@shared/database/withSerializationRetry';
import { fromWire, toWire, reinsertClosed, isSameStart } from '../domain/dateRangeWire';
import { SameStartUseCorrectionError, RangeInvalidError } from '../domain/rangeWriteErrors';

export interface CreateLinkInput {
  contractId: string;
  validFrom: string;
  validTo: string | null;
}

export interface EndLinkInput {
  /** Último dia vigente (INCLUSIVO). */
  validTo: string;
}

export type LinkSupersedeReason = 'CORRECTION' | 'SWITCHED';

export interface SupersedeLinkInput {
  reason: LinkSupersedeReason;
  contractId: string;
  validFrom: string;
  validTo: string | null;
}

abstract class LinkWriteError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;
}

export class ServiceNotFoundForLinkError extends LinkWriteError {
  readonly httpStatus = 404;
  readonly code = 'SERVICE_NOT_FOUND';
  constructor() {
    super('Contracted service not found');
    this.name = 'ServiceNotFoundForLinkError';
  }
}

export class ContractNotFoundForLinkError extends LinkWriteError {
  readonly httpStatus = 404;
  readonly code = 'CONTRACT_NOT_FOUND';
  constructor() {
    super('Insurance contract not found');
    this.name = 'ContractNotFoundForLinkError';
  }
}

/** 404 — `end`/`supersede` sem vínculo vivo no serviço. */
export class NoLiveLinkError extends LinkWriteError {
  readonly httpStatus = 404;
  readonly code = 'NO_LIVE_LINK';
  constructor() {
    super('The service has no live contract link');
    this.name = 'NoLiveLinkError';
  }
}

interface LiveLink {
  id: string;
  contract_id: string;
  valid: string;
}

const LOCK_PATIENT_SQL = `SELECT pg_advisory_xact_lock(hashtext('contract-link:patient:' || $1::uuid::text))`;

const INSERT_LINK_SQL = `INSERT INTO contracted_service_contract (contracted_service_id, contract_id, valid, recorded_by)
                         VALUES ($1, $2, $3, $4)`;

export class ContractedServiceContractLinkWriter {
  private poolMemo?: Pool;

  constructor(private readonly poolProvider?: () => Pool) {}

  private get pool(): Pool {
    this.poolMemo ??= this.poolProvider ? this.poolProvider() : DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /** Posse + lock do paciente. A ordem (posse → lock → leitura da viva) é parte do contrato: a viva só é lida DEPOIS do lock. */
  private async guard(client: PoolClient, patientId: string, serviceId: string): Promise<void> {
    const owner = await client.query(`SELECT 1 FROM patient_contracted_services WHERE id = $1 AND patient_id = $2`, [serviceId, patientId]);
    if (owner.rowCount === 0) throw new ServiceNotFoundForLinkError();
    await client.query(LOCK_PATIENT_SQL, [patientId]);
  }

  private async assertContract(client: PoolClient, contractId: string): Promise<void> {
    const c = await client.query(`SELECT 1 FROM insurance_contracts WHERE id = $1`, [contractId]);
    if (c.rowCount === 0) throw new ContractNotFoundForLinkError();
  }

  /** O vínculo VIVO atual do serviço = o de maior início entre os vivos (o trecho anterior, se houver, também é vivo e fechado). */
  private async liveLink(client: PoolClient, serviceId: string): Promise<LiveLink> {
    const r = await client.query<LiveLink>(
      `SELECT id, contract_id, valid::text AS valid
         FROM contracted_service_contract
        WHERE contracted_service_id = $1 AND superseded_at IS NULL
        ORDER BY valid DESC LIMIT 1 FOR UPDATE`,
      [serviceId],
    );
    if (!r.rows[0]) throw new NoLiveLinkError();
    return r.rows[0];
  }

  private mark(client: PoolClient, linkId: string, reason: 'ENDED' | LinkSupersedeReason, actorUid: string): Promise<unknown> {
    return client.query(`UPDATE contracted_service_contract SET superseded_by = $2, superseded_reason = $3 WHERE id = $1`, [linkId, actorUid, reason]);
  }

  private insert(client: PoolClient, serviceId: string, contractId: string, valid: string, actorUid: string): Promise<unknown> {
    return client.query(INSERT_LINK_SQL, [serviceId, contractId, valid, actorUid]);
  }

  private run<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withSerializationRetry(() => withActorContext(this.pool, fn));
  }

  /** Vínculo NOVO (sem marcar nada na transação): a T1 aplica as regras literais da spec. */
  async create(patientId: string, serviceId: string, input: CreateLinkInput, actorUid: string): Promise<void> {
    await this.run(async (client) => {
      await this.guard(client, patientId, serviceId);
      await this.assertContract(client, input.contractId);
      await this.insert(client, serviceId, input.contractId, fromWire({ validFrom: input.validFrom, validTo: input.validTo }), actorUid);
    });
  }

  /** Encerra o vínculo vivo no `validTo` (inclusivo): marca `ENDED` e re-insere o trecho fechado do mesmo contrato. */
  async end(patientId: string, serviceId: string, input: EndLinkInput, actorUid: string): Promise<void> {
    await this.run(async (client) => {
      await this.guard(client, patientId, serviceId);
      const live = await this.liveLink(client, serviceId);
      const wire = toWire(live.valid);
      if (input.validTo < wire.validFrom || (wire.validTo !== null && input.validTo >= wire.validTo)) throw new RangeInvalidError('LINK_RANGE_INVALID');
      await this.mark(client, live.id, 'ENDED', actorUid);
      await this.insert(client, serviceId, live.contract_id, fromWire({ validFrom: wire.validFrom, validTo: input.validTo }), actorUid);
    });
  }

  /** Troca (`SWITCHED`, só dentro do mesmo pagador) ou corrige (`CORRECTION`, qualquer contrato do país) o vínculo vivo. */
  async supersede(patientId: string, serviceId: string, input: SupersedeLinkInput, actorUid: string): Promise<void> {
    await this.run(async (client) => {
      await this.guard(client, patientId, serviceId);
      await this.assertContract(client, input.contractId);
      const live = await this.liveLink(client, serviceId);
      const wire = toWire(live.valid);
      let reinsert: string | null = null;
      if (input.reason === 'SWITCHED') {
        if (isSameStart(wire.validFrom, input.validFrom)) throw new SameStartUseCorrectionError();
        if (input.validFrom < wire.validFrom || (wire.validTo !== null && input.validFrom > wire.validTo)) throw new RangeInvalidError('LINK_RANGE_INVALID');
        reinsert = reinsertClosed(wire.validFrom, input.validFrom);
      }
      await this.mark(client, live.id, input.reason, actorUid);
      if (reinsert !== null) await this.insert(client, serviceId, live.contract_id, reinsert, actorUid);
      await this.insert(client, serviceId, input.contractId, fromWire({ validFrom: input.validFrom, validTo: input.validTo }), actorUid);
    });
  }
}
