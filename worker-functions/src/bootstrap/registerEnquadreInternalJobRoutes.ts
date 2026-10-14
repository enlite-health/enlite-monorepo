/**
 * registerEnquadreInternalJobRoutes — os jobs agendados da esteira pós-call do ENQUADRE (spec 052, Fase 3), ao lado dos da
 * admissão e SEPARADOS deles (D506): rota, contexto de sistema e lote próprios. Nesta rodada só o job de fim de call
 * (`POST /api/internal/jobs/enquadre-post-call`, mesmo padrão e mesmo `X-Internal-Secret` da admissão). Sem job "ao vivo"
 * (decisão do Gabriel, 14/10/2026). A importação do Tactiq entra na rodada seguinte.
 *
 * A LÓGICA é a mesma classe da admissão (`AdmissionPostCallJob`) instanciada com a fonte e o destino do enquadre.
 */
import type { Express } from 'express';
import type { Pool } from 'pg';
import { systemContextMiddleware } from '../shared/database/systemContextMiddleware';
import { internalAuthMiddleware } from '@modules/notification';
import { AdmissionPostCallJob } from '@modules/matching/application/AdmissionPostCallJob';
import { AdmissionPostCallInternalController } from '@modules/matching/interfaces/controllers/AdmissionPostCallInternalController';
import { createEnquadrePostCallInternalRoutes } from '@modules/matching/interfaces/routes/enquadreJobRoutes';
import { EnquadrePostCallRepository } from '@modules/matching/infrastructure/EnquadrePostCallRepository';
import { EnquadreEventTrailRepository } from '@modules/matching/infrastructure/EnquadreEventTrailRepository';
import type { MeetConferencePort } from '@modules/matching/application/ports/MeetConferencePort';
import type { PostCallNaming } from '@modules/matching/application/ports/PostCallPorts';

export const ENQUADRE_POST_CALL_NAMING: PostCallNaming = { prefix: 'enquadre', idKey: 'eventId' };

export interface EnquadreInternalJobDeps {
  db: Pool;
  /** A mesma Meet API (real ou dublê) que a admissão usa. */
  meet: MeetConferencePort;
}

export function registerEnquadreInternalJobRoutes(app: Express, deps: EnquadreInternalJobDeps): void {
  const { db, meet } = deps;
  app.use(
    '/api/internal',
    systemContextMiddleware('job:enquadre-post-call'),
    internalAuthMiddleware,
    createEnquadrePostCallInternalRoutes(
      new AdmissionPostCallInternalController(
        new AdmissionPostCallJob({
          repo: new EnquadrePostCallRepository(db),
          meet,
          events: new EnquadreEventTrailRepository(db),
          naming: ENQUADRE_POST_CALL_NAMING,
          db,
        }),
      ),
    ),
  );
}
