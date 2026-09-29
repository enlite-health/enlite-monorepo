/**
 * ContractedServiceProviderRepository — leitura do histórico da alocação anterior ao itinerário
 * (migration 319, spec 013, lex C-e). Desde a Fase 14 nenhuma rota escreve aqui: a alocação
 * nova é pela aba do itinerário; as linhas antigas só são lidas (ficha do serviço).
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
}
