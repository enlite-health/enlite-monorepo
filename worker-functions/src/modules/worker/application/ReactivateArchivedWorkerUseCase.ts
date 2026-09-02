/**
 * src/modules/worker/application/ReactivateArchivedWorkerUseCase.ts
 *
 * Desfaz, quando o prestador dá sinal de vida, um arquivamento que foi ERRO NOSSO.
 *
 * O incidente que originou isto (02/09/2026, D245): o arquivamento em massa de 10/08 mediu a
 * antiguidade do REGISTRO (`encuadres.recruitment_date`) e não a atividade da PESSOA. Resultado —
 * a entrada ficou aberta e a saída fechada: `activeWorkerFilter` esconde `DISABLED` de 14 pontos de
 * leitura da operação (kanban, candidatos, export, dashboard…), mas o app do prestador segue
 * funcionando. 32 pessoas mexeram no próprio cadastro enquanto estavam invisíveis; 8 chegaram a
 * entregar documentação que ninguém veria. Dois casos viraram chamado do time no mesmo dia.
 *
 * A trava que importa é a PRIMEIRA: nem todo `DISABLED` é erro nosso. Medido em produção no dia da
 * escrita — entre os workers `DISABLED`, a última transição veio de `system:bulk-archive-stale-…`
 * (3.763) e `system:redisable-30d-cut-…` (55), mas também de `luz:baja-cuenta` (3) e
 * `lgpd:baja-solicitada:…` (1). **Essas 4 pediram para sair.** Reativá-las por terem logado seria
 * reverter a vontade do titular (Ley 25.326 art. 27 inc. 3) — o oposto do que este arquivo existe
 * para fazer.
 */

import type { Pool } from 'pg';
import type { WorkerStatus } from '../domain/Worker';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { reportError } from '@shared/logging';

/** Job desta reativação. Vira `worker_status_history.changed_by` = `system:<isto>`. */
export const REACTIVATION_JOB = 'reactivacion-por-actividad';

/**
 * Estado restaurado. Constante, não lookup: medido em produção, os 3.818 workers arquivados por
 * ato administrativo estavam TODOS em `INCOMPLETE_REGISTER` antes. Promover a `REGISTERED` seria
 * barrado por `fn_guard_registered_status` de qualquer forma — e falhar no meio de um request do
 * prestador é pior que não promover.
 */
const RESTORED_STATUS: WorkerStatus = 'INCOMPLETE_REGISTER';

/**
 * Allow-list explícita — NÃO prefixo `system:%`.
 *
 * `worker_status_history.changed_by` é `VARCHAR(128)` livre, preenchido por
 * `current_setting('app.current_uid')` sem CHECK nenhum: o prefixo é convenção de quem escreveu
 * cada caminho de baixa, não garantia do banco. Com prefixo, um caminho FUTURO de baixa a pedido
 * que grave `system:…` por descuido passaria a reverter a vontade do titular em silêncio. Com
 * allow-list, o padrão é não reativar, e um lote administrativo novo só entra aqui depois de
 * alguém classificá-lo. Falha fechada por construção.
 */
const REVERSIBLE_ARCHIVAL_JOBS = [
  'system:bulk-archive-stale-2026-01-30',
  'system:redisable-30d-cut-2026-08-11',
] as const;

/**
 * Marcas de vontade do titular. Se QUALQUER transição do histórico casar, o worker nunca é
 * reativado aqui — nem que o arquivamento mais recente tenha sido nosso. Alguém que pediu baixa,
 * foi reativado por staff e depois caiu no lote não pode voltar por decisão de máquina.
 */
const TITULAR_REQUEST_MARKERS = ['luz:%', 'lgpd:%', 'worker_self%', 'staff:%'];

interface ArchivalOrigin {
  status: string;
  archivedBy: string | null;
  everRequestedByTitular: boolean;
}

/**
 * Reativa `workerId` se — e somente se — ele estiver `DISABLED` por ato administrativo nosso.
 *
 * @returns `true` se reativou; `false` se não havia o que fazer OU se a origem não autoriza.
 *          Nunca lança: quem chama está no caminho de um request do prestador, e auditoria/reparo
 *          jamais pode derrubar o acesso dele ao próprio cadastro.
 */
