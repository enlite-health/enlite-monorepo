import type { Application } from 'express';
import type { Pool as PgPool } from 'pg';
import { PubSubClient } from '@shared/events/PubSubClient';
import { poolMax } from '@shared/database/DatabaseConnection';
import { ServicePrincipalSecretManagerRepo } from '../infrastructure/ServicePrincipalSecretManagerRepo';
import { McpAuditLogger } from '../infrastructure/McpAuditLogger';
import { CapabilityRegistry } from '../application/CapabilityRegistry';
import { WorkerProfileGetCapability } from '../application/capabilities/WorkerProfileGetCapability';
import { WorkerDocumentsListCapability } from '../application/capabilities/WorkerDocumentsListCapability';
import { WorkerVacanciesListCapability } from '../application/capabilities/WorkerVacanciesListCapability';
import { WorkerInterviewGetCapability } from '../application/capabilities/WorkerInterviewGetCapability';
import { WorkerProfileUpdateCapability } from '../application/capabilities/WorkerProfileUpdateCapability';
import { WorkerProfileProposeUpdateCapability } from '../application/capabilities/WorkerProfileProposeUpdateCapability';
import { WorkerProfileConfirmUpdateCapability } from '../application/capabilities/WorkerProfileConfirmUpdateCapability';
import { WorkerDocumentsUploadCapability } from '../application/capabilities/WorkerDocumentsUploadCapability';
import { GetWorkerByIdUseCase } from '../../worker/application/GetWorkerByIdUseCase';
import { WorkerRepository } from '../../worker/infrastructure/WorkerRepository';
import { WorkerDocumentsRepository } from '../../worker/infrastructure/WorkerDocumentsRepository';
import { GetCurrentInterviewUseCase } from '../../matching/application/GetCurrentInterviewUseCase';
import { ListAvailableVacanciesForWorkerUseCase } from '../../matching/application/ListAvailableVacanciesForWorkerUseCase';
import { UpdateWorkerProfileFieldsUseCase } from '../../worker/application/UpdateWorkerProfileFieldsUseCase';
import { ProposeWorkerProfileUpdateUseCase } from '../../worker/application/ProposeWorkerProfileUpdateUseCase';
import { ConfirmWorkerProfileUpdateUseCase } from '../../worker/application/ConfirmWorkerProfileUpdateUseCase';
import { PendingProfileChangeRepository } from '../../worker/infrastructure/PendingProfileChangeRepository';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { IngestDocumentFromUrlUseCase } from '../../worker/application/IngestDocumentFromUrlUseCase';
import { GetWorkerStatsUseCase } from '../../worker/application/GetWorkerStatsUseCase';
import { GetProfileEditsStatsUseCase } from '../../worker/application/GetProfileEditsStatsUseCase';
import { WorkerProfileEditsStatsCapability } from '../application/capabilities/WorkerProfileEditsStatsCapability';
import { GetFunnelActivityStatsUseCase } from '../../matching/application/GetFunnelActivityStatsUseCase';
import { FunnelActivityStatsCapability } from '../application/capabilities/FunnelActivityStatsCapability';
import { SearchWorkersUseCase } from '../../worker/application/SearchWorkersUseCase';
import { WorkerStatsGetCapability } from '../application/capabilities/WorkerStatsGetCapability';
import { WorkerSearchCapability } from '../application/capabilities/WorkerSearchCapability';
import { DbQueryReadonlyCapability } from '../application/capabilities/DbQueryReadonlyCapability';
import { PatientChatMapCapability } from '../application/capabilities/PatientChatMapCapability';
import { GetPatientChatMapUseCase } from '@modules/case';
import { WorkerCaseMemoryGetCapability } from '../application/capabilities/WorkerCaseMemoryGetCapability';
import { WorkerCaseMemoryPutCapability } from '../application/capabilities/WorkerCaseMemoryPutCapability';
import { WorkerOptOutRegisterCapability } from '../application/capabilities/WorkerOptOutRegisterCapability';
import { HandoverNotifyCapability } from '../application/capabilities/HandoverNotifyCapability';
import { WorkerApplicationsListCapability } from '../application/capabilities/WorkerApplicationsListCapability';
import { ListWorkerApplicationsUseCase } from '../../matching/application/ListWorkerApplicationsUseCase';
import { NotifyHandoverUseCase } from '../../notification/application/NotifyHandoverUseCase';
import { PeriskopeGroupNotifyService } from '../../notification/infrastructure/PeriskopeGroupNotifyService';
import { PeriskopeNoteService } from '../../notification/infrastructure/PeriskopeNoteService';
import { PeriskopeTicketService } from '../../notification/infrastructure/PeriskopeTicketService';
import { WorkerAccountDeactivateCapability } from '../application/capabilities/WorkerAccountDeactivateCapability';
import { WorkerAvailabilitySetCapability } from '../application/capabilities/WorkerAvailabilitySetCapability';
import { WorkerVacanciesNearbyCapability } from '../application/capabilities/WorkerVacanciesNearbyCapability';
import { WorkerAvailabilityGetCapability } from '../application/capabilities/WorkerAvailabilityGetCapability';
import { FindNearbyVacanciesForWorkerUseCase } from '../../matching/application/FindNearbyVacanciesForWorkerUseCase';
import { AvailabilityRepository } from '../../worker/infrastructure/AvailabilityRepository';
import { RegisterOptOutUseCase } from '../../notification/application/RegisterOptOutUseCase';
import { DeactivateWorkerAccountUseCase } from '../../worker/application/DeactivateWorkerAccountUseCase';
import { SetWorkerAvailabilityUseCase } from '../../worker/application/SetWorkerAvailabilityUseCase';
import { CaseMemoryRepository } from '../../worker/infrastructure/CaseMemoryRepository';
import { WorkerApplicationRegisterCapability } from '../application/capabilities/WorkerApplicationRegisterCapability';
import { WorkerInterviewSlotsListCapability } from '../application/capabilities/WorkerInterviewSlotsListCapability';
import { WorkerInterviewBookCapability } from '../application/capabilities/WorkerInterviewBookCapability';
import { ApplyToVacancyUseCase } from '../../matching/application/ApplyToVacancyUseCase';
import { ListInterviewSlotsForVacancyUseCase } from '../../matching/application/ListInterviewSlotsForVacancyUseCase';
import { BookInterviewSlotUseCase } from '../../notification/application/BookInterviewSlotUseCase';
import { GoogleCalendarService } from '../../matching/infrastructure/GoogleCalendarService';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { ReadonlyDbQueryService } from '../application/ReadonlyDbQueryService';
import { Pool } from 'pg';
import { createMcpRoutes } from '../interfaces/routes/mcpRoutes';
import { mountOAuthRoutes, type OAuthMountResult } from './mountOAuthRoutes';
import { AdminRepository } from '../../identity/infrastructure/AdminRepository';
import { logger } from '@shared/logging/Logger';
import { systemContextMiddleware } from '@shared/database/systemContextMiddleware';

