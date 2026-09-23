import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * E2E de banco real: fundação do painel de grupos de permissão (change
 * painel-grupos-permissao, grupo 1 — migrations 274-280, D115).
 *
 * O que este arquivo PROVA contra Postgres real (não contra mock):
 *   A. mig 274 — schema `iam`: as 8 tabelas moradas em iam, views de compatibilidade
 *      em public, policy 271 re-apontada, privilégios (SELECT sim, escrita NÃO).
 *   B. mig 275/276 — ciclo de vida + funções de resolução: sem grupo → []; arquivado /
 *      removido / suspenso / deprecated / tenant errado → []; histórico + vivo coexistem
 *      e o 2º vínculo vivo do mesmo par é rejeitado.
 *   C. mig 278 — RLS grant-only SOB app_runtime: sem grupo vê 0 (mesmo com claim);
 *      grupo {AR} vê AR; GUCs forjados não abrem nada (lex C3); sistema forjado por
 *      app_runtime não fura; grant/revogação valem na query seguinte.
 *   D. mig 279 — escrita em iam.* SÓ por SECURITY DEFINER (lex C4): INSERT direto
 *      negado; sem ator / sem célula / sem motivo / célula inválida / grupo de sistema
 *      → exceção; caminho feliz grava *_by do GUC; anti-lockout; sync do manifest só
 *      em contexto de sistema e sem sobrescrever override; query_audit gated + registra.
 *   E. mig 280 — permission_audit_log particionada, INSERT-only para as roles do app,
 *      invariante "toda partição é INSERT-only" (trava drift de partição futura).
 *   F. mig 277 — country_features: chave validada, sem FK de domínio.
 *   G. rollback 278_down restaura o ramo do claim.
 *
 * Padrão do harness: `SET LOCAL ROLE app_runtime|app_system` (roles de GRUPO da 269,
 * não-owner) dentro de transação + set_config(..., true) — o contrato do
 * withActorContext. O superuser (enlite_admin) só semeia/afere estado.
 */
