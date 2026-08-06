/**
 * GetFunnelActivityStatsUseCase
 *
 * "Quanto a Luz fez × quanto cada pessoa do time fez", no período.
 *
 * Junta as três trilhas de ação do recrutamento, todas já existentes:
 *   - worker_job_application_stage_history  (movimento de etapa no funil)
 *   - worker_status_history                 (mudança de status do worker)
 *   - worker_profile_changes_audit          (edição de campo de cadastro, D92/D93)
 *
 * A fonte sai do PREFIXO de `changed_by` (`actorSourceSql`), não da coluna
 * `change_source` — assim a medição funciona sem alterar os triggers do banco.
 * Linha sem autor (tudo que é anterior à instrumentação) entra na fatia
 * explícita `nao_instrumentado`: é a resposta honesta, e não autoria inferida.
 *
 * Zero PII de candidato: só contagens, o identificador do ator e — para staff —
 * o e-mail corporativo resolvido em `users` (mesma técnica de
 * WorkerAuditRepository.resolveActorEmail).
 *
 * ⚠️ Limite a declarar junto com o número: cobre AÇÕES NO SISTEMA. O time
 * também conversa com candidato pelo Periskope, que não passa por aqui.
 */

import type { Pool } from 'pg';
import { actorSourceSql, NOT_INSTRUMENTED } from '@shared/audit/actorSource';

export interface FunnelActivityActorStats {
  /** Identidade gravada: `staff:<uid>`, `luz:<tool>`, `system:<job>`, … */
  actor: string;
  /** Fonte derivada do prefixo: admin_panel | luz_conversation | … */
  source: string;
  /** E-mail do staff quando resolvido em `users`; senão, o próprio `actor`. */
  label: string;
  funnelMoves: number;
  statusChanges: number;
  profileEdits: number;
  /** Soma das três — a ordenação do resultado. */
  totalActions: number;
  /** Prestadores distintos tocados pelo ator no período. */
  workers: number;
  lastActionAt: string | null;
}

export interface FunnelActivityStatsResult {
  sinceDays: number;
  totalActions: number;
  byActor: FunnelActivityActorStats[];
}

interface ActivityRow {
  actor: string;
  source: string;
  email: string | null;
  funnel_moves: string;
  status_changes: string;
  profile_edits: string;
  workers: string;
  last_action_at: Date | null;
}

export class GetFunnelActivityStatsUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(input: { sinceDays: number }): Promise<FunnelActivityStatsResult> {
    const { rows } = await this.pool.query<ActivityRow>(
      `WITH acoes AS (
         -- Movimento de etapa no funil (o trabalho principal do recrutamento)
         SELECT COALESCE(h.changed_by, '${NOT_INSTRUMENTED}') AS actor,
                wja.worker_id,
                h.created_at,
                'funnel'::text AS kind
           FROM worker_job_application_stage_history h
           JOIN worker_job_applications wja ON wja.id = h.application_id
          WHERE h.created_at >= NOW() - make_interval(days => $1)

         UNION ALL

         -- Mudança de status do worker (inclui a baixa de conta da Luz)
         SELECT COALESCE(s.changed_by, '${NOT_INSTRUMENTED}'),
                s.worker_id,
                s.created_at,
                'status'
           FROM worker_status_history s
          WHERE s.created_at >= NOW() - make_interval(days => $1)

         UNION ALL

         -- Edição de campo de cadastro: a trilha já tem a FONTE tipada, não a
         -- identidade — por isso o ator aqui é a própria fonte (o legado 'luz'
         -- vira 'luz:cadastro' para casar com o prefixo das outras trilhas).
         SELECT CASE
                  WHEN a.changed_by IN ('luz', 'luz_conversation') THEN 'luz:cadastro'
                  WHEN a.changed_by = 'admin_panel'                THEN 'staff:cadastro-painel'
                  WHEN a.changed_by = 'worker_self'                THEN 'worker_self'
                  WHEN a.changed_by = 'sync_import'                THEN 'sync:cadastro'
                  ELSE '${NOT_INSTRUMENTED}'
                END,
                a.worker_id,
                a.created_at,
                'profile'
           FROM worker_profile_changes_audit a
          WHERE a.created_at >= NOW() - make_interval(days => $1)
       )
       SELECT acoes.actor,
              ${actorSourceSql('acoes.actor')}                       AS source,
              u.email                                                AS email,
              COUNT(*) FILTER (WHERE kind = 'funnel')::int           AS funnel_moves,
              COUNT(*) FILTER (WHERE kind = 'status')::int           AS status_changes,
              COUNT(*) FILTER (WHERE kind = 'profile')::int          AS profile_edits,
              COUNT(DISTINCT acoes.worker_id)::int                   AS workers,
              MAX(acoes.created_at)                                  AS last_action_at
         FROM acoes
         -- Staff é gravado por firebase_uid (estável, sem dado pessoal na trilha);
         -- o e-mail legível é resolvido só na leitura.
         LEFT JOIN users u
                ON acoes.actor LIKE 'staff:%'
               AND u.firebase_uid = substring(acoes.actor from 7)
        GROUP BY acoes.actor, u.email
        ORDER BY (COUNT(*)) DESC`,
      [input.sinceDays],
    );

    const byActor = rows.map((r) => {
      const funnelMoves = Number(r.funnel_moves);
      const statusChanges = Number(r.status_changes);
      const profileEdits = Number(r.profile_edits);
      return {
        actor: r.actor,
        source: r.source,
        label: r.email ?? r.actor,
        funnelMoves,
        statusChanges,
        profileEdits,
        totalActions: funnelMoves + statusChanges + profileEdits,
        workers: Number(r.workers),
        lastActionAt: r.last_action_at ? r.last_action_at.toISOString() : null,
      };
    });

    return {
      sinceDays: input.sinceDays,
      totalActions: byActor.reduce((acc, a) => acc + a.totalActions, 0),
      byActor,
    };
  }
}