/**
 * Mounts the MCP server at /mcp on the Express app.
 * Only called when MCP_ENABLED=true (feature flag).
 * Com MCP_OAUTH_ENABLED=true, monta também o authorization server OAuth 2.1
 * (conector claude.ai) e o /mcp/v1 passa a aceitar access tokens OAuth.
 */
export function mountMcpRoutes(app: Application, dbPool: PgPool): void {
  const principalRepo = new ServicePrincipalSecretManagerRepo();
  const auditor = new McpAuditLogger();
  const pubsub = new PubSubClient();

  let oauth: OAuthMountResult | undefined;
  if (process.env.MCP_OAUTH_ENABLED === 'true') {
    const issuerUrl = process.env.MCP_OAUTH_ISSUER_URL;
    const signingKey = process.env.MCP_OAUTH_SIGNING_KEY;
    const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY;
    const firebaseAuthDomain = process.env.FIREBASE_WEB_AUTH_DOMAIN;
    if (!issuerUrl || !signingKey || !firebaseApiKey || !firebaseAuthDomain) {
      logger.error(
        {},
        'mcp-oauth: MCP_OAUTH_ENABLED=true mas faltam MCP_OAUTH_ISSUER_URL/MCP_OAUTH_SIGNING_KEY/FIREBASE_WEB_API_KEY/FIREBASE_WEB_AUTH_DOMAIN — OAuth NÃO montado',
      );
    } else {
      oauth = mountOAuthRoutes(
        app,
        { issuerUrl, signingKey, firebaseApiKey, firebaseAuthDomain },
        { staffLookup: new AdminRepository(), auditor },
      );
    }
  }

  // Query SQL read-only ad-hoc (conector Claude): só quando a role dedicada
  // está configurada. Defesa em profundidade: role sem escrita + tx READ ONLY.
  let readonlyDbCapability: DbQueryReadonlyCapability | undefined;
  const roUser = process.env.MCP_DB_RO_USER;
  const roPassword = process.env.MCP_DB_RO_PASSWORD;
  if (roUser && roPassword) {
    const roPool = new Pool({
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      user: roUser,
      password: roPassword,
      // Conta no orçamento de max_connections da instância (o gate do flip de
      // QA pegou este pool fora da conta: 3 instâncias × 3 = +9 num teto de 25).
      max: poolMax('MCP_DB_RO_POOL_MAX', 3),
    });
    // Erro de client idle não derruba o processo (mesmo padrão do
    // DatabaseConnection): sem este handler, o `error` sem listener no pg-pool
    // vira exceção não tratada e mata o servidor INTEIRO quando o Cloud SQL
    // encerra uma conexão ociosa — e este pool fica ocioso quase sempre.
    roPool.on('error', (err) => {
      logger.error({ err: err.message }, 'mcp: erro em client idle do pool read-only (não fatal)');
    });
    // FORA do roteamento por contexto de request, por DESIGN: este pool tem
    // identidade própria (`MCP_DB_RO_USER`, read-only), que é justamente a
    // defesa em profundidade da capability de SQL ad-hoc. Passá-lo pelo
    // `createRlsAwarePool` o faria emprestar o client — e a identidade — da
    // request, jogando fora a garantia de "sem escrita".
    readonlyDbCapability = new DbQueryReadonlyCapability(new ReadonlyDbQueryService(roPool));
  }

  // Shared deps for the propose/confirm profile-update flow (Luz).
  const kms = new KMSEncryptionService();
  const pendingProfileRepo = new PendingProfileChangeRepository(dbPool);

  // Camada A: dossiê da Luz (worker_case_memory).
  const caseMemoryRepo = new CaseMemoryRepository(dbPool);

  // Conversão convite→postulação→entrevista pela Luz (change luz-conversao-entrevista):
  // Calendar (DWD; mock via USE_MOCK_GOOGLE_CALENDAR) + Cloud Tasks (lembretes) que
  // antes só o webhook de botão injetava.
  const getWorkerById = new GetWorkerByIdUseCase(new WorkerRepository(pubsub));
  const bookInterviewSlotUseCase = new BookInterviewSlotUseCase(
    dbPool,
    pubsub,
    new CloudTasksClient(),
    new GoogleCalendarService(),
  );

  const registry = new CapabilityRegistry({
    profileGet: new WorkerProfileGetCapability(
      new GetWorkerByIdUseCase(new WorkerRepository(pubsub)),
    ),
    documentsList: new WorkerDocumentsListCapability(
      new WorkerDocumentsRepository(dbPool),
    ),
    vacanciesList: new WorkerVacanciesListCapability(
      new ListAvailableVacanciesForWorkerUseCase(),
    ),
    interviewGet: new WorkerInterviewGetCapability(
      new GetCurrentInterviewUseCase(),
    ),
    profileUpdate: new WorkerProfileUpdateCapability(
      new UpdateWorkerProfileFieldsUseCase(pubsub),
    ),
    profilePropose: new WorkerProfileProposeUpdateCapability(
      new ProposeWorkerProfileUpdateUseCase(pendingProfileRepo, kms),
    ),
    profileConfirm: new WorkerProfileConfirmUpdateCapability(
      new ConfirmWorkerProfileUpdateUseCase(
        pendingProfileRepo,
        kms,
        new UpdateWorkerProfileFieldsUseCase(pubsub),
      ),
    ),
    documentsUpload: new WorkerDocumentsUploadCapability(
      new IngestDocumentFromUrlUseCase(),
    ),
    statsGet: new WorkerStatsGetCapability(new GetWorkerStatsUseCase(dbPool)),
    profileEditsStats: new WorkerProfileEditsStatsCapability(
      new GetProfileEditsStatsUseCase(dbPool),
    ),
    funnelActivityStats: new FunnelActivityStatsCapability(
      new GetFunnelActivityStatsUseCase(dbPool),
    ),
    workerSearch: new WorkerSearchCapability(new SearchWorkersUseCase(dbPool)),
    caseMemoryGet: new WorkerCaseMemoryGetCapability(caseMemoryRepo),
    caseMemoryPut: new WorkerCaseMemoryPutCapability(caseMemoryRepo),
    optOutRegister: new WorkerOptOutRegisterCapability(
      new RegisterOptOutUseCase(dbPool),
    ),
    accountDeactivate: new WorkerAccountDeactivateCapability(
      new DeactivateWorkerAccountUseCase(dbPool, new RegisterOptOutUseCase(dbPool)),
    ),
    availabilitySet: new WorkerAvailabilitySetCapability(
      new SetWorkerAvailabilityUseCase(dbPool),
    ),
    availabilityGet: new WorkerAvailabilityGetCapability(
      new AvailabilityRepository(),
    ),
    vacanciesNearby: new WorkerVacanciesNearbyCapability(
      new FindNearbyVacanciesForWorkerUseCase(dbPool),
    ),
    applicationRegister: new WorkerApplicationRegisterCapability(
      new ApplyToVacancyUseCase(),
      dbPool,
      getWorkerById,
    ),
    interviewSlotsList: new WorkerInterviewSlotsListCapability(
      new ListInterviewSlotsForVacancyUseCase(dbPool),
    ),
    interviewBook: new WorkerInterviewBookCapability(bookInterviewSlotUseCase, getWorkerById),
    handoverNotify: new HandoverNotifyCapability(
      new NotifyHandoverUseCase(
        new PeriskopeGroupNotifyService(),
        new PeriskopeTicketService(),
        new PeriskopeNoteService(),
      ),
    ),
    patientChatMap: new PatientChatMapCapability(new GetPatientChatMapUseCase()),
    applicationsList: new WorkerApplicationsListCapability(
      new ListWorkerApplicationsUseCase(dbPool),
    ),
    ...(readonlyDbCapability !== undefined ? { dbQuery: readonlyDbCapability } : {}),
    auditor,
  });

  app.use(
    '/mcp',
    // Capability MCP (Luz, conector claude.ai) é contexto de SISTEMA declarado:
    // o isolamento dela é por worker_id/allowlist, não por país (ABAC task 3.3).
    systemContextMiddleware('mcp:enlite-worker-mcp'),
    createMcpRoutes({
      principalRepo,
      auditor,
      registry,
      serverName: 'enlite-worker-mcp',
      serverVersion: '1.0.0',
      ...(oauth !== undefined
        ? { oauthVerifier: oauth.verifier, resourceMetadataUrl: oauth.resourceMetadataUrl }
        : {}),
    }),
  );
}
