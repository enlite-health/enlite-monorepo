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

/**
 * O que `updateChecked` devolve — o serviço traduz `outcome` no erro de
 * domínio certo. A infra não precisa (nem deve) conhecer os tipos de erro do
 * `PatientChatRolesService`; devolver um resultado tipado mantém a fronteira.
 */
export type UpdateCheckedResult =
  | { outcome: 'not_found' }
  | { outcome: 'exclusivity_conflict'; conflicts: SharedGroupConflict[] }
  | { outcome: 'in_use'; patientCount: number }
  | { outcome: 'updated'; role: PatientChatRoleSpec };

/** O que `deleteChecked` devolve — mesmo espírito de `UpdateCheckedResult`. */
export type DeleteCheckedResult =
  | { outcome: 'not_found' }
  | { outcome: 'in_use'; patientCount: number }
  | { outcome: 'deleted' };

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

  async findByCode(code: string, client?: PoolClient): Promise<PatientChatRoleSpec | null> {
    const runner = client ?? this.pool;
    const res = await runner.query<PatientChatRoleSpec>(
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
    const { sets, values } = buildUpdateSets(code, input);
    if (sets.length === 0) return this.findByCode(code);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const role = await this.writeUpdate(code, input, sets, values, client);
      if (role === null) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      return role;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * update() acima faz seu PRÓPRIO BEGIN/COMMIT; até 11/08 as duas travas do
   * serviço (TRAVA 1 exclusividade, TRAVA 2 uso) rodavam antes disso, numa
   * consulta em conexão SEPARADA — janela TOCTOU real: outro processo podia
   * inserir um conflito entre o check e este write (achado de review, 11/08).
   *
   * `updateChecked` reúne check + write num client só: abre a transação, roda
   * as MESMAS duas travas que o serviço rodava, e só então grava — tudo antes
   * do COMMIT. Devolve um resultado com `outcome` para o serviço decidir qual
   * erro lançar, sem a infra precisar conhecer os tipos de erro do domínio.
   */
  async updateChecked(code: string, input: UpdateChatRoleInput): Promise<UpdateCheckedResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const current = await this.findByCode(code, client);
      if (!current) {
        await client.query('ROLLBACK');
        return { outcome: 'not_found' };
      }

      // TRAVA 1 — compartilhado → exclusivo
      if (input.isExclusive === true && !current.isExclusive) {
        const conflicts = await this.findSharedGroups(code, client);
        if (conflicts.length > 0) {
          await client.query('ROLLBACK');
          return { outcome: 'exclusivity_conflict', conflicts };
        }
      }

      // TRAVA 2 — desativar papel em uso
      if (input.isActive === false && current.isActive) {
        const patientCount = await this.countUsage(code, client);
        if (patientCount > 0) {
          await client.query('ROLLBACK');
          return { outcome: 'in_use', patientCount };
        }
      }

      const { sets, values } = buildUpdateSets(code, input);
      if (sets.length === 0) {
        // Body só com campos que não mudam nada gravável (não deveria acontecer
        // — o schema exige ao menos um campo — mas defensivo: não abre UPDATE vazio).
        await client.query('COMMIT');
        return { outcome: 'updated', role: current };
      }

      const role = await this.writeUpdate(code, input, sets, values, client);
      if (role === null) {
        await client.query('ROLLBACK');
        return { outcome: 'not_found' };
      }
      await client.query('COMMIT');
      return { outcome: 'updated', role };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** O UPDATE em si + a sincronização da coluna derivada, dado um client já em transação. */
  private async writeUpdate(
    code: string,
    input: UpdateChatRoleInput,
    sets: string[],
    values: unknown[],
    client: PoolClient,
  ): Promise<PatientChatRoleSpec | null> {
    const res = await client.query<PatientChatRoleSpec>(
      `UPDATE patient_chat_roles
          SET ${sets.join(', ')}, updated_at = NOW()
        WHERE code = $1
      RETURNING ${SELECT_COLUMNS}`,
      values,
    );

    if (res.rows.length === 0) return null;

    if (input.isExclusive !== undefined) {
      await client.query(
        `UPDATE patient_chat_ids
            SET is_exclusive = $2, updated_at = NOW()
          WHERE role = $1 AND is_exclusive IS DISTINCT FROM $2`,
        [code, input.isExclusive],
      );
    }

    return res.rows[0];
  }

  /** Remove o papel do catálogo. Só é chamado quando `countUsage` deu zero. */
  async delete(code: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM patient_chat_roles WHERE code = $1', [code]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * `delete()` acima é uma query só, sem transação — a checagem de uso (TRAVA 2)
   * rodava antes, em outra conexão: mesma janela TOCTOU de `updateChecked`.
   * `deleteChecked` reúne check + delete no MESMO client.
   */
  async deleteChecked(code: string): Promise<DeleteCheckedResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const current = await this.findByCode(code, client);
      if (!current) {
        await client.query('ROLLBACK');
        return { outcome: 'not_found' };
      }

      const patientCount = await this.countUsage(code, client);
      if (patientCount > 0) {
        await client.query('ROLLBACK');
        return { outcome: 'in_use', patientCount };
      }

      const res = await client.query('DELETE FROM patient_chat_roles WHERE code = $1', [code]);
      if ((res.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return { outcome: 'not_found' };
      }

      await client.query('COMMIT');
      return { outcome: 'deleted' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Quantos PACIENTES usam este papel hoje — INCLUINDO os soft-deleted.
   *
   * ⚠️ Até 11/08 filtrava `p.deleted_at IS NULL` (achado de review): um papel
   * usado SÓ por pacientes já soft-deleted contava 0 e podia ser apagado do
   * catálogo com linhas de `patient_chat_ids` ainda existindo (não há FK entre
   * `patient_chat_ids.role` e este catálogo — nada além desta contagem impedia).
   * A migration 263 passou a liberar (deletar) as linhas de `patient_chat_ids`
   * no MOMENTO do soft-delete do paciente — então a contagem certa aqui é
   * simplesmente TODAS as linhas do papel, sem depender do estado do paciente.
   */
  async countUsage(code: string, client?: PoolClient): Promise<number> {
    const runner = client ?? this.pool;
    const res = await runner.query<{ n: string }>(
      `SELECT COUNT(DISTINCT patient_id)::text AS n
         FROM patient_chat_ids
        WHERE role = $1`,
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
  async findSharedGroups(code: string, client?: PoolClient): Promise<SharedGroupConflict[]> {
    const runner = client ?? this.pool;
    const res = await runner.query<{ chatId: string; patientCount: string }>(
      // O índice que esta trava protege (`idx_patient_chat_ids_exclusive_chat`) é
      // GLOBAL sobre chat_id, parcial só em `WHERE is_exclusive` — ele não olha o
      // papel. Filtrar por `role = $1` media a coisa errada: um grupo dividido
      // entre DOIS papéis compartilhados de pacientes diferentes passava na
      // checagem (dentro do papel havia só 1 paciente), virava exclusivo, e criava
      // justamente a contagem dupla que esta flag existe para impedir — ou
      // estourava 23505 na virada seguinte, caindo no 500 genérico em vez do 409
      // com a contagem.
      //
      // A pergunta certa é: depois da virada, que chat_ids ficariam exclusivos em
      // mais de um paciente? O universo é (linhas deste papel) ∪ (linhas já
      // exclusivas), porque são essas que o índice parcial passa a enxergar.
      `WITH would_be_exclusive AS (
         SELECT ci.chat_id, ci.patient_id
           FROM patient_chat_ids ci
           JOIN patients p ON p.id = ci.patient_id
          WHERE p.deleted_at IS NULL
            AND (ci.role = $1 OR ci.is_exclusive)
       )
       SELECT chat_id AS "chatId", COUNT(DISTINCT patient_id)::text AS "patientCount"
         FROM would_be_exclusive
        GROUP BY chat_id
       HAVING COUNT(DISTINCT patient_id) > 1
        ORDER BY chat_id`,
      [code],
    );
    return res.rows.map(r => ({ chatId: r.chatId, patientCount: Number(r.patientCount) }));
  }
}

/**
 * Monta o `SET` do UPDATE só com os campos mandados. Módulo-level (não método)
 * porque é usada tanto por `update()` quanto por `updateChecked()`, e as duas
 * precisam do resultado ANTES de decidir se abrem transação — uma função pura
 * evita duplicar a lista de campos duas vezes.
 */
function buildUpdateSets(
  code: string,
  input: UpdateChatRoleInput,
): { sets: string[]; values: unknown[] } {
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

  return { sets, values };
}
