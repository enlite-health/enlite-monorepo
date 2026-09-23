import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * Spec 026 — "simular grupo de acesso" (só Acesso Master).
 *
 * RED (T1.2): as funções/tabela ainda não existem (migration 458, T1.3). Este arquivo prova o
 * contrato de `data-model.md` §Writer functions / §Expiração híbrida contra banco real — molde
 * `master-group-self-managed-guard.e2e.test.ts` (ator via `SET LOCAL ROLE app_runtime` +
 * `app.user_uid`).
 *
 * Cobre (b) a (h) do "Termina quando" de F1 em `tasks.md`. (a) — diff 0 sem simulação para TODOS
 * os usuários do banco — é T1.4 (SC-001), arquivo próprio.
 */
describe('spec 026 — simular grupo de acesso (banco real)', () => {
  let pool: Pool;

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const MASTER_ID = 'a0000000-0000-0000-0000-000000000001';
  const NONEXISTENT_GROUP = '9999aaaa-9999-aaaa-9999-aaaa99999999';

  const U = {
    /** Master real: membro vivo do Acesso Master. */
    master: 'sim-master-1',
    /** Não-Master: membro vivo só de G1. */
    staff: 'sim-staff-1',
  };

  const GROUP_NAMES = ['E2E Sim G1 026', 'E2E Sim G2 026', 'E2E Sim G3 026 arquivado'];

  let G1: string;
  let G2: string;
  let G3: string;
  /** Snapshot de `effective_permissions(master)` tirado no beforeAll, ANTES de qualquer simulação — usado em (e). */
  let masterPermsSnapshot: string[];

  async function cleanup(): Promise<void> {
    // permission_audit_log.simulation_id tem FK para group_simulations (458, aceita pela
    // partição) — apagar o FILHO (audit_log) ANTES do PAI (group_simulations), senão a FK
    // barra o DELETE de qualquer linha ainda referenciada (achado no GREEN, letra f).
    await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [Object.values(U)]);
    // group_simulations ainda não existe no RED (T1.3 não rodou) — não pode derrubar o beforeAll.
    try {
      await pool.query(`DELETE FROM iam.group_simulations WHERE user_id = ANY($1)`, [Object.values(U)]);
    } catch (err: any) {
      if (err?.code !== '42P01') throw err;
    }
    await pool.query(
      `DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE tenant_id = $1 AND name = ANY($2))`,
      [TENANT, GROUP_NAMES],
    );
    await pool.query(
      `DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE tenant_id = $1 AND name = ANY($2))`,
      [TENANT, GROUP_NAMES],
    );
    await pool.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1)`, [Object.values(U)]);
    await pool.query(`DELETE FROM iam.permission_groups WHERE tenant_id = $1 AND name = ANY($2)`, [TENANT, GROUP_NAMES]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [Object.values(U)]);
  }

  /** Limpa qualquer simulação (aberta ou fechada) de master/staff — roda ANTES de cada teste para isolar estado. */
  async function resetSimulations(): Promise<void> {
    // Filho (audit_log.simulation_id, FK da 458) antes do pai — letra (f) planta uma linha real
    // referenciada; sem isso o DELETE de group_simulations bate na FK no teste seguinte.
    await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [Object.values(U)]);
    await pool.query(`DELETE FROM iam.group_simulations WHERE user_id = ANY($1)`, [Object.values(U)]);
  }

  /** Roda `fn` como `uid`, sob `app_runtime` (a role de runtime real — D112). Commita no sucesso, rollback na exceção. */
  async function asActor<T>(uid: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [uid]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** `iam.start_group_simulation`, devolvendo só o `id` da linha nova (uma chamada só — efeito único). */
  async function startSim(c: PoolClient, groupId: string, ttl: string): Promise<{ id: string }> {
    const r = await c.query<{ id: string }>(`SELECT (iam.start_group_simulation($1, $2::interval)).id AS id`, [groupId, ttl]);
    return r.rows[0];
  }

  /** `iam.end_group_simulation`. */
  async function endSim(c: PoolClient): Promise<boolean> {
    const r = await c.query<{ ok: boolean }>(`SELECT iam.end_group_simulation() AS ok`);
    return r.rows[0].ok;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'qa.sim.master1@enlite.test', 'admin',     'ACTIVE', true, $3),
         ($2, 'qa.sim.staff1@enlite.test',  'recruiter', 'ACTIVE', true, $3)`,
      [U.master, U.staff, TENANT],
    );

    // master: membro vivo do Acesso Master (filiação REAL, exigida por is_master_member).
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.master, MASTER_ID, TENANT]);

    const g1 = await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system) VALUES ($1, $2, 'e2e 026 — grupo vivo com célula e país', false) RETURNING id`,
      [TENANT, GROUP_NAMES[0]],
    );
    G1 = g1.rows[0].id;
    const g2 = await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system) VALUES ($1, $2, 'e2e 026 — grupo vivo sem célula e sem país', false) RETURNING id`,
      [TENANT, GROUP_NAMES[1]],
    );
    G2 = g2.rows[0].id;
    const g3 = await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system, archived_at) VALUES ($1, $2, 'e2e 026 — grupo arquivado', false, now()) RETURNING id`,
      [TENANT, GROUP_NAMES[2]],
    );
    G3 = g3.rows[0].id;

    // staff: membro vivo só de G1 (nunca do Master).
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.staff, G1, TENANT]);

    const patientRead = await pool.query<{ id: string }>(
      `SELECT id FROM iam.permissions WHERE resource = 'patient' AND action = 'read' AND deprecated_at IS NULL`,
    );
    expect(patientRead.rowCount).toBe(1); // premissa: célula do catálogo existe e está ativa
    await pool.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2)`, [G1, patientRead.rows[0].id]);
    await pool.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by) VALUES ($1, 'AR', $2)`, [G1, U.master]);

    // Snapshot ANTES de qualquer simulação (letra e). Não toca group_simulations — passa no RED.
    const snap = await pool.query<{ p: string[] }>(`SELECT iam.effective_permissions($1, $2) AS p`, [U.master, TENANT]);
    masterPermsSnapshot = snap.rows[0].p;
    expect(masterPermsSnapshot.length).toBeGreaterThan(0); // premissa: Master tem células reais (436)
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(resetSimulations);

  it('(b) sob simulação, effective_permissions/effective_countries devolvem só o grupo simulado — nunca os do Master', async () => {
    await asActor(U.master, (c) => startSim(c, G1, '4 hours'));
    const permsG1 = await pool.query<{ p: string[] }>(`SELECT iam.effective_permissions($1, $2) AS p`, [U.master, TENANT]);
    expect(permsG1.rows[0].p).toEqual(['patient:read']);
    expect(permsG1.rows[0].p).not.toContain('permission_management:write');
    const countriesG1 = await pool.query<{ p: string[] }>(`SELECT iam.effective_countries($1, $2) AS p`, [U.master, TENANT]);
    expect(countriesG1.rows[0].p).toEqual(['AR']);

    await asActor(U.master, (c) => startSim(c, G2, '4 hours'));
    const permsG2 = await pool.query<{ p: string[] }>(`SELECT iam.effective_permissions($1, $2) AS p`, [U.master, TENANT]);
    expect(permsG2.rows[0].p).toEqual([]);
    const countriesG2 = await pool.query<{ p: string[] }>(`SELECT iam.effective_countries($1, $2) AS p`, [U.master, TENANT]);
    expect(countriesG2.rows[0].p).toEqual([]);
  });

  it('(c) start recusa não-Master (42501), Master-alvo (23514), arquivado (P0002) e inexistente (P0002)', async () => {
    await expect(
      asActor(U.staff, (c) => c.query(`SELECT iam.start_group_simulation($1, $2::interval)`, [G1, '4 hours'])),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      asActor(U.master, (c) => c.query(`SELECT iam.start_group_simulation($1, $2::interval)`, [MASTER_ID, '4 hours'])),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      asActor(U.master, (c) => c.query(`SELECT iam.start_group_simulation($1, $2::interval)`, [G3, '4 hours'])),
    ).rejects.toMatchObject({ code: 'P0002' });

    await expect(
      asActor(U.master, (c) => c.query(`SELECT iam.start_group_simulation($1, $2::interval)`, [NONEXISTENT_GROUP, '4 hours'])),
    ).rejects.toMatchObject({ code: 'P0002' });
  });

  it('(d) troca fecha a anterior como SUPERSEDED; end fecha como USER e é idempotente; vencida fecha como EXPIRED no próximo toque', async () => {
    let row1: { id: string } | undefined;
    let row2: { id: string } | undefined;

    await asActor(U.master, async (c) => {
      row1 = await startSim(c, G1, '4 hours');
    });
    await asActor(U.master, async (c) => {
      row2 = await startSim(c, G2, '4 hours');
    });

    const r1 = await pool.query<{ ended_reason: string | null; ended_at: Date | null }>(
      `SELECT ended_reason, ended_at FROM iam.group_simulations WHERE id = $1`,
      [row1!.id],
    );
    expect(r1.rows[0].ended_reason).toBe('SUPERSEDED');
    expect(r1.rows[0].ended_at).not.toBeNull();

    let ended1: boolean | undefined;
    await asActor(U.master, async (c) => {
      ended1 = await endSim(c);
    });
    expect(ended1).toBe(true);
    const r2 = await pool.query<{ ended_reason: string | null }>(`SELECT ended_reason FROM iam.group_simulations WHERE id = $1`, [row2!.id]);
    expect(r2.rows[0].ended_reason).toBe('USER');

    let ended2: boolean | undefined;
    await asActor(U.master, async (c) => {
      ended2 = await endSim(c);
    });
    expect(ended2).toBe(false); // idempotente: nada aberto para fechar

    let row3: { id: string } | undefined;
    await asActor(U.master, async (c) => {
      row3 = await startSim(c, G1, '4 hours');
    });
    // Planta a linha aberta como VENCIDA (UPDATE direto — nunca via writer function). Precisa
    // empurrar started_at também: expires_at > started_at é CHECK da tabela, e started_at nasceu
    // ~agora (dentro de startSim) — só mexer em expires_at para o passado violaria o CHECK.
    await pool.query(
      `UPDATE iam.group_simulations SET started_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1`,
      [row3!.id],
    );

    await asActor(U.master, async (c) => {
      await startSim(c, G2, '4 hours');
    });
    const r3 = await pool.query<{ ended_reason: string | null }>(`SELECT ended_reason FROM iam.group_simulations WHERE id = $1`, [row3!.id]);
    expect(r3.rows[0].ended_reason).toBe('EXPIRED');
  });

  it('(e) linha aberta e vencida (plantada) não decide: active_group_simulation → NULL e effective_permissions volta ao Master real', async () => {
    await pool.query(
      `INSERT INTO iam.group_simulations (tenant_id, user_id, group_id, started_at, expires_at)
       VALUES ($1, $2, $3, now() - interval '2 hours', now() - interval '1 minute')`,
      [TENANT, U.master, G1],
    );

    const active = await pool.query<{ row: unknown }>(`SELECT iam.active_group_simulation($1, $2) AS row`, [U.master, TENANT]);
    expect(active.rows[0].row).toBeNull();

    const perms = await pool.query<{ p: string[] }>(`SELECT iam.effective_permissions($1, $2) AS p`, [U.master, TENANT]);
    expect(perms.rows[0].p).toEqual(masterPermsSnapshot);
  });

  it('(f) iam.query_audit continua executando com a coluna simulation_id — linha plantada entra na contagem', async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const until = new Date(Date.now() + 3600 * 1000);

    // FK real (permission_audit_log_simulation_id_fkey, 458): precisa de uma linha de verdade em
    // group_simulations, não de um UUID qualquer — a FK foi aceita pela partição (achado do T1.3).
    // JÁ FECHADA (ended_at/ended_reason preenchidos): uma linha ABERTA aqui viraria a simulação
    // ATIVA do master (G1, só `patient:read`) e derrubaria o próprio `permission_management:read`
    // que query_audit exige do ator — achado ao rodar GREEN, não é o que a letra (f) quer provar.
    const sim = await pool.query<{ id: string }>(
      `INSERT INTO iam.group_simulations (tenant_id, user_id, group_id, started_at, expires_at, ended_at, ended_reason)
       VALUES ($1, $2, $3, now() - interval '10 minutes', now() + interval '50 minutes', now(), 'USER') RETURNING id`,
      [TENANT, U.master, G1],
    );
    await pool.query(
      `INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, resource_id, decision, country, simulation_id)
       VALUES ($1, $2, 'patient', 'read', 'e2e-sim-026', 'ALLOW', 'AR', $3)`,
      [TENANT, U.master, sim.rows[0].id],
    );

    let n: number | undefined;
    await asActor(U.master, async (c) => {
      // Master tem `permission_management:read` (436 — todas as células ativas); premissa checada no molde 456.
      const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM iam.query_audit($1, $2, $3, $4, $5) q`, [
        U.master,
        null,
        since,
        until,
        50,
      ]);
      n = Number(r.rows[0].n);
    });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('(g) RLS de país herda o grupo simulado: sem escopo (G2) nega, com AR (G1) concede', async () => {
    await asActor(U.master, async (c) => {
      await startSim(c, G2, '4 hours');
      const r = await c.query<{ ok: boolean }>(`SELECT iam.session_may_see_country('AR', 'app_runtime', false) AS ok`);
      expect(r.rows[0].ok).toBe(false);
    });

    await asActor(U.master, async (c) => {
      await startSim(c, G1, '4 hours'); // supersede G2 → G1 (tem escopo AR)
      const r = await c.query<{ ok: boolean }>(`SELECT iam.session_may_see_country('AR', 'app_runtime', false) AS ok`);
      expect(r.rows[0].ok).toBe(true);
    });
  });

  it('(h) não-Master com linha plantada à mão NÃO simula: guarda de filiação real vence, nunca o grupo plantado', async () => {
    await pool.query(
      `INSERT INTO iam.group_simulations (tenant_id, user_id, group_id, started_at, expires_at)
       VALUES ($1, $2, $3, now(), now() + interval '1 hour')`,
      [TENANT, U.staff, G2], // G2 não tem célula — se a guarda vazar, effective_permissions viraria []
    );

    const active = await pool.query<{ row: unknown }>(`SELECT iam.active_group_simulation($1, $2) AS row`, [U.staff, TENANT]);
    expect(active.rows[0].row).toBeNull();

    const perms = await pool.query<{ p: string[] }>(`SELECT iam.effective_permissions($1, $2) AS p`, [U.staff, TENANT]);
    expect(perms.rows[0].p).toEqual(['patient:read']); // G1 real, nunca o G2 plantado
  });
});
