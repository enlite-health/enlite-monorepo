import type { Application } from 'express';
import type { Pool as PgPool } from 'pg';
import { ServicePrincipalSecretManagerRepo } from '../infrastructure/ServicePrincipalSecretManagerRepo';
import { McpAuditLogger } from '../infrastructure/McpAuditLogger';
import { CapabilityRegistry } from '../application/CapabilityRegistry';
import { WorkerProfileGetCapability } from '../application/capabilities/WorkerProfileGetCapability';
import { WorkerDocumentsListCapability } from '../application/capabilities/WorkerDocumentsListCapability';
import { WorkerVacanciesListCapability } from '../application/capabilities/WorkerVacanciesListCapability';
import { WorkerInterviewGetCapability } from '../application/capabilities/WorkerInterviewGetCapability';
import { GetWorkerByIdUseCase } from '../../worker/application/GetWorkerByIdUseCase';
import { WorkerRepository } from '../../worker/infrastructure/WorkerRepository';
import { WorkerDocumentsRepository } from '../../worker/infrastructure/WorkerDocumentsRepository';
import { GetCurrentInterviewUseCase } from '../../matching/application/GetCurrentInterviewUseCase';
import { ListAvailableVacanciesForWorkerUseCase } from '../../matching/application/ListAvailableVacanciesForWorkerUseCase';
import { createMcpRoutes } from '../interfaces/routes/mcpRoutes';

/**
 * Mounts the MCP server at /mcp on the Express app.
 * Only called when MCP_ENABLED=true (feature flag).
 */
export function mountMcpRoutes(app: Application, dbPool: PgPool): void {
  const principalRepo = new ServicePrincipalSecretManagerRepo();
  const auditor = new McpAuditLogger();

  const registry = new CapabilityRegistry({
    profileGet: new WorkerProfileGetCapability(
      new GetWorkerByIdUseCase(new WorkerRepository()),
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
    }),
  );
}
