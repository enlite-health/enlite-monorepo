import { CapabilityRegistry } from '../CapabilityRegistry';
import { WorkerProfileGetCapability } from '../capabilities/WorkerProfileGetCapability';
import { WorkerDocumentsListCapability } from '../capabilities/WorkerDocumentsListCapability';
import { WorkerVacanciesListCapability } from '../capabilities/WorkerVacanciesListCapability';
import { WorkerInterviewGetCapability } from '../capabilities/WorkerInterviewGetCapability';
import { WorkerProfileUpdateCapability } from '../capabilities/WorkerProfileUpdateCapability';
import { WorkerProfileProposeUpdateCapability } from '../capabilities/WorkerProfileProposeUpdateCapability';
import { WorkerProfileConfirmUpdateCapability } from '../capabilities/WorkerProfileConfirmUpdateCapability';
import { WorkerDocumentsUploadCapability } from '../capabilities/WorkerDocumentsUploadCapability';
import { WriteRateLimiter } from '../WriteRateLimiter';
import { ServicePrincipal } from '../../domain/ServicePrincipal';
import { RateLimitExceededError } from '../../domain/McpErrors';
import { createHash } from 'node:crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const WORKER_ID = '123e4567-e89b-12d3-a456-426614174000';

const ALL_CAPS = [
  'worker.profile.get',
  'worker.documents.list',
  'worker.vacancies.list',
  'worker.interview.get',
  'worker.profile.update',
  'worker.profile.proposeUpdate',
  'worker.profile.confirmUpdate',
  'worker.documents.upload',
];

function makePrincipal(capabilities: string[] = ALL_CAPS): ServicePrincipal {
  return new ServicePrincipal({
    name: 'triage-service',
    allowedCapabilities: capabilities,
    tokenHashes: [sha256('test-token')],
  });
}

function makeAuditor() {
  return { emit: jest.fn() };
}

function makeMcpServer() {
  return { registerTool: jest.fn() };
}

function makeCapabilities() {
  const profileGet = new WorkerProfileGetCapability({
    execute: jest.fn().mockResolvedValue({ worker: { id: WORKER_ID } }),
  } as never);
  const documentsList = new WorkerDocumentsListCapability({
    findByWorkerId: jest.fn().mockResolvedValue(null),
  } as never);
  const vacanciesList = new WorkerVacanciesListCapability({
    execute: jest.fn().mockResolvedValue({ vacancies: [] }),
  } as never);
  const interviewGet = new WorkerInterviewGetCapability({
    execute: jest.fn().mockResolvedValue({ interview: null }),
  } as never);
  const profileUpdate = new WorkerProfileUpdateCapability({
    execute: jest.fn().mockResolvedValue({ workerId: WORKER_ID, fieldsUpdated: ['firstName'] }),
  } as never);
  const profilePropose = new WorkerProfileProposeUpdateCapability({
    execute: jest.fn().mockResolvedValue({
      handle: '223e4567-e89b-12d3-a456-426614174999',
      expiresAt: '2026-06-01T00:05:00.000Z',
      summary: [{ field: 'firstName', newValue: 'João' }],
    }),
  } as never);
  const profileConfirm = new WorkerProfileConfirmUpdateCapability({
    execute: jest.fn().mockResolvedValue({
      applied: true,
      workerId: WORKER_ID,
      fieldsUpdated: ['firstName'],
    }),
  } as never);
  const documentsUpload = new WorkerDocumentsUploadCapability({
    execute: jest.fn().mockResolvedValue({
      filePath: `workers/${WORKER_ID}/ingested/resume_cv/123`,
      documentType: 'resume_cv',
      workerId: WORKER_ID,
    }),
  } as never);
  return {
    profileGet,
    documentsList,
    vacanciesList,
    interviewGet,
    profileUpdate,
    profilePropose,
    profileConfirm,
    documentsUpload,
  };
}

