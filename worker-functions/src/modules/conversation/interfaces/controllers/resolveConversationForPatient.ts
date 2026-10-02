/**
 * resolveConversationForPatient — glue T119/T120 precisam para ir de `:id` (patientId) na URL
 * até o `conversationId` que `PostMessageUseCase`/`ListConversationUseCase`/
 * `MarkConversationReadUseCase` (T110/T112/T117) recebem. Nenhuma task anterior do Bloco 1
 * criou esse lookup — `conversations` (mig 458) é 1:1 com `patients` (`UNIQUE(patient_id)`), e o
 * "canal" nasce sob demanda na PRIMEIRA mensagem/leitura, não numa migration de seed.
 *
 * Molde: `patientExistsCheck.ts` (`case/interfaces/controllers/`) — mesmo padrão (`Pool` direto,
 * SEM KMS, SEM regra de negócio) para a MESMA classe de checagem simples que aquele helper faz;
 * não foi reusado literal porque não é exportado pelo barrel de `@modules/case` (fronteira de
 * módulo) e a cópia byte-a-byte criaria a MESMA duplicação que aquele arquivo documenta ter
 * evitado dentro do próprio `case`.
 *
 * `conversations` só tem GRANT `SELECT, INSERT` (mig 458, de propósito — nunca UPDATE) — por
 * isso o get-or-create é SELECT → INSERT ... ON CONFLICT (patient_id) DO NOTHING → SELECT de
 * novo se perdeu a corrida (nunca `ON CONFLICT DO UPDATE`, que exigiria privilégio de UPDATE).
 *
 * ⚠️ Achado do gate revisao-pr (Bloco 1, Tarefa 2): o INSERT (e o SELECT de corrida que o segue)
 * rodam dentro de `withActorContext` (`@shared/database/actorContext`) — nunca em `db.query` cru.
 * A policy de RLS de `conversations` (mig 458, `FOR ALL`) vale como `WITH CHECK` do INSERT: sem o
 * contexto do ator carimbado na transação, a política cai no caminho fail-closed e o INSERT
 * derruba com erro de RLS (500 mudo). O primeiro SELECT (get) segue em `db.query` direto — esse
 * já é roteado pela sessão da request (`rlsAwarePool`/`requestDbSession`, GUCs de sessão) e é só
 * LEITURA, sem WITH CHECK a satisfazer.
 */
import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';

export interface ConversationForPatientLookup {
  patientExists: boolean;
  conversationId: string | null;
}

export async function resolveConversationForPatient(db: Pool, patientId: string): Promise<ConversationForPatientLookup> {
  const { rows } = await db.query<{ patientId: string; conversationId: string | null }>(
    `SELECT p.id AS "patientId", c.id AS "conversationId"
       FROM patients p
       LEFT JOIN conversations c ON c.patient_id = p.id
      WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [patientId],
  );
  if (rows.length === 0) return { patientExists: false, conversationId: null };
  if (rows[0].conversationId) return { patientExists: true, conversationId: rows[0].conversationId };

  return withActorContext(db, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO conversations (patient_id) VALUES ($1)
         ON CONFLICT (patient_id) DO NOTHING
       RETURNING id`,
      [patientId],
    );
    if (inserted.rows[0]) return { patientExists: true, conversationId: inserted.rows[0].id };

    // Corrida: outra request criou a conversa entre o SELECT e o INSERT — relê, MESMO client
    // (já carimbado com o contexto do ator; um `db.query` novo aqui reabriria o mesmo risco).
    const retry = await client.query<{ id: string }>(`SELECT id FROM conversations WHERE patient_id = $1`, [patientId]);
    return { patientExists: true, conversationId: retry.rows[0]?.id ?? null };
  });
}
