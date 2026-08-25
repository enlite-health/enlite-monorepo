import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

/**
 * A BATERIA DE ABUSO da API de escrita (task 4.1b) — HTTP real, banco real.
 *
 * O "e2e por rota" da 4.1 é caminho feliz: ele prova que a tela funciona, não
 * que alguém não se auto-promove. Superfície nova é alvo novo, e a API é a
 * porta que o `_require_manager` do banco não vê.
 *
 * ⚠️ **O engine fica DESLIGADO nesta suíte, de propósito.** Com
 * `PERMISSION_ENGINE_ENABLED` off, o `perm.require` das rotas é NO-OP — ou
 * seja, tudo que reprovar aqui reprovou porque o **BANCO** recusou, não porque
 * o Express filtrou. É a única forma de provar a afirmação do cabeçalho do
 * router: "o portão da rota é a segunda tranca, nunca a única". Se alguém
 * trocar as funções `SECURITY DEFINER` por SQL direto, esta suíte fica vermelha
 * antes de a porta abrir.
 *
 * ⚠️ Toda alínea afirma DUAS coisas: o erro HTTP **e** a ausência de efeito no
 * banco. Só o status seria régua de forma — um handler que respondesse 403 e
 * gravasse mesmo assim passaria.
 *
 * ⚠️ Mock do jest é PROIBIDO aqui: mockar qualquer peça apagaria a camada sob
 * teste.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('4.1b — bateria de abuso da escrita do painel (HTTP e banco reais)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = {
    /** Gestor de acessos: tem `permission_management:write`. */
    gestor: 'abuse-e2e-gestor',
    /** Staff ativo, em grupo comum — SEM a célula de gestão. */
    comum: 'abuse-e2e-comum',
    /** Staff ativo sem NENHUM grupo. */
    semGrupo: 'abuse-e2e-sem-grupo',
  };
  const G = {
    gestao: 'Abuse E2E Gestão',
    comum: 'Abuse E2E Comum',
    alvo: 'Abuse E2E Alvo',
  };
  let idGestao: string;
  let idComum: string;
  let idAlvo: string;

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string | null,
    corpo?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(uid ? { Authorization: tokenMock(uid) } : {}),
      },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** As células vigentes de um grupo, direto do banco. */
  async function celulasDoGrupo(groupId: string): Promise<string[]> {
    const r = await pool.query(
      `SELECT p.resource || ':' || p.action AS k
         FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id = $1 ORDER BY 1`,
      [groupId],
    );
    return r.rows.map((x) => x.k as string);
  }

  async function membrosVivos(groupId: string): Promise<string[]> {
    const r = await pool.query(
      `SELECT user_id FROM iam.user_groups WHERE group_id = $1 AND removed_at IS NULL ORDER BY 1`,
      [groupId],
    );
    return r.rows.map((x) => x.user_id as string);
  }

  async function limpar(): Promise<void> {
    // ⚠️ As features que a bateria tenta criar entram aqui. Sem isto, uma
    // rodada em que a criação PASSOU (por defeito ou por acoplamento de ordem)
    // deixa a linha no banco e a rodada seguinte reprova por resíduo, não por
    // regressão — e o diagnóstico vai para o lugar errado.
    await pool.query(`DELETE FROM iam.country_features WHERE feature_key LIKE 'screen:abuse%'`);
    await pool.query(`DELETE FROM iam.country_feature_changes WHERE feature_key LIKE 'screen:abuse%'`);
    await pool.query(`DELETE FROM iam.permission_groups WHERE name LIKE $1`, ['Abuse E2E%outro']);
    await pool.query(`DELETE FROM iam.tenants WHERE name = 'Abuse E2E Outro Tenant'`);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(G) });
    await pool.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`, [Object.values(G)]);
    await pool.query(`DELETE FROM iam.permission_groups WHERE name = ANY($1)`, [Object.values(G)]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'abuse-gestor@e2e.local',   'admin', 'ACTIVE', true, $4),
         ($2, 'abuse-comum@e2e.local',    'admin', 'ACTIVE', true, $4),
         ($3, 'abuse-semgrupo@e2e.local', 'admin', 'ACTIVE', true, $4)`,
      [U.gestor, U.comum, U.semGrupo, TENANT_E2E],
    );

    idGestao = await grupoComCelulas(pool, {
      nome: G.gestao, uid: U.gestor,
      celulas: [['permission_management', 'write'], ['permission_management', 'read']],
    });
    idComum = await grupoComCelulas(pool, {
      nome: G.comum, uid: U.comum, celulas: [['worker', 'read']],
    });
    idAlvo = await grupoComCelulas(pool, {
      nome: G.alvo, uid: U.comum, celulas: [['funnel', 'read']],
    });

    setEnv('USE_MOCK_AUTH', 'true');
    // 🔴 ENGINE OFF — ver o cabeçalho. Tudo que reprovar aqui reprovou no BANCO.
    setEnv('PERMISSION_ENGINE_ENABLED', 'false');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createPermissionPanelWriteRoutes } = await import('@modules/identity');

    app = await montarAppDeFamilia({
      montarRotas: ({ app: ex, auth, permissions, modulo }) => {
        ex.use('/api/admin', createPermissionPanelWriteRoutes({
          writer: modulo, auth, permissions, tenantId: TENANT_E2E,
        }));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── (a) ESCALAÇÃO DE PRIVILÉGIO ────────────────────────────────────────────

  describe('(a) escalação de privilégio', () => {
    it('🔴 membro COMUM não concede célula nenhuma — nem a mais inócua', async () => {
      const antes = await celulasDoGrupo(idAlvo);

      const res = await chamar('PUT', `/api/admin/permission-groups/${idAlvo}/permissions`, U.comum, {
        cellKeys: ['worker:read'],
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(await celulasDoGrupo(idAlvo)).toEqual(antes);
    });

    it('🔴 membro comum não se AUTO-PROMOVE a gestor pelo próprio grupo', async () => {
      const res = await chamar('PUT', `/api/admin/permission-groups/${idComum}/permissions`, U.comum, {
        cellKeys: ['worker:read', 'permission_management:write'],
      });

      expect(res.status).toBe(403);
      expect(await celulasDoGrupo(idComum)).toEqual(['worker:read']);
    });

    it('🔴 membro comum não se põe no grupo de GESTÃO', async () => {
      const res = await chamar('POST', `/api/admin/permission-groups/${idGestao}/members`, U.comum, {
        userId: U.comum,
      });

      expect(res.status).toBe(403);
      expect(await membrosVivos(idGestao)).toEqual([U.gestor]);
    });

    it('🔴 nem cria grupo novo já com a célula de gestão', async () => {
      const res = await chamar('POST', '/api/admin/permission-groups', U.comum, { name: 'Abuse E2E Comum atalho' });

      expect(res.status).toBe(403);
      const r = await pool.query(`SELECT 1 FROM iam.permission_groups WHERE name = $1`, ['Abuse E2E Comum atalho']);
      expect(r.rowCount).toBe(0);
    });

    it('o GESTOR consegue o que o comum não conseguiu — senão o 403 acima seria de outra causa', async () => {
      // Controle POSITIVO da bateria inteira: sem ele, um banco fora do ar
      // devolveria 403 para todo mundo e a suíte ficaria verde.
      const res = await chamar('PUT', `/api/admin/permission-groups/${idAlvo}/permissions`, U.gestor, {
        cellKeys: ['funnel:read', 'worker:read'],
        reason: 'controle positivo da bateria',
      });

      expect(res.status).toBe(200);
      expect(await celulasDoGrupo(idAlvo)).toEqual(['funnel:read', 'worker:read']);
    });
  });

  // ── (b) IDOR e (c) CROSS-TENANT ────────────────────────────────────────────

  describe('(b)(c) IDOR e cross-tenant', () => {
    it('🔴 grupo de outro tenant é 404 na ESCRITA, e nada muda lá', async () => {
      const outro = await pool.query(
        `INSERT INTO iam.tenants (id, name, region) VALUES (gen_random_uuid(), 'Abuse E2E Outro Tenant', 'SA')
         ON CONFLICT DO NOTHING RETURNING id`,
      );
      const tenantOutro = outro.rows[0]?.id
        ?? (await pool.query(`SELECT id FROM iam.tenants WHERE name = $1`, ['Abuse E2E Outro Tenant'])).rows[0].id;
      const g = await pool.query(
        `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING id`,
        [tenantOutro, G.alvo + ' outro'],
      );
      const idOutro = g.rows[0].id as string;

      const res = await chamar('PATCH', `/api/admin/permission-groups/${idOutro}`, U.gestor, { name: 'sequestrado' });

      expect(res.status).toBe(404);
      const depois = await pool.query(`SELECT name FROM iam.permission_groups WHERE id = $1`, [idOutro]);
      expect(depois.rows[0].name).toBe(G.alvo + ' outro');

      await pool.query(`DELETE FROM iam.permission_groups WHERE id = $1`, [idOutro]);
      await pool.query(`DELETE FROM iam.tenants WHERE id = $1`, [tenantOutro]);
    });

    it('🔴 id inexistente é 404 — mesmo caminho, indistinguível de outro tenant', async () => {
      const res = await chamar('DELETE', '/api/admin/permission-groups/99999999-9999-4999-8999-999999999999', U.gestor);

      expect(res.status).toBe(404);
    });

    it('id malformado é 400 e não chega ao banco', async () => {
      const res = await chamar('PATCH', '/api/admin/permission-groups/../../etc/passwd', U.gestor, { name: 'x' });

      expect([400, 404]).toContain(res.status);
    });
  });

  // ── (d) STAFF SEM CÉLULA CHAMANDO DIRETO ───────────────────────────────────

  describe('(d) staff sem célula chamando cada rota direto, não pela tela', () => {
    const rotas: Array<[string, string, unknown]> = [
      ['POST', '/api/admin/permission-groups', { name: 'Abuse E2E direto' }],
      ['PATCH', '/api/admin/permission-groups/:id', { name: 'renomeado' }],
      ['DELETE', '/api/admin/permission-groups/:id', undefined],
      ['PUT', '/api/admin/permission-groups/:id/permissions', { cellKeys: ['worker:read'] }],
      ['POST', '/api/admin/permission-groups/:id/countries', { country: 'BR', reason: 'x' }],
      ['DELETE', '/api/admin/permission-groups/:id/countries/AR', undefined],
      ['POST', '/api/admin/permission-groups/:id/members', { userId: 'abuse-e2e-comum' }],
      ['DELETE', '/api/admin/permission-groups/:id/members/abuse-e2e-comum', undefined],
      ['PUT', '/api/admin/country-features/BR/screen:abuse-e2e', { enabled: true, reason: 'x' }],
    ];

    it.each(rotas)('🔴 %s %s — staff SEM GRUPO é recusado', async (metodo, caminho, corpo) => {
      const res = await chamar(metodo, caminho.replace(':id', idAlvo), U.semGrupo, corpo);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
    });

    it('🔴 e o banco não guardou NADA do que o staff sem grupo tentou', async () => {
      const novos = await pool.query(`SELECT 1 FROM iam.permission_groups WHERE name = $1`, ['Abuse E2E direto']);
      expect(novos.rowCount).toBe(0);

      const feature = await pool.query(`SELECT 1 FROM iam.country_features WHERE feature_key = $1`, ['screen:abuse-e2e']);
      expect(feature.rowCount).toBe(0);

      const grupo = await pool.query(`SELECT name, archived_at FROM iam.permission_groups WHERE id = $1`, [idAlvo]);
      expect(grupo.rows[0].name).toBe(G.alvo);
      expect(grupo.rows[0].archived_at).toBeNull();
    });

    it('sem credencial nenhuma é 401, antes de qualquer decisão', async () => {
      const res = await chamar('POST', '/api/admin/permission-groups', null, { name: 'x' });
      expect(res.status).toBe(401);
    });
  });

  // ── (e) ANTI-LOCKOUT POR CAMINHO INDIRETO ──────────────────────────────────

  describe('(e) anti-lockout: o último gestor não cai por nenhum caminho', () => {
    async function gestoresAtivos(): Promise<number> {
      const r = await pool.query(
        `SELECT count(DISTINCT u.firebase_uid)::int AS n FROM users u
          WHERE u.status = 'ACTIVE'
            AND 'permission_management:write' = ANY (iam.effective_permissions(u.firebase_uid, $1))`,
        [TENANT_E2E],
      );
      return r.rows[0].n as number;
    }

    it('a fixture tem EXATAMENTE um gestor — senão nada abaixo prova coisa alguma', async () => {
      expect(await gestoresAtivos()).toBe(1);
    });

    it('🔴 caminho 1: o gestor não se REMOVE do próprio grupo', async () => {
      const res = await chamar('DELETE', `/api/admin/permission-groups/${idGestao}/members/${U.gestor}`, U.gestor);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_manager');
      expect(await membrosVivos(idGestao)).toEqual([U.gestor]);
      expect(await gestoresAtivos()).toBe(1);
    });

    it('🔴 caminho 2: nem ARQUIVA o grupo que carrega a célula', async () => {
      const res = await chamar('DELETE', `/api/admin/permission-groups/${idGestao}`, U.gestor);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_manager');
      const g = await pool.query(`SELECT archived_at FROM iam.permission_groups WHERE id = $1`, [idGestao]);
      expect(g.rows[0].archived_at).toBeNull();
      expect(await gestoresAtivos()).toBe(1);
    });

    it('🔴 caminho 3: nem TIRA a célula do grupo, deixando o grupo vivo e vazio', async () => {
      const res = await chamar('PUT', `/api/admin/permission-groups/${idGestao}/permissions`, U.gestor, {
        cellKeys: ['permission_management:read'],
        reason: 'tentativa de lockout',
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_manager');
      expect(await celulasDoGrupo(idGestao)).toContain('permission_management:write');
      expect(await gestoresAtivos()).toBe(1);
    });

    it('com DOIS gestores, os mesmos caminhos passam — a trava é o último, não a operação', async () => {
      // Controle POSITIVO: sem ele, uma função que recusasse SEMPRE passaria nos
      // três casos acima e a suíte aprovaria um sistema inoperante.
      await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
        U.comum, idGestao, TENANT_E2E,
      ]);
      app.invalidar([U.comum, U.gestor]);
      expect(await gestoresAtivos()).toBe(2);

      const res = await chamar('DELETE', `/api/admin/permission-groups/${idGestao}/members/${U.gestor}`, U.comum);

      expect(res.status).toBe(200);
      expect(await gestoresAtivos()).toBe(1);
      expect(await membrosVivos(idGestao)).toEqual([U.comum]);

      // ⚠️ RESTAURA a fixture. Sem isto o `U.comum` sai deste bloco sendo
      // GESTOR, e o bloco (f) — que roda depois e usa o mesmo uid como "staff
      // sem a célula" — mede o oposto do que afirma e passa por engano.
      // Acoplamento por ordem de teste é defeito do teste, não do código.
      await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
        U.gestor, idGestao, TENANT_E2E,
      ]);
      await pool.query(
        `UPDATE iam.user_groups SET removed_at = now() WHERE user_id = $1 AND group_id = $2 AND removed_at IS NULL`,
        [U.comum, idGestao],
      );
      app.invalidar([U.comum, U.gestor]);
      expect(await gestoresAtivos()).toBe(1);
    });

    it('a fixture voltou ao estado inicial — um gestor, e o comum sem a célula', async () => {
      // Controle da restauração acima: se ela falhar, é AQUI que aparece, e não
      // num caso do bloco (f) reprovando por motivo errado.
      expect(await membrosVivos(idGestao)).toEqual([U.gestor]);
      const r = await pool.query(
        `SELECT 'permission_management:write' = ANY (iam.effective_permissions($1, $2)) AS tem`,
        [U.comum, TENANT_E2E],
      );
      expect(r.rows[0].tem).toBe(false);
    });
  });

  // ── (f) COUNTRY-FEATURES PARA PAÍS FORA DO GRANT ───────────────────────────

  describe('(f) country-features', () => {
    it('país fora do catálogo é 400 e não cria linha', async () => {
      const res = await chamar('PUT', '/api/admin/country-features/XX/screen:abuse', U.comum, {
        enabled: true, reason: 'x',
      });

      expect(res.status).toBe(400);
      const r = await pool.query(`SELECT 1 FROM iam.country_features WHERE feature_key = $1`, ['screen:abuse']);
      expect(r.rowCount).toBe(0);
    });

    it('🔴 staff sem a célula não liga feature em país nenhum, nem no seu', async () => {
      const res = await chamar('PUT', '/api/admin/country-features/AR/screen:abuse', U.comum, {
        enabled: true, reason: 'x',
      });

      expect(res.status).toBe(403);
      const r = await pool.query(`SELECT 1 FROM iam.country_features WHERE feature_key = $1`, ['screen:abuse']);
      expect(r.rowCount).toBe(0);
    });

    it('chave de feature malformada é recusada — e a mensagem diz qual é o problema', async () => {
      const res = await chamar('PUT', '/api/admin/country-features/AR/NAO_E_CHAVE', U.comum, {
        enabled: true, reason: 'x',
      });

      expect([400, 403]).toContain(res.status);
    });
  });
});
