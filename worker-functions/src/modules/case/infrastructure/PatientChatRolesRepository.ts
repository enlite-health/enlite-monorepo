import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { PatientChatRoleSpec } from '../domain/PatientChatRole';

export interface CreateChatRoleInput {
  code: string;
  labelEs: string;
  labelPtBr: string;
  isExclusive: boolean;
  displayOrder: number;
  matchKeywords: string[];
}

export type UpdateChatRoleInput = Partial<Omit<CreateChatRoleInput, 'code'>> & { isActive?: boolean };

/** Um grupo que aparece em MAIS DE UM paciente dentro do mesmo papel. */
export interface SharedGroupConflict {
  chatId: string;
  patientCount: number;
}

const SELECT_COLUMNS = `
  code,
  label_es       AS "labelEs",
  label_pt_br    AS "labelPtBr",
  is_exclusive   AS "isExclusive",
  display_order  AS "displayOrder",
  is_active      AS "isActive",
  match_keywords AS "matchKeywords"`;

/**
 * PatientChatRolesRepository — o CATÁLOGO de papéis (migration 262).
 *
 * É a fonte de verdade da exclusividade. `patient_chat_ids.is_exclusive` é a
 * cópia derivada que alimenta o índice único parcial; quem mantém as duas em
 * sincronia é `updatePolicy`, numa transação só.
 *
 * Sem PII: papel é vocabulário da operação, não dado de pessoa.
 */
export class PatientChatRolesRepository {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  /** Todos os papéis, ativos e inativos, na ordem de exibição. Para a tela de admin. */
  async listAll(): Promise<PatientChatRoleSpec[]> {
    const res = await this.pool.query<PatientChatRoleSpec>(
      `SELECT ${SELECT_COLUMNS} FROM patient_chat_roles ORDER BY display_order, code`,
    );
    return res.rows;
  }

  /** Só os ativos — o que a ficha do paciente mostra e o que se pode gravar. */
  async listActive(): Promise<PatientChatRoleSpec[]> {
    const res = await this.pool.query<PatientChatRoleSpec>(
      `SELECT ${SELECT_COLUMNS} FROM patient_chat_roles WHERE is_active ORDER BY display_order, code`,
    );
    return res.rows;
  }

  async findByCode(code: string): Promise<PatientChatRoleSpec | null> {
    const res = await this.pool.query<PatientChatRoleSpec>(
      `SELECT ${SELECT_COLUMNS} FROM patient_chat_roles WHERE code = $1`,
      [code],
    );
    return res.rows[0] ?? null;
  }

  async create(input: CreateChatRoleInput): Promise<PatientChatRoleSpec> {
    const res = await this.pool.query<PatientChatRoleSpec>(
      `INSERT INTO patient_chat_roles
         (code, label_es, label_pt_br, is_exclusive, display_order, match_keywords)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.code,
        input.labelEs,
        input.labelPtBr,
        input.isExclusive,
        input.displayOrder,
        input.matchKeywords,
      ],
    );
    return res.rows[0];
  }

  /**
   * Atualiza o papel E, na MESMA transação, a cópia derivada nas linhas de
   * vínculo já gravadas.
   *
   * Sem isso, virar a política deixaria `patient_chat_ids.is_exclusive` mentindo
   * para o índice parcial: o papel passaria a ser compartilhável na tela e
   * continuaria trancado no banco (ou o contrário, que é pior — deixaria de
   * trancar sem ninguém saber).
   */
  async update(code: string, input: UpdateChatRoleInput): Promise<PatientChatRoleSpec | null> {
    const sets: string[] = [];
    const values: unknown[] = [code];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (input.labelEs !== undefined) push('label_es', input.labelEs);
    if (input.labelPtBr !== undefined) push('label_pt_br', input.labelPtBr);
    if (input.isExclusive !== undefined) push('is_exclusive', input.isExclusive);
    if (input.displayOrder !== undefined) push('display_order', input.displayOrder);
    if (input.isActive !== undefined) push('is_active', input.isActive);
    if (input.matchKeywords !== undefined) push('match_keywords', input.matchKeywords);

    if (sets.length === 0) return this.findByCode(code);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query<PatientChatRoleSpec>(
        `UPDATE patient_chat_roles
            SET ${sets.join(', ')}, updated_at = NOW()
          WHERE code = $1
        RETURNING ${SELECT_COLUMNS}`,
        values,
      );

      if (res.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      if (input.isExclusive !== undefined) {
        await client.query(
          `UPDATE patient_chat_ids
              SET is_exclusive = $2, updated_at = NOW()
            WHERE role = $1 AND is_exclusive IS DISTINCT FROM $2`,
          [code, input.isExclusive],
        );
      }

      await client.query('COMMIT');
      return res.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Remove o papel do catálogo. Só é chamado quando `countUsage` deu zero. */
  async delete(code: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM patient_chat_roles WHERE code = $1', [code]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Quantos PACIENTES (não apagados) usam este papel hoje. */
  async countUsage(code: string, client?: PoolClient): Promise<number> {
    const runner = client ?? this.pool;
    const res = await runner.query<{ n: string }>(
      `SELECT COUNT(DISTINCT ci.patient_id)::text AS n
         FROM patient_chat_ids ci
         JOIN patients p ON p.id = ci.patient_id
        WHERE ci.role = $1 AND p.deleted_at IS NULL`,
      [code],
    );
    return Number(res.rows[0].n);
  }

  /**
   * Grupos que hoje pertencem a MAIS DE UM paciente dentro deste papel.
   *
   * É a pergunta que decide se dá para virar um papel de compartilhado para
   * exclusivo. Se voltar não-vazio, a virada tem de ser recusada COM a
   * contagem — deixar bater no índice único devolveria um 23505 sem explicação,
   * e "resolver" escolhendo um vencedor sozinho é escolher qual paciente perde
   * o vínculo, o que não é decisão de software.
   */
  async findSharedGroups(code: string): Promise<SharedGroupConflict[]> {
    const res = await this.pool.query<{ chatId: string; patientCount: string }>(
      `SELECT ci.chat_id AS "chatId", COUNT(DISTINCT ci.patient_id)::text AS "patientCount"
         FROM patient_chat_ids ci
         JOIN patients p ON p.id = ci.patient_id
        WHERE ci.role = $1 AND p.deleted_at IS NULL
        GROUP BY ci.chat_id
       HAVING COUNT(DISTINCT ci.patient_id) > 1
        ORDER BY ci.chat_id`,
      [code],
    );
    return res.rows.map(r => ({ chatId: r.chatId, patientCount: Number(r.patientCount) }));
  }
}
