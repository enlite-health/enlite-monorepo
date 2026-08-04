import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkerProfileGetCapability } from './capabilities/WorkerProfileGetCapability';
import type { WorkerDocumentsListCapability } from './capabilities/WorkerDocumentsListCapability';
import type { WorkerVacanciesListCapability } from './capabilities/WorkerVacanciesListCapability';
import type { WorkerInterviewGetCapability } from './capabilities/WorkerInterviewGetCapability';
import type { WorkerProfileUpdateCapability } from './capabilities/WorkerProfileUpdateCapability';
import type { WorkerProfileProposeUpdateCapability } from './capabilities/WorkerProfileProposeUpdateCapability';
import type { WorkerProfileConfirmUpdateCapability } from './capabilities/WorkerProfileConfirmUpdateCapability';
import type { WorkerDocumentsUploadCapability } from './capabilities/WorkerDocumentsUploadCapability';
import type { WorkerStatsGetCapability } from './capabilities/WorkerStatsGetCapability';
import type { WorkerSearchCapability } from './capabilities/WorkerSearchCapability';
import type { DbQueryReadonlyCapability } from './capabilities/DbQueryReadonlyCapability';
import type { WorkerCaseMemoryGetCapability } from './capabilities/WorkerCaseMemoryGetCapability';
import type { WorkerCaseMemoryPutCapability } from './capabilities/WorkerCaseMemoryPutCapability';
import type { WorkerOptOutRegisterCapability } from './capabilities/WorkerOptOutRegisterCapability';
import type { WorkerAccountDeactivateCapability } from './capabilities/WorkerAccountDeactivateCapability';
import type { WorkerAvailabilitySetCapability } from './capabilities/WorkerAvailabilitySetCapability';
import type { WorkerVacanciesNearbyCapability } from './capabilities/WorkerVacanciesNearbyCapability';
import type { WorkerAvailabilityGetCapability } from './capabilities/WorkerAvailabilityGetCapability';
import type { WorkerApplicationRegisterCapability } from './capabilities/WorkerApplicationRegisterCapability';
import type { WorkerInterviewSlotsListCapability } from './capabilities/WorkerInterviewSlotsListCapability';
import type { WorkerInterviewBookCapability } from './capabilities/WorkerInterviewBookCapability';
import type { HandoverNotifyCapability } from './capabilities/HandoverNotifyCapability';
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
  profilePropose: WorkerProfileProposeUpdateCapability;
  profileConfirm: WorkerProfileConfirmUpdateCapability;
  documentsUpload: WorkerDocumentsUploadCapability;
  statsGet: WorkerStatsGetCapability;
  workerSearch: WorkerSearchCapability;
  caseMemoryGet: WorkerCaseMemoryGetCapability;
  caseMemoryPut: WorkerCaseMemoryPutCapability;
  optOutRegister: WorkerOptOutRegisterCapability;
  accountDeactivate: WorkerAccountDeactivateCapability;
  availabilitySet: WorkerAvailabilitySetCapability;
  availabilityGet: WorkerAvailabilityGetCapability;
  vacanciesNearby: WorkerVacanciesNearbyCapability;
  applicationRegister: WorkerApplicationRegisterCapability;
  interviewSlotsList: WorkerInterviewSlotsListCapability;
  interviewBook: WorkerInterviewBookCapability;
  handoverNotify: HandoverNotifyCapability;
  /** Só registrada quando o pool read-only (MCP_DB_RO_*) está configurado. */
  dbQuery?: DbQueryReadonlyCapability;
  auditor: IAuditEmitter;
  writeRateLimiter?: WriteRateLimiter;
}

/** Capabilities that mutate state and require rate limiting. */
const WRITE_CAPABILITY_NAMES = new Set([
  'worker.profile.update',
  'worker.profile.proposeUpdate',
  'worker.profile.confirmUpdate',
  'worker.documents.upload',
  'worker.caseMemory.put',
  'worker.optOut.register',
  'worker.account.deactivate',
  'worker.availability.set',
  'worker.application.register',
  'worker.interview.book',
  'handover.notify',
]);

export class CapabilityRegistry {
  private readonly writeRateLimiter: WriteRateLimiter;

  constructor(private readonly deps: RegistryDeps) {
    this.writeRateLimiter = deps.writeRateLimiter ?? new WriteRateLimiter();
  }

  /**
   * Registers as tools on the MCP server only the capabilities allowed for o
   * principal da request (o server é criado por request, então tools/list fica
   * escopado pelo allowlist — um principal read-only nem vê as tools de escrita).
   * Fail-closed: sem principal resolvido, nenhuma tool é registrada.
   * Each tool wrapper re-validates principal.isCapabilityAllowed before delegating.
   * Write capabilities are additionally guarded by the WriteRateLimiter.
   */
  registerAll(server: McpServer, getPrincipal: () => ServicePrincipal | undefined): void {
    const principal = getPrincipal();
    const entries = this.buildEntries().filter(
      (entry) => principal?.isCapabilityAllowed(entry.name) === true,
    );
    for (const entry of entries) {
      // claude.ai rejeita "." em nome de tool (^[a-zA-Z0-9_-]{1,64}$);
      // principals OAuth veem worker_profile_get, internos veem worker.profile.get.
      const exposedName = principal?.sanitizedToolNames
        ? entry.name.replace(/\./g, '_')
        : entry.name;
      this.registerOne(server, entry, exposedName, getPrincipal);
    }
  }