export async function reactivateIfArchivedByUs(pool: Pool, workerId: string): Promise<boolean> {
  try {
    const origin = await readArchivalOrigin(pool, workerId);

    // Falha fechada. `null` aqui significa "não consegui determinar a origem" — e determinar é a
    // única coisa que separa erro nosso de vontade da pessoa. É a D103 ao contrário: lá, uma
    // consulta de liveness que devolvia vazio arquivava todo mundo; aqui, reativaria.
    if (!origin) return false;
    if (origin.status !== 'DISABLED') return false;
    if (origin.everRequestedByTitular) return false;
    if (!isReversibleJob(origin.archivedBy)) return false;

    return await applyReactivation(pool, workerId);
  } catch (err) {
    // Nunca propaga: quem chama está servindo um request do prestador. Mas também nunca some em
    // silêncio — retificação quebrada e invisível deixa o prazo do art. 16 inc. 2 correr sem que
    // ninguém saiba. Só o id: `err.detail` do Postgres ecoa a linha inteira, que é PII.
    reportError(err instanceof Error ? err : new Error(String(err)), {
      source: 'ReactivateArchivedWorkerUseCase:reactivateIfArchivedByUs',
      workerId,
    });
    return false;
  }
}

/**
 * Ponto de entrada para o caminho "o prestador acabou de dar sinal de vida": curto-circuita quem
 * não está arquivado (a esmagadora maioria dos requests) antes de tocar o banco.
 *
 * @returns o status restaurado, para quem chama refletir na resposta sem reler o banco; `null` se
 *          nada foi feito. Devolver o valor (em vez de um booleano) mantém a constante numa fonte
 *          só — o chamador não precisa saber para qual estado a restituição leva.
 */
export async function reactivateOnActivity(
  workerId: string,
  status: string,
): Promise<WorkerStatus | null> {
  if (status !== 'DISABLED') return null;
  const pool = DatabaseConnection.getInstance().getPool();
  return (await reactivateIfArchivedByUs(pool, workerId)) ? RESTORED_STATUS : null;
}

function isReversibleJob(changedBy: string | null): boolean {
  return !!changedBy && (REVERSIBLE_ARCHIVAL_JOBS as readonly string[]).includes(changedBy);
}

/**
 * Status atual, quem executou o arquivamento mais recente e se há QUALQUER marca de pedido do
 * titular no histórico inteiro — não só na última transição.
 */
async function readArchivalOrigin(pool: Pool, workerId: string): Promise<ArchivalOrigin | null> {
  const res = await pool.query<{
    status: string;
    archived_by: string | null;
    ever_requested: boolean;
  }>(
    `SELECT w.status,
            (SELECT h.changed_by
               FROM worker_status_history h
              WHERE h.worker_id = w.id
                AND h.new_value = 'DISABLED'
              ORDER BY h.created_at DESC
              LIMIT 1) AS archived_by,
            EXISTS (
              SELECT 1
                FROM worker_status_history h2
               WHERE h2.worker_id = w.id
                 AND h2.changed_by LIKE ANY ($2::text[])
            ) AS ever_requested
       FROM workers w
      WHERE w.id = $1`,
    [workerId, TITULAR_REQUEST_MARKERS],
  );

  const row = res.rows[0];
  return row
    ? {
        status: row.status,
        archivedBy: row.archived_by,
        everRequestedByTitular: row.ever_requested,
      }
    : null;
}

/**
 * A escrita, numa transação carimbada. A condição vai no `WHERE` em vez de confiar na leitura
 * anterior — entre ler e escrever, a linha pode ter mudado.
 *
 * ⚠️ NÃO toca em `messaging_opt_out`, de propósito. Parecer `lex` de 02/09: `reason='admin'` NÃO
 * prova origem administrativa — o script do lote fez
 * `ON CONFLICT (worker_id) DO UPDATE SET reason = EXCLUDED.reason` sobre uma tabela de UMA linha
 * por worker e SEM histórico, então um `user_request` anterior a 10/08 pode ter virado `admin` sem
 * deixar rastro. A varredura em produção não achou vítima (as 4 pessoas com baixa a pedido seguem
 * `user_request`), mas ausência de rastro não é prova de ausência — e o caminho existe:
 * `WorkerOptOutRegisterCapability` registra opt-out a pedido SEM desativar a conta.
 *
 * Religar automaticamente arriscaria mandar WhatsApp para quem pediu para não receber. O
 * `VacancyInviteGuard` seguirá exibindo "Worker pediu para não receber mensagens" para quem não
 * pediu — mas a mentira está no LEITOR, que ignora `reason`, e é lá que ela deve ser consertada.
 * Reescrever o registro de vontade de alguém para corrigir a frase de uma tela é o negócio errado.
 */
async function applyReactivation(pool: Pool, workerId: string): Promise<boolean> {
  return withActorContext(
    pool,
    async (client) => {
      const updated = await client.query(
        `UPDATE workers
            SET status = $2
          WHERE id = $1
            AND status = 'DISABLED'`,
        [workerId, RESTORED_STATUS],
      );

      // 0 linhas → outra transação já reativou (ou desativou de novo). Não é erro; não é reativação.
      return updated.rowCount === 1;
    },
    systemActor(REACTIVATION_JOB),
  );
}