/** Makes a WriteRateLimiter that always allows. */
function makePermissiveRateLimiter(): WriteRateLimiter {
  const rl = new WriteRateLimiter();
  jest.spyOn(rl, 'consume').mockReturnValue({ allowed: true });
  return rl;
}

/** Makes a WriteRateLimiter that always denies. */
function makeDenyingRateLimiter(retryAfterMs = 30_000): WriteRateLimiter {
  const rl = new WriteRateLimiter();
  jest.spyOn(rl, 'consume').mockReturnValue({ allowed: false, retryAfterMs });
  return rl;
}

function makeRegistry(
  overrides: Partial<{
    writeRateLimiter: WriteRateLimiter;
  }> = {},
) {
  const caps = makeCapabilities();
  const auditor = makeAuditor();
  const registry = new CapabilityRegistry({
    ...caps,
    auditor,
    writeRateLimiter: overrides.writeRateLimiter,
  });
  return { registry, caps, auditor };
}

// Helper to get handler for a specific tool name
function getHandler(
  server: ReturnType<typeof makeMcpServer>,
  name: string,
): (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> {
  const call = (server.registerTool.mock.calls as [string, unknown, (args: unknown) => Promise<unknown>][]).find(
    ([n]) => n === name,
  );
  if (!call) throw new Error(`Tool "${name}" not registered`);
  return call[2] as (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CapabilityRegistry', () => {
  beforeEach(() => jest.clearAllMocks());

  // 1. registerAll registers exactly 8 tools
  it('registerAll registers exactly 8 tools on the server', () => {
    const { registry } = makeRegistry();
    const server = makeMcpServer();

    registry.registerAll(server as never, () => makePrincipal());

    expect(server.registerTool).toHaveBeenCalledTimes(8);
  });

  // 2. registerAll uses correct NAMEs
  it('registers tools with correct names', () => {
    const { registry } = makeRegistry();
    const server = makeMcpServer();

    registry.registerAll(server as never, () => undefined);

    const registeredNames = (server.registerTool.mock.calls as [string, ...unknown[]][]).map(
      ([name]) => name,
    );
    for (const cap of ALL_CAPS) {
      expect(registeredNames).toContain(cap);
    }
  });

  // 3. Wrapper: principal not set → throws
  it('wrapper throws when principal is not resolved', async () => {
    const { registry } = makeRegistry();
    const server = makeMcpServer();

    registry.registerAll(server as never, () => undefined);

    const handler = getHandler(server, 'worker.profile.get');
    await expect(handler({ workerId: WORKER_ID })).rejects.toThrow(
      'ServicePrincipal not resolved',
    );
  });

  // 4. Wrapper: principal without permission → throws
  it('wrapper throws when capability is not allowed for principal', async () => {
    const { registry } = makeRegistry();
    const server = makeMcpServer();

    const restrictedPrincipal = makePrincipal([]);
    registry.registerAll(server as never, () => restrictedPrincipal);

    const handler = getHandler(server, 'worker.profile.get');
    await expect(handler({ workerId: WORKER_ID })).rejects.toThrow(/not allowed for/);
  });

  // 5. Happy path → audits outcome=success, returns text content
  it('happy path: audits success and returns text content', async () => {
    const { registry, auditor } = makeRegistry();
    const server = makeMcpServer();
    const principal = makePrincipal();

    registry.registerAll(server as never, () => principal);

    const handler = getHandler(server, 'worker.profile.get');
    const result = await handler({ workerId: WORKER_ID });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(typeof result.content[0].text).toBe('string');
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', principal: 'triage-service' }),
    );
  });

  // 6. Use case error → audits outcome=error with errorCode + errorMessage
  it('use case error: audits with outcome=error and errorCode', async () => {
    const caps = makeCapabilities();
    jest.spyOn(caps.profileGet, 'execute').mockRejectedValue(new Error('DB unavailable'));
    const auditor = makeAuditor();
    const registry = new CapabilityRegistry({ ...caps, auditor });
    const server = makeMcpServer();

    registry.registerAll(server as never, () => makePrincipal());

    const handler = getHandler(server, 'worker.profile.get');
    await expect(handler({ workerId: WORKER_ID })).rejects.toThrow('DB unavailable');
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        errorCode: 'Error',
        errorMessage: 'DB unavailable',
      }),
    );
  });

  // 7. workerId extracted from args into audit onBehalfOfWorkerId
  it('extracts workerId from args into onBehalfOfWorkerId audit field', async () => {
    const { registry, auditor } = makeRegistry();
    const server = makeMcpServer();

    registry.registerAll(server as never, () => makePrincipal());

    const handler = getHandler(server, 'worker.profile.get');
    await handler({ workerId: WORKER_ID });

    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ onBehalfOfWorkerId: WORKER_ID }),
    );
  });

  // 8. latencyMs >= 0 in audit event
  it('latencyMs in audit event is >= 0', async () => {
    const { registry, auditor } = makeRegistry();
    const server = makeMcpServer();

    registry.registerAll(server as never, () => makePrincipal());

    const handler = getHandler(server, 'worker.profile.get');
    await handler({ workerId: WORKER_ID });

    const emitArg = (auditor.emit.mock.calls[0] as [Record<string, unknown>])[0];
    expect(typeof emitArg.latencyMs).toBe('number');
    expect(emitArg.latencyMs as number).toBeGreaterThanOrEqual(0);
  });

  // 9. Write capability + rate limiter returns allowed:false → throws RateLimitExceededError + audit logged
  it('write capability blocked by rate limiter throws RateLimitExceededError and logs audit error', async () => {
    const denyingRl = makeDenyingRateLimiter(25_000);
    const { registry, auditor } = makeRegistry({ writeRateLimiter: denyingRl });
    const server = makeMcpServer();

    registry.registerAll(server as never, () => makePrincipal());

    const handler = getHandler(server, 'worker.profile.update');
    await expect(
      handler({ workerId: WORKER_ID, fields: { firstName: 'Ana' } }),
    ).rejects.toThrow(RateLimitExceededError);

    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        errorCode: 'RateLimitExceededError',
        capability: 'worker.profile.update',
      }),
    );
  });

  // 10. Write capability + rate limiter returns allowed:true → execute runs normally
  it('write capability with allowed rate limit executes normally', async () => {
    const permissiveRl = makePermissiveRateLimiter();
    const { registry, auditor } = makeRegistry({ writeRateLimiter: permissiveRl });
    const server = makeMcpServer();

    registry.registerAll(server as never, () => makePrincipal());

    const handler = getHandler(server, 'worker.profile.update');
    const result = await handler({ workerId: WORKER_ID, fields: { firstName: 'Ana' } });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', capability: 'worker.profile.update' }),
    );
    expect(permissiveRl.consume).toHaveBeenCalled();
  });

  // 11. Read capability does NOT consult the rate limiter
  it('read capability does not call the rate limiter', async () => {
    const permissiveRl = makePermissiveRateLimiter();
    const { registry } = makeRegistry({ writeRateLimiter: permissiveRl });
    const server = makeMcpServer();

    registry.registerAll(server as never, () => makePrincipal());

    const handler = getHandler(server, 'worker.profile.get');
    await handler({ workerId: WORKER_ID });

    expect(permissiveRl.consume).not.toHaveBeenCalled();
  });

  // 12. documents.upload write capability also goes through rate limiter
  it('worker.documents.upload write capability consults rate limiter', async () => {
    const permissiveRl = makePermissiveRateLimiter();
    const { registry, auditor } = makeRegistry({ writeRateLimiter: permissiveRl });
    const server = makeMcpServer();

    registry.registerAll(server as never, () => makePrincipal());

    const handler = getHandler(server, 'worker.documents.upload');
    await handler({
      workerId: WORKER_ID,
      documentType: 'resume_cv',
      mediaUrl: 'https://media.twilio.com/file.pdf',
    });

    expect(permissiveRl.consume).toHaveBeenCalled();
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', capability: 'worker.documents.upload' }),
    );
  });
});
