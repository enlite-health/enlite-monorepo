import type { Application } from 'express';
import type { Pool as PgPool } from 'pg';
import { PubSubClient } from '@shared/events/PubSubClient';
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
import { ProfileChangeAuditRepository } from '../../worker/infrastructure/ProfileChangeAuditRepository';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { IngestDocumentFromUrlUseCase } from '../../worker/application/IngestDocumentFromUrlUseCase';
import { GetWorkerStatsUseCase } from '../../worker/application/GetWorkerStatsUseCase';
import { SearchWorkersUseCase } from '../../worker/application/SearchWorkersUseCase';
import { WorkerStatsGetCapability } from '../application/capabilities/WorkerStatsGetCapability';
import { WorkerSearchCapability } from '../application/capabilities/WorkerSearchCapability';
import { DbQueryReadonlyCapability } from '../application/capabilities/DbQueryReadonlyCapability';
import { WorkerCaseMemoryGetCapability } from '../application/capabilities/WorkerCaseMemoryGetCapability';
import { WorkerCaseMemoryPutCapability } from '../application/capabilities/WorkerCaseMemoryPutCapability';
import { WorkerOptOutRegisterCapability } from '../application/capabilities/WorkerOptOutRegisterCapability';
import { RegisterOptOutUseCase } from '../../notification/application/RegisterOptOutUseCase';
import { CaseMemoryRepository } from '../../worker/infrastructure/CaseMemoryRepository';
import { ReadonlyDbQueryService } from '../application/ReadonlyDbQueryService';
import { Pool } from 'pg';
import { createMcpRoutes } from '../interfaces/routes/mcpRoutes';
import { mountOAuthRoutes, type OAuthMountResult } from './mountOAuthRoutes';
import { AdminRepository } from '../../identity/infrastructure/AdminRepository';
import { logger } from '@shared/logging/Logger';

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
      max: 3,
    });
    readonlyDbCapability = new DbQueryReadonlyCapability(new ReadonlyDbQueryService(roPool));
  }

  // Shared deps for the propose/confirm profile-update flow (Luz).
  const kms = new KMSEncryptionService();
  const pendingProfileRepo = new PendingProfileChangeRepository(dbPool);
  const profileAuditRepo = new ProfileChangeAuditRepository(dbPool);

  // Camada A: dossiê da Luz (worker_case_memory).
  const caseMemoryRepo = new CaseMemoryRepository(dbPool);

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
        profileAuditRepo,
        kms,
        new UpdateWorkerProfileFieldsUseCase(pubsub),
      ),
    ),
    documentsUpload: new WorkerDocumentsUploadCapability(
      new IngestDocumentFromUrlUseCase(),
    ),
    statsGet: new WorkerStatsGetCapability(new GetWorkerStatsUseCase(dbPool)),
    workerSearch: new WorkerSearchCapability(new SearchWorkersUseCase(dbPool)),
    caseMemoryGet: new WorkerCaseMemoryGetCapability(caseMemoryRepo),
    caseMemoryPut: new WorkerCaseMemoryPutCapability(caseMemoryRepo),
    optOutRegister: new WorkerOptOutRegisterCapability(
      new RegisterOptOutUseCase(dbPool),
    ),
    ...(readonlyDbCapability !== undefined ? { dbQuery: readonlyDbCapability } : {}),
    auditor,
  });

  app.use(
    '/mcp',
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
