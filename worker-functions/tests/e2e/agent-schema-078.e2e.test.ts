/**
 * agent-schema-078.e2e.test.ts — spec 078, fase M2 (migration 556): o agente como pessoa no ABAC, provado no BANCO real.
 *
 * Seção 1 (M2.1.1): `users.account_type` aceita `agent` e continua recusando o resto. Banco: DATABASE_URL (dono, só para
 * semear e medir catálogo). Nada passa pela API. As seções seguintes (2: triggers; 3: auditoria; 4: seed) entram nas
 * tasks M2.1.3, M2.1.5 e M2.1.7, neste MESMO arquivo.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import { CELULAS_VEDADAS_A_AGENTE } from '../../src/modules/identity/permissions/domain/ActorClass';
import { PgPermissionAuditRepository } from '../../src/modules/identity/permissions/infrastructure/PgPermissionAuditRepository';
import { isStaffAccount } from '../../src/modules/identity/domain/AccountType';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const PREFIXO = 'e2e-agent078-';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
});
afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${PREFIXO}%`]);
  await pool.end();
});

describe('556 §1 — users.account_type aceita `agent`', () => {
  const inserir = (uid: string, role: string, tipo: string) =>
    pool.query(
      `INSERT INTO users (firebase_uid, email, role, account_type, tenant_id) VALUES ($1, $2, $3, $4, $5)`,
      [uid, `${uid}@e2e.local`, role, tipo, TENANT],
    );

  it('account_type=agent grava (role=support: a ponte não classifica, o tipo vai declarado)', async () => {
    await inserir(`${PREFIXO}ok-agent`, 'support', 'agent');
    const r = await pool.query(`SELECT account_type FROM users WHERE firebase_uid = $1`, [`${PREFIXO}ok-agent`]);
    expect(r.rows).toEqual([{ account_type: 'agent' }]);
  });

  it('controle: staff e worker seguem gravando', async () => {
    await inserir(`${PREFIXO}ok-staff`, 'recruiter', 'staff');
    await inserir(`${PREFIXO}ok-worker`, 'worker', 'worker');
    const r = await pool.query(`SELECT account_type FROM users WHERE firebase_uid LIKE $1 ORDER BY 1`, [`${PREFIXO}ok-%`]);
    expect(r.rows.map((x) => x.account_type).sort()).toEqual(['agent', 'staff', 'worker']);
  });

  it.each([['bot'], ['patient'], ['']])('account_type=%j → check_violation (23514, nunca vira tipo novo por engano)', async (tipo) => {
    await expect(inserir(`${PREFIXO}no-${tipo || 'vazio'}`, 'support', tipo)).rejects.toMatchObject({ code: '23514' });
    const r = await pool.query(`SELECT count(*)::int AS n FROM users WHERE firebase_uid = $1`, [`${PREFIXO}no-${tipo || 'vazio'}`]);
    expect(r.rows[0].n).toBe(0);
  });

  it('o CHECK do catálogo lista exatamente staff|worker|agent', async () => {
    const r = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.users'::regclass AND conname = 'users_account_type_check'`,
    );
    expect(r.rows).toHaveLength(1);
    for (const t of ['staff', 'worker', 'agent']) expect(r.rows[0].def).toContain(`'${t}'`);
  });

  it('isStaffAccount({accountType:"agent"}) continua false (fail-closed: agente não é staff)', () => {
    expect(isStaffAccount({ accountType: 'agent' })).toBe(false);
    expect(isStaffAccount({ accountType: 'staff' })).toBe(true); // controle positivo
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 556 §2 — classe AGENT, células vedadas e os 3 triggers (item 36). Escritas como `app_runtime` via
// iam.set_group_permissions / iam.add_member (ator = gestor com permission_management:write, tenant próprio);
// o dono (DATABASE_URL) só semeia e troca classe (não há função de painel para isso).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('556 §2 — grupo AGENT: células vedadas e os 3 triggers', () => {
  const T2 = 'e0780000-0000-0000-0000-000000000002';
  const GESTOR = `${PREFIXO}gestor`;
  const AGENTE = `${PREFIXO}luz-teste`;
  const HUMANO = `${PREFIXO}humano`;
  const NOME = 'E2E078 ';
  let permId: Record<string, string>;
  let seq = 0;

  const limparSecao2 = async () => {
    const g = `(SELECT id FROM iam.permission_groups WHERE tenant_id = '${T2}')`;
    await pool.query(`DELETE FROM iam.permission_group_changes WHERE group_id IN ${g}`);
    await pool.query(`DELETE FROM iam.group_permissions WHERE group_id IN ${g}`);
    await pool.query(`DELETE FROM iam.user_groups WHERE tenant_id = $1`, [T2]);
    await pool.query(`DELETE FROM iam.permission_groups WHERE tenant_id = $1`, [T2]);
    await pool.query(`DELETE FROM users WHERE firebase_uid IN ($1, $2, $3)`, [GESTOR, AGENTE, HUMANO]);
    await pool.query(`DELETE FROM iam.tenants WHERE id = $1`, [T2]);
  };

  const ensurePerm = async (cell: string): Promise<string> => {
    const [resource, action] = cell.split(':');
    await pool.query(
      `INSERT INTO iam.permissions (resource, action, description, category) VALUES ($1, $2, 'e2e078', 'Operações') ON CONFLICT (resource, action) DO NOTHING`,
      [resource, action],
    );
    const r = await pool.query(`SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    return r.rows[0].id;
  };

  const novoGrupo = async (classe: 'INTERNAL' | 'EXTERNAL_THIRD_PARTY' | 'AGENT', cells: string[] = []): Promise<string> => {
    const r = await pool.query(
      `INSERT INTO iam.permission_groups (tenant_id, name, actor_class) VALUES ($1, $2, $3) RETURNING id`,
      [T2, `${NOME}${classe} ${++seq}`, classe],
    );
    for (const c of cells) {
      await pool.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2)`, [r.rows[0].id, permId[c]]);
    }
    return r.rows[0].id;
  };

  const comoRuntime = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [GESTOR]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  const setCells = (grupo: string, cells: string[]) =>
    comoRuntime((c) => c.query(`SELECT iam.set_group_permissions($1, $2::uuid[], 'e2e078')`, [grupo, cells.map((x) => permId[x])]));
  const addMember = (grupo: string, uid: string) => comoRuntime((c) => c.query(`SELECT iam.add_member($1, $2)`, [grupo, uid]));
  const celulasDe = async (grupo: string) =>
    (await pool.query(`SELECT p.resource || ':' || p.action AS c FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id WHERE gp.group_id = $1 ORDER BY 1`, [grupo])).rows.map((x) => x.c);
  const trocarClasse = (grupo: string, classe: string) => pool.query(`UPDATE iam.permission_groups SET actor_class = $2 WHERE id = $1`, [grupo, classe]);

  beforeAll(async () => {
    await limparSecao2();
    permId = {};
    for (const c of ['permission_management:write', 'permission_management:read', 'worker:export', 'vacancy:read', 'worker:read']) permId[c] = await ensurePerm(c);
    await pool.query(`INSERT INTO iam.tenants (id, name, region, status) VALUES ($1, 'E2E078 tenant', 'SA', 'ACTIVE')`, [T2]);
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, account_type, status, is_active, tenant_id) VALUES
         ($1, $4, 'admin', 'staff', 'ACTIVE', true, $7), ($2, $5, 'support', 'agent', 'ACTIVE', true, $7), ($3, $6, 'recruiter', 'staff', 'ACTIVE', true, $7)`,
      [GESTOR, AGENTE, HUMANO, `${GESTOR}@e2e.local`, `${AGENTE}@e2e.local`, `${HUMANO}@e2e.local`, T2],
    );
    const gGestor = await novoGrupo('INTERNAL', ['permission_management:write']);
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [GESTOR, gGestor, T2]);
  });
  afterAll(async () => {
    await limparSecao2();
  });

  describe('T1 — célula vedada entrando em grupo AGENT', () => {
    it.each([...CELULAS_VEDADAS_A_AGENTE].sort())('%s em grupo AGENT → check_violation (23514) e nada é gravado', async (celula) => {
      const g = await novoGrupo('AGENT');
      await expect(setCells(g, [celula])).rejects.toMatchObject({ code: '23514' });
      expect(await celulasDe(g)).toEqual([]);
    });

    it('célula permitida (vacancy:read, worker:read) em grupo AGENT → grava', async () => {
      const g = await novoGrupo('AGENT');
      await setCells(g, ['vacancy:read', 'worker:read']);
      expect(await celulasDe(g)).toEqual(['vacancy:read', 'worker:read']);
    });

    it('controle: a MESMA célula vedada em grupo INTERNAL → grava (a classe é o que veda)', async () => {
      const g = await novoGrupo('INTERNAL');
      await setCells(g, ['worker:export', 'permission_management:read']);
      expect(await celulasDe(g)).toEqual(['permission_management:read', 'worker:export']);
    });
  });

  describe('T2 — a classe do grupo mudando', () => {
    it('grupo INTERNAL com permission_management:write virando AGENT → erro e a classe não muda', async () => {
      const g = await novoGrupo('INTERNAL', ['permission_management:write']);
      await expect(trocarClasse(g, 'AGENT')).rejects.toMatchObject({ code: '23514' });
      const r = await pool.query(`SELECT actor_class FROM iam.permission_groups WHERE id = $1`, [g]);
      expect(r.rows[0].actor_class).toBe('INTERNAL');
    });

    it('grupo AGENT com um agente-membro virando INTERNAL → erro', async () => {
      const g = await novoGrupo('AGENT');
      await addMember(g, AGENTE);
      await expect(trocarClasse(g, 'INTERNAL')).rejects.toMatchObject({ code: '23514' });
      await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE group_id = $1`, [g]);
    });

    it('grupo INTERNAL com membro humano virando AGENT → erro (mudança de classe de grupo com membros)', async () => {
      const g = await novoGrupo('INTERNAL', ['vacancy:read']);
      await addMember(g, HUMANO);
      await expect(trocarClasse(g, 'AGENT')).rejects.toMatchObject({ code: '23514' });
      await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE group_id = $1`, [g]);
    });

    it('controle: grupo AGENT VAZIO virando INTERNAL grava, e INTERNAL vazio sem célula vedada virando AGENT grava', async () => {
      const a = await novoGrupo('AGENT');
      await trocarClasse(a, 'INTERNAL');
      const b = await novoGrupo('INTERNAL', ['vacancy:read']);
      await trocarClasse(b, 'AGENT');
      const r = await pool.query(`SELECT id, actor_class FROM iam.permission_groups WHERE id = ANY($1) ORDER BY actor_class`, [[a, b]]);
      expect(r.rows.map((x) => x.actor_class)).toEqual(['AGENT', 'INTERNAL']);
    });

    it('controle da 285: INTERNAL com membro humano virando EXTERNAL_THIRD_PARTY segue permitido (sem a regra nova)', async () => {
      const g = await novoGrupo('INTERNAL', ['vacancy:read']);
      await addMember(g, HUMANO);
      await trocarClasse(g, 'EXTERNAL_THIRD_PARTY');
      await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE group_id = $1`, [g]);
    });
  });

  describe('T3 — quem é membro de grupo AGENT', () => {
    it('agente em grupo INTERNAL → erro; o vínculo não nasce', async () => {
      const g = await novoGrupo('INTERNAL');
      await expect(addMember(g, AGENTE)).rejects.toMatchObject({ code: '23514' });
      const r = await pool.query(`SELECT count(*)::int AS n FROM iam.user_groups WHERE group_id = $1`, [g]);
      expect(r.rows[0].n).toBe(0);
    });

    it('agente em grupo AGENT → grava', async () => {
      const g = await novoGrupo('AGENT');
      await addMember(g, AGENTE);
      const r = await pool.query(`SELECT count(*)::int AS n FROM iam.user_groups WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`, [g, AGENTE]);
      expect(r.rows[0].n).toBe(1);
      await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE group_id = $1`, [g]);
    });

    it('membro humano em grupo AGENT → erro (a regra vale nas duas direções)', async () => {
      const g = await novoGrupo('AGENT');
      await expect(addMember(g, HUMANO)).rejects.toMatchObject({ code: '23514' });
    });

    it('controle: humano em grupo INTERNAL → grava', async () => {
      const g = await novoGrupo('INTERNAL');
      await addMember(g, HUMANO);
      const r = await pool.query(`SELECT count(*)::int AS n FROM iam.user_groups WHERE group_id = $1 AND removed_at IS NULL`, [g]);
      expect(r.rows[0].n).toBe(1);
      await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE group_id = $1`, [g]);
    });
  });

  describe('paridade TS × SQL e anti-lockout', () => {
    it('CELULAS_VEDADAS_A_AGENTE (TS) é igual a iam.celulas_vedadas_a_agente() (SQL)', async () => {
      const r = await pool.query(`SELECT unnest(iam.celulas_vedadas_a_agente()) AS c ORDER BY 1`);
      const noBanco = r.rows.map((x) => x.c);
      expect(noBanco.length).toBeGreaterThan(0);
      expect(noBanco).toEqual([...CELULAS_VEDADAS_A_AGENTE].sort());
    });

    it('iam.is_last_manager ignora agente: agente em grupo AGENT → false; e o gestor humano segue sendo o último gestor', async () => {
      const g = await novoGrupo('AGENT', ['vacancy:read']);
      await addMember(g, AGENTE);
      const r = await pool.query(`SELECT iam.is_last_manager($1) AS agente, iam.is_last_manager($2) AS gestor`, [AGENTE, GESTOR]);
      expect(r.rows[0]).toEqual({ agente: false, gestor: true });
      await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE group_id = $1`, [g]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 556 §3 — a trilha distingue agente de pessoa (item 34). Escritas como `app_runtime` (o mesmo login do INSERT humano).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('556 §3 — iam.permission_audit_log: actor_kind, gatilho_id, registro_versao', () => {
  const ENLITE = '00000000-0000-0000-0000-000000000001';
  const UID = `${PREFIXO}trilha`;
  const UID_HUMANO = `${PREFIXO}trilha-hum`;
  const TABELA = 'iam.permission_audit_log';

  const limparTrilha = () => pool.query(`DELETE FROM ${TABELA} WHERE user_id LIKE $1`, [`${PREFIXO}trilha%`]);
  const comoRuntime = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  const kindDe = async (uid: string) => (await pool.query(`SELECT actor_kind, gatilho_id, registro_versao FROM ${TABELA} WHERE user_id = $1`, [uid])).rows;

  beforeAll(limparTrilha);
  afterEach(limparTrilha);
  afterAll(limparTrilha);

  describe('(a) as formas de INSERT antigas continuam gravando, com actor_kind = humano', () => {
    it('forma do repositório (PgPermissionAuditRepository, 8 colunas) — a CLASSE real, não uma cópia do SQL', async () => {
      new PgPermissionAuditRepository(pool).record({ tenantId: ENLITE, userId: UID, resource: 'vacancy', action: 'read', decision: 'ALLOW' } as never);
      for (let i = 0; i < 40 && (await kindDe(UID)).length === 0; i++) await new Promise((r) => setTimeout(r, 50)); // record() é fire-and-forget
      expect(await kindDe(UID)).toEqual([{ actor_kind: 'humano', gatilho_id: null, registro_versao: null }]);
    });

    it('forma das funções SQL 279/280/283/458 (6 colunas: tenant, user, resource, action, resource_id, decision), como app_runtime', async () => {
      await comoRuntime((c) =>
        c.query(`INSERT INTO ${TABELA} (tenant_id, user_id, resource, action, resource_id, decision) VALUES ($1, $2, 'permission_audit', 'read', 'x', 'ALLOW')`, [ENLITE, UID]),
      );
      expect(await kindDe(UID)).toEqual([{ actor_kind: 'humano', gatilho_id: null, registro_versao: null }]);
    });

    it('forma da cópia da 280 (9 colunas, com id, ip_address e created_at explícitos)', async () => {
      await pool.query(
        `INSERT INTO ${TABELA} (id, tenant_id, user_id, resource, action, resource_id, decision, ip_address, created_at) VALUES (gen_random_uuid(), $1, $2, 'vacancy', 'read', NULL, 'DENY', '10.0.0.1', now())`,
        [ENLITE, UID],
      );
      expect(await kindDe(UID)).toEqual([{ actor_kind: 'humano', gatilho_id: null, registro_versao: null }]);
    });

    it('forma com country e simulation_id nulos (458) — o INSERT mais largo que o código usa hoje', async () => {
      await pool.query(
        `INSERT INTO ${TABELA} (tenant_id, user_id, resource, action, resource_id, decision, country, simulation_id) VALUES ($1, $2, 'patient', 'read', 'p1', 'ALLOW', 'AR', NULL)`,
        [ENLITE, UID],
      );
      expect((await kindDe(UID))[0].actor_kind).toBe('humano');
    });
  });

  it('(b) actor_kind=agente SEM registro_versao → check_violation (agente_versao_ck); COM registro_versao → grava', async () => {
    await expect(
      comoRuntime((c) => c.query(`INSERT INTO ${TABELA} (tenant_id, user_id, resource, action, decision, actor_kind) VALUES ($1, $2, 'worker', 'read', 'ALLOW', 'agente')`, [ENLITE, UID])),
    ).rejects.toMatchObject({ code: '23514', constraint: 'permission_audit_log_agente_versao_ck' });
    await comoRuntime((c) =>
      c.query(`INSERT INTO ${TABELA} (tenant_id, user_id, resource, action, decision, actor_kind, registro_versao, gatilho_id) VALUES ($1, $2, 'worker', 'read', 'ALLOW', 'agente', 'a1b2c3d4e5f6', 'msg-123')`, [ENLITE, UID]),
    );
    expect(await kindDe(UID)).toEqual([{ actor_kind: 'agente', gatilho_id: 'msg-123', registro_versao: 'a1b2c3d4e5f6' }]);
  });

  it('(c) actor_kind fora de humano|agente|sistema → check_violation (actor_kind_ck); sistema grava', async () => {
    await expect(
      comoRuntime((c) => c.query(`INSERT INTO ${TABELA} (tenant_id, user_id, resource, action, decision, actor_kind) VALUES ($1, $2, 'worker', 'read', 'ALLOW', 'xpto')`, [ENLITE, UID])),
    ).rejects.toMatchObject({ code: '23514', constraint: 'permission_audit_log_actor_kind_ck' });
    await comoRuntime((c) => c.query(`INSERT INTO ${TABELA} (tenant_id, user_id, resource, action, decision, actor_kind) VALUES ($1, $2, 'worker', 'read', 'ALLOW', 'sistema')`, [ENLITE, UID]));
    expect((await kindDe(UID))[0].actor_kind).toBe('sistema');
  });

  it('(d) lista FECHADA de colunas textuais: nenhuma coluna de texto livre nova além de gatilho_id e registro_versao', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'iam' AND table_name = 'permission_audit_log' AND data_type IN ('text', 'character varying', 'character') ORDER BY 1`,
    );
    const colunas = r.rows.map((x) => x.column_name);
    expect(colunas.length).toBeGreaterThan(0); // contagem zero é falha
    expect(colunas).toEqual(
      ['action', 'actor_kind', 'country', 'decision', 'gatilho_id', 'registro_versao', 'resource', 'resource_id', 'user_id'].sort(),
    );
  });

  it('(e) a consulta do limitador usa o índice parcial do agente (EXPLAIN com ≥ 2000 linhas humanas e ≥ 5 do agente, ANALYZE antes)', async () => {
    await pool.query(
      `INSERT INTO ${TABELA} (tenant_id, user_id, resource, action, decision, created_at)
       SELECT $1, $2 || (g % 50), 'vacancy', 'read', 'ALLOW', now() - (g % 600) * interval '1 second' FROM generate_series(1, 2500) g`,
      [ENLITE, UID_HUMANO],
    );
    await pool.query(
      `INSERT INTO ${TABELA} (tenant_id, user_id, resource, action, decision, actor_kind, registro_versao, created_at)
       SELECT $1, $2, 'worker', 'update', 'ALLOW', 'agente', 'a1b2c3d4e5f6', now() - g * interval '1 second' FROM generate_series(1, 6) g`,
      [ENLITE, UID],
    );
    await pool.query(`ANALYZE ${TABELA}`);
    const plano = await pool.query(
      `EXPLAIN SELECT count(*) FROM ${TABELA} WHERE actor_kind = 'agente' AND user_id = $1 AND decision = 'ALLOW' AND action <> 'read' AND created_at > now() - interval '1 hour'`
        .replace('$1', `'${UID}'`),
    );
    const texto = plano.rows.map((x) => x['QUERY PLAN']).join('\n');
    const usados = [...texto.matchAll(/(?:Index (?:Only )?Scan using|Bitmap Index Scan on) (\S+)/g)].map((m) => m[1]);
    expect([texto, usados.length > 0]).toEqual([texto, true]);
    for (const idx of usados) {
      const def = await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'iam' AND indexname = $1`, [idx]);
      expect([idx, def.rows[0]?.indexdef]).toEqual([idx, expect.stringContaining(`WHERE (actor_kind = 'agente'::text)`)]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 556 §3b — iam.query_audit (a tela de auditoria de /admin/access) segue respondendo com as colunas novas.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('556 §3b — iam.query_audit com as 3 colunas novas', () => {
  const ENLITE = '00000000-0000-0000-0000-000000000001';
  const AUDITOR = `${PREFIXO}auditor`;
  const ALVO = `${PREFIXO}qa-alvo`;
  let grupo: string;

  const limpar = async () => {
    await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id IN ($1, $2)`, [AUDITOR, ALVO]);
    await pool.query(`DELETE FROM iam.user_groups WHERE user_id = $1`, [AUDITOR]);
    await pool.query(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = 'E2E078 auditoria')`);
    await pool.query(`DELETE FROM iam.permission_groups WHERE name = 'E2E078 auditoria'`);
    await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [AUDITOR]);
  };

  beforeAll(async () => {
    await limpar();
    await pool.query(
      `INSERT INTO iam.permissions (resource, action, description, category) VALUES ('permission_management', 'read', 'e2e078', 'Operações') ON CONFLICT (resource, action) DO NOTHING`,
    );
    await pool.query(`INSERT INTO users (firebase_uid, email, role, account_type, status, is_active, tenant_id) VALUES ($1, $2, 'admin', 'staff', 'ACTIVE', true, $3)`, [AUDITOR, `${AUDITOR}@e2e.local`, ENLITE]);
    grupo = (await pool.query(`INSERT INTO iam.permission_groups (tenant_id, name) VALUES ($1, 'E2E078 auditoria') RETURNING id`, [ENLITE])).rows[0].id;
    await pool.query(
      `INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = 'permission_management' AND action = 'read'`,
      [grupo],
    );
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [AUDITOR, grupo, ENLITE]);
    await pool.query(
      `INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, decision, actor_kind, registro_versao, gatilho_id) VALUES ($1, $2, 'worker', 'update', 'ALLOW', 'agente', 'a1b2c3d4e5f6', 'msg-9')`,
      [ENLITE, ALVO],
    );
  });
  afterAll(limpar);

  it('o auditor (permission_management:read) lê a trilha como app_runtime, e a linha do agente vem com actor_kind', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [AUDITOR]);
      const r = await client.query(`SELECT user_id, actor_kind, registro_versao, gatilho_id FROM iam.query_audit($1, NULL, NULL, NULL, 50)`, [ALVO]);
      await client.query('COMMIT');
      expect(r.rows).toEqual([{ user_id: ALVO, actor_kind: 'agente', registro_versao: 'a1b2c3d4e5f6', gatilho_id: 'msg-9' }]);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 556 §4-§6 — a linha `agent:luz`, o grupo espelho vazio, os privilégios e o ROLLBACK.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('556 §4-§6 — seed do agente, privilégios e rollback', () => {
  const ENLITE = '00000000-0000-0000-0000-000000000001';
  const MIGRACOES = path.resolve(__dirname, '..', '..', 'migrations');
  const SQL_556 = fs.readFileSync(path.join(MIGRACOES, '556_078_agente_principal.sql'), 'utf8');
  const SECAO_4 = SQL_556.slice(SQL_556.indexOf('-- ── 4. A linha do agente'), SQL_556.indexOf('-- ── 5. Privilégios'));
  const ROLLBACK = fs.readFileSync(path.join(MIGRACOES, 'pending', 'ROLLBACK_556_078_agente_principal.sql'), 'utf8');
  const GRUPO = 'Luz — espelho Recrutador';

  it('(a) a linha agent:luz existe com o tipo, status, e-mail e tenant do contrato', async () => {
    expect(SECAO_4.length).toBeGreaterThan(200); // a fatia achou a seção (contagem zero é falha)
    const r = await pool.query(`SELECT account_type, status, is_active, email, tenant_id, role FROM users WHERE firebase_uid = 'agent:luz'`);
    expect(r.rows).toEqual([
      { account_type: 'agent', status: 'ACTIVE', is_active: true, email: 'triage-service-sa@enlite-prd.iam.gserviceaccount.com', tenant_id: ENLITE, role: 'support' },
    ]);
  });

  it('(b) reaplicar a seção 4 (idempotência) não duplica nem falha: 1 linha, 1 grupo, 1 país AR vivo', async () => {
    await pool.query(SECAO_4);
    await pool.query(SECAO_4);
    const u = await pool.query(`SELECT count(*)::int AS n FROM users WHERE firebase_uid = 'agent:luz' OR email = 'triage-service-sa@enlite-prd.iam.gserviceaccount.com'`);
    const g = await pool.query(`SELECT id, actor_class, is_system FROM iam.permission_groups WHERE tenant_id = $1 AND name = $2`, [ENLITE, GRUPO]);
    const c = await pool.query(`SELECT country FROM iam.group_country_scopes WHERE group_id = $1 AND revoked_at IS NULL`, [g.rows[0]?.id]);
    expect(u.rows[0].n).toBe(1);
    expect(g.rows).toEqual([expect.objectContaining({ actor_class: 'AGENT', is_system: false })]);
    expect(c.rows.map((x) => x.country.trim())).toEqual(['AR']);
  });

  it('(c) o agente recém-nascido é inerte: 0 células e 0 países (sem grupo, sem acesso), e o grupo espelho nasce SEM membro e SEM célula de negócio', async () => {
    const e = await pool.query(`SELECT iam.effective_permissions('agent:luz', $1) AS cel, iam.effective_countries('agent:luz', $1) AS pais`, [ENLITE]);
    expect(e.rows[0].cel ?? []).toEqual([]);
    expect(e.rows[0].pais ?? []).toEqual([]);
    const m = await pool.query(
      `SELECT (SELECT count(*)::int FROM iam.user_groups ug JOIN iam.permission_groups g ON g.id = ug.group_id WHERE g.name = $1 AND ug.removed_at IS NULL) AS membros,
              (SELECT count(*)::int FROM iam.group_permissions gp JOIN iam.permission_groups g ON g.id = gp.group_id JOIN iam.permissions p ON p.id = gp.permission_id
                WHERE g.name = $1 AND p.resource NOT LIKE 'own\_%' ESCAPE '\\') AS celulas_de_negocio`,
      [GRUPO],
    );
    expect(m.rows[0]).toEqual({ membros: 0, celulas_de_negocio: 0 });
  });

  it('(d) a migration não concede célula a NENHUM grupo: sem INSERT em group_permissions/user_groups no arquivo e a contagem não muda ao reaplicar a seção 4', async () => {
    const insere = /INSERT\s+INTO\s+iam\.(group_permissions|user_groups)/i;
    // controle positivo: a mesma regex ACHA o INSERT numa migration que concede (471)
    expect(insere.test(fs.readFileSync(path.join(MIGRACOES, '471_grant_own_cells_to_active_groups_on_sync.sql'), 'utf8'))).toBe(true);
    expect(insere.test(SQL_556.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'))).toBe(false);
    const antes = await pool.query(`SELECT count(*)::int AS n FROM iam.group_permissions`);
    await pool.query(SECAO_4);
    const depois = await pool.query(`SELECT count(*)::int AS n FROM iam.group_permissions`);
    expect(depois.rows[0].n).toBe(antes.rows[0].n);
  });

  it('(e) privilégios: app_runtime INSERT t / UPDATE f / DELETE f na trilha, INSERT t na coluna actor_kind; EXECUTE da função t para app_runtime e f para PUBLIC', async () => {
    const r = await pool.query(
      `SELECT has_table_privilege('app_runtime', 'iam.permission_audit_log', 'INSERT') AS ins,
              has_table_privilege('app_runtime', 'iam.permission_audit_log', 'UPDATE') AS upd,
              has_table_privilege('app_runtime', 'iam.permission_audit_log', 'DELETE') AS del,
              has_column_privilege('app_runtime', 'iam.permission_audit_log', 'actor_kind', 'INSERT') AS col,
              has_function_privilege('app_runtime', 'iam.celulas_vedadas_a_agente()', 'EXECUTE') AS fn_rt,
              has_function_privilege('app_system', 'iam.celulas_vedadas_a_agente()', 'EXECUTE') AS fn_sys,
              has_function_privilege('public', 'iam.celulas_vedadas_a_agente()', 'EXECUTE') AS fn_pub`,
    );
    expect(r.rows[0]).toEqual({ ins: true, upd: false, del: false, col: true, fn_rt: true, fn_sys: true, fn_pub: false });
    // o literal do contrato: t|f|f|t
    expect([r.rows[0].ins, r.rows[0].upd, r.rows[0].del, r.rows[0].col].map((b) => (b ? 't' : 'f')).join('|')).toBe('t|f|f|t');
  });

  it('(f) ROLLBACK (numa transação, desfeita no fim): o banco volta ao estado da 555 — CHECKs, colunas, triggers, funções, linha, grupo, query_audit', async () => {
    // o ROLLBACK falha DE PROPÓSITO se sobrar outra conta `agent` (o CHECK antigo não a aceita): tira as dos testes anteriores deste arquivo
    await pool.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${PREFIXO}%`]);
    const client = await pool.connect();
    const estado = async () =>
      (
        await client.query(
          `SELECT
             (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'users_account_type_check') AS ck_users,
             (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'permission_groups_actor_class_ck') AS ck_classe,
             (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'iam' AND table_name = 'permission_audit_log'
                AND column_name IN ('actor_kind', 'gatilho_id', 'registro_versao')) AS colunas,
             (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('veda_celula_a_agente', 'veda_trocar_classe_agente', 'veda_agente_fora_de_grupo_agent')) AS triggers,
             (SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'iam'::regnamespace AND proname IN ('celulas_vedadas_a_agente', 'trg_veda_celula_a_agente', 'trg_veda_trocar_classe_agente', 'trg_veda_agente_fora_de_grupo_agent')) AS funcoes,
             (SELECT count(*)::int FROM users WHERE firebase_uid = 'agent:luz') AS linha,
             (SELECT count(*)::int FROM iam.permission_groups WHERE name = $1) AS grupo,
             (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'iam' AND indexname = 'idx_pal_agente_user_created') AS indice,
             (SELECT pg_get_functiondef('iam.query_audit(varchar,varchar,timestamptz,timestamptz,int)'::regprocedure) LIKE '%actor_kind%') AS query_audit_nova`,
          [GRUPO],
        )
      ).rows[0];
    try {
      const antes = await estado();
      expect(antes).toMatchObject({ colunas: 3, triggers: 3, funcoes: 4, linha: 1, grupo: 1, indice: 1, query_audit_nova: true });
      await client.query('BEGIN');
      await client.query(ROLLBACK);
      const depois = await estado();
      expect(depois.ck_users).toContain(`'staff'`);
      expect(depois.ck_users).not.toContain('agent');
      expect(depois.ck_classe).not.toContain('AGENT');
      expect(depois.ck_classe).toContain('EXTERNAL_THIRD_PARTY');
      expect(depois).toMatchObject({ colunas: 0, triggers: 0, funcoes: 0, linha: 0, grupo: 0, indice: 0, query_audit_nova: false });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    // o ROLLBACK da transação deixou a 556 de pé
    const r = await pool.query(`SELECT count(*)::int AS n FROM users WHERE firebase_uid = 'agent:luz'`);
    expect(r.rows[0].n).toBe(1);
  });
});
