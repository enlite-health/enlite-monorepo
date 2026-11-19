/**
 * SubmitDailyReportUseCase — `PUT /api/workers/me/daily-reports/{id}` (spec 092, DC-1..DC-10).
 *
 * Ordem (cada passo corresponde a um código do contrato):
 *   1. conta ativa; 2. a guarda é do prestador (expansão do itinerário, F-5/DC-10) → `occurrence_unknown`;
 *   3. mesmo `id` já existe: mesmo conteúdo → 200 (retry), outro → 409 `daily_report_conflict`;
 *   4. outra `id` já cobre a guarda → 409 `daily_report_exists`;
 *   5. janela de aceite (prazo + 7 dias) → `daily_report_window_closed`;
 *   6. PTI informado (ou nenhum, DC-4) e respostas contra o molde → erros nomeados;
 *   7. grava (201). Corrida de 2 PUTs: o UNIQUE pega o 2º e o use case relê UMA vez e decide 200/409.
 *
 * O servidor NÃO exige check-out (DC-10: informe e check-out sobem por filas diferentes). Nada aqui loga nem ecoa `narrative` ou respostas.
 */
import type { DailyReportPort, DailyReportTx, GuardOccurrence } from '../ports/DailyReportPort';
import { DuplicateReportError } from '../ports/DailyReportPort';
import {
  DailyReportConflictError, DailyReportError, DailyReportTemplate, ReportDue, sameReportContent,
  type ReportAnswer, type ReportContent,
} from '../../domain/DailyReport';
import { AccountInactiveError } from '../GetWorkerItineraryUseCase';
import { projectInForceFor } from '../../domain/TherapeuticProjectVigencia';
import { templateOf } from './templateAssembler';

export interface SubmitDailyReportCommand {
  uid: string;
  reportId: string;
  occurrenceId: string;
  ptiVersionId: string | null;
  narrative: string;
  narrativeSource: 'TYPED' | 'DICTATED' | 'MIXED';
  deviceSubmittedAt: Date;
  appVersion: string;
  answers: readonly ReportAnswer[];
  /** Instante do servidor e a data civil dele (fuso da operação). */
  now: Date;
  today: string;
}

export type SubmitOutcome = 'created' | 'replayed';

export class SubmitDailyReportUseCase {
  constructor(private readonly port: DailyReportPort) {}

  async execute(cmd: SubmitDailyReportCommand): Promise<SubmitOutcome> {
    try {
      return await this.port.run((tx) => this.attempt(tx, cmd));
    } catch (err) {
      if (!(err instanceof DuplicateReportError)) throw err;
      // corrida: o outro PUT venceu entre a leitura e o INSERT; relê numa transação nova e decide.
      return this.port.run((tx) => this.attempt(tx, cmd));
    }
  }

  private async attempt(tx: DailyReportTx, cmd: SubmitDailyReportCommand): Promise<SubmitOutcome> {
    const workerId = await tx.workerIdByUid(cmd.uid);
    if (workerId === null) throw new AccountInactiveError();
    const guard = (await tx.guardsOf(workerId, cmd.today)).find((g) => g.occurrenceId === cmd.occurrenceId);
    if (!guard) throw new DailyReportError('occurrence_unknown');

    const content = this.contentOf(cmd, workerId, guard);
    const same = await tx.reportById(cmd.reportId);
    if (same) {
      if (sameReportContent(same, content)) return 'replayed';
      throw new DailyReportConflictError('daily_report_conflict');
    }
    if ((await tx.reportIdOfGuard(workerId, guard.slotId, guard.onDate)) !== null) throw new DailyReportConflictError('daily_report_exists');
    if (ReportDue.of(guard.endsAt).isWindowClosed(cmd.now)) throw new DailyReportError('daily_report_window_closed');

    const catalog = await tx.scaleCatalog();
    const template = await this.templateFor(tx, cmd.ptiVersionId, guard, catalog);
    template.validate(cmd.answers, catalog);
    await tx.insertReport(cmd.reportId, content);
    return 'created';
  }

  /**
   * O PTI do corpo tem de ser EXATAMENTE o vigente que o GET dos moldes escolhe (`projectInForceFor`: mesmo serviço, não anulado, data da guarda
   * em [início, fim], empate por `createdAt`). Sem vigente (DC-4), só `null` (relato). Anulada, vencida, substituída ou de outro serviço → mismatch.
   */
  private async templateFor(tx: DailyReportTx, ptiVersionId: string | null, guard: GuardOccurrence, catalog: Awaited<ReturnType<DailyReportTx['scaleCatalog']>>): Promise<DailyReportTemplate> {
    const inForce = projectInForceFor(await tx.projectVersionsOfService(guard.serviceId), guard.serviceId, guard.onDate);
    if ((inForce?.id ?? null) !== ptiVersionId) throw new DailyReportError('pti_version_mismatch');
    return templateOf(tx, catalog, inForce);
  }

  private contentOf(cmd: SubmitDailyReportCommand, workerId: string, guard: GuardOccurrence): ReportContent {
    return {
      workerId, slotId: guard.slotId, onDate: guard.onDate, ptiVersionId: cmd.ptiVersionId, narrative: cmd.narrative,
      narrativeSource: cmd.narrativeSource, deviceSubmittedAt: cmd.deviceSubmittedAt, appVersion: cmd.appVersion, answers: cmd.answers,
    };
  }
}
