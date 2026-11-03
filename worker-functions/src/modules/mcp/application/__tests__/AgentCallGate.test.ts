import { AgentCallGate, REGISTRO_VERSAO_NAO_INFORMADO } from '../AgentCallGate';
import type { AgentCellDecision } from '../AgentCellGuard';
import type { AdmitResult, AgentCallRecord } from '../AgentWriteLimiter';

type Linha = AgentCallRecord & { decision: 'ALLOW' | 'DENY' };

/** Dublês que escrevem na MESMA "tabela" (como o limitador e o repositório escrevem na mesma `permission_audit_log`). */
function montar(opts: { decision: AgentCellDecision; limite?: AdmitResult }) {
  const linhas: Linha[] = [];
  const ordem: string[] = [];
  const gate = new AgentCallGate({
    guard: { check: async () => { ordem.push('guard'); return opts.decision; } },
    limiter: {
      admit: async (c) => {
        ordem.push('limitador+insert');
        const r = opts.limite ?? { ok: true as const };
        linhas.push({ ...c, decision: r.ok ? 'ALLOW' : 'DENY' });
        return r;
      },
    },
    audit: { recordDeny: async (c) => { ordem.push('insert-deny'); linhas.push({ ...c, decision: 'DENY' }); } },
  });
  return { gate, linhas, ordem };
}
const ok = (resource: string, action: string): AgentCellDecision => ({ ok: true, resource, action, exception: false });
const entrada = { uid: 'agent:luz', capability: 'worker.vacancies.list', resourceId: 'w-1', gatilhoId: 'msg-9', registroVersao: 'abc123abc123' };

describe('AgentCallGate (porta MCP do agente, contrato §5-§6)', () => {
  it('ALLOW de leitura: exatamente 1 linha, actor via uid, gatilho e versão do header', async () => {
    const m = montar({ decision: ok('vacancy', 'read') });
    const r = await m.gate.run(entrada, async () => 'dados');
    expect(r).toMatchObject({ allowed: true, value: 'dados' });
    expect(m.linhas).toEqual([
      { uid: 'agent:luz', resource: 'vacancy', action: 'read', resourceId: 'w-1', gatilhoId: 'msg-9', registroVersao: 'abc123abc123', ip: null, decision: 'ALLOW' },
    ]);
  });

  it('ALLOW de escrita: exatamente 1 linha com a ação da célula (≠ read)', async () => {
    const m = montar({ decision: ok('worker', 'update') });
    await m.gate.run({ ...entrada, capability: 'worker.availability.set' }, async () => 1);
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]).toMatchObject({ resource: 'worker', action: 'update', decision: 'ALLOW' });
  });

  it('DENY missing_cell: 1 linha DENY, execução NÃO roda, recusa no formato isError com o code', async () => {
    const m = montar({ decision: { ok: false, code: 'missing_cell', resource: 'interview', action: 'read' } });
    const exec = jest.fn();
    const r = await m.gate.run(entrada, exec);
    expect(exec).not.toHaveBeenCalled();
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]).toMatchObject({ resource: 'interview', action: 'read', decision: 'DENY' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.refusal.isError).toBe(true);
      expect(JSON.parse(r.refusal.content[0].text)).toMatchObject({ code: 'missing_cell', cell: 'interview:read' });
    }
  });

  it('DENY no_cell_declared: 1 linha com resource=mcp_capability e action=<nome da capability>', async () => {
    const m = montar({ decision: { ok: false, code: 'no_cell_declared', resource: 'mcp_capability', action: 'db.query.readonly' } });
    await m.gate.run({ ...entrada, capability: 'db.query.readonly' }, jest.fn());
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]).toMatchObject({ resource: 'mcp_capability', action: 'db.query.readonly', decision: 'DENY' });
  });

  it('DENY por limite: 1 linha DENY (gravada pelo limitador), execução NÃO roda, recusa com retryAfterMs', async () => {
    const m = montar({ decision: ok('worker', 'update'), limite: { ok: false, code: 'AGENT_RATE_LIMITED', retryAfterMs: 4200 } });
    const exec = jest.fn();
    const r = await m.gate.run(entrada, exec);
    expect(exec).not.toHaveBeenCalled();
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0].decision).toBe('DENY');
    if (!r.allowed) expect(JSON.parse(r.refusal.content[0].text)).toMatchObject({ code: 'AGENT_RATE_LIMITED', retryAfterMs: 4200 });
  });

  it('limitador indisponível: recusa AGENT_LIMITER_UNAVAILABLE e a execução NÃO roda (fail-closed)', async () => {
    const m = montar({ decision: ok('worker', 'update'), limite: { ok: false, code: 'AGENT_LIMITER_UNAVAILABLE' } });
    const exec = jest.fn();
    const r = await m.gate.run(entrada, exec);
    expect(exec).not.toHaveBeenCalled();
    if (!r.allowed) expect(JSON.parse(r.refusal.content[0].text).code).toBe('AGENT_LIMITER_UNAVAILABLE');
  });

  it('headers ausentes NÃO viram erro: gatilho_id=null e registro_versao="nao-informado" (a trilha é telemetria, não gate)', async () => {
    const m = montar({ decision: ok('vacancy', 'read') });
    const r = await m.gate.run({ uid: 'agent:luz', capability: 'worker.vacancies.list' }, async () => 'x');
    expect(r.allowed).toBe(true);
    expect(m.linhas[0]).toMatchObject({ gatilhoId: null, registroVersao: REGISTRO_VERSAO_NAO_INFORMADO });
    expect(REGISTRO_VERSAO_NAO_INFORMADO).toBe('nao-informado');
  });

  it('ORDEM observável: guard -> limitador(+INSERT commitado) -> execução; a execução só roda DEPOIS do INSERT', async () => {
    const m = montar({ decision: ok('worker', 'update') });
    await m.gate.run(entrada, async () => { m.ordem.push('executa'); });
    expect(m.ordem).toEqual(['guard', 'limitador+insert', 'executa']);
  });

  it('capability que FALHA depois do INSERT mantém a linha (conta no teto) e o erro sobe', async () => {
    const m = montar({ decision: ok('worker', 'update') });
    await expect(m.gate.run(entrada, async () => { throw new Error('falhou'); })).rejects.toThrow('falhou');
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0].decision).toBe('ALLOW');
  });

  it('guard que lança -> recusa AGENT_AUTHZ_UNAVAILABLE, nada executa (fail-closed)', async () => {
    const gate = new AgentCallGate({
      guard: { check: async () => { throw new Error('db'); } },
      limiter: { admit: async () => ({ ok: true }) },
      audit: { recordDeny: async () => undefined },
    });
    const exec = jest.fn();
    const r = await gate.run(entrada, exec);
    expect(exec).not.toHaveBeenCalled();
    expect(r.allowed).toBe(false);
  });
});
