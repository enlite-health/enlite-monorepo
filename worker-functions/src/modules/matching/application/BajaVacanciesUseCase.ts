/**
 * BajaVacanciesUseCase — spec 084 F1: dar baixa (DE_BAJA) em vagas SEM serviço, uma ou em lote, sem apagar nada (R2).
 *
 * TUDO OU NADA: se UMA vaga do lote não pode baixar (tem serviço — P1; já baixada; inexistente), nada é gravado e a
 * resposta lista cada recusa com o código. Uma transação (`withActorContext`, nunca `connect()` cru), vagas travadas
 * (`FOR UPDATE`) em ordem de id. Cada baixa grava `status_before_baja` + `baja_reason` (P2) e UMA linha de auditoria
 * (P6: quem, quando, status anterior, status novo, motivo).
 *
 * NÃO existe o caminho inverso (R17): reativar vaga só acontece pela reativação do serviço, no repositório do serviço.
 * Side-effect outbound (pausar no Talentum, F4) é do CHAMADOR, DEPOIS do commit — esta classe só toca o banco.
 */
import type { Pool, PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { JobPostingAuditRepository } from '../infrastructure/JobPostingAuditRepository';
import type { HumanActor } from '../interfaces/controllers/vacancyCrudAuditHelpers';
import { decideManualBaja, DE_BAJA_STATUS, type BajaReason, type BajaRefusalCode } from '../domain/VacancyBajaPolicy';

export const BAJA_BATCH_MAX = 200;

export type BajaRefusal = { vacancyId: string; code: BajaRefusalCode | 'VACANCY_NOT_FOUND' };
export type BajaOutcome =
  | { ok: true; baixadas: { vacancyId: string; statusBefore: string }[] }
  | { ok: false; refused: BajaRefusal[] };

interface LockedRow {
  id: string;
  status: string | null;
  contracted_service_id: string | null;
}

export class BajaVacanciesUseCase {
  constructor(
    private readonly db: Pool,
    private readonly audit: Pick<JobPostingAuditRepository, 'logEventSafe'> = new JobPostingAuditRepository(),
  ) {}

  async execute(vacancyIds: readonly string[], reason: Exclude<BajaReason, 'SERVICE'>, actor: HumanActor): Promise<BajaOutcome> {
    return withActorContext(this.db, (client) => this.executeInTx(client, vacancyIds, reason, actor));
  }

  /**
   * O MESMO caminho dentro de uma transação que o chamador já abriu — é o que o ensaio da linha de corte (F3)
   * usa: uma transação só, ROLLBACK no dry-run, COMMIT no apply.
   */
  async executeInTx(
    client: PoolClient,
    vacancyIds: readonly string[],
    reason: Exclude<BajaReason, 'SERVICE'>,
    actor: HumanActor,
  ): Promise<BajaOutcome> {
    const ids = [...new Set(vacancyIds)].sort();
    const locked = await client.query<LockedRow>(
      `SELECT id, status, contracted_service_id FROM job_postings
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
      [ids],
    );
    const byId = new Map(locked.rows.map((r) => [r.id, r]));
    const refused: BajaRefusal[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        refused.push({ vacancyId: id, code: 'VACANCY_NOT_FOUND' });
        continue;
      }
      const decision = decideManualBaja({ status: row.status, contractedServiceId: row.contracted_service_id });
      if (!decision.ok) refused.push({ vacancyId: id, code: decision.code });
    }
    if (refused.length > 0) return { ok: false, refused } as BajaOutcome;

    const baixadas: { vacancyId: string; statusBefore: string }[] = [];
    for (const id of ids) {
      const before = byId.get(id)!.status ?? 'SEARCHING';
      await client.query(
        `UPDATE job_postings
            SET status_before_baja = status, status = '${DE_BAJA_STATUS}', baja_reason = $2, updated_at = NOW(),
                -- R13: a pausa no Talentum fica PENDENTE na MESMA transação da baixa (nunca NULL calado)
                talentum_pause_state = CASE WHEN talentum_project_id IS NOT NULL THEN 'PENDING_PAUSE' ELSE talentum_pause_state END
          WHERE id = $1 AND deleted_at IS NULL AND contracted_service_id IS NULL AND status != '${DE_BAJA_STATUS}'`,
        [id, reason],
      );
      await this.audit.logEventSafe(client, {
        jobPostingId: id,
        eventType: 'STATUS_CHANGED',
        fieldName: 'status',
        changes: { before: { status: before, baja_reason: null }, after: { status: DE_BAJA_STATUS, baja_reason: reason } },
        actorUserId: actor.actorUserId,
        actorType: actor.actorType,
        actorLabel: actor.actorLabel,
        traceId: actor.traceId ?? null,
      });
      baixadas.push({ vacancyId: id, statusBefore: before });
    }
    return { ok: true, baixadas } as BajaOutcome;
  }
}
