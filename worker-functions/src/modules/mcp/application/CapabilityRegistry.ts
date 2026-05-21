import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkerProfileGetCapability } from './capabilities/WorkerProfileGetCapability';
import type { WorkerDocumentsListCapability } from './capabilities/WorkerDocumentsListCapability';
import type { WorkerVacanciesListCapability } from './capabilities/WorkerVacanciesListCapability';
import type { WorkerInterviewGetCapability } from './capabilities/WorkerInterviewGetCapability';
import type { WorkerProfileUpdateCapability } from './capabilities/WorkerProfileUpdateCapability';
import type { WorkerDocumentsUploadCapability } from './capabilities/WorkerDocumentsUploadCapability';
import type { McpAuditEvent } from '../domain/McpAuditEvent';
import type { ServicePrincipal } from '../domain/ServicePrincipal';
import { RateLimitExceededError } from '../domain/McpErrors';
import { WriteRateLimiter } from './WriteRateLimiter';

interface IAuditEmitter {
  emit(event: McpAuditEvent): void;
}

interface CapabilityEntry {
  name: string;
  description: string;
  inputShape: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown>;
}

interface RegistryDeps {
  profileGet: WorkerProfileGetCapability;
  documentsList: WorkerDocumentsListCapability;
  vacanciesList: WorkerVacanciesListCapability;
  interviewGet: WorkerInterviewGetCapability;
  profileUpdate: WorkerProfileUpdateCapability;
  documentsUpload: WorkerDocumentsUploadCapability;
  auditor: IAuditEmitter;
  writeRateLimiter?: WriteRateLimiter;
}

/** Capabilities that mutate state and require rate limiting. */
const WRITE_CAPABILITY_NAMES = new Set([
  'worker.profile.update',
  'worker.documents.upload',
]);

export class CapabilityRegistry {
  private readonly writeRateLimiter: WriteRateLimiter;

  constructor(private readonly deps: RegistryDeps) {
    this.writeRateLimiter = deps.writeRateLimiter ?? new WriteRateLimiter();
  }

  /**
   * Registers all capabilities as tools on the MCP server.
   * Each tool wrapper validates principal.isCapabilityAllowed before delegating.
   * Write capabilities are additionally guarded by the WriteRateLimiter.
   */
  registerAll(server: McpServer, getPrincipal: () => ServicePrincipal | undefined): void {
    const entries = this.buildEntries();
    for (const entry of entries) {
      this.registerOne(server, entry, getPrincipal);
    }
  }

  private buildEntries(): CapabilityEntry[] {
    const {
      profileGet,
      documentsList,
      vacanciesList,
      interviewGet,
      profileUpdate,
      documentsUpload,
    } = this.deps;

    return [
      {
        name: (profileGet.constructor as { NAME?: string }).NAME ?? 'worker.profile.get',
        description:
          (profileGet.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Get worker profile.',
        inputShape:
          (profileGet.constructor as { INPUT_SHAPE?: Record<string, unknown> }).INPUT_SHAPE ?? {},
        execute: (args) => profileGet.execute(args),
      },
      {
        name: (documentsList.constructor as { NAME?: string }).NAME ?? 'worker.documents.list',
        description:
          (documentsList.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'List worker documents.',
        inputShape:
          (documentsList.constructor as { INPUT_SHAPE?: Record<string, unknown> }).INPUT_SHAPE ??
          {},
        execute: (args) => documentsList.execute(args),
      },
      {
        name:
          (vacanciesList.constructor as { NAME?: string }).NAME ?? 'worker.vacancies.list',
        description:
          (vacanciesList.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'List worker vacancies.',
        inputShape:
          (vacanciesList.constructor as { INPUT_SHAPE?: Record<string, unknown> }).INPUT_SHAPE ??
          {},
        execute: (args) => vacanciesList.execute(args),
      },
      {
        name: (interviewGet.constructor as { NAME?: string }).NAME ?? 'worker.interview.get',
        description:
          (interviewGet.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Get worker interview.',
        inputShape:
          (interviewGet.constructor as { INPUT_SHAPE?: Record<string, unknown> }).INPUT_SHAPE ??
          {},
        execute: (args) => interviewGet.execute(args),
      },
      {
        name:
          (profileUpdate.constructor as { NAME?: string }).NAME ?? 'worker.profile.update',
        description:
          (profileUpdate.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Update worker profile.',
        inputShape:
          (profileUpdate.constructor as { INPUT_SHAPE?: Record<string, unknown> }).INPUT_SHAPE ??
          {},
        execute: (args) => profileUpdate.execute(args),
      },
      {
        name:
          (documentsUpload.constructor as { NAME?: string }).NAME ?? 'worker.documents.upload',
        description:
          (documentsUpload.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Upload worker document.',
        inputShape:
          (documentsUpload.constructor as { INPUT_SHAPE?: Record<string, unknown> }).INPUT_SHAPE ??
          {},
        execute: (args) => documentsUpload.execute(args),
      },
    ];
  }

  private registerOne(
    server: McpServer,
    entry: CapabilityEntry,
    getPrincipal: () => ServicePrincipal | undefined,
  ): void {
    const { auditor } = this.deps;
    const rateLimiter = this.writeRateLimiter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registerTool = server.registerTool.bind(server) as (
      name: string,
      config: Record<string, unknown>,
      cb: (args: unknown) => Promise<unknown>,
    ) => void;

    registerTool(
      entry.name,
      { description: entry.description, inputSchema: entry.inputShape },
      async (args: unknown) => {
        const start = Date.now();
        const principal = getPrincipal();
        try {
          if (!principal) {
            throw new Error('ServicePrincipal not resolved');
          }
          if (!principal.isCapabilityAllowed(entry.name)) {
            throw new Error(
              `Capability ${entry.name} not allowed for ${principal.name}`,
            );
          }

          // Rate limit guard for write capabilities
          if (WRITE_CAPABILITY_NAMES.has(entry.name)) {
            const workerId =
              extractWorkerId(args) ?? 'unknown';
            const rlKey = `${principal.name}:${workerId}:${entry.name}`;
            const rlResult = rateLimiter.consume(rlKey);
            if (!rlResult.allowed) {
              throw new RateLimitExceededError(entry.name, rlResult.retryAfterMs);
            }
          }

          const result = await entry.execute(args);
          const workerId = extractWorkerId(args);
          auditor.emit({
            timestamp: new Date().toISOString(),
            principal: principal.name,
            onBehalfOfWorkerId: workerId,
            capability: entry.name,
            argsRedacted: toRecord(args),
            outcome: 'success',
            latencyMs: Date.now() - start,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (err) {
          const principal_ = getPrincipal();
          const workerId = extractWorkerId(args);
          auditor.emit({
            timestamp: new Date().toISOString(),
            principal: principal_?.name ?? 'unknown',
            onBehalfOfWorkerId: workerId,
            capability: entry.name,
            argsRedacted: toRecord(args),
            outcome: 'error',
            errorCode: err instanceof Error ? err.constructor.name : 'UnknownError',
            errorMessage: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - start,
          });
          throw err;
        }
      },
    );
  }
}

function extractWorkerId(args: unknown): string | null {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const candidate = (args as Record<string, unknown>).workerId;
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

function toRecord(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}
