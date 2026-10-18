/**
 * ContractedServiceAuthorizationRepository — leitura/escrita de `contracted_service_authorization` (migration 529, spec 056).
 *
 * Toda escrita passa por `withActorContext` (transação + RLS + carimbo do ator; `connect()` cru dá 500 sob RLS).
 * Corrigir = `supersede`: UPDATE da antiga e INSERT da nova NA MESMA transação (o EXCLUDE parcial só vê linhas
 * correntes). `valid` é gravado `[)`: `validTo` inclusivo da API vira `upper = validTo + 1 dia` (domínio).
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import {
  AuthorizationNotFoundError,
  AuthorizationOverlapsError,
  exclusiveUpperOf,
  inclusiveValidToOf,
  type AuthorizationView,
} from '../domain/ContractedServiceAuthorization';

export interface AuthorizationWrite {
  serviceId: string;
  hours: number;
  validFrom: string;
  validTo: string;
  actorUid: string;
}

interface AuthorizationRow {
  id: string;
  hours: string;
  valid_from: string;
  valid_upper: string;
  recorded_at: Date;
  recorded_by: string;
  superseded_at: Date | null;
}

const RETURNING = `id, hours::text AS hours, lower(valid)::text AS valid_from, upper(valid)::text AS valid_upper,
                   recorded_at, recorded_by, superseded_at`;

function toView(r: AuthorizationRow): AuthorizationView {
  return {
    id: r.id,
    hours: Number(r.hours),
    validFrom: r.valid_from,
    validTo: inclusiveValidToOf(r.valid_upper),
    recordedAt: r.recorded_at.toISOString(),
    recordedBy: r.recorded_by,
    supersededAt: r.superseded_at ? r.superseded_at.toISOString() : null,
  };
}

async function insertRow(cli: PoolClient, w: AuthorizationWrite): Promise<AuthorizationView> {
  try {
    const { rows } = await cli.query<AuthorizationRow>(
      `INSERT INTO contracted_service_authorization (contracted_service_id, hours, valid, recorded_by)
       VALUES ($1, $2, daterange($3::date, $4::date, '[)'), $5)
       RETURNING ${RETURNING}`,
      [w.serviceId, w.hours, w.validFrom, exclusiveUpperOf(w.validTo), w.actorUid],
    );
    return toView(rows[0]);
  } catch (err: unknown) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23P01' && e.constraint === 'csa_sem_sobreposicao') throw new AuthorizationOverlapsError();
    throw err;
  }
}

export class ContractedServiceAuthorizationRepository {
  private poolMemo?: Pool;
  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /** O serviço existe e é deste paciente? (outro paciente/inexistente = false → 404). */
  async serviceBelongsToPatient(patientId: string, serviceId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM patient_contracted_services WHERE id = $2 AND patient_id = $1`,
      [patientId, serviceId],
    );
    return rows.length > 0;
  }

  async list(serviceId: string): Promise<AuthorizationView[]> {
    const { rows } = await this.pool.query<AuthorizationRow>(
      `SELECT ${RETURNING} FROM contracted_service_authorization
        WHERE contracted_service_id = $1
        ORDER BY lower(valid) DESC, recorded_at DESC`,
      [serviceId],
    );
    return rows.map(toView);
  }

  async create(w: AuthorizationWrite): Promise<AuthorizationView> {
    return withActorContext(this.pool, (cli) => insertRow(cli, w));
  }

  /** Fecha a corrente `authorizationId` e grava a nova na mesma transação. 0 linhas no UPDATE → NotFound (nada é inserido). */
  async supersede(authorizationId: string, w: AuthorizationWrite): Promise<AuthorizationView> {
    return withActorContext(this.pool, async (cli) => {
      const upd = await cli.query(
        `UPDATE contracted_service_authorization SET superseded_at = now()
          WHERE id = $1 AND contracted_service_id = $2 AND superseded_at IS NULL`,
        [authorizationId, w.serviceId],
      );
      if (upd.rowCount === 0) throw new AuthorizationNotFoundError();
      return insertRow(cli, w);
    });
  }
}
