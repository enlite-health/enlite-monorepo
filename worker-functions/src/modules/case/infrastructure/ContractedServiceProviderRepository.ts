/**
 * ContractedServiceProviderRepository — prestador(es) alocado(s) num serviço contratado
 * (migration 319, spec 013, lex C-e).
 *
 * Sem rota DELETE (C-e.2): baixa é `active=false` + `ended_at`. Reassociar o MESMO
 * (serviço, worker) depois de uma baixa cria linha NOVA — o índice único parcial
 * (`uq_contracted_service_providers_active_pair`) só impede duas linhas ATIVAS ao mesmo tempo;
 * histórico de alocações passadas fica intacto.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

export interface ContractedServiceProviderDetail {
  id: string;
  serviceId: string;
  workerId: string;
  /** Nome descriptografado (KMS) — exibição na ficha do serviço, mesmo nível de acesso de staff. */
  workerName: string | null;
  weeklyHours: number | null;
  active: boolean;
  endedAt: string | null;
  country: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssociateProviderInput {
  serviceId: string;
  workerId: string;
  weeklyHours?: number | null;
  country?: 'AR' | 'BR' | null;
  actorUid: string;
}

export interface UpdateProviderInput {
  weeklyHours?: number | null;
  /** Só `false` é um caminho válido (baixa) — o controller nunca envia `true` (C-e.2). */
  active?: boolean;
  actorUid: string;
}

export class ProviderAlreadyActiveError extends Error {
  readonly code = 'PROVIDER_ALREADY_ACTIVE';
  constructor(
    readonly serviceId: string,
    readonly workerId: string,
  ) {
    super(`Worker ${workerId} already actively allocated to service ${serviceId}`);
    this.name = 'ProviderAlreadyActiveError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

interface ProviderRow {
  id: string;
  service_id: string;
  worker_id: string;
  weekly_hours: string | null;
  active: boolean;
  ended_at: string | null;
  country: string;
  created_at: string;
  updated_at: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

export class ContractedServiceProviderRepository {
  private poolMemo?: Pool;

  constructor(private readonly enc: KMSEncryptionService = new KMSEncryptionService()) {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  private async decorate(rows: ProviderRow[]): Promise<ContractedServiceProviderDetail[]> {
    return Promise.all(
      rows.map(async (r) => {
        const [first, last] = await Promise.all([
          this.enc.decrypt(r.first_name_encrypted ?? ''),
          this.enc.decrypt(r.last_name_encrypted ?? ''),
        ]);
        const workerName = [first, last].filter((s) => s && s.length > 0).join(' ') || null;
        return {
          id: r.id,
          serviceId: r.service_id,
          workerId: r.worker_id,
          workerName,
          weeklyHours: r.weekly_hours != null ? Number(r.weekly_hours) : null,
          active: r.active,
          endedAt: r.ended_at,
          country: r.country,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      }),
    );
  }

  /** Todos os prestadores (ativos e inativos — histórico) de um serviço, ativos primeiro. */
  async listForService(serviceId: string): Promise<ContractedServiceProviderDetail[]> {
    const { rows } = await this.pool.query<ProviderRow>(
      `SELECT csp.id, csp.service_id, csp.worker_id, csp.weekly_hours, csp.active, csp.ended_at,
              csp.country, csp.created_at, csp.updated_at,
              w.first_name_encrypted, w.last_name_encrypted
         FROM contracted_service_providers csp
         JOIN workers w ON w.id = csp.worker_id
        WHERE csp.service_id = $1
        ORDER BY csp.active DESC, csp.created_at ASC`,
      [serviceId],
    );
    return this.decorate(rows);
  }

  /** Associa um worker existente ao serviço. Duplicar um par ATIVO → ProviderAlreadyActiveError. */
  async associate(input: AssociateProviderInput): Promise<ContractedServiceProviderDetail> {
    let inserted: { id: string };
    try {
      const ins = await this.pool.query<{ id: string }>(
        `INSERT INTO contracted_service_providers
           (service_id, worker_id, weekly_hours, country, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING id`,
        [input.serviceId, input.workerId, input.weeklyHours ?? null, input.country ?? null, input.actorUid],
      );
      inserted = ins.rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) throw new ProviderAlreadyActiveError(input.serviceId, input.workerId);
      throw err;
    }
    const [detail] = await this.decorate(
      (
        await this.pool.query<ProviderRow>(
          `SELECT csp.id, csp.service_id, csp.worker_id, csp.weekly_hours, csp.active, csp.ended_at,
                  csp.country, csp.created_at, csp.updated_at,
                  w.first_name_encrypted, w.last_name_encrypted
             FROM contracted_service_providers csp
             JOIN workers w ON w.id = csp.worker_id
            WHERE csp.id = $1`,
          [inserted.id],
        )
      ).rows,
    );
    return detail;
  }

  /** `weeklyHours` e/ou baixa (`active:false` → grava `ended_at`). Nunca reabre (C-e.2). */
  async update(providerId: string, patch: UpdateProviderInput): Promise<ContractedServiceProviderDetail | null> {
    const sets: string[] = [];
    const params: unknown[] = [providerId];
    if (patch.weeklyHours !== undefined) {
      params.push(patch.weeklyHours);
      sets.push(`weekly_hours = $${params.length}`);
    }
    if (patch.active !== undefined) {
      params.push(patch.active);
      sets.push(`active = $${params.length}`);
      sets.push(patch.active ? 'ended_at = NULL' : 'ended_at = NOW()');
    }
    if (sets.length === 0) {
      const existing = await this.pool.query<ProviderRow>(
        `SELECT csp.id, csp.service_id, csp.worker_id, csp.weekly_hours, csp.active, csp.ended_at,
                csp.country, csp.created_at, csp.updated_at,
                w.first_name_encrypted, w.last_name_encrypted
           FROM contracted_service_providers csp
           JOIN workers w ON w.id = csp.worker_id
          WHERE csp.id = $1`,
        [providerId],
      );
      if (existing.rows.length === 0) return null;
      const [detail] = await this.decorate(existing.rows);
      return detail;
    }
    params.push(patch.actorUid);
    sets.push(`updated_by = $${params.length}`);
    sets.push('updated_at = NOW()');
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE contracted_service_providers SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
      params,
    );
    if (rows.length === 0) return null;
    const full = await this.pool.query<ProviderRow>(
      `SELECT csp.id, csp.service_id, csp.worker_id, csp.weekly_hours, csp.active, csp.ended_at,
              csp.country, csp.created_at, csp.updated_at,
              w.first_name_encrypted, w.last_name_encrypted
         FROM contracted_service_providers csp
         JOIN workers w ON w.id = csp.worker_id
        WHERE csp.id = $1`,
      [providerId],
    );
    const [detail] = await this.decorate(full.rows);
    return detail ?? null;
  }
}