describe('IAM — fundação do painel de grupos (migrations 274-280, banco real)', () => {
  let pool: Pool;

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const U = {
    gestor: 'iam-e2e-gestor',
    ana: 'iam-e2e-ana',
    bob: 'iam-e2e-bob',
  };
  const IDS = {
    patientAR: 'ee280000-0a00-0001-0001-000000000001',
    patientBR: 'ee280000-0a00-0001-0002-000000000001',
  };
  const GROUP_NAME = 'IAM E2E Recrutamento';
  let recrutadorId: string;
  let masterId: string;

  async function cleanup(p: Pool): Promise<void> {
    await p.query(`DELETE FROM iam.country_feature_changes WHERE feature_key LIKE 'screen:iam-e2e%'`);
    await p.query(`DELETE FROM iam.country_features WHERE feature_key LIKE 'screen:iam-e2e%'`);
    await p.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [Object.values(U)]);
    await p.query(
      `DELETE FROM iam.permission_group_changes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`,
      [GROUP_NAME],
    );
    await p.query(
      `DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)
         OR granted_by = ANY($2)`,
      [GROUP_NAME, Object.values(U)],
    );
    await p.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1)`, [Object.values(U)]);
    await p.query(`DELETE FROM iam.permission_groups WHERE name = $1`, [GROUP_NAME]);
    await p.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [Object.values(U)]);
    await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);

    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'iam-gestor@e2e.local', 'admin', 'ACTIVE', true, $4),
         ($2, 'iam-ana@e2e.local', 'recruiter', 'ACTIVE', true, $4),
         ($3, 'iam-bob@e2e.local', 'recruiter', 'ACTIVE', true, $4)`,
      [U.gestor, U.ana, U.bob, TENANT],
    );
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES
         ($1, 'iam-e2e-ar', 'Paciente', 'AR', 'AR'),
         ($2, 'iam-e2e-br', 'Paciente', 'BR', 'BR')`,
      [IDS.patientAR, IDS.patientBR],
    );
    const g = await pool.query(`SELECT id, name FROM iam.permission_groups WHERE name IN ('Recrutador', 'Acesso Master')`);
    recrutadorId = g.rows.find((r) => r.name === 'Recrutador')!.id;
    masterId = g.rows.find((r) => r.name === 'Acesso Master')!.id;
    // gestor no Acesso Master (tem permission_management:write) — semeado como superuser
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.gestor, masterId, TENANT]);
  });

  afterAll(async () => {
    // Estado global que este arquivo pode ter deixado: policy restaurada, escopos do Recrutador
    await pool.query(`DELETE FROM iam.group_country_scopes WHERE group_id = $1 AND reason LIKE 'iam-e2e%'`, [recrutadorId]);
    await cleanup(pool);
    await pool.end();
  });

  async function asRole<T>(
    role: 'app_runtime' | 'app_system',
    ctx: { uid?: string; country?: string; countries?: string; systemContext?: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      if (ctx.uid) await client.query(`SELECT set_config('app.user_uid', $1, true)`, [ctx.uid]);
      if (ctx.country) await client.query(`SELECT set_config('app.user_country', $1, true)`, [ctx.country]);
      if (ctx.countries) await client.query(`SELECT set_config('app.user_countries', $1, true)`, [ctx.countries]);
      if (ctx.systemContext) await client.query(`SELECT set_config('app.system_context', $1, true)`, [ctx.systemContext]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  /** Como asRole, mas COMMITA (para efeitos que precisam sobreviver ao teste seguinte). */
  async function asRoleCommit<T>(
    role: 'app_runtime' | 'app_system',
    ctx: { uid?: string; systemContext?: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      if (ctx.uid) await client.query(`SELECT set_config('app.user_uid', $1, true)`, [ctx.uid]);
      if (ctx.systemContext) await client.query(`SELECT set_config('app.system_context', $1, true)`, [ctx.systemContext]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Os arquivos têm meta-comandos psql (\set, :'ack'); para o protocolo pg, tira essas linhas. */
  function psqlFileForPg(rel: string): string {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    return fs
      .readFileSync(path.resolve(__dirname, rel), 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('\\set') && !l.includes(":'ack'"))
      .join('\n');
  }
  const rollout278SqlForPg = () => psqlFileForPg('../../scripts/rollout/278_rls_country_grant_only.sql');
  const rollback278SqlForPg = () => psqlFileForPg('../../scripts/rollback/278_down.sql');

  /**
   * Aplica a 278 do jeito que o operador aplica: lê quantos staff ACTIVE ficam sem
   * país efetivo e passa o número como ack (pré-condição fail-closed do script). No
   * harness há staff de teste sem grupo por desenho (bob) — o ack é o retrato disso.
   */
  async function applyRollout278(): Promise<void> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sql = rollout278SqlForPg();
    const c = await pool.connect();
    try {
      const n = await c.query(`SELECT count(*)::int n FROM users u WHERE u.status='ACTIVE'
        AND u.role IN ('admin','recruiter','community_manager')
        AND cardinality(iam.effective_countries(u.firebase_uid, iam.current_tenant_id()))=0`);
      await c.query(`SELECT set_config('app.rollout_278_ack', $1, false)`, [String(n.rows[0].n)]);
      await c.query(sql);
    } finally {
      await c.query(`SELECT set_config('app.rollout_278_ack', '', false)`).catch(() => {});
      c.release();
    }
  }

  const eff = (uid: string) =>
    pool.query(`SELECT iam.effective_permissions($1, $2) AS p, iam.effective_countries($1, $2) AS c`, [uid, TENANT])
      .then((r) => r.rows[0] as { p: string[]; c: string[] });

  // ── A. schema iam ────────────────────────────────────────────────────────────────
  describe('A. mig 274 — schema iam', () => {
    it('as 8 tabelas moram em iam e têm view de compatibilidade em public', async () => {
      const t = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='iam' ORDER BY 1`);
      const expected = ['group_country_scopes','group_permissions','permission_groups','permissions','tenants','user_departments','user_groups'];
      for (const name of expected) expect(t.rows.map((r) => r.tablename)).toContain(name);
      // permission_audit_log é particionada (280): aparece como mãe + partições
      const v = await pool.query(`SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname = ANY($1)`,
        [[...expected, 'permission_audit_log']]);
      expect(v.rowCount).toBe(8);
    });

    it('policy de patients referencia iam.* (não quebrou entre 274 e 278)', async () => {
      const r = await pool.query(`SELECT pg_get_expr(polqual, polrelid) AS q FROM pg_policy WHERE polname='patients_country_isolation'`);
      expect(r.rows[0].q).toContain('iam.');
    });

    it('app_runtime lê iam.* mas NÃO escreve nas tabelas de controle de acesso', async () => {
      const r = await pool.query(`
        SELECT t, has_table_privilege('app_runtime', 'iam.'||t, 'SELECT') sel,
               has_table_privilege('app_runtime', 'iam.'||t, 'INSERT') ins
        FROM unnest(ARRAY['permission_groups','user_groups','group_country_scopes','group_permissions','permissions','tenants','country_features']) t`);
      for (const row of r.rows) {
        expect({ t: row.t, sel: row.sel }).toEqual({ t: row.t, sel: true });
        expect({ t: row.t, ins: row.ins }).toEqual({ t: row.t, ins: false });
      }
    });
  });

  // ── B. funções de resolução ──────────────────────────────────────────────────────
  describe('B. mig 275/276 — ciclo de vida e effective_*', () => {
    beforeAll(async () => {
      await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.ana, recrutadorId, TENANT]);
      await pool.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'AR', $2, 'iam-e2e seed')`, [recrutadorId, U.gestor]);
    });

    it('ana no Recrutador com {AR}: as células EFETIVAS batem com o grant cru do grupo (nunca um número fixo — PR-8b/435 muda a contagem a cada célula create/update que o Recrutador ganha) e países {AR}', async () => {
      // Contagem DINÂMICA (item 2 da rodada A3, ADR-2/SUP-30): 435 converte `write` em
      // `create`+`update` para os 23 recursos splitados, o que muda a contagem do Recrutador
      // toda vez que o seed de grupos fixos mudar — travar em "35" ficou obsoleto assim que a
      // migration rodou. A régua correta é: o conjunto que `effective_permissions` devolve é
      // EXATAMENTE `resource:action` das linhas não-deprecated concedidas ao grupo.
      const bruto = await pool.query<{ cell: string }>(
        `SELECT p.resource || ':' || p.action AS cell
           FROM iam.group_permissions gp
           JOIN iam.permissions p ON p.id = gp.permission_id
          WHERE gp.group_id = $1 AND p.deprecated_at IS NULL`,
        [recrutadorId],
      );
      const esperado = bruto.rows.map((row) => row.cell).sort();
      const r = await eff(U.ana);
      expect([...r.p].sort()).toEqual(esperado);
      expect(r.c).toEqual(['AR']);
    });

    it('sem grupo → []; tenant errado → []', async () => {
      const bob = await eff(U.bob);
      expect(bob.p).toEqual([]);
      expect(bob.c).toEqual([]);
      const wrong = await pool.query(`SELECT iam.effective_permissions($1, gen_random_uuid()) AS p`, [U.ana]);
      expect(wrong.rows[0].p).toEqual([]);
    });

    it('grupo arquivado / vínculo removido / usuário suspenso / célula deprecated → some (e volta)', async () => {
      await pool.query(`UPDATE iam.permission_groups SET archived_at = now() WHERE id = $1`, [recrutadorId]);
      expect((await eff(U.ana)).p).toEqual([]);
      await pool.query(`UPDATE iam.permission_groups SET archived_at = NULL WHERE id = $1`, [recrutadorId]);

      await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE user_id = $1`, [U.ana]);
      expect((await eff(U.ana)).c).toEqual([]);
      await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.ana, recrutadorId, TENANT]);
      const hist = await pool.query(`SELECT count(*)::int n, count(*) FILTER (WHERE removed_at IS NULL)::int live FROM iam.user_groups WHERE user_id = $1`, [U.ana]);
      expect(hist.rows[0]).toEqual({ n: 2, live: 1 });

      await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE firebase_uid = $1`, [U.ana]);
      expect((await eff(U.ana)).p).toEqual([]);
      await pool.query(`UPDATE users SET status = 'ACTIVE' WHERE firebase_uid = $1`, [U.ana]);

      await pool.query(`UPDATE iam.permissions SET deprecated_at = now() WHERE resource='vacancy' AND action='read'`);
      expect((await eff(U.ana)).p).not.toContain('vacancy:read');
      await pool.query(`UPDATE iam.permissions SET deprecated_at = NULL WHERE resource='vacancy' AND action='read'`);
      expect((await eff(U.ana)).p).toContain('vacancy:read');
    });

    it('2º vínculo VIVO do mesmo (user, grupo) é rejeitado pelo índice parcial', async () => {
      await expect(
        pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.ana, recrutadorId, TENANT]),
      ).rejects.toMatchObject({ constraint: 'uq_user_groups_live' });
    });
  });

  // ── C. RLS grant-only sob app_runtime ────────────────────────────────────────────
  describe('C. rollout 278 — RLS grant-only (lex C3)', () => {
    const list = `SELECT country FROM patients WHERE id = ANY($1) ORDER BY 1`;
    const both = [IDS.patientAR, IDS.patientBR];
    // A 278 vive em scripts/rollout/ (aplicação manual, gated na task 5.4) — aqui a
    // aplicamos explicitamente e restauramos no fim (278_down) para não mudar o
    // comportamento das outras suítes que rodam no mesmo banco (as do ABAC 271/274
    // provam o modelo ATUAL, com o ramo do claim).
    beforeAll(async () => {
      await applyRollout278();
    });
    afterAll(async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      await pool.query(rollback278SqlForPg());
    });

    it('sem GUC → erro NOMEADO (411, nunca vazio); bob (sem grupo) → 0 mesmo com claim BR e países forjados', async () => {
      await expect(asRole('app_runtime', {}, (c) => c.query(list, [both]))).rejects.toThrow(/rls_session_without_identity/);
      const bob = await asRole('app_runtime', { uid: U.bob, country: 'BR', countries: '{AR,BR}' }, (c) => c.query(list, [both]));
      expect(bob.rowCount).toBe(0);
    });

    it('ana (Recrutador {AR}) vê AR e só AR — claim BR forjado não abre BR', async () => {
      const r = await asRole('app_runtime', { uid: U.ana, country: 'BR', countries: '{AR,BR}' }, (c) => c.query(list, [both]));
      expect(r.rows.map((x) => x.country)).toEqual(['AR']);
    });

    it('app_runtime forjando system_context NÃO fura (gate por role)', async () => {
      const r = await asRole('app_runtime', { uid: U.ana, systemContext: 'job:forjado' }, (c) => c.query(list, [both]));
      expect(r.rows.map((x) => x.country)).toEqual(['AR']);
    });

    it('app_system com contexto declarado vê os dois', async () => {
      const r = await asRole('app_system', { systemContext: 'job:e2e' }, (c) => c.query(list, [both]));
      expect(r.rows.map((x) => x.country)).toEqual(['AR', 'BR']);
    });

    it('grant BR abre BR na query seguinte; revogação fecha', async () => {
      await pool.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'BR', $2, 'iam-e2e grant')`, [recrutadorId, U.gestor]);
      const open = await asRole('app_runtime', { uid: U.ana }, (c) => c.query(list, [both]));
      expect(open.rows.map((x) => x.country)).toEqual(['AR', 'BR']);
      await pool.query(`UPDATE iam.group_country_scopes SET revoked_at = now() WHERE group_id = $1 AND country = 'BR'`, [recrutadorId]);
      const closed = await asRole('app_runtime', { uid: U.ana }, (c) => c.query(list, [both]));
      expect(closed.rows.map((x) => x.country)).toEqual(['AR']);
    });
  });

  // ── D. escrita só por SECURITY DEFINER ───────────────────────────────────────────
  describe('D. mig 279 — funções writer (lex C4/C7)', () => {
    let newGroupId: string;

    it('INSERT direto por app_runtime → permission denied', async () => {
      await expect(
        asRole('app_runtime', { uid: U.gestor }, (c) =>
          c.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'BR', 'x', 'x')`, [recrutadorId])),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('sem ator → 42501; ana (sem célula) → 42501', async () => {
      await expect(asRole('app_runtime', {}, (c) => c.query(`SELECT iam.create_group($1, 'x', 'd')`, [TENANT])))
        .rejects.toMatchObject({ code: '42501' });
      await expect(asRole('app_runtime', { uid: U.ana }, (c) => c.query(`SELECT iam.create_group($1, 'x', 'd')`, [TENANT])))
        .rejects.toMatchObject({ code: '42501' });
    });

    it('gestor: cria grupo, concede país com motivo (idempotente), adiciona membro, seta células — *_by vem do GUC', async () => {
      newGroupId = await asRoleCommit('app_runtime', { uid: U.gestor }, async (c) => {
        const g = await c.query(`SELECT iam.create_group($1, $2, 'e2e') AS id`, [TENANT, GROUP_NAME]);
        const id = g.rows[0].id as string;
        const s1 = await c.query(`SELECT iam.grant_country($1, 'BR', 'iam-e2e expansão') AS id`, [id]);
        const s2 = await c.query(`SELECT iam.grant_country($1, 'BR', 'iam-e2e de novo') AS id`, [id]);
        expect(s1.rows[0].id).toBe(s2.rows[0].id);
        await c.query(`SELECT iam.add_member($1, $2)`, [id, U.ana]);
        // `vacancy:write` foi depreciada pela migration 453 (SUP-31/ADR-2: sem checagem literal
        // de `:write` em código de produção — a rota já pede `create`/`update` desde o PR-8b.4) —
        // conceder a célula viva equivalente, não a descontinuada.
        await c.query(
          `SELECT iam.set_group_permissions($1, ARRAY(SELECT id FROM iam.permissions WHERE resource='vacancy' AND action IN ('read','create','update')), 'setup')`,
          [id],
        );
        return id;
      });
      const scope = await pool.query(`SELECT granted_by FROM iam.group_country_scopes WHERE group_id = $1 AND revoked_at IS NULL`, [newGroupId]);
      expect(scope.rows[0].granted_by).toBe(U.gestor);
      const member = await pool.query(`SELECT assigned_by FROM iam.user_groups WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`, [newGroupId, U.ana]);
      expect(member.rows[0].assigned_by).toBe(U.gestor);
      // migration 469 (spec 022 R4): `iam.create_group` (chamado 2 linhas acima) já concede a
      // este grupo as 3 células `own_*` do catálogo (own_notifications:read/update,
      // own_presence:update — mig 464/466) direto em `group_permissions`, sem trilha própria.
      // `set_group_permissions` é REPLACE TOTAL, mas a migration 470 (Rodada 5, achado A5 do
      // gate revisao-pr da Rodada 4) protege a família `own_*` desse REPLACE: ao gravar só as 3
      // células de vacancy, as 3 `own_*` PERMANECEM no grupo e NÃO entram na trilha como
      // 'remove' — só os 3 'add' de vacancy aparecem (antes da 470 seriam 6 linhas, com 3
      // 'remove' fantasma; ver cabeçalho da migration 470).
      const OWN_PREFIX_BASELINE = 3;
      const changes = await pool.query<{ op: string; changed_by: string; resource: string }>(
        `SELECT c.op, c.changed_by, p.resource
           FROM iam.permission_group_changes c
           JOIN iam.permissions p ON p.id = c.permission_id
          WHERE c.group_id = $1`,
        [newGroupId],
      );
      const ownRemoves = changes.rows.filter((r) => r.resource.startsWith('own_') && r.op === 'remove');
      const vacancyAdds = changes.rows.filter((r) => !r.resource.startsWith('own_'));
      expect(changes.rows).toHaveLength(3); // só os 3 'add' de vacancy — mig 470 barra o 'remove' fantasma de own_*
      expect(ownRemoves).toHaveLength(0); // as OWN_PREFIX_BASELINE own_* NÃO saem mais do grupo (mig 470)
      // 3 linhas, não 2: `set_group_permissions` grava uma linha por permission_id do diff, e a
      // troca de `vacancy:write` (1 célula) por `vacancy:create`+`vacancy:update` (2 células,
      // migration 453) soma 3 ids no total (read+create+update), não 2 (read+write).
      expect(vacancyAdds).toHaveLength(3);
      expect(vacancyAdds.every((r) => r.op === 'add' && r.changed_by === U.gestor)).toBe(true);
      // own_* continuam em group_permissions — confirmado porque o teste seguinte assume este
      // estado de partida ao mexer só na trilha de erro (célula inválida não grava nada a mais).
      const cellCount = await pool.query(`SELECT count(*)::int n FROM iam.group_permissions WHERE group_id = $1`, [newGroupId]);
      expect(cellCount.rows[0].n).toBe(OWN_PREFIX_BASELINE + 3);
      const ana = await eff(U.ana);
      expect(ana.c).toEqual(expect.arrayContaining(['AR', 'BR']));
    });

    it('🔒 país sem motivo NÃO levanta mais 23502 (mig 412); célula inválida → 23503; arquivar grupo de sistema → 23514', async () => {
      // O 23502 saiu da `iam.grant_country` na mig 412 (decisão do Gabriel,
      // 05/09). Aqui a asserção é só que a chamada PASSA — o que ela GRAVA
      // (reason NULL) é medido no `iam-permissions-usecases`, que tem grupo
      // próprio. Este arquivo compartilha `newGroupId` entre os testes, e
      // revogar/reconceder aqui derrubava dois testes vizinhos: a prova não
      // pode custar o estado de quem vem depois.
      await expect(asRole('app_runtime', { uid: U.gestor }, (c) => c.query(`SELECT iam.grant_country($1, 'AR', '  ')`, [newGroupId])))
        .resolves.toBeDefined();
      // e o resto do guarda da função CONTINUA de pé — eu tirei só o RAISE do motivo
      await expect(asRole('app_runtime', { uid: U.gestor }, (c) => c.query(`SELECT iam.set_group_permissions($1, ARRAY[gen_random_uuid()], 'x')`, [newGroupId])))
        .rejects.toMatchObject({ code: '23503' });
      await expect(asRole('app_runtime', { uid: U.gestor }, (c) => c.query(`SELECT iam.archive_group($1)`, [masterId])))
        .rejects.toMatchObject({ code: '23514' });
    });

    it('anti-lockout: remover o último gestor de permission_management:write é rejeitado (23514) e nada muda', async () => {
      // Só o gestor de teste tem write? Outros staff do harness podem ter — filtramos pelo nosso.
      const before = await pool.query(`SELECT count(*)::int n FROM iam.user_groups WHERE user_id = $1 AND removed_at IS NULL`, [U.gestor]);
      const managers = await pool.query(
        `SELECT count(DISTINCT u.firebase_uid)::int n FROM users u WHERE u.status='ACTIVE'
           AND 'permission_management:write' = ANY(iam.effective_permissions(u.firebase_uid, $1))`, [TENANT]);
      if (managers.rows[0].n === 1) {
        await expect(asRole('app_runtime', { uid: U.gestor }, (c) => c.query(`SELECT iam.remove_member($1, $2)`, [masterId, U.gestor])))
          .rejects.toMatchObject({ code: '23514' });
        const after = await pool.query(`SELECT count(*)::int n FROM iam.user_groups WHERE user_id = $1 AND removed_at IS NULL`, [U.gestor]);
        expect(after.rows[0].n).toBe(before.rows[0].n);
      } else {
        // Harness com outros gestores: provamos a invariante pela função diretamente
        // com um tenant onde ele é o único (não há) — então só afirmamos que a
        // função existe e é chamável. Registrar: cenário exato coberto no probe de 16/08.
        expect(managers.rows[0].n).toBeGreaterThan(1);
      }
    });

    it('remove_member é soft (histórico fica) e archive_group tira o acesso', async () => {
      await asRoleCommit('app_runtime', { uid: U.gestor }, (c) => c.query(`SELECT iam.remove_member($1, $2)`, [newGroupId, U.ana]));
      const rows = await pool.query(`SELECT removed_at, removed_by FROM iam.user_groups WHERE group_id = $1 AND user_id = $2`, [newGroupId, U.ana]);
      expect(rows.rows[0].removed_at).not.toBeNull();
      expect(rows.rows[0].removed_by).toBe(U.gestor);
      await asRoleCommit('app_runtime', { uid: U.gestor }, (c) => c.query(`SELECT iam.archive_group($1)`, [newGroupId]));
      const g = await pool.query(`SELECT archived_at, archived_by FROM iam.permission_groups WHERE id = $1`, [newGroupId]);
      expect(g.rows[0].archived_by).toBe(U.gestor);
      expect((await eff(U.ana)).c).not.toContain('BR');
    });

    it('sync do manifest: gate por ACL — app_runtime NÃO chama nem forjando o GUC (BLOCKER (a) do gate #223)', async () => {
      // Sem GUC: 42501 (permission denied for function — ACL)
      await expect(asRole('app_runtime', { uid: U.gestor }, (c) =>
        c.query(`SELECT iam.sync_country_feature_default('BR', 'screen:iam-e2e', false, NULL)`)))
        .rejects.toMatchObject({ code: '42501' });
      // COM app.system_context forjado por app_runtime: continua 42501 — dentro de SECURITY
      // DEFINER `current_user` é o dono, então o gate de role tem que ser ACL, não pg_has_role.
      await expect(asRole('app_runtime', { uid: U.gestor, systemContext: 'job:forjado' }, (c) =>
        c.query(`SELECT iam.sync_country_feature_default('BR', 'screen:iam-e2e', false, NULL)`)))
        .rejects.toMatchObject({ code: '42501' });
      // app_system SEM o GUC: 42501 (o GUC segue obrigatório)
      await expect(asRole('app_system', {}, (c) =>
        c.query(`SELECT iam.sync_country_feature_default('BR', 'screen:iam-e2e', false, NULL)`)))
        .rejects.toMatchObject({ code: '42501' });
      await asRoleCommit('app_runtime', { uid: U.gestor }, (c) =>
        c.query(`SELECT iam.set_country_feature('BR', 'screen:iam-e2e', false, NULL, 'não existe no BR')`));
      await asRoleCommit('app_system', { systemContext: 'job:boot' }, async (c) => {
        await c.query(`SELECT iam.sync_country_feature_default('AR', 'screen:iam-e2e', true, NULL)`);
        await c.query(`SELECT iam.sync_country_feature_default('BR', 'screen:iam-e2e', true, NULL)`);
      });
      const r = await pool.query(`SELECT country, enabled, source FROM iam.country_features WHERE feature_key = 'screen:iam-e2e' ORDER BY country`);
      expect(r.rows).toEqual([
        { country: 'AR', enabled: true, source: 'default' },
        { country: 'BR', enabled: false, source: 'override' },
      ]);
      const ch = await pool.query(`SELECT changed_by, new_source FROM iam.country_feature_changes WHERE feature_key = 'screen:iam-e2e'`);
      expect(ch.rows).toEqual([{ changed_by: U.gestor, new_source: 'override' }]);
    });

    it('query_audit: gated em permission_management:read e o ato fica registrado', async () => {
      await expect(asRole('app_runtime', { uid: U.ana }, (c) => c.query(`SELECT * FROM iam.query_audit(NULL, NULL, NULL, NULL, 10)`)))
        .rejects.toMatchObject({ code: '42501' });
      await asRoleCommit('app_runtime', { uid: U.gestor }, (c) => c.query(`SELECT * FROM iam.query_audit(NULL, NULL, NULL, NULL, 10)`));
      const r = await pool.query(`SELECT decision FROM iam.permission_audit_log WHERE user_id = $1 AND resource = 'permission_audit'`, [U.gestor]);
      expect(r.rows).toEqual([{ decision: 'ALLOW' }]);
    });
  });

  // ── E. audit log particionado — partições INSERT-only; pai/view leem desde a mig 455 ──
  describe('E. mig 280 — permission_audit_log', () => {
    it('é particionada; as PARTIÇÕES continuam INSERT-only (trava drift) — o PAI e a view LEEM por decisão do Gabriel (20/09/2026, mig 455)', async () => {
      const kind = await pool.query(`SELECT relkind FROM pg_class WHERE oid = 'iam.permission_audit_log'::regclass`);
      expect(kind.rows[0].relkind).toBe('p');
      const parts = await pool.query(`
        SELECT c.relname,
               has_table_privilege('app_runtime', c.oid, 'SELECT') sel,
               has_table_privilege('app_runtime', c.oid, 'INSERT') ins,
               has_table_privilege('app_runtime', c.oid, 'UPDATE') upd
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'iam.permission_audit_log'::regclass`);
      expect(parts.rowCount).toBeGreaterThan(80);
      // A mig 455 concede SELECT só no PAI (objeto nomeado) — cada PARTIÇÃO segue sem
      // SELECT individualmente, exatamente como antes. Esta asserção não muda.
      const bad = parts.rows.filter((r) => r.sel || !r.ins || r.upd);
      expect(bad).toEqual([]);
      const mother = await pool.query(`SELECT has_table_privilege('app_runtime','iam.permission_audit_log','SELECT') sel`);
      // A partir da mig 455 (20/09/2026) o PAI passa a LER — decisão explícita do Gabriel
      // que SOBREPÕE o least-privilege desta migration (280) e da 274 (ver cabeçalho da 455).
      expect(mother.rows[0].sel).toBe(true);
      // A VIEW de compatibilidade também passa a ter SELECT — mesma decisão, mesma migration
      // (a 455 aplica `security_invoker=true` na view DEPOIS de conceder o SELECT no pai, na
      // mesma transação, para não abrir janela em que a view perderia leitura).
      const view = await pool.query(`SELECT has_table_privilege('app_runtime','public.permission_audit_log','SELECT') sel`);
      expect(view.rows[0].sel).toBe(true);
      await expect(asRole('app_runtime', {}, (c) => c.query(`SELECT count(*) FROM public.permission_audit_log`)))
        .resolves.toBeDefined();
    });

    /**
     * ⚠️ A reaplicação roda dentro de UMA transação, com ROLLBACK no fim.
     *
     * A 279 define `iam.query_audit` com `CREATE OR REPLACE`, e migrations
     * POSTERIORES redefinem a mesma função (280, e a 283 com o mascaramento por
     * país). Reaplicar a 279 FORA de transação devolvia a versão ANTIGA da
     * função para o banco inteiro — e, como o CI roda as suítes em paralelo
     * contra o MESMO banco, derrubava a suíte vizinha enquanto este arquivo
     * ficava verde. Foi exatamente assim que o mascaramento da 283 sumiu.
     *
     * A asserção de privilégio nunca perceberia: ela olha `has_table_privilege`,
     * e o que muda é o CORPO da função. Por isso a guarda abaixo compara a
     * definição INTEIRA de `query_audit` antes e depois — tudo que a
     * reaplicação poderia ter mexido, não o campo que alguém lembrou de checar.
     *
     * O DDL das duas migrations é transacional (nenhum CONCURRENTLY), então o
     * ROLLBACK devolve o banco ao estado anterior.
     */
    it('re-rodar 274 e 279 DEPOIS da 280 e da 455: a 274 REVOGA de novo a leitura do PAI (efeito colateral esperado da REVOKE explícita nela) — view e partições não mudam', async () => {
      // A mig 455 já rodou antes deste teste (é migration de verdade, aplicada na suíte). A 274
      // tem uma linha explícita `REVOKE SELECT ... ON iam.permission_audit_log` (274:155) que
      // NÃO sabe da 455 e desfaz o GRANT dela ao ser reaplicada — isto é esperado, não regressão:
      // a 274 nunca foi tocada por este PR, e reaplicar migration antiga por cima de decisão nova
      // pode reabrir a janela até a próxima aplicação da 455. A `public.permission_audit_log`
      // (view) NÃO é revogada pela 274 (ela só revoga escrita na view, nunca SELECT — 274:170-173),
      // então o SELECT que a 455 concedeu na view sobrevive à reaplicação.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const DEF = `SELECT pg_get_functiondef('iam.query_audit(varchar,varchar,timestamptz,timestamptz,int)'::regprocedure) AS d`;
      const antes = await pool.query<{ d: string }>(DEF);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.resolve(__dirname, '../../migrations/274_iam_schema.sql'), 'utf8'));
        await client.query(fs.readFileSync(path.resolve(__dirname, '../../migrations/279_iam_writer_functions.sql'), 'utf8'));
        const r = await client.query(`
          SELECT has_table_privilege('app_runtime','iam.permission_audit_log','SELECT') mother,
                 has_table_privilege('app_runtime','public.permission_audit_log','SELECT') view,
                 (SELECT bool_or(has_table_privilege('app_runtime', c.oid, 'SELECT'))
                    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                   WHERE i.inhparent = 'iam.permission_audit_log'::regclass) any_part`);
        expect(r.rows[0]).toEqual({ mother: false, view: true, any_part: false });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }

      // A reaplicação não pode ter deixado rastro NENHUM na função instalada.
      const depois = await pool.query<{ d: string }>(DEF);
      expect(depois.rows[0].d).toBe(antes.rows[0].d);
    });

    it('app_runtime consegue INSERT (trilha) e agora também LÊ o pai por decisão do Gabriel (20/09/2026, mig 455 — sobrepõe o least-privilege desta migration)', async () => {
      await asRole('app_runtime', {}, (c) =>
        c.query(`INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, decision) VALUES ($1, $2, 'x', 'read', 'DENY')`, [TENANT, U.bob]));
      await expect(asRole('app_runtime', {}, (c) => c.query(`SELECT count(*) FROM iam.permission_audit_log`)))
        .resolves.toBeDefined();
    });
  });

  // ── F. country_features ─────────────────────────────────────────────────────────
  describe('F. mig 277 — country_features', () => {
    it('chave fora do formato screen:|options:|component: é rejeitada; sem FK de domínio', async () => {
      await expect(pool.query(`INSERT INTO iam.country_features (country, feature_key, enabled) VALUES ('AR', 'tela:x', true)`))
        .rejects.toMatchObject({ code: '23514' });
      const fks = await pool.query(`SELECT count(*)::int n FROM pg_constraint WHERE conrelid = 'iam.country_features'::regclass AND contype = 'f'`);
      expect(fks.rows[0].n).toBe(0);
    });
  });

  // ── G. rollback ─────────────────────────────────────────────────────────────────
  describe('G. rollout 278 ↔ rollback 278_down são inversos', () => {
    it('278 tira o ramo do claim; 278_down devolve; estado final = policy da 274 (a das outras suítes)', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const up = rollout278SqlForPg();
      const down = rollback278SqlForPg();
      const list = `SELECT country FROM patients WHERE id = ANY($1) ORDER BY 1`;
      const q = () => asRole('app_runtime', { uid: U.bob, country: 'BR' }, (c) => c.query(list, [[IDS.patientAR, IDS.patientBR]]));
      // Pré-condição fail-closed: sem ack → PARA; ack errado → PARA (o "esqueci a 5.1")
      await expect(pool.query(up)).rejects.toMatchObject({ code: '23514' });
      // …e via psql REAL (o caminho do operador): sem -v ack o psql para no :'ack'
      // (ON_ERROR_STOP) e a policy fica INTACTA — BLOCKER do gate #223: antes, sem
      // ON_ERROR_STOP o RAISE era ignorado e o DDL rodava mesmo assim.
      const { execSync } = await import('node:child_process');
      const before = await pool.query(`SELECT obj_description(oid, 'pg_policy') d FROM pg_policy WHERE polname='patients_country_isolation'`);
      let psqlFailed = false;
      try {
        execSync(`psql "${DATABASE_URL}" -q -f scripts/rollout/278_rls_country_grant_only.sql`, { stdio: 'pipe' });
      } catch { psqlFailed = true; }
      expect(psqlFailed).toBe(true);
      const after = await pool.query(`SELECT obj_description(oid, 'pg_policy') d FROM pg_policy WHERE polname='patients_country_isolation'`);
      expect(after.rows[0].d).toBe(before.rows[0].d);   // policy não mudou
      // ack errado via psql real: também para, policy intacta
      let psqlFailed2 = false;
      try {
        execSync(`psql "${DATABASE_URL}" -q -v ack=999 -f scripts/rollout/278_rls_country_grant_only.sql`, { stdio: 'pipe' });
      } catch { psqlFailed2 = true; }
      expect(psqlFailed2).toBe(true);
      const after2 = await pool.query(`SELECT obj_description(oid, 'pg_policy') d FROM pg_policy WHERE polname='patients_country_isolation'`);
      expect(after2.rows[0].d).toBe(before.rows[0].d);
      const c = await pool.connect();
      try {
        await c.query(`SELECT set_config('app.rollout_278_ack', '999', false)`);
        await expect(c.query(up)).rejects.toMatchObject({ code: '23514' });
      } finally { c.release(); }
      await applyRollout278();
      expect((await q()).rowCount).toBe(0);           // grant-only: claim não concede
      await pool.query(down);
      expect((await q()).rows.map((x) => x.country)).toEqual(['BR']);   // claim de volta
    });
  });
});
