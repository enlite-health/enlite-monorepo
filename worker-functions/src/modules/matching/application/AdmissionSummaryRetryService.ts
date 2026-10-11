import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { MAX_SUMMARY_ATTEMPTS } from './ports/AdmissionImportPorts';
import {
  SUMMARY_RETRY_AUTHORIZED_EVENT,
  decideSummaryRetry,
  MAX_SUMMARY_RETRY_AUTHORIZATIONS,
  summaryRetryView,
  type SummaryRetryView,
} from '../domain/admissionSummaryRetry';
import type { AdmissionEventRepository } from '../infrastructure/AdmissionEventRepository';
import type { AdmissionImportRepository } from '../infrastructure/AdmissionImportRepository';
import { AppointmentNotFoundError, SummaryRetryLimitReachedError, SummaryRetryNotAllowedError } from './AdmissionPanelErrors';
import type { AdmissionLogger } from './AdmissionMessagingService';

/** O que o botão precisa da importação: rodar UMA reunião agora (o `AdmissionImportService` cumpre). */
export interface SummaryImportNow {
  importOne(appointmentId: string): Promise<string>;
}

export interface SummaryRetryResult {
  appointmentId: string;
  /** `authorized`: +1 rodada autorizada, a reunião voltou à fila. `run_now`: sem autorização (rodada em curso ou motivo que não conta no teto). */
  mode: 'authorized' | 'run_now';
  authorizationsUsed: number;
  authorizationsLeft: number;
  /** Só em `run_now`: o resultado da importação disparada agora. */
  outcome?: string;
}

export interface AdmissionSummaryRetryDeps {
  db: Pool;
  repo: Pick<AdmissionImportRepository, 'countModelSummaryFailures' | 'countRetryAuthorizations' | 'summaryRetryFacts'>;
  events: Pick<AdmissionEventRepository, 'append'>;
  importer: SummaryImportNow;
  log?: AdmissionLogger;
}

/**
 * AdmissionSummaryRetryService — "Reintentar resumen" (spec 050 F11, R-38). Esgotadas as 3 chamadas pagas, UMA pessoa com a célula
 * `patient_admission:retry_summary` autoriza +1 rodada: o evento `summary_retry_authorized` (quem, quando) entra na trilha
 * (só-acréscimo; nada é apagado) e a reunião volta à fila. A contagem de falhas passa a valer DESDE essa autorização.
 *
 * Exclusão mútua: a reunião é lida `FOR UPDATE` dentro da transação do ator (RLS de país: reunião de outro país = 404). Dois cliques
 * simultâneos serializam nela e o 2º já vê a rodada nova (0 falhas desde a autorização): não grava a 2ª autorização, só roda agora.
 * Teto: 2 autorizações por reunião (409). Não esgotada (inclui `prompt_*` e catálogo, que não contam no teto): sem autorização, roda
 * agora. Log e trilha: só ids e contagens.
 */
export class AdmissionSummaryRetryService {
  private readonly log: AdmissionLogger;

  constructor(private readonly deps: AdmissionSummaryRetryDeps) {
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
  }

  /** Por reunião `booked` do paciente: o que a aba mostra no botão (`null` = sem botão). Leitura sob a identidade da request (RLS de país). */
  async viewsFor(patientId: string): Promise<Map<string, SummaryRetryView | null>> {
    const facts = await this.deps.repo.summaryRetryFacts(patientId, this.deps.db);
    return new Map(facts.map((f) => [f.id, summaryRetryView(f, MAX_SUMMARY_ATTEMPTS)]));
  }

  async retry(input: { patientId: string; appointmentId: string; actorUid: string }): Promise<SummaryRetryResult> {
    const { patientId, appointmentId, actorUid } = input;
    const step = await withActorContext(this.deps.db, async (cli) => {
      const appt = await cli.query<{ status: string; import_status: string | null }>(
        `SELECT a.status, a.import_status
           FROM admission_appointments a
           JOIN patients p ON p.id = a.patient_id AND p.deleted_at IS NULL
          WHERE a.id = $1 AND a.patient_id = $2
            FOR UPDATE OF a`,
        [appointmentId, patientId],
      );
      if (appt.rows.length === 0) throw new AppointmentNotFoundError();
      const authorizations = await this.deps.repo.countRetryAuthorizations(appointmentId, cli);
      const decision = decideSummaryRetry(
        {
          appointmentStatus: appt.rows[0].status,
          importStatus: appt.rows[0].import_status,
          modelFailuresSinceAuthorization: await this.deps.repo.countModelSummaryFailures(appointmentId, cli),
          authorizations,
        },
        MAX_SUMMARY_ATTEMPTS,
      );
      if (decision.kind === 'refuse') {
        if (decision.reason === 'authorization_limit') throw new SummaryRetryLimitReachedError();
        throw new SummaryRetryNotAllowedError(decision.reason);
      }
      if (decision.kind === 'run_now') return { mode: 'run_now' as const, authorizations };
      await this.deps.events.append(
        { appointmentId, kind: SUMMARY_RETRY_AUTHORIZED_EVENT, outcome: 'authorized', ref: { actorUid, authorization: authorizations + 1 } },
        cli,
      );
      await cli.query(`UPDATE admission_appointments SET import_status = 'waiting', updated_at = NOW() WHERE id = $1`, [appointmentId]);
      return { mode: 'authorized' as const, authorizations: authorizations + 1 };
    });

    const base = {
      appointmentId,
      mode: step.mode,
      authorizationsUsed: step.authorizations,
      authorizationsLeft: Math.max(0, MAX_SUMMARY_RETRY_AUTHORIZATIONS - step.authorizations),
    };
    this.log.info({ appointmentId, mode: step.mode, authorizationsUsed: step.authorizations }, 'admission.summary_retry');
    if (step.mode === 'authorized') return base;
    return { ...base, outcome: await this.deps.importer.importOne(appointmentId) };
  }
}
