/**
 * ServiceTeamContactLogRepository — quadro C (Servicio Contratado), modal do prestador (Figma,
 * rodada 2, decisão D). Lê/grava `service_team_contact_log` (migration 490) e busca os campos
 * cifrados do prestador que o modal precisa projetar (nome/telefone, via `projectWorkerFields`,
 * chamado pelo use case — este arquivo só entrega a linha CIFRADA, nunca decripta).
 *
 * Append-only (molde 481): `insert` sempre cria linha nova; não há `update`/`delete` aqui — a
 * tabela não concede esses privilégios ao app (REVOKE na 490).
 */
import type { PoolClient } from 'pg';

export interface ServiceTeamContactLogRow {
  id: string;
  serviceId: string;
  workerId: string;
  contacted: boolean;
  eventDate: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface InsertContactLogInput {
  serviceId: string;
  workerId: string;
  contacted: boolean;
  eventDate: string;
  note: string | null;
  actorUid: string;
}

export interface WorkerContactRow {
  id: string;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

interface ContactLogSqlRow {
  id: string;
  service_id: string;
  worker_id: string;
  contacted: boolean;
  event_date: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

export class ServiceTeamContactLogRepository {
  /** Histórico do par (serviço × prestador), mais recente primeiro — o "Historial" do modal. */
  async listForPair(client: PoolClient, serviceId: string, workerId: string): Promise<ServiceTeamContactLogRow[]> {
    const res = await client.query<ContactLogSqlRow>(
      `SELECT id, service_id, worker_id, contacted, to_char(event_date, 'YYYY-MM-DD') AS event_date,
              note, created_by, created_at
         FROM service_team_contact_log
        WHERE service_id = $1 AND worker_id = $2
        ORDER BY created_at DESC`,
      [serviceId, workerId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      serviceId: r.service_id,
      workerId: r.worker_id,
      contacted: r.contacted,
      eventDate: r.event_date,
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  /** Linha nova sempre (append-only — a tabela É o histórico, nunca reescrita). */
  async insert(client: PoolClient, input: InsertContactLogInput): Promise<void> {
    await client.query(
      `INSERT INTO service_team_contact_log (service_id, worker_id, contacted, event_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.serviceId, input.workerId, input.contacted, input.eventDate, input.note, input.actorUid],
    );
  }

  /**
   * Os campos CIFRADOS do prestador (nome/whatsapp) — quem decripta é o use case, via
   * `projectWorkerFields` (a célula decide ANTES do KMS, C3). `null` = worker inexistente (não
   * deveria acontecer se ele já apareceu no time — o use case trata como not-found).
   */
  async getWorkerContactRow(client: PoolClient, workerId: string): Promise<WorkerContactRow | null> {
    const res = await client.query<{
      id: string;
      first_name_encrypted: string | null;
      last_name_encrypted: string | null;
    }>(
      `SELECT id, first_name_encrypted, last_name_encrypted
         FROM workers WHERE id = $1`,
      [workerId],
    );
    if ((res.rowCount ?? 0) === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      firstNameEncrypted: row.first_name_encrypted,
      lastNameEncrypted: row.last_name_encrypted,
    };
  }
}
