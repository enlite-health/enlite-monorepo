import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { decideFastRead } from '../domain/admissionFastSummary';
import type { AdmissionEventRepository } from '../infrastructure/AdmissionEventRepository';
import type { AdmissionFastSummaryRepository } from '../infrastructure/AdmissionFastSummaryRepository';
import type { AdmissionLogger } from './AdmissionMessagingService';
import type { AdmissionImportService, ImportOutcome } from './AdmissionImportService';
import { createFastGate } from './AdmissionFastGate';

/** O que o passo precisa da importação: o MESMO `importOne` da rede de 15 min, agora com o portão (modo rápido). */
export type SummaryImportNow = Pick<AdmissionImportService, 'importOne'>;

export type FastStepOutcome = 'none' | 'not_ready' | 'released' | 'fired' | 'gave_up' | 'cancelled';

export interface AdmissionFastSummaryStepDeps {
  repo: AdmissionFastSummaryRepository;
  importer: SummaryImportNow;
  events: Pick<AdmissionEventRepository, 'append'>;
  db?: Pool;
  log?: AdmissionLogger;
}

type Claim =
  | { kind: 'none' | 'gave_up' | 'cancelled' }
  | { kind: 'claimed'; previousCount: number | null; previousLastReadAt: Date | null; reads: number };

/** O que fazer com o gatilho depois que a importação em modo rápido voltou. */
export function fastAfterImport(outcome: ImportOutcome): 'count_read' | 'release' | 'fired' | 'cancel' {
  switch (outcome) {
    case 'not_ready':
      return 'count_read';
    case 'transient': // responsável ocupada ou token adiado: nada foi lido
    case 'skipped_locked': // outra importação da mesma reunião: nada foi lido
      return 'release';
    case 'done': // chegou ao cofre e ao Vertex: o gatilho cumpriu o papel; falha daqui em diante é do teto de 3 e da rede
    case 'summary_failed':
    case 'vault_failed':
      return 'fired';
    default: // a importação decidiu outra coisa (já feita, bloqueada, de teste, fora da fila…): o gatilho não tem mais o que fazer
      return 'cancel';
  }
}

/**
 * AdmissionFastSummaryStep — o passo do resumo do job de 1 min (spec 050 F28; R-49, R-51, R-52, R-53, R-55). Roda DEPOIS da observação
 * da reunião e FORA da transação dela: `decideFastRead` → reivindica a leitura na linha (transação curta) → `importOne` em modo rápido
 * (o mesmo caminho da rede: cofre, Vertex, PDF, teto de 3, ensaio) → grava a contagem, `fired` ou `gave_up` (transação curta).
 * Nenhuma transação fica aberta durante a leitura do Tactiq. Log e trilha: só ids, contagens e motivos.
 */
export class AdmissionFastSummaryStep {
  private readonly db: Pool;
  private readonly log: AdmissionLogger;

  constructor(private readonly deps: AdmissionFastSummaryStepDeps) {
    this.db = deps.db ?? DatabaseConnection.getInstance().getPool();
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
  }

  async runOne(id: string, now: Date, conferenceOpen: boolean): Promise<FastStepOutcome> {
    const claim = await this.claim(id, now);
    if (claim.kind !== 'claimed') return claim.kind;

    const gate = createFastGate({ previousCount: claim.previousCount, conferenceOpen });
    const outcome = await this.deps.importer.importOne(id, now, gate);
    const count = gate.count ?? null;
    const what = fastAfterImport(outcome);
    return withActorContext(this.db, async (cli): Promise<FastStepOutcome> => {
      switch (what) {
        case 'release':
          await this.deps.repo.releaseRead(id, claim.previousLastReadAt, cli);
          return 'released';
        case 'count_read':
          await this.deps.repo.recordRead(id, count, cli);
          return 'not_ready';
        case 'fired':
          await this.deps.repo.finish(id, 'fired', cli, { count });
          await this.deps.events.append(
            { appointmentId: id, kind: 'summary_fast_ready', outcome: 'ready', reason: outcome, ref: { reads: claim.reads + 1, blocks: count } },
            cli,
          );
          this.log.info({ appointmentId: id, reads: claim.reads + 1, outcome }, 'admission.summary_fast_ready');
          return 'fired';
        default:
          await this.deps.repo.finish(id, 'cancelled', cli);
          this.log.info({ appointmentId: id, outcome }, 'admission.summary_fast_cancelled');
          return 'cancelled';
      }
    });
  }

  /** Decide e reivindica numa transação curta, sob a trava da linha. Nada de rede aqui dentro. */
  private claim(id: string, now: Date): Promise<Claim> {
    return withActorContext(this.db, async (cli): Promise<Claim> => {
      const row = await this.deps.repo.lockArmed(id, cli);
      if (!row) return { kind: 'none' };
      if (!row.conference_ended_at || row.import_status !== 'pending') {
        await this.deps.repo.finish(id, 'cancelled', cli); // a rede (ou um bloqueio) já assumiu a reunião
        return { kind: 'cancelled' };
      }
      const lastReadAt = row.summary_fast_last_read_at ? new Date(row.summary_fast_last_read_at) : null;
      const decision = decideFastRead({ now, endedAt: new Date(row.conference_ended_at), reads: row.summary_fast_reads, lastReadAt });
      if (decision.kind === 'wait') return { kind: 'none' };
      if (decision.kind === 'give_up') {
        await this.deps.repo.finish(id, 'gave_up', cli);
        await this.deps.events.append(
          { appointmentId: id, kind: 'summary_fast_gave_up', outcome: 'gave_up', reason: decision.reason, ref: { reads: row.summary_fast_reads ?? 0 } },
          cli,
        );
        this.log.info({ appointmentId: id, reason: decision.reason, reads: row.summary_fast_reads ?? 0 }, 'admission.summary_fast_gave_up');
        return { kind: 'gave_up' };
      }
      await this.deps.repo.claimRead(id, now, cli);
      return { kind: 'claimed', previousCount: row.summary_fast_last_count, previousLastReadAt: lastReadAt, reads: row.summary_fast_reads ?? 0 };
    });
  }
}
