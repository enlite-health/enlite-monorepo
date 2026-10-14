/**
 * registerEnquadreInternalJobRoutes — os jobs agendados da esteira pós-call do ENQUADRE (spec 052, Fase 3), ao lado dos da
 * admissão e SEPARADOS deles (D506): rota, contexto de sistema e lote próprios. Nesta rodada só o job de fim de call
 * (`POST /api/internal/jobs/enquadre-post-call`, mesmo padrão e mesmo `X-Internal-Secret` da admissão) e o da importação do Tactiq
 * (`POST /api/internal/jobs/enquadre-import`, T-34b rodada 2). Sem job "ao vivo" (decisão do Gabriel, 14/10/2026).
 *
 * A LÓGICA é a mesma classe da admissão (`AdmissionPostCallJob`, `AdmissionImportService`) instanciada com a fonte e o destino do enquadre.
 */
import type { Express } from 'express';
import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { systemContextMiddleware } from '../shared/database/systemContextMiddleware';
import { internalAuthMiddleware } from '@modules/notification';
import { AdmissionPostCallJob } from '@modules/matching/application/AdmissionPostCallJob';
import { AdmissionPostCallInternalController } from '@modules/matching/interfaces/controllers/AdmissionPostCallInternalController';
import { createEnquadreImportInternalRoutes, createEnquadrePostCallInternalRoutes } from '@modules/matching/interfaces/routes/enquadreJobRoutes';
import { AdmissionImportService } from '@modules/matching/application/AdmissionImportService';
import { AdmissionImportInternalController } from '@modules/matching/interfaces/controllers/AdmissionImportInternalController';
import { EnquadreImportRepository, type EnquadreImportSubject } from '@modules/matching/infrastructure/EnquadreImportRepository';
import { EnquadreImportDestination, type EnquadreImportDestinationDeps } from '@modules/matching/infrastructure/EnquadreImportDestination';
import type { AdmissionSummaryPort, TranscriptVaultPort } from '@modules/matching/application/ports/AdmissionImportPorts';
import type { TactiqMcpPort, TactiqTokenProvider } from '@modules/matching/application/ports/TactiqPorts';
import type { AdmissionLogger } from '@modules/matching/application/AdmissionMessagingService';
import { EnquadrePostCallRepository } from '@modules/matching/infrastructure/EnquadrePostCallRepository';
import { EnquadreEventTrailRepository } from '@modules/matching/infrastructure/EnquadreEventTrailRepository';
import type { MeetConferencePort } from '@modules/matching/application/ports/MeetConferencePort';
import type { PostCallNaming } from '@modules/matching/application/ports/PostCallPorts';
import { EnquadrePresenceService } from '@modules/matching/application/EnquadrePresenceService';

export const ENQUADRE_POST_CALL_NAMING: PostCallNaming = { prefix: 'enquadre', idKey: 'eventId' };

/** As fronteiras da importação: as MESMAS da admissão (vínculo e MCP do Tactiq), o cofre e o gerador do enquadre. */
export interface EnquadreImportDeps {
  tokens: TactiqTokenProvider;
  mcp: TactiqMcpPort;
  /** Cofre do enquadre (`ENQUADRE_TRANSCRIPT_VAULT_BUCKET`). */
  vault: TranscriptVaultPort;
  /** Gerador de resumo com o perfil do enquadre (prompt em arquivo, convocados, gate próprio). */
  summary: AdmissionSummaryPort;
  /** Para teste: substitui o armazenamento do PDF e o decifrador dos nomes. */
  destination?: EnquadreImportDestinationDeps;
  log?: AdmissionLogger;
  now?: () => Date;
  batchSize?: number;
}

export interface EnquadreInternalJobDeps {
  db: Pool;
  /** A mesma Meet API (real ou dublê) que a admissão usa. */
  meet: MeetConferencePort;
  /** Para teste: substitui a medição de presença (padrão: `EnquadrePresenceService` sobre `meet` e `db`). */
  presence?: Pick<EnquadrePresenceService, 'runOnce'>;
  /** Ausente = só o job de fim de call (a importação não é registrada). */
  import?: EnquadreImportDeps;
}

/** A MESMA `AdmissionImportService` da admissão, com a fonte (`enquadre_events`), o destino e a trilha do enquadre. */
export function createEnquadreImportService(db: Pool, d: EnquadreImportDeps): AdmissionImportService<EnquadreImportSubject> {
  return new AdmissionImportService<EnquadreImportSubject>({
    repo: new EnquadreImportRepository(db, d.batchSize),
    destination: new EnquadreImportDestination({ db, ...d.destination }),
    events: new EnquadreEventTrailRepository(db),
    tokens: d.tokens, mcp: d.mcp, vault: d.vault, summary: d.summary, db, log: d.log, now: d.now,
  });
}

/**
 * O job de fim de call do enquadre + a medição de presença DEPOIS dele (T-34c), na mesma rodada. A presença nunca derruba o fim de
 * call: o serviço engole as próprias falhas (presença NULL + log do motivo), e aqui um erro inesperado também vira só um log.
 */
function withPresence(job: Pick<AdmissionPostCallJob, 'runOnce'>, presence: Pick<EnquadrePresenceService, 'runOnce'>): Pick<AdmissionPostCallJob, 'runOnce'> {
  return {
    async runOnce(now) {
      const summary = await job.runOnce(now);
      await presence.runOnce().catch(() => logger.error({ reason: 'unexpected' }, 'enquadre.presence.failed'));
      return summary;
    },
  };
}

export function registerEnquadreInternalJobRoutes(app: Express, deps: EnquadreInternalJobDeps): void {
  const { db, meet } = deps;
  if (deps.import) {
    app.use(
      '/api/internal',
      systemContextMiddleware('job:enquadre-import'),
      internalAuthMiddleware,
      createEnquadreImportInternalRoutes(new AdmissionImportInternalController(createEnquadreImportService(db, deps.import))),
    );
  }
  app.use(
    '/api/internal',
    systemContextMiddleware('job:enquadre-post-call'),
    internalAuthMiddleware,
    createEnquadrePostCallInternalRoutes(
      new AdmissionPostCallInternalController(
        withPresence(
          new AdmissionPostCallJob({
            repo: new EnquadrePostCallRepository(db),
            meet,
            events: new EnquadreEventTrailRepository(db),
            naming: ENQUADRE_POST_CALL_NAMING,
            db,
          }),
          deps.presence ?? new EnquadrePresenceService({ meet, db }),
        ),
      ),
    ),
  );
}
