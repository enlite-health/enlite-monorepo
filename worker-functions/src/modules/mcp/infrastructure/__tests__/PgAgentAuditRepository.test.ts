import { readFileSync } from 'fs';
import { join } from 'path';
import { PgAgentAuditRepository, insertAgentAuditRow } from '../PgAgentAuditRepository';

const call = { uid: 'agent:luz', resource: 'worker', action: 'update', registroVersao: 'v1', gatilhoId: null };

describe('PgAgentAuditRepository (trilha do agente, contrato §6)', () => {
  it('o INSERT carrega actor_kind EXPLÍCITO (agente) — nunca o DEFAULT humano; regex no arquivo e no SQL executado', async () => {
    const src = readFileSync(join(__dirname, '../PgAgentAuditRepository.ts'), 'utf8');
    expect(src).toMatch(/\(tenant_id, user_id, resource, action, resource_id, decision, ip_address, actor_kind, gatilho_id, registro_versao\)/);
    expect(src).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, 'agente', \$8, \$9\)/);
    const q = jest.fn(async () => ({ rows: [] }));
    await insertAgentAuditRow({ query: q } as never, call, 'ALLOW');
    expect(String((q.mock.calls[0] as unknown[])[0])).toContain("'agente'");
    expect((q.mock.calls[0] as unknown[][])[1]).toEqual(['00000000-0000-0000-0000-000000000001', 'agent:luz', 'worker', 'update', null, 'ALLOW', null, null, 'v1']);
  });

  it('recordDeny grava 1 linha DENY; falha de gravação não lança (a chamada já está recusada)', async () => {
    const q = jest.fn(async () => ({ rows: [] }));
    await new PgAgentAuditRepository({ query: q } as never).recordDeny(call);
    expect(q).toHaveBeenCalledTimes(1);
    expect((q.mock.calls[0] as unknown[][])[1]?.[5]).toBe('DENY');
    await expect(new PgAgentAuditRepository({ query: jest.fn(async () => { throw new Error('x'); }) } as never).recordDeny(call)).resolves.toBeUndefined();
  });
});
