/**
 * Trava de BOOT da RLS de país (BLOCKER-1).
 *
 * O que estes testes travam:
 *  - com a flag desligada, ZERO query (o boot de hoje não paga nada);
 *  - membership faltando ⇒ o processo RECUSA subir, com o usuário e a role na
 *    mensagem (o cenário real: migration que esquece o GRANT, restore de banco);
 *  - falha ao VERIFICAR também é falha (fail-closed) — subir sem saber é
 *    exatamente o que este assert existe para impedir;
 *  - pool único não inventa uma segunda checagem (não há 2ª identidade).
 */

import { assertDbRoleMembership } from '../assertDbRoleMembership';

function poolWith(member: boolean | null, who = 'enlite_runtime') {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ member, who }], rowCount: 1 }),
  } as never;
}

const ORIGINAL_FLAG = process.env.COUNTRY_RLS_ENABLED;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.COUNTRY_RLS_ENABLED;
  else process.env.COUNTRY_RLS_ENABLED = ORIGINAL_FLAG;
});

describe('assertDbRoleMembership', () => {
  it('flag desligada: não consulta o banco', async () => {
    delete process.env.COUNTRY_RLS_ENABLED;
    const runtime = poolWith(true);

    await assertDbRoleMembership(runtime, runtime);

    expect((runtime as unknown as { query: jest.Mock }).query).not.toHaveBeenCalled();
  });

  it('pool único: verifica só app_runtime', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const runtime = poolWith(true);

    await expect(assertDbRoleMembership(runtime, runtime)).resolves.toBeUndefined();

    const query = (runtime as unknown as { query: jest.Mock }).query;
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('pg_has_role');
    expect(query.mock.calls[0][1]).toEqual(['app_runtime']);
  });

  it('dois pools: cada identidade é verificada na SUA role', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const runtime = poolWith(true, 'enlite_runtime');
    const system = poolWith(true, 'enlite_system');

    await assertDbRoleMembership(runtime, system);

    expect((runtime as unknown as { query: jest.Mock }).query.mock.calls[0][1]).toEqual(['app_runtime']);
    expect((system as unknown as { query: jest.Mock }).query.mock.calls[0][1]).toEqual(['app_system']);
  });

  it('sem membership de app_runtime, RECUSA subir (com usuário e role na mensagem)', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const runtime = poolWith(false, 'enlite_app');

    await expect(assertDbRoleMembership(runtime, runtime)).rejects.toThrow(
      /enlite_app.*app_runtime|app_runtime/,
    );
    await expect(assertDbRoleMembership(runtime, runtime)).rejects.toThrow(/enlite_app/);
  });

  it('sem membership de app_system, RECUSA subir mesmo com runtime ok', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const runtime = poolWith(true, 'enlite_runtime');
    const system = poolWith(false, 'enlite_system');

    await expect(assertDbRoleMembership(runtime, system)).rejects.toThrow(/app_system/);
  });

  it('linha ausente (banco respondeu vazio) também recusa', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const runtime = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as never;

    await expect(assertDbRoleMembership(runtime, runtime)).rejects.toThrow(/desconhecido/);
  });

  it('falha ao VERIFICAR é falha de boot (fail-closed)', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const runtime = { query: jest.fn().mockRejectedValue(new Error('sem conexão')) } as never;

    await expect(assertDbRoleMembership(runtime, runtime)).rejects.toThrow(
      /não foi possível verificar.*sem conexão/s,
    );
  });

  it('erro não-Error na verificação também vira mensagem legível', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const runtime = { query: jest.fn().mockRejectedValue('timeout cru') } as never;

    await expect(assertDbRoleMembership(runtime, runtime)).rejects.toThrow(/timeout cru/);
  });

  // ── ABAC_MAIN_POOL_ROLE: o serviço MCP roda o MESMO index.ts como enlite_system ──

  it('ABAC_MAIN_POOL_ROLE=app_system: exige app_system no pool principal (o caso do MCP)', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    process.env.ABAC_MAIN_POOL_ROLE = 'app_system';
    try {
      const query = jest.fn().mockResolvedValue({ rows: [{ member: true, who: 'enlite_system' }] });
      const pool = { query } as never;

      await expect(assertDbRoleMembership(pool, pool)).resolves.toBeUndefined();
      expect(query.mock.calls[0][1]).toEqual(['app_system']);
    } finally {
      delete process.env.ABAC_MAIN_POOL_ROLE;
    }
  });

  it('ABAC_MAIN_POOL_ROLE inválido LANÇA — config errada não vira assert frouxo', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    process.env.ABAC_MAIN_POOL_ROLE = 'app_admin';
    try {
      const pool = { query: jest.fn() } as never;
      await expect(assertDbRoleMembership(pool, pool)).rejects.toThrow(/ABAC_MAIN_POOL_ROLE inválido/);
    } finally {
      delete process.env.ABAC_MAIN_POOL_ROLE;
    }
  });
});