  private buildEntries(): CapabilityEntry[] {
    const {
      profileGet,
      documentsList,
      vacanciesList,
      interviewGet,
      profileUpdate,
      profilePropose,
      profileConfirm,
      documentsUpload,
      statsGet,
      workerSearch,
      caseMemoryGet,
      caseMemoryPut,
      optOutRegister,
      accountDeactivate,
      availabilitySet,
      availabilityGet,
      vacanciesNearby,
      applicationRegister,
      interviewSlotsList,
      interviewBook,
      handoverNotify,
      dbQuery,
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
          (profilePropose.constructor as { NAME?: string }).NAME ??
          'worker.profile.proposeUpdate',
        description:
          (profilePropose.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Propose a worker profile update.',
        inputShape:
          (profilePropose.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => profilePropose.execute(args),
      },
      {
        name:
          (profileConfirm.constructor as { NAME?: string }).NAME ??
          'worker.profile.confirmUpdate',
        description:
          (profileConfirm.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Confirm a proposed worker profile update.',
        inputShape:
          (profileConfirm.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => profileConfirm.execute(args),
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
      {
        name: (statsGet.constructor as { NAME?: string }).NAME ?? 'worker.stats.get',
        description:
          (statsGet.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Aggregate worker statistics.',
        inputShape:
          (statsGet.constructor as { INPUT_SHAPE?: Record<string, unknown> }).INPUT_SHAPE ?? {},
        execute: (args) => statsGet.execute(args),
      },
      {
        name: (workerSearch.constructor as { NAME?: string }).NAME ?? 'worker.search',
        description:
          (workerSearch.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Search workers with filters and pagination.',
        inputShape:
          (workerSearch.constructor as { INPUT_SHAPE?: Record<string, unknown> }).INPUT_SHAPE ??
          {},
        execute: (args) => workerSearch.execute(args),
      },
      {
        name:
          (caseMemoryGet.constructor as { NAME?: string }).NAME ??
          'worker.caseMemory.get',
        description:
          (caseMemoryGet.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Get worker case memory.',
        inputShape:
          (caseMemoryGet.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => caseMemoryGet.execute(args),
      },
      {
        name:
          (caseMemoryPut.constructor as { NAME?: string }).NAME ??
          'worker.caseMemory.put',
        description:
          (caseMemoryPut.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Merge-update worker case memory.',
        inputShape:
          (caseMemoryPut.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => caseMemoryPut.execute(args),
      },
      {
        name:
          (optOutRegister.constructor as { NAME?: string }).NAME ??
          'worker.optOut.register',
        description:
          (optOutRegister.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Register a messaging opt-out for a worker.',
        inputShape:
          (optOutRegister.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => optOutRegister.execute(args),
      },
      {
        name:
          (accountDeactivate.constructor as { NAME?: string }).NAME ??
          'worker.account.deactivate',
        description:
          (accountDeactivate.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Deactivate a worker account at the worker request.',
        inputShape:
          (accountDeactivate.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => accountDeactivate.execute(args),
      },
      {
        name:
          (availabilitySet.constructor as { NAME?: string }).NAME ??
          'worker.availability.set',
        description:
          (availabilitySet.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Replace worker structured availability.',
        inputShape:
          (availabilitySet.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => availabilitySet.execute(args),
      },
      {
        name:
          (availabilityGet.constructor as { NAME?: string }).NAME ??
          'worker.availability.get',
        description:
          (availabilityGet.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Get worker structured availability.',
        inputShape:
          (availabilityGet.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => availabilityGet.execute(args),
      },
      {
        name:
          (vacanciesNearby.constructor as { NAME?: string }).NAME ??
          'worker.vacancies.nearby',
        description:
          (vacanciesNearby.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'List vacancies the worker nearly matches.',
        inputShape:
          (vacanciesNearby.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => vacanciesNearby.execute(args),
      },
      {
        name:
          (applicationRegister.constructor as { NAME?: string }).NAME ??
          'worker.application.register',
        description:
          (applicationRegister.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Register a job application for a worker on a vacancy.',
        inputShape:
          (applicationRegister.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => applicationRegister.execute(args),
      },
      {
        name:
          (interviewSlotsList.constructor as { NAME?: string }).NAME ??
          'worker.interview.slots.list',
        description:
          (interviewSlotsList.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'List future interview slots of a vacancy.',
        inputShape:
          (interviewSlotsList.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => interviewSlotsList.execute(args),
      },
      {
        name:
          (interviewBook.constructor as { NAME?: string }).NAME ?? 'worker.interview.book',
        description:
          (interviewBook.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Book an interview slot for a qualified worker.',
        inputShape:
          (interviewBook.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => interviewBook.execute(args),
      },
      {
        name:
          (handoverNotify.constructor as { NAME?: string }).NAME ?? 'handover.notify',
        description:
          (handoverNotify.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
          'Notify the human team on Periskope that Luz handed a conversation over.',
        inputShape:
          (handoverNotify.constructor as { INPUT_SHAPE?: Record<string, unknown> })
            .INPUT_SHAPE ?? {},
        execute: (args) => handoverNotify.execute(args),
      },
      ...(dbQuery !== undefined
        ? [
            {
              name: (dbQuery.constructor as { NAME?: string }).NAME ?? 'db.query.readonly',
              description:
                (dbQuery.constructor as { DESCRIPTION?: string }).DESCRIPTION ??
                'Run a read-only SQL query.',
              inputShape:
                (dbQuery.constructor as { INPUT_SHAPE?: Record<string, unknown> }).INPUT_SHAPE ??
                {},
              execute: (args: unknown) => dbQuery.execute(args),
            },
          ]
        : []),
    ];
  }

  private registerOne(
    server: McpServer,
    entry: CapabilityEntry,
    exposedName: string,
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
      exposedName,
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
