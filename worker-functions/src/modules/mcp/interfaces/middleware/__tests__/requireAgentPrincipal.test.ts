import type { Request, Response } from 'express';
import { AGENT_AUDIENCE, AGENT_IDENTITY_HEADER } from '../../../domain/AgentCapabilityCells';
import type { AgentUserRepository, AgentUserRow } from '../../../infrastructure/AgentUserRepository';
import { requireAgentPrincipal } from '../requireAgentPrincipal';

const SA = 'luz-sa@enlite-teste.iam.gserviceaccount.com';
const ENV = { GCP_PROJECT_ID: 'enlite-teste', USE_MOCK_AUTH: 'true' } as NodeJS.ProcessEnv;
const token = (p: object = {}): string =>
  `mock_${Buffer.from(JSON.stringify({ email: SA, email_verified: true, aud: AGENT_AUDIENCE, ...p })).toString('base64')}`;

function repo(rows: () => AgentUserRow[]): AgentUserRepository & { calls: number } {
  const r = { calls: 0, async findByEmail() { r.calls += 1; return rows(); } };
  return r;
}
const agente = (status: string, accountType = 'agent'): AgentUserRow => ({ uid: 'agent:luz', accountType, status });

async function chamar(users: AgentUserRepository, headers: Record<string, string>) {
  const req = { headers } as unknown as Request;
  let status = 0;
  let body: unknown;
  const res = { status(c: number) { status = c; return res; }, json(b: unknown) { body = b; return res; } } as unknown as Response;
  const next = jest.fn();
  await requireAgentPrincipal({ users, env: ENV })(req, res, next);
  return { req, status, body, next };
}
const H = (t: string) => ({ [AGENT_IDENTITY_HEADER]: t });

describe('requireAgentPrincipal (porta MCP do agente, contrato §2)', () => {
  it('token inválido -> 401 AGENT_IDENTITY_INVALID e nem lê o banco', async () => {
    const u = repo(() => [agente('ACTIVE')]);
    const r = await chamar(u, H('f'.repeat(64)));
    expect([r.status, r.body, r.next.mock.calls.length, u.calls]).toEqual([401, { code: 'AGENT_IDENTITY_INVALID' }, 0, 0]);
  });

  it('e-mail sem linha em users -> 401 com o MESMO código', async () => {
    const r = await chamar(repo(() => []), H(token()));
    expect([r.status, r.body]).toEqual([401, { code: 'AGENT_IDENTITY_INVALID' }]);
  });

  it('account_type=staff com o e-mail da SA -> 401 com o MESMO código (não revela qual condição falhou)', async () => {
    const r = await chamar(repo(() => [agente('ACTIVE', 'staff')]), H(token()));
    expect([r.status, r.body, r.next.mock.calls.length]).toEqual([401, { code: 'AGENT_IDENTITY_INVALID' }, 0]);
  });

  it('duas linhas para o mesmo e-mail (ambíguo) -> 401 AGENT_IDENTITY_INVALID', async () => {
    const r = await chamar(repo(() => [agente('ACTIVE'), agente('ACTIVE', 'staff')]), H(token()));
    expect([r.status, r.body]).toEqual([401, { code: 'AGENT_IDENTITY_INVALID' }]);
  });

  it.each(['SUSPENDED', 'DEACTIVATED', 'PENDING_ONBOARDING'])('status=%s -> 401 AGENT_DISABLED', async (st) => {
    const r = await chamar(repo(() => [agente(st)]), H(token()));
    expect([r.status, r.body, r.next.mock.calls.length]).toEqual([401, { code: 'AGENT_DISABLED' }, 0]);
  });

  it('status=ACTIVE -> next() com req.agentPrincipal={uid:agent:luz}; o header aceita Bearer e token puro', async () => {
    const a = await chamar(repo(() => [agente('ACTIVE')]), H(token()));
    expect(a.next).toHaveBeenCalledTimes(1);
    expect(a.req.agentPrincipal).toEqual({ uid: 'agent:luz', email: SA });
    const b = await chamar(repo(() => [agente('ACTIVE')]), H(`Bearer ${token()}`));
    expect(b.next).toHaveBeenCalledTimes(1);
    expect(b.req.agentPrincipal?.uid).toBe('agent:luz');
  });

  it('ZERO CACHE: duas chamadas seguidas com o status mudando entre elas — a 2ª reflete o novo status (repo chamado 2x)', async () => {
    let status = 'ACTIVE';
    const u = repo(() => [agente(status)]);
    const mw = requireAgentPrincipal({ users: u, env: ENV });
    const rodar = async () => {
      let s = 0;
      const res = { status(c: number) { s = c; return res; }, json() { return res; } } as unknown as Response;
      const next = jest.fn();
      await mw({ headers: H(token()) } as unknown as Request, res, next);
      return { s, passou: next.mock.calls.length === 1 };
    };
    expect(await rodar()).toEqual({ s: 0, passou: true });
    status = 'SUSPENDED';
    expect(await rodar()).toEqual({ s: 401, passou: false });
    status = 'ACTIVE';
    expect(await rodar()).toEqual({ s: 0, passou: true });
    expect(u.calls).toBe(3);
  });

  it('header presente + falha NUNCA chama next() (não cai no caminho legado)', async () => {
    const r = await chamar(repo(() => [agente('ACTIVE')]), { ...H(token({ aud: 'https://api.enlite.health/assistentes' })), authorization: 'Bearer abc' });
    expect([r.status, r.next.mock.calls.length]).toEqual([401, 0]);
  });

  it('erro ao ler users -> 503 fail-closed (nunca next)', async () => {
    const u: AgentUserRepository = { async findByEmail() { throw new Error('pool'); } };
    const r = await chamar(u, H(token()));
    expect([r.status, r.body, r.next.mock.calls.length]).toEqual([503, { code: 'AGENT_AUTH_UNAVAILABLE' }, 0]);
  });

  it('header ausente: não é a porta do agente, segue (controle positivo do "presente => só este caminho")', async () => {
    const u = repo(() => [agente('ACTIVE')]);
    const r = await chamar(u, {});
    expect([r.next.mock.calls.length, u.calls, r.req.agentPrincipal]).toEqual([1, 0, undefined]);
  });
});
