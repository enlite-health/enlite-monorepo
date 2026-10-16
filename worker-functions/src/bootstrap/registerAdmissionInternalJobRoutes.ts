/**
 * registerAdmissionInternalJobRoutes
 *
 * Monta, em `/api/internal`, os jobs agendados da admissão que fecham a call: relatório diário do Chrome
 * (spec 050 F15) e job de 15 min do fim REAL da call (spec 049 F5) e job de 1 min (spec 050 F26, depois do post-call). A ORDEM é a de antes da extração
 * (Chrome, depois post-call) e vale depois do job de teste do Tactiq e antes da importação.
 * Extraído de src/index.ts para respeitar o limite de 400 linhas.
 */

import type { Express } from 'express';
import type { Pool } from 'pg';
import { systemContextMiddleware } from '../shared/database/systemContextMiddleware';
import { internalAuthMiddleware } from '@modules/notification';
import { ChromeReportJob } from '@modules/matching/application/ChromeReportJob';
import { ChromeReportRepository } from '@modules/matching/infrastructure/ChromeReportRepository';
import { ChromeReportInternalController } from '@modules/matching/interfaces/controllers/ChromeReportInternalController';
import { createChromeReportInternalRoutes } from '@modules/matching/interfaces/routes/chromeReportRoutes';
import { AdmissionPostCallJob } from '@modules/matching/application/AdmissionPostCallJob';
import { AdmissionCalendarSweeps } from '@modules/matching/application/admissionCalendarSweeps';
import { AdmissionPostCallRepository } from '@modules/matching/infrastructure/AdmissionPostCallRepository';
import { AdmissionPostCallInternalController } from '@modules/matching/interfaces/controllers/AdmissionPostCallInternalController';
import { createAdmissionPostCallInternalRoutes } from '@modules/matching/interfaces/routes/admissionPostCallRoutes';
import { AdmissionLiveJob } from '@modules/matching/application/AdmissionLiveJob';
import { AdmissionLiveRepository } from '@modules/matching/infrastructure/AdmissionLiveRepository';
import { AdmissionLiveInternalController } from '@modules/matching/interfaces/controllers/AdmissionLiveInternalController';
import { createAdmissionLiveInternalRoutes } from '@modules/matching/interfaces/routes/admissionLiveRoutes';
import type { createAdmissionExternals } from '@modules/matching/infrastructure/admissionExternals';
import type { AdmissionEventRepository } from '@modules/matching/infrastructure/AdmissionEventRepository';
import { AdmissionFastSummaryRepository } from '@modules/matching/infrastructure/AdmissionFastSummaryRepository';
import { AdmissionFastSummaryStep, type SummaryImportNow } from '@modules/matching/application/AdmissionFastSummaryStep';

export interface AdmissionInternalJobDeps {
  db: Pool;
  externals: ReturnType<typeof createAdmissionExternals>;
  events: AdmissionEventRepository;
  /** A MESMA importação da rota de 15 min: o passo do resumo do job de 1 min chama o `importOne` dela em modo rápido (F28). */
  importer: SummaryImportNow;
}

export function registerAdmissionInternalJobRoutes(app: Express, deps: AdmissionInternalJobDeps): void {
  const { db, externals, events, importer } = deps;

  // spec 050 F15: relatório diário do Chrome (a extensão do Tactiq por operadora). Porta dublada; o adaptador real não tem rede até a F18.
  app.use(
    '/api/internal',
    systemContextMiddleware('job:admission-chrome-report'),
    internalAuthMiddleware,
    createChromeReportInternalRoutes(
      new ChromeReportInternalController(
        new ChromeReportJob({ repo: new ChromeReportRepository(db), chrome: externals.chrome, db }),
      ),
    ),
  );

  // spec 049 F5: job de 15 min — fim REAL da call (Meet API), no_show e detectores de silêncio (Cloud Scheduler, a cada 15 min).
  app.use(
    '/api/internal',
    systemContextMiddleware('job:admission-post-call'),
    internalAuthMiddleware,
    createAdmissionPostCallInternalRoutes(
      new AdmissionPostCallInternalController(
        new AdmissionPostCallJob({
          repo: new AdmissionPostCallRepository(db),
          meet: externals.meet,
          events,
          db,
          calendarSweeps: new AdmissionCalendarSweeps({
            db,
            calendar: externals.calendar,
            events,
            impersonateEmail: process.env.ADMISSION_IMPERSONATE_EMAIL || 'enlite@enlite.health',
          }),
        }),
      ),
    ),
  );

  // spec 050 F26/F28: job de 1 min — início e fim em até 2 min, reabertura, fim cedo e o resumo assim que a transcrição estiver pronta. Sem agendador (terraform) ninguém chama esta rota.
  app.use(
    '/api/internal',
    systemContextMiddleware('job:admission-live'),
    internalAuthMiddleware,
    createAdmissionLiveInternalRoutes(
      new AdmissionLiveInternalController(
        new AdmissionLiveJob({
          live: new AdmissionLiveRepository(db),
          postCall: new AdmissionPostCallRepository(db),
          meet: externals.meet,
          events,
          fast: new AdmissionFastSummaryStep({ repo: new AdmissionFastSummaryRepository(), importer, events, db }),
          db,
        }),
      ),
    ),
  );
}
