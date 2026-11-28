/**
 * SubmitDailyReportUseCase — `PUT /api/workers/me/daily-reports/{id}` (spec 092 + emenda 077 §2).
 *
 * Ordem (cada passo corresponde a um código do contrato):
 *   1. conta ativa; 2. a guarda é do prestador (expansão do itinerário, F-5/DC-10) → `occurrence_unknown`;
 *   3. mesmo `id` já existe: mesmo conteúdo → 200 (retry), outro → 409 `daily_report_conflict` (responde ANTES de consultar o attendance);
 *   4. outra `id` já cobre a guarda → 409 `daily_report_exists`;
 *   5. janela de aceite (fim + 8 d) → 422 `daily_report_window_closed` (terminal: vence o retentável);
 *   5b. presença fechada (`CLOSED` ou `CLOSED_DECLARED`, lida do attendance) → senão 409 `daily_report_presence_open` (retentável; attendance fora → 503);
 *   5c. o servidor escolhe o PTI vigente na data da guarda; `null` ou versão ≠ vigente com PTI vigente → 409 `daily_report_template_outdated` (retentável);
 *   6. respostas contra o molde → erros nomeados; 7. grava (201). Corrida de 2 PUTs: o UNIQUE pega o 2º e o use case relê UMA vez e decide 200/409.
 *
 * Transações: a consulta do 5b roda FORA de qualquer transação (ver `SubmitDailyReportUseCase`): 1-5 numa tx, 5b sem tx, 3/4 + 5c-7 em outra tx.
 *
 * Revoga a DC-10 ("o servidor não exige check-out"). Nada aqui loga nem ecoa `narrative` ou respostas.
 */
import type { DailyReportPort, DailyReportTx, GuardOccurrence } from '../ports/DailyReportPort';
import { DuplicateReportError } from '../ports/DailyReportPort';
import { isPresenceClosed, type PresenceReader } from '../ports/PresenceReaderPort';
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

/** Saída da 1ª transação (passos 1-5): ou já respondeu (retry idempotente) ou entrega o que a presença e a 2ª transação precisam. */
type Prepared = { outcome: SubmitOutcome } | { outcome: null; workerId: string; guard: GuardOccurrence; content: ReportContent };

/**
 * Três fases, para NUNCA segurar conexão do pool durante chamada de rede (DB_POOL_MAX=5 em prd: attendance lento esgotaria o pool do WF):
 *   A (tx curta) passos 1-5 · presença (HTTP ao attendance, SEM transação aberta) · B (tx curta) 3/4 de novo + 5c-7.
 * A 3/4 se repete em B porque outro PUT pode ter gravado enquanto a presença era consultada; o UNIQUE continua sendo a trava final.
 */
export class SubmitDailyReportUseCase {
  constructor(private readonly port: DailyReportPort, private readonly presence: PresenceReader) {}

  async execute(cmd: SubmitDailyReportCommand): Promise<SubmitOutcome> {
    const prepared = await this.port.run((tx) => this.prepare(tx, cmd));
    if (prepared.outcome !== null) return prepared.outcome;
    const { workerId, guard, content } = prepared;

    if (!isPresenceClosed(await this.presence.statusOf(guard.occurrenceId))) throw new DailyReportConflictError('daily_report_presence_open');

    try {
      return await this.port.run((tx) => this.persist(tx, cmd, workerId, guard, content));
    } catch (err) {
      if (!(err instanceof DuplicateReportError)) throw err;
      // corrida: o outro PUT venceu entre a leitura e o INSERT; relê numa transação nova e decide 200/409.
      return this.port.run((tx) => this.persist(tx, cmd, workerId, guard, content));
    }
  }

  /** Passos 1-5 (só banco): conta, guarda, idempotência, outra id, janela. */
  private async prepare(tx: DailyReportTx, cmd: SubmitDailyReportCommand): Promise<Prepared> {
    const workerId = await tx.workerIdByUid(cmd.uid);
    if (workerId === null) throw new AccountInactiveError();
    const guard = (await tx.guardsOf(workerId, cmd.today)).find((g) => g.occurrenceId === cmd.occurrenceId);
    if (!guard) throw new DailyReportError('occurrence_unknown');

    const content = this.contentOf(cmd, workerId, guard);
    const replayed = await this.idempotency(tx, cmd, workerId, guard, content);
    if (replayed) return { outcome: replayed };
    if (ReportDue.of(guard.endsAt).isWindowClosed(cmd.now)) throw new DailyReportError('daily_report_window_closed');
    return { outcome: null, workerId, guard, content };
  }

  /** Passos 3-4: mesmo `id` (mesmo conteúdo = 'replayed'; outro = 409) e outra `id` na mesma guarda (409). `null` = nada gravado ainda. */
  private async idempotency(tx: DailyReportTx, cmd: SubmitDailyReportCommand, workerId: string, guard: GuardOccurrence, content: ReportContent): Promise<'replayed' | null> {
    const same = await tx.reportById(cmd.reportId);
    if (same) {
      if (sameReportContent(same, content)) return 'replayed';
      throw new DailyReportConflictError('daily_report_conflict');
    }
    if ((await tx.reportIdOfGuard(workerId, guard.slotId, guard.onDate)) !== null) throw new DailyReportConflictError('daily_report_exists');
    return null;
  }

  /** Passos 3/4 de novo + 5c-7 (só banco). */
  private async persist(tx: DailyReportTx, cmd: SubmitDailyReportCommand, workerId: string, guard: GuardOccurrence, content: ReportContent): Promise<SubmitOutcome> {
    const replayed = await this.idempotency(tx, cmd, workerId, guard, content);
    if (replayed) return replayed;
    const catalog = await tx.scaleCatalog();
    const template = await this.templateFor(tx, cmd.ptiVersionId, guard, catalog);
    template.validate(cmd.answers, catalog);
    await tx.insertReport(cmd.reportId, content);
    return 'created';
  }

  /**
   * O servidor decide o PTI (R-19): o vigente na data da guarda (`projectInForceFor`: mesmo serviço, não anulado, data em [início, fim], empate por `createdAt`),
   * a mesma regra do GET dos moldes. O `ptiVersionId` do app NÃO é fonte de verdade: com PTI vigente, `null` ou versão diferente → 409 retentável
   * `daily_report_template_outdated` (o app atualiza o molde e reenvia). Sem PTI vigente: `null` = só relato (DC-4, resposta → item_not_in_pti); id não-nulo → 422 `pti_version_mismatch`.
   */
  private async templateFor(tx: DailyReportTx, ptiVersionId: string | null, guard: GuardOccurrence, catalog: Awaited<ReturnType<DailyReportTx['scaleCatalog']>>): Promise<DailyReportTemplate> {
    const inForce = projectInForceFor(await tx.projectVersionsOfService(guard.serviceId), guard.serviceId, guard.onDate);
    if (inForce === null) {
      if (ptiVersionId !== null) throw new DailyReportError('pti_version_mismatch');
      return templateOf(tx, catalog, null);
    }
    if (inForce.id !== ptiVersionId) throw new DailyReportConflictError('daily_report_template_outdated');
    return templateOf(tx, catalog, inForce);
  }

  private contentOf(cmd: SubmitDailyReportCommand, workerId: string, guard: GuardOccurrence): ReportContent {
    return {
      workerId, slotId: guard.slotId, onDate: guard.onDate, ptiVersionId: cmd.ptiVersionId, narrative: cmd.narrative,
      narrativeSource: cmd.narrativeSource, deviceSubmittedAt: cmd.deviceSubmittedAt, appVersion: cmd.appVersion, answers: cmd.answers,
    };
  }
}
