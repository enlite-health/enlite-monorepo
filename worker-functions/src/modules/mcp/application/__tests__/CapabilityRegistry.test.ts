import { CapabilityRegistry } from '../CapabilityRegistry';
import { WorkerProfileGetCapability } from '../capabilities/WorkerProfileGetCapability';
import { WorkerDocumentsListCapability } from '../capabilities/WorkerDocumentsListCapability';
import { WorkerVacanciesListCapability } from '../capabilities/WorkerVacanciesListCapability';
import { WorkerInterviewGetCapability } from '../capabilities/WorkerInterviewGetCapability';
import { ServicePrincipal } from '../../domain/ServicePrincipal';
import { createHash } from 'node:crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const WORKER_ID = '123e4567-e89b-12d3-a456-426614174000';

function makePrincipal(capabilities: string[] = ['worker.profile.get']): ServicePrincipal {
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
  return { profileGet, documentsList, vacanciesList, interviewGet };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CapabilityRegistry', () => {
  beforeEach(() => jest.clearAllMocks());

  // 1. registerAll chama registerTool 4 vezes
  it('registerAll registers exactly 4 tools on the server', () => {
    const caps = makeCapabilities();
    const auditor = makeAuditor();
    const registry = new CapabilityRegistry({ ...caps, auditor });
    const server = makeMcpServer();

    registry.registerAll(server as never, () => makePrincipal(['worker.profile.get', 'worker.documents.list', 'worker.vacancies.list', 'worker.interview.get']));

    expect(server.registerTool).toHaveBeenCalledTimes(4);
  });

  // 2. registerAll usa os NAMEs corretos de cada capability
  it('registers tools with correct names', () => {
    const caps = makeCapabilities();
    const auditor = makeAuditor();
    const registry = new CapabilityRegistry({ ...caps, auditor });
    const server = makeMcpServer();

    registry.registerAll(server as never, () => undefined);

    const registeredNames = (server.registerTool.mock.calls as [string, ...unknown[]][]).map(
      ([name]) => name,
    );
    expect(registeredNames).toContain('worker.profile.get');
    expect(registeredNames).toContain('worker.documents.list');
    expect(registeredNames).toContain('worker.vacancies.list');
    expect(registeredNames).toContain('worker.interview.get');
  });

  // 3. Wrapper: principal não setado → lança erro
  it('wrapper throws when principal is not resolved', async () => {
    const caps = makeCapabilities();
    const auditor = makeAuditor();
    const registry = new CapabilityRegistry({ ...caps, auditor });
    const server = makeMcpServer();

    registry.registerAll(server as never, () => undefined);

    // Get the handler for the first registered tool
    const [, , handler] = server.registerTool.mock.calls[0] as [string, unknown, (args: unknown) => Promise<unknown>];

    await expect(handler({ workerId: WORKER_ID })).rejects.toThrow(
      'ServicePrincipal not resolved',
    );
  });

  // 4. Wrapper: principal sem permissão → lança erro com mensagem correta
  it('wrapper throws when capability is not allowed for principal', async () => {
    const caps = makeCapabilities();
    const auditor = makeAuditor();
    const registry = new CapabilityRegistry({ ...caps, auditor });
    const server = makeMcpServer();

    // Principal com nenhuma capability permitida
    const restrictedPrincipal = makePrincipal([]);
    registry.registerAll(server as never, () => restrictedPrincipal);

    const [, , handler] = server.registerTool.mock.calls[0] as [string, unknown, (args: unknown) => Promise<unknown>];

    await expect(handler({ workerId: WORKER_ID })).rejects.toThrow(
      /not allowed for/,
    );
  });

  // 5. Happy path → audita outcome=success, retorna content[0].type='text'
  it('happy path: audits success and returns text content', async () => {
    const caps = makeCapabilities();
    const auditor = makeAuditor();
    const registry = new CapabilityRegistry({ ...caps, auditor });
    const server = makeMcpServer();

    const principal = makePrincipal(['worker.profile.get', 'worker.documents.list', 'worker.vacancies.list', 'worker.interview.get']);
    registry.registerAll(server as never, () => principal);

    const [, , handler] = server.registerTool.mock.calls[0] as [string, unknown, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>];
    const result = await handler({ workerId: WORKER_ID });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(typeof result.content[0].text).toBe('string');
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', principal: 'triage-service' }),
    );
  });

  // 6. Erro do use case → audita outcome=error com errorCode + errorMessage
  it('use case error: audits with outcome=error and errorCode', async () => {
    const caps = makeCapabilities();
    // Override profileGet to throw
    jest.spyOn(caps.profileGet, 'execute').mockRejectedValue(
      new Error('DB unavailable'),
    );
    const auditor = makeAuditor();
    const registry = new CapabilityRegistry({ ...caps, auditor });
    const server = makeMcpServer();

    const principal = makePrincipal(['worker.profile.get', 'worker.documents.list', 'worker.vacancies.list', 'worker.interview.get']);
    registry.registerAll(server as never, () => principal);

    const [, , handler] = server.registerTool.mock.calls[0] as [string, unknown, (args: unknown) => Promise<unknown>];

    await expect(handler({ workerId: WORKER_ID })).rejects.toThrow('DB unavailable');
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        errorCode: 'Error',
        errorMessage: 'DB unavailable',
      }),
    );
  });

  // 7. workerId extraído dos args para audit onBehalfOfWorkerId
  it('extracts workerId from args into onBehalfOfWorkerId audit field', async () => {
    const caps = makeCapabilities();
    const auditor = makeAuditor();
    const registry = new CapabilityRegistry({ ...caps, auditor });
    const server = makeMcpServer();

    const principal = makePrincipal(['worker.profile.get', 'worker.documents.list', 'worker.vacancies.list', 'worker.interview.get']);
    registry.registerAll(server as never, () => principal);

    const [, , handler] = server.registerTool.mock.calls[0] as [string, unknown, (args: unknown) => Promise<unknown>];
    await handler({ workerId: WORKER_ID });

    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ onBehalfOfWorkerId: WORKER_ID }),
    );
  });

  // 8. latencyMs >= 0 no evento de audit
  it('latencyMs in audit event is >= 0', async () => {
    const caps = makeCapabilities();
    const auditor = makeAuditor();
    const registry = new CapabilityRegistry({ ...caps, auditor });
    const server = makeMcpServer();

    const principal = makePrincipal(['worker.profile.get', 'worker.documents.list', 'worker.vacancies.list', 'worker.interview.get']);
    registry.registerAll(server as never, () => principal);

    const [, , handler] = server.registerTool.mock.calls[0] as [string, unknown, (args: unknown) => Promise<unknown>];
    await handler({ workerId: WORKER_ID });

    const emitArg = (auditor.emit.mock.calls[0] as [Record<string, unknown>])[0];
    expect(typeof emitArg.latencyMs).toBe('number');
    expect(emitArg.latencyMs as number).toBeGreaterThanOrEqual(0);
  });
});
