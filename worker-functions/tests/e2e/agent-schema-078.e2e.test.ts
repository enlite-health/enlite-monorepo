/**
 * agent-schema-078.e2e.test.ts — spec 078, fase M2 (migration 556): o agente como pessoa no ABAC, provado no BANCO real.
 *
 * Seção 1 (M2.1.1): `users.account_type` aceita `agent` e continua recusando o resto. Banco: DATABASE_URL (dono, só para
 * semear e medir catálogo). Nada passa pela API. As seções seguintes (2: triggers; 3: auditoria; 4: seed) entram nas
 * tasks M2.1.3, M2.1.5 e M2.1.7, neste MESMO arquivo.
 */
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
