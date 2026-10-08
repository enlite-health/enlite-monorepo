/**
 * deletePatientAddress — remover uma Localización do paciente (spec 044, D4).
 *
 * Regra do Gabriel: só remove se NENHUMA vaga (qualquer status, inclusive fechada e soft-deleted) e NENHUM
 * serviço contratado (ativo ou não) apontar para o endereço. As contagens NÃO filtram status nem `deleted_at`:
 * `job_postings.deleted_at` não libera a FK 149 (RESTRICT) e a FK 330 de serviço não tem ON DELETE.
 *
 * Uma transação (`withActorContext`, D95):
 *   1. SELECT ... FOR UPDATE da linha viva do paciente → nada: `not_found`.
 *   2. É o Principal e existe OUTRO endereço ativo → `primary_with_others` (marcar outro primeiro).
 *   3. Conta vagas e serviços, sem filtro → >0: `in_use` com os números (só números, sem PII).
 *   4. DELETE físico + linha de auditoria SEM texto, na MESMA transação (sem trilha, não há DELETE).
 *   5. Corrida (vaga criada entre a contagem e o DELETE): o `23503` da FK vira `in_use`. A FK é a última barreira.
 * Remover o último endereço é permitido (a completude `ADDRESS` volta a acusar).
 *
 * PII: nenhuma consulta daqui devolve nem loga o texto do endereço.
 */
import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { PatientAddressAuditRepository, buildAddressDeletedChanges } from './PatientAddressAuditRepository';

export type DeletePatientAddressOutcome =
  | { kind: 'deleted' }
  | { kind: 'not_found' }
  | { kind: 'primary_with_others' }
  | { kind: 'in_use'; vacancies: number; services: number };

export interface DeletePatientAddressInput {
  patientId: string;
  addressId: string;
  /** firebase_uid de quem removeu (vai para a trilha). */
  actorUserId: string | null;
  traceId?: string | null;
}

const PG_FOREIGN_KEY_VIOLATION = '23503';
const audit = new PatientAddressAuditRepository();

async function countReferences(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ vacancies: number; services: number }> }> },
  addressId: string,
): Promise<{ vacancies: number; services: number }> {
  const { rows } = await client.query(
    `SELECT (SELECT count(*)::int FROM job_postings WHERE patient_address_id = $1) AS vacancies,
            (SELECT count(*)::int FROM patient_contracted_services WHERE address_id = $1) AS services`,
    [addressId],
  );
  return { vacancies: rows[0].vacancies, services: rows[0].services };
}

export async function deletePatientAddress(
  pool: Pool,
  input: DeletePatientAddressInput,
): Promise<DeletePatientAddressOutcome> {
  try {
    return await withActorContext<DeletePatientAddressOutcome>(pool, async (client) => {
      const found = await client.query<{ id: string; address_type: string | null; neighborhood: string | null; is_default: boolean }>(
        `SELECT id, address_type, neighborhood, is_default
           FROM patient_addresses
          WHERE id = $1 AND patient_id = $2 AND archived_at IS NULL
          FOR UPDATE`,
        [input.addressId, input.patientId],
      );
      const row = found.rows[0];
      if (!row) return { kind: 'not_found' };

      if (row.is_default) {
        const others = await client.query(
          `SELECT 1 FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL AND id <> $2 LIMIT 1`,
          [input.patientId, input.addressId],
        );
        if ((others.rowCount ?? 0) > 0) return { kind: 'primary_with_others' };
      }

      const refs = await countReferences(client, input.addressId);
      if (refs.vacancies > 0 || refs.services > 0) return { kind: 'in_use', ...refs };

      await client.query(`DELETE FROM patient_addresses WHERE id = $1 AND patient_id = $2`, [input.addressId, input.patientId]);
      await audit.logDeleted(client, {
        patientId: input.patientId,
        changes: buildAddressDeletedChanges(row),
        actorUserId: input.actorUserId,
        traceId: input.traceId ?? null,
      });
      return { kind: 'deleted' };
    });
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== PG_FOREIGN_KEY_VIOLATION) throw err;
    // Corrida: alguém apontou uma vaga/serviço para o endereço entre a contagem e o DELETE. A transação
    // já voltou atrás (nada foi apagado nem auditado); recontamos em transação nova para devolver os números.
    // 23503 também é o que a FK do ATOR da auditoria (users) levanta: se a recontagem não acha referência,
    // o erro NÃO é de uso — sobe como veio (500), nunca vira um 409 falso.
    const refs = await withActorContext(pool, (client) => countReferences(client, input.addressId));
    if (refs.vacancies === 0 && refs.services === 0) throw err;
    return { kind: 'in_use', ...refs };
  }
}
