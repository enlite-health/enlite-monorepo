import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { ChromeReportRepository } from '../infrastructure/ChromeReportRepository';
import {
  ChromeReportEmptyListError,
  ChromeReportNotReleasedError,
  TACTIQ_EXTENSION_ID,
  type ChromeReportPort,
} from './ports/ChromeReportPort';
import { classifyExtension, isConclusive, type ConclusiveExtensionState, type ExtensionState } from '../domain/chromeExtensionState';
import type { AdmissionLogger } from './AdmissionMessagingService';

export interface ChromeReportSummary {
  /** `unavailable` = a porta não está liberada (F18): nada foi lido nem gravado. */
  status: 'ok' | 'unavailable';
  rosterHosts: number;
  instalada: number;
  ausente: number;
  desativada: number;
  sem_relatorio: number;
  transitions: number;
  notified: number;
  policy: 'applied' | 'absent' | 'unknown' | 'unchecked';
}

export interface ChromeReportJobDeps {
  repo: ChromeReportRepository;
  chrome: ChromeReportPort;
  publisher?: SystemNotificationPublisher;
  db?: Pool;
  log?: AdmissionLogger;
  now?: () => Date;
}

const EVENT_KIND: Record<ConclusiveExtensionState, { kind: string; notice: 'installed' | 'missing' | 'disabled' }> = {
  instalada: { kind: 'tactiq_extension.installed', notice: 'installed' },
  ausente: { kind: 'tactiq_extension.missing', notice: 'missing' },
  desativada: { kind: 'tactiq_extension.disabled', notice: 'disabled' },
};

/**
 * ChromeReportJob — o job diário do relatório do Chrome (spec 050 F15: R-1, R-2, R-3, R-5, R-6).
 * `POST /api/internal/jobs/admission-chrome-report`.
 *
 *  1. Porta não liberada (adaptador real, antes da F18): devolve `unavailable`, ZERO leitura, ZERO escrita, sem `run_done`.
 *  2. Lê a lista de instalações + o controle `countInstalledApps`. Lista VAZIA com controle > 0 → falha alto (`ChromeReportEmptyListError`,
 *     nada gravado): nunca vira "ninguém tem" (R-2).
 *  3. Para cada responsável ativa do roster: perfil → estado (`classifyExtension`): `sem_relatorio` se o relatório tem mais de 48 h.
 *  4. TRANSIÇÃO conclusiva (≠ último estado conclusivo): 1 evento `tactiq_extension.*` + 1 aviso no sino, na MESMA transação.
 *     `sem_relatorio` grava o veredito mas não revoga, não libera e não é transição.
 *  5. Confere a política de instalação forçada (R-5): `absent` → log de alarme `admission.chrome_report.policy_missing`.
 *  6. `admission.chrome_report.run_done` (R-6) só quando a rodada terminou inteira.
 *
 * O relatório NUNCA torna ninguém apta (§3.4): o job só escreve em `admission_chrome_reports` e na trilha; não toca vínculo, prova nem agenda.
 * Logs: só contagens, estado e motivo — nenhum e-mail, nome ou id de perfil/dispositivo.
 */
export class ChromeReportJob {
  private readonly repo: ChromeReportRepository;
  private readonly publisher: SystemNotificationPublisher;
  private readonly db: Pool;
  private readonly log: AdmissionLogger;
  private readonly now: () => Date;

  constructor(private readonly deps: ChromeReportJobDeps) {
    this.repo = deps.repo;
    this.publisher = deps.publisher ?? new SystemNotificationPublisher();
    this.db = deps.db ?? DatabaseConnection.getInstance().getPool();
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
    this.now = deps.now ?? (() => new Date());
  }

  async run(): Promise<ChromeReportSummary> {
    const summary: ChromeReportSummary = {
      status: 'ok', rosterHosts: 0, instalada: 0, ausente: 0, desativada: 0, sem_relatorio: 0, transitions: 0, notified: 0, policy: 'unchecked',
    };
    const { chrome } = this.deps;
    let installed: Set<string>;
    try {
      const emails = await chrome.findInstalledEmails(TACTIQ_EXTENSION_ID);
      const profileCount = await chrome.countInstalledProfiles(TACTIQ_EXTENSION_ID);
      if (emails.length === 0 && profileCount > 0) {
        this.log.error({ profileCount }, 'admission.chrome_report.empty_list');
        throw new ChromeReportEmptyListError(profileCount);
      }
      installed = new Set(emails.map((e) => e.toLowerCase()));
    } catch (err) {
      if (err instanceof ChromeReportNotReleasedError) {
        this.log.warn({}, 'admission.chrome_report.unavailable');
        return { ...summary, status: 'unavailable' };
      }
      throw err;
    }

    const roster = await this.repo.listActiveRosterEmails();
    summary.rosterHosts = roster.length;
    for (const email of roster) {
      const profile = await chrome.getProfile(email);
      const obs = classifyExtension({ profile, inInstalledList: installed.has(email.toLowerCase()), extensionId: TACTIQ_EXTENSION_ID, now: this.now() });
      summary[obs.state] += 1;
      const notified = await this.record(email, obs.state, obs.reportAt);
      if (notified.transition) summary.transitions += 1;
      if (notified.notified) summary.notified += 1;
    }

    summary.policy = await chrome.resolveForcedInstall(TACTIQ_EXTENSION_ID);
    if (summary.policy === 'absent') this.log.error({}, 'admission.chrome_report.policy_missing');
    else if (summary.policy === 'unknown') this.log.warn({}, 'admission.chrome_report.policy_unverifiable');

    this.log.info({ ...summary }, 'admission.chrome_report.run_done');
    return summary;
  }

  /** Veredito + (se for transição conclusiva) evento e sino, atômicos. O lock por pessoa serializa duas execuções. */
  private async record(email: string, state: ExtensionState, reportAt: Date | null): Promise<{ transition: boolean; notified: boolean }> {
    const now = this.now();
    const uid = await this.repo.activeUserUidByEmail(email);
    return withActorContext(this.db, async (cli) => {
      await this.repo.lockHost(email, cli);
      const prev = await this.repo.findByEmail(email, cli);
      const conclusive = isConclusive(state) ? state : null;
      await this.repo.upsert({ email, state, reportAt, conclusive, now }, cli);
      if (!conclusive || prev?.conclusive_state === conclusive) return { transition: false, notified: false };
      const { kind, notice } = EVENT_KIND[conclusive];
      await this.repo.appendEvent({ email, kind, outcome: conclusive, reportAt, at: now }, cli);
      const eventId = await this.publisher.publishAdmissionTactiqExtensionChanged(cli, { recipientUid: uid, state: notice });
      this.log.info({ state: conclusive, notified: eventId !== null }, 'admission.chrome_report.transition');
      return { transition: true, notified: eventId !== null };
    });
  }
}
