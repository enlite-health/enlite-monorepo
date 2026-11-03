/**
 * agent-abac-verifier-078.e2e.test.ts — spec 078, M2 (lote 4): o verificador de subconjunto do agente (`scripts/verificar-agente-abac.ts`) E o item 36
 * (nenhum agente tem célula de gestão de permissão nem de lote) contra Postgres REAL, motor ABAC ligado (catálogo sincronizado pelo boot da API de setup).
 *
 *   células(capabilities) ⊆ células(grupo AGENT) ⊆ células(grupo humano espelho); nada de permission_management:* nem de lote no grupo AGENT.
 *
 * Papéis declarados: o verificador lê como `app_system` (login de teste, NOBYPASSRLS); a mutação de grupo (item 36) vai como `app_runtime` com ator gestor
 * semeado; só o SEED e os casos "contornando o trigger" usam o dono — dentro de uma transação DESFEITA no fim (o trigger derrubado nunca persiste).
 * Tenant próprio (`…036`), agente próprio (`agent:agv078`); a `agent:luz` real da 556 não é tocada. Dados sintéticos.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import { AGENT_CAPABILITY_CELLS } from '../../src/modules/mcp/domain/AgentCapabilityCells';
import { formatar, verificarAgente } from '../../scripts/verificar-agente-abac';
import { ensureLoginRole, dropLoginRoles, urlFor } from './helpers/loginRoles';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const T3 = 'e0780000-0000-0000-0000-000000000036';
const SYS = 'agv078_sys';
const PW = 'agv078_pw';
const AGENTE = 'agv078';
const UID = `agent:${AGENTE}`;
const GESTOR = 'agv078-gestor';
const HUMANO = 'agv078-humano';
const ESPELHO = 'AGV078 espelho humano';
const GRUPO_AGENT = 'AGV078 agente';
const CELULAS_DO_MAPA = [...new Set(Object.values(AGENT_CAPABILITY_CELLS))];

describe('verificador de subconjunto do agente + item 36 (banco real, ABAC ligado)', () => {
  let admin: Pool;
  let sys: Pool;
  let permId: Record<string, string>;
  let gAgent: string;
  let gEspelho: string;
  let gGestor: string;

  const grupo = async (nome: string, classe: string): Promise<string> =>
    (await admin.query(`INSERT INTO iam.permission_groups (tenant_id, name, actor_class) VALUES ($1, $2, $3) RETURNING id`, [T3, nome, classe])).rows[0].id;
  const dar = async (g: string, cells: string[], c: Pick<Pool, 'query'> = admin) => {
    for (const cell of cells) await c.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2)`, [g, permId[cell]]);
  };
  const ensurePerm = async (cell: string): Promise<string> => {
    const [resource, action] = cell.split(':');
    await admin.query(`INSERT INTO iam.permissions (resource, action, description, category) VALUES ($1, $2, 'e2e078', 'Operações') ON CONFLICT (resource, action) DO NOTHING`, [resource, action]);
    return (await admin.query(`SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action])).rows[0].id;
  };
  const limpar = async () => {
    const g = `(SELECT id FROM iam.permission_groups WHERE tenant_id = '${T3}')`;
    await admin.query(`DELETE FROM iam.permission_group_changes WHERE group_id IN ${g}`);
    await admin.query(`DELETE FROM iam.group_permissions WHERE group_id IN ${g}`);
    await admin.query(`DELETE FROM iam.user_groups WHERE tenant_id = $1`, [T3]);
    await admin.query(`DELETE FROM iam.permission_groups WHERE tenant_id = $1`, [T3]);
    await admin.query(`DELETE FROM users WHERE firebase_uid IN ($1, $2, $3)`, [UID, GESTOR, HUMANO]);
    await admin.query(`DELETE FROM iam.tenants WHERE id = $1`, [T3]);
  };
  /** Transação do DONO, sempre desfeita: aqui moram os casos "contornando o trigger" (DISABLE TRIGGER é transacional). */
  const emTx = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  };
  const comoRuntime = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_runtime');
      await c.query(`SELECT set_config('app.user_uid', $1, true)`, [GESTOR]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const setCells = (g: string, cells: string[]) =>
    comoRuntime((c) => c.query(`SELECT iam.set_group_permissions($1, $2::uuid[], 'e2e078')`, [g, cells.map((x) => permId[x])]));
  const celulasDe = async (g: string): Promise<string[]> =>
    (await admin.query(`SELECT p.resource || ':' || p.action AS c FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id WHERE gp.group_id = $1 ORDER BY 1`, [g])).rows.map((x) => x.c);
  const rodar = (pool: Pick<Pool, 'query'> = sys) => verificarAgente(pool, { agente: AGENTE, espelho: ESPELHO });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL, max: 4 });
    await ensureLoginRole(admin, SYS, PW, 'app_system');
    sys = new Pool({ connectionString: urlFor(ADMIN_URL, SYS, PW), max: 2 });
    await limpar();
    permId = {};
    for (const c of [...CELULAS_DO_MAPA, 'permission_management:write', 'permission_management:read', 'worker:export', 'patient:read', 'funnel:read']) permId[c] = await ensurePerm(c);
    await admin.query(`INSERT INTO iam.tenants (id, name, region, status) VALUES ($1, 'E2E078 verificador', 'SA', 'ACTIVE')`, [T3]);
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, account_type, status, is_active, tenant_id) VALUES
         ($1, $4, 'support', 'agent', 'ACTIVE', true, $7), ($2, $5, 'admin', 'staff', 'ACTIVE', true, $7), ($3, $6, 'recruiter', 'staff', 'ACTIVE', true, $7)`,
      [UID, GESTOR, HUMANO, `${AGENTE}@e2e.local`, `${GESTOR}@e2e.local`, `${HUMANO}@e2e.local`, T3],
    );
    gGestor = await grupo('AGV078 gestor', 'INTERNAL');
    await dar(gGestor, ['permission_management:write']);
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [GESTOR, gGestor, T3]);
    gEspelho = await grupo(ESPELHO, 'INTERNAL');
    await dar(gEspelho, [...CELULAS_DO_MAPA, 'patient:read']);
    gAgent = await grupo(GRUPO_AGENT, 'AGENT');
    await dar(gAgent, CELULAS_DO_MAPA);
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [UID, gAgent, T3]);
  }, 60000);

  afterAll(async () => {
    await limpar();
    await sys.end();
    await dropLoginRoles(admin, [SYS]).catch(() => undefined);
    await admin.end();
  });

  // ── o instrumento: medido nos dois sentidos ───────────────────────────────────────────
  it('a conexão do verificador é app_system sem bypass de RLS (declarada); o mapa tem ≥ 1 célula e todas vivas no catálogo (contagem zero é falha)', async () => {
    const r = await sys.query(`SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    expect(r.rows[0]).toEqual({ u: SYS, bypass: false });
    // 15 capabilities da classe (a) compartilham 10 células distintas (ex.: worker:update ×4, vacancy:read ×2)
    expect(Object.keys(AGENT_CAPABILITY_CELLS)).toHaveLength(15);
    expect(CELULAS_DO_MAPA.length).toBeGreaterThanOrEqual(10);
    const vivas = await admin.query(`SELECT count(*)::int AS n FROM iam.permissions WHERE deprecated_at IS NULL AND resource || ':' || action = ANY($1)`, [CELULAS_DO_MAPA]);
    expect(vivas.rows[0].n).toBe(CELULAS_DO_MAPA.length);
  });

  it('grupo AGENT correto (células ⊇ capabilities do mapa, ⊆ espelho): rc 0 e `N checagens executadas` com N ≥ 1', async () => {
    const r = await rodar();
    expect(r.linhas.filter((l) => l.startsWith('DIVERGE'))).toEqual([]);
    expect(r.rc).toBe(0);
    expect(r.checagens).toBeGreaterThanOrEqual(1);
    expect(formatar(r)).toMatch(/(^|\n)\d+ checagens executadas\nrc=0$/);
  });

  it('grupo sem a célula de uma capability: `DIVERGE AGENTE … CAPABILITY_FORA_DO_GRUPO <capability> <cell>` rc 1', async () => {
    await admin.query(`DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id = $2`, [gAgent, permId['interview:read']]);
    try {
      const r = await rodar();
      expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} CAPABILITY_FORA_DO_GRUPO worker.interview.get interview:read`);
      expect(r.rc).toBe(1);
    } finally {
      await dar(gAgent, ['interview:read']);
    }
    expect((await rodar()).rc).toBe(0); // controle: restaurado, volta a rc 0
  });

  it('grupo com célula fora do espelho: GRUPO_FORA_DO_ESPELHO rc 1 (a célula existe e é permitida ao agente, só não está no grupo humano)', async () => {
    await dar(gAgent, ['funnel:read']);
    try {
      const r = await rodar();
      expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} GRUPO_FORA_DO_ESPELHO funnel:read`);
      expect(r.rc).toBe(1);
    } finally {
      await admin.query(`DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id = $2`, [gAgent, permId['funnel:read']]);
    }
    expect((await rodar()).rc).toBe(0);
  });

  it('espelho inexistente: ESPELHO_AUSENTE rc 1 (não presume "tudo bem")', async () => {
    const r = await verificarAgente(sys, { agente: AGENTE, espelho: 'grupo que não existe' });
    expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} ESPELHO_AUSENTE grupo que não existe`);
    expect(r.rc).toBe(1);
  });

  it('sem grupo: SEM_GRUPO rc 1', async () => {
    await admin.query(`UPDATE iam.user_groups SET removed_at = now() WHERE user_id = $1 AND removed_at IS NULL`, [UID]);
    try {
      const r = await rodar();
      expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} SEM_GRUPO`);
      expect(r.rc).toBe(1);
    } finally {
      await admin.query(`UPDATE iam.user_groups SET removed_at = NULL WHERE user_id = $1`, [UID]);
    }
    expect((await rodar()).rc).toBe(0);
  });

  it('grupo INTERNAL (vínculo criado com o trigger T3 derrubado, na transação desfeita): GRUPO_NAO_AGENT rc 1', async () => {
    const r = await emTx(async (c) => {
      await c.query(`ALTER TABLE iam.user_groups DISABLE TRIGGER veda_agente_fora_de_grupo_agent`);
      await c.query(`UPDATE iam.user_groups SET removed_at = now() WHERE user_id = $1 AND removed_at IS NULL`, [UID]);
      await c.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [UID, gEspelho, T3]);
      return rodar(c);
    });
    expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} GRUPO_NAO_AGENT ${ESPELHO}`);
    expect(r.rc).toBe(1);
    expect((await rodar()).rc).toBe(0); // nada persistiu
  });

  it('célula vedada INSERIDA contornando o trigger (defesa em profundidade): CELULA_VEDADA rc 1 para permission_management:write e para a de lote', async () => {
    const r = await emTx(async (c) => {
      await c.query(`ALTER TABLE iam.group_permissions DISABLE TRIGGER veda_celula_a_agente`);
      await dar(gAgent, ['permission_management:write', 'worker:export'], c);
      return rodar(c);
    });
    expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} CELULA_VEDADA permission_management:write`);
    expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} CELULA_VEDADA worker:export`);
    expect(r.rc).toBe(1);
    expect((await celulasDe(gAgent)).some((c) => c === 'permission_management:write')).toBe(false); // nada persistiu
  });

  it('`permission_management:read` (qualquer célula do recurso, I5) também é acusada, mesmo se a função do banco não a listasse', async () => {
    const r = await emTx(async (c) => {
      await c.query(`ALTER TABLE iam.group_permissions DISABLE TRIGGER veda_celula_a_agente`);
      await c.query(`CREATE OR REPLACE FUNCTION iam.celulas_vedadas_a_agente() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['worker:export']::text[] $$`);
      await dar(gAgent, ['permission_management:read'], c);
      return rodar(c);
    });
    expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} CELULA_VEDADA permission_management:read`);
  });

  it('célula do mapa DEPRECADA no catálogo: CELULA_DO_MAPA_SEM_CATALOGO rc 1 (e a deprecada não conta como célula do grupo)', async () => {
    const r = await emTx(async (c) => {
      await c.query(`UPDATE iam.permissions SET deprecated_at = now() WHERE resource = 'worker_pii' AND action = 'read'`);
      return rodar(c);
    });
    expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} CELULA_DO_MAPA_SEM_CATALOGO worker_pii:read`);
    expect(r.linhas).toContain(`DIVERGE AGENTE ${UID} CAPABILITY_FORA_DO_GRUPO worker.byPhone worker_pii:read`);
    expect(r.rc).toBe(1);
  });

  it('agente SUSPENDED: AVISO (não é divergência), rc 0', async () => {
    const r = await emTx(async (c) => {
      await c.query(`UPDATE users SET status = 'SUSPENDED' WHERE firebase_uid = $1`, [UID]);
      return rodar(c);
    });
    expect(r.linhas).toContain(`AVISO AGENTE ${UID} AGENTE_INATIVO`);
    expect(r.rc).toBe(0);
  });

  it('conexão impossível: rc 2 (falha), NUNCA 0, e `0 checagens`', async () => {
    const morto = new Pool({ connectionString: urlFor(ADMIN_URL, SYS, PW).replace(/:\d+\//, ':1/'), connectionTimeoutMillis: 800 });
    try {
      const r = await verificarAgente(morto, { agente: AGENTE, espelho: ESPELHO });
      expect(r.rc).toBe(2);
      expect(r.checagens).toBe(0);
      expect(formatar(r)).toContain('0 checagens executadas');
    } finally {
      await morto.end().catch(() => undefined);
    }
  });

  it('a saída nunca contém e-mail, token nem ID de pessoa (regex) — e o controle: o e-mail do agente EXISTE no banco', async () => {
    expect((await admin.query(`SELECT email FROM users WHERE firebase_uid = $1`, [UID])).rows[0].email).toContain('@');
    await dar(gAgent, ['funnel:read']); // gera uma linha DIVERGE para a regex varrer algo
    try {
      const saida = formatar(await rodar());
      expect(saida).toContain('DIVERGE AGENTE');
      expect(saida).not.toMatch(/@|mock_|Bearer|eyJ|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    } finally {
      await admin.query(`DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id = $2`, [gAgent, permId['funnel:read']]);
    }
  });

  it('COMANDO DO HOST (`npm run verificar:agente-abac`): bom → rc=0 e N checagens; ruim → DIVERGE AGENTE e rc=1; sem --espelho → rc 2', () => {
    const cwd = path.resolve(__dirname, '../..');
    const env = { ...process.env, DATABASE_URL: urlFor(ADMIN_URL, SYS, PW) };
    const run = (args: string[]): { out: string; rc: number } => {
      try {
        return { out: execFileSync('npm', ['run', '-s', 'verificar:agente-abac', '--', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), rc: 0 };
      } catch (e) {
        const x = e as { stdout?: string; stderr?: string; status?: number };
        return { out: `${x.stdout ?? ''}${x.stderr ?? ''}`, rc: x.status ?? -1 };
      }
    };
    const bom = run(['--agente', AGENTE, '--espelho', ESPELHO]);
    expect(bom.rc).toBe(0);
    expect(bom.out).toMatch(/\d+ checagens executadas\nrc=0/);
    // ruim: a capability perde a célula (commit, desfeito logo abaixo)
    const semCelula = admin.query(`DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id = $2`, [gAgent, permId['vacancy:read']]);
    return semCelula.then(async () => {
      try {
        const ruim = run(['--agente', AGENTE, '--espelho', ESPELHO]);
        expect(ruim.rc).toBe(1);
        expect(ruim.out).toContain(`DIVERGE AGENTE ${UID} CAPABILITY_FORA_DO_GRUPO worker.vacancies.list vacancy:read`);
      } finally {
        await dar(gAgent, ['vacancy:read']);
      }
      expect(run(['--agente', AGENTE]).rc).toBe(2);
    });
  }, 90000);

  // ── item 36 ───────────────────────────────────────────────────────────────────────────
  describe('item 36 — nenhum agente tem célula de gestão de permissão nem de lote', () => {
    it('permission_management:write, :read e a de lote (worker:export) em grupo AGENT (via iam.set_group_permissions como app_runtime) → erro do banco', async () => {
      for (const cell of ['permission_management:write', 'permission_management:read', 'worker:export']) {
        await expect(setCells(gAgent, [...CELULAS_DO_MAPA, cell])).rejects.toThrow(/AGENT|vedada|item 36/i);
        expect(await celulasDe(gAgent)).not.toContain(cell);
      }
    });

    it('controle positivo: a célula permitida (worker.byPhone = worker_pii:read) em grupo AGENT → grava', async () => {
      await setCells(gAgent, CELULAS_DO_MAPA);
      expect(await celulasDe(gAgent)).toContain('worker_pii:read');
    });

    it('agente em grupo INTERNAL → erro (add_member como app_runtime); o vínculo não nasce', async () => {
      const gInt = await grupo('AGV078 interno vazio', 'INTERNAL');
      await expect(comoRuntime((c) => c.query(`SELECT iam.add_member($1, $2)`, [gInt, UID]))).rejects.toThrow(/AGENT|agente/i);
      expect((await admin.query(`SELECT 1 FROM iam.user_groups WHERE user_id = $1 AND group_id = $2`, [UID, gInt])).rowCount).toBe(0);
    });

    it('grupo INTERNAL com permission_management:write virando AGENT → erro e a classe não muda', async () => {
      const g = await grupo('AGV078 gestor-interno', 'INTERNAL');
      await dar(g, ['permission_management:write']);
      await expect(admin.query(`UPDATE iam.permission_groups SET actor_class = 'AGENT' WHERE id = $1`, [g])).rejects.toThrow(/AGENT|vedada/i);
      expect((await admin.query(`SELECT actor_class FROM iam.permission_groups WHERE id = $1`, [g])).rows[0].actor_class).toBe('INTERNAL');
    });

    it('grupo AGENT com o agente virando INTERNAL → erro', async () => {
      await expect(admin.query(`UPDATE iam.permission_groups SET actor_class = 'INTERNAL' WHERE id = $1`, [gAgent])).rejects.toThrow(/AGENT|membro|classe/i);
      expect((await admin.query(`SELECT actor_class FROM iam.permission_groups WHERE id = $1`, [gAgent])).rows[0].actor_class).toBe('AGENT');
    });

    it('verificador: grupo bom → rc 0 e N ≥ 1; grupo ruim (trigger derrubado + célula vedada inserida) → `DIVERGE AGENTE … CELULA_VEDADA <cell>` rc 1', async () => {
      const bom = await rodar();
      expect([bom.rc, bom.checagens >= 1]).toEqual([0, true]);
      const ruim = await emTx(async (c) => {
        await c.query(`ALTER TABLE iam.group_permissions DISABLE TRIGGER veda_celula_a_agente`);
        await dar(gAgent, ['permission_management:write'], c);
        return rodar(c);
      });
      expect(ruim.linhas).toContain(`DIVERGE AGENTE ${UID} CELULA_VEDADA permission_management:write`);
      expect(ruim.rc).toBe(1);
    });

    it('iam.is_last_manager inalterado: o humano gestor segue sendo o último gestor antes e depois de o agente existir em grupo AGENT; o agente nunca é o último', async () => {
      const antes = (await admin.query(`SELECT iam.is_last_manager($1) AS a, iam.is_last_manager($2) AS b`, [GESTOR, UID])).rows[0];
      await setCells(gAgent, CELULAS_DO_MAPA);
      const depois = (await admin.query(`SELECT iam.is_last_manager($1) AS a, iam.is_last_manager($2) AS b`, [GESTOR, UID])).rows[0];
      expect(depois).toEqual(antes);
      expect(antes.b).toBe(false);
    });
  });
});
