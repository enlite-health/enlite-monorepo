import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * EXPORT/IMPORT DA CONFIGURAÇÃO IAM (D208) — banco real, roles do app, ator por GUC.
 *
 * A stage é onde o time configura; o JSON é o que viaja para prod. Aqui o alvo é
 * o próprio banco de e2e: exporto, importo de volta (0 ops), altero o JSON e
 * provo que o import aplica EXATAMENTE aquilo, pelas funções da 279 (a trilha
 * `permission_group_changes`/`country_feature_changes` nasce delas — é a prova
 * de que não houve INSERT direto). E os dois fail-closed: célula inexistente
 * (nada escrito) e último gestor removido (23514, ROLLBACK de tudo).
 * ⚠️ Mock é PROIBIDO aqui.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';

describe('iam-config export/import (D208)', () => {
  let admin: Pool;
  let runtime: Pool;
  let repo: import('@modules/identity/permissions/infrastructure/PgIamConfigRepository').PgIamConfigRepository;
  let plan: typeof import('@modules/identity/permissions/application/iamConfig');

  const U = { gestor: 'cfg-e2e-gestor', gestor2: 'cfg-e2e-gestor2', ana: 'cfg-e2e-ana', semCelula: 'cfg-e2e-sem-celula' };
  const G = { cfg: 'CFG E2E Recrutamento', novo: 'CFG E2E Novo' };
  const email = (u: string) => `${u}@e2e.local`;

  async function limpar(): Promise<void> {
    await admin.query(`DELETE FROM iam.country_feature_changes WHERE feature_key LIKE 'screen:cfg-e2e%'`);
    await admin.query(`DELETE FROM iam.country_features WHERE feature_key LIKE 'screen:cfg-e2e%'`);
    await admin.query(`DELETE FROM iam.permission_group_changes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'CFG E2E%')`);
    await admin.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'CFG E2E%')`);
    await admin.query(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'CFG E2E%')`);
    await admin.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1)`, [Object.values(U)]);
    await admin.query(`DELETE FROM iam.permission_groups WHERE name LIKE 'CFG E2E%'`);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [Object.values(U)]);
  }

  async function gruposVivos(): Promise<string[]> {
    const r = await admin.query(`SELECT name FROM iam.permission_groups WHERE name LIKE 'CFG E2E%' AND archived_at IS NULL ORDER BY 1`);
    return r.rows.map((x) => x.name as string);
  }
  async function membros(nome: string): Promise<string[]> {
    const r = await admin.query(
      `SELECT ug.user_id FROM iam.user_groups ug JOIN iam.permission_groups g ON g.id = ug.group_id WHERE g.name = $1 AND ug.removed_at IS NULL ORDER BY 1`,
      [nome],
    );
    return r.rows.map((x) => x.user_id as string);
  }
  async function trilha(nome: string): Promise<Array<{ op: string; changed_by: string; reason: string }>> {
    const r = await admin.query(
      `SELECT c.op, c.changed_by, c.reason FROM iam.permission_group_changes c JOIN iam.permission_groups g ON g.id = c.group_id WHERE g.name = $1 ORDER BY c.changed_at, c.op`,
      [nome],
    );
    return r.rows;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    runtime = new Pool({ connectionString: DATABASE_URL, options: '-c role=app_runtime' });
    await limpar();
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, $5, 'admin', 'ACTIVE', true, $9), ($2, $6, 'admin', 'ACTIVE', true, $9),
         ($3, $7, 'recruiter', 'ACTIVE', true, $9), ($4, $8, 'recruiter', 'ACTIVE', true, $9)`,
      [U.gestor, U.gestor2, U.ana, U.semCelula, email(U.gestor), email(U.gestor2), email(U.ana), email(U.semCelula), TENANT],
    );
    // gestor no Acesso Master (tem permission_management:write) — é o ATOR do import
    const master = await admin.query(`SELECT id FROM iam.permission_groups WHERE name = 'Acesso Master' AND tenant_id = $1`, [TENANT]);
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.gestor, master.rows[0].id, TENANT]);
    // grupo de teste com célula, país e membro — o que a "stage" teria montado
    const g = await admin.query(`INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING id`, [TENANT, G.cfg]);
    await admin.query(`INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = 'worker' AND action = 'read'`, [g.rows[0].id]);
    await admin.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'AR', $2, 'e2e')`, [g.rows[0].id, U.gestor]);
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.ana, g.rows[0].id, TENANT]);

    setEnv('DATABASE_URL', DATABASE_URL);
    const { PgIamConfigRepository } = await import('@modules/identity/permissions/infrastructure/PgIamConfigRepository');
    plan = await import('@modules/identity/permissions/application/iamConfig');
    repo = new PgIamConfigRepository(runtime);
  }, 30000);

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string) { envAnterior[k] = process.env[k]; process.env[k] = v; }

  afterAll(async () => {
    await limpar();
    await runtime.end();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  async function estadoAlvo() {
    return {
      current: await repo.exportSnapshot(TENANT),
      catalog: await repo.liveCells(),
      knownEmails: new Set((await repo.staffUidsByEmail()).keys()),
      // (M1) `removableEmails` — mesma lookup SEM filtro de role que o script real
      // usa para REMOVE (`uidsByEmailAny`), distinta de `knownEmails` (staff-only).
      removableEmails: new Set((await repo.uidsByEmailAny()).keys()),
      archivedGroupNames: await repo.archivedGroupNames(TENANT),
    };
  }
  const ctx = async () => ({ tenantId: TENANT, actorUid: U.gestor, reason: 'e2e import' });

  it('export → import no MESMO banco = 0 operações; export 2× = mesmo hash (idempotência provada)', async () => {
    const s1 = await repo.exportSnapshot(TENANT);
    const s2 = await repo.exportSnapshot(TENANT);
    expect(plan.snapshotHash(s1)).toBe(plan.snapshotHash(s2));
    const cfg = s1.groups.find((g) => g.name === G.cfg)!;
    expect(cfg).toMatchObject({ cells: ['worker:read'], countries: ['AR'], members: [email(U.ana)] });
    const p = plan.planIamConfigImport(s1, await estadoAlvo());
    expect(p).toEqual({ ops: [], errors: [], pendencies: [] });
    expect(await repo.applyPlan(p, await ctx())).toBe(0);
  });

  it('JSON alterado (célula +, membro −, feature off, grupo novo) → aplica EXATAMENTE isso, pela 279, com trilha', async () => {
    const desired = await repo.exportSnapshot(TENANT);
    const cfg = desired.groups.find((g) => g.name === G.cfg)!;
    cfg.cells = ['worker:read', 'vacancy:read'];
    cfg.members = [];
    desired.groups.push({ name: G.novo, description: 'nasceu do JSON', isSystem: false, cells: ['worker:read'], countries: ['BR'], members: [email(U.semCelula)] });
    desired.countryFeatures.push({ country: 'AR', featureKey: 'screen:cfg-e2e', enabled: false, config: { motivo: 'e2e' } });

    const p = plan.planIamConfigImport(desired, await estadoAlvo());
    expect(p.errors).toEqual([]);
    expect(p.ops.map((o) => o.kind)).toEqual(['create_group', 'set_permissions', 'set_permissions', 'grant_country', 'add_member', 'remove_member', 'set_country_feature']);
    expect(await repo.applyPlan(p, await ctx())).toBe(7);

    // efeito no banco, não no plano
    expect(await gruposVivos()).toEqual([G.novo, G.cfg]);
    expect(await membros(G.cfg)).toEqual([]);
    expect(await membros(G.novo)).toEqual([U.semCelula]);
    const depois = await repo.exportSnapshot(TENANT);
    expect(depois.groups.find((g) => g.name === G.cfg)?.cells).toEqual(['vacancy:read', 'worker:read']);
    expect(depois.groups.find((g) => g.name === G.novo)).toMatchObject({ countries: ['BR'], members: [email(U.semCelula)] });
    expect(depois.countryFeatures).toContainEqual({ country: 'AR', featureKey: 'screen:cfg-e2e', enabled: false, config: { motivo: 'e2e' } });
    // a TRILHA nasceu da 279: autoria = ator, reason = a nossa
    const t = await trilha(G.cfg);
    expect(t).toEqual([{ op: 'add', changed_by: U.gestor, reason: 'e2e import' }]);
    const vinculo = await admin.query(`SELECT assigned_by FROM iam.user_groups ug JOIN iam.permission_groups g ON g.id = ug.group_id WHERE g.name = $1 AND ug.removed_at IS NULL`, [G.novo]);
    expect(vinculo.rows[0].assigned_by).toBe(U.gestor);
    const removido = await admin.query(`SELECT removed_by FROM iam.user_groups WHERE user_id = $1 AND removed_at IS NOT NULL`, [U.ana]);
    expect(removido.rows[0].removed_by).toBe(U.gestor);
    const feat = await admin.query(`SELECT f.source, c.reason, c.changed_by FROM iam.country_features f JOIN iam.country_feature_changes c USING (country, feature_key) WHERE f.feature_key = 'screen:cfg-e2e'`);
    expect(feat.rows[0]).toMatchObject({ source: 'override', reason: 'e2e import', changed_by: U.gestor });

    // 2ª execução do MESMO JSON → 0 ops
    const p2 = plan.planIamConfigImport(desired, await estadoAlvo());
    expect(p2.ops).toEqual([]);
  });

  it('célula que o alvo não conhece → erro no plano, applyPlan recusa, NADA escrito', async () => {
    const desired = await repo.exportSnapshot(TENANT);
    desired.groups.find((g) => g.name === G.cfg)!.cells.push('patient:fly');
    const antes = plan.snapshotHash(await repo.exportSnapshot(TENANT));
    const p = plan.planIamConfigImport(desired, await estadoAlvo());
    expect(p.errors).toEqual([{ code: 'unknown_cell', detail: `${G.cfg}: patient:fly` }]);
    await expect(repo.applyPlan(p, await ctx())).rejects.toThrow('nada aplicado');
    expect(plan.snapshotHash(await repo.exportSnapshot(TENANT))).toBe(antes);
  });

  it('remover o último gestor pelo JSON → 23514 do banco, ROLLBACK: nem a operação anterior fica', async () => {
    const desired = await repo.exportSnapshot(TENANT);
    const master = desired.groups.find((g) => g.name === 'Acesso Master')!;
    master.members = master.members.filter((m) => m !== email(U.gestor));
    // uma op "inocente" ANTES da remoção, para provar que a transação inteira volta
    desired.groups.find((g) => g.name === G.novo)!.description = 'mudou junto';
    const antes = plan.snapshotHash(await repo.exportSnapshot(TENANT));
    const p = plan.planIamConfigImport(desired, await estadoAlvo());
    expect(p.ops.map((o) => o.kind)).toEqual(['update_group', 'remove_member']);
    await expect(repo.applyPlan(p, await ctx())).rejects.toMatchObject({ code: '23514' });
    expect(plan.snapshotHash(await repo.exportSnapshot(TENANT))).toBe(antes);
  });

  it('ator SEM permission_management:write → 42501 da 279, nada aplicado', async () => {
    const desired = await repo.exportSnapshot(TENANT);
    desired.groups.find((g) => g.name === G.novo)!.description = 'tentativa';
    const p = plan.planIamConfigImport(desired, await estadoAlvo());
    expect(p.ops).toHaveLength(1);
    await expect(repo.applyPlan(p, { tenantId: TENANT, actorUid: U.ana, reason: 'e2e' })).rejects.toMatchObject({ code: '42501' });
  });

  it('e-mail sem conta no alvo é pendência: listado, pulado, e o resto aplica', async () => {
    const desired = await repo.exportSnapshot(TENANT);
    desired.groups.find((g) => g.name === G.novo)!.members.push('ninguem@e2e.local');
    const p = plan.planIamConfigImport(desired, await estadoAlvo());
    expect(p.pendencies).toEqual([{ code: 'email_without_account', email: 'ninguem@e2e.local', group: G.novo }]);
    expect(p.ops).toEqual([]);
  });

  it('os DOIS scripts funcionam de ponta a ponta (export → dry-run 2× idêntico) contra o banco real', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iam-config-'));
    const file = join(dir, 'cfg.json');
    const env = { ...process.env, DATABASE_URL };
    const run = (script: string, args: string[]) =>
      execFileSync('npx', ['ts-node', '-r', 'dotenv/config', '-r', 'tsconfig-paths/register', script, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const exp = run('scripts/iam-config-export.ts', ['--out', file]);
    expect(exp).toMatch(/\[iam-config\] exportado → .*grupos=\d+/);
    const json = readFileSync(file, 'utf8');
    expect(JSON.parse(json).groups.some((g: { name: string }) => g.name === G.cfg)).toBe(true);
    const d1 = run('scripts/iam-config-import.ts', ['--file', file, '--actor-email', email(U.gestor)]);
    const d2 = run('scripts/iam-config-import.ts', ['--file', file, '--actor-email', email(U.gestor)]);
    expect(d1).toContain('DRY-RUN');
    expect(d1).toContain('ops=0');
    expect(d1).toBe(d2);
    // JSON com célula inexistente → o script sai com 1 e não toca o banco
    const quebrado = JSON.parse(json);
    quebrado.groups[0].cells.push('patient:fly');
    writeFileSync(file, JSON.stringify(quebrado));
    expect(() => run('scripts/iam-config-import.ts', ['--file', file, '--actor-email', email(U.gestor), '--execute'])).toThrow();
  }, 120000);
});

/**
 * F12 — marcador `iam.rollout_state` (mig 282) gravado pelo `iam-config-import.ts`.
 *
 * `describe` PRÓPRIO (não aninhado no de cima) de propósito: o Jest só roda o
 * `afterAll` de um describe DEPOIS de todos os `it`s dele — então, rodando
 * como irmão SEGUINTE do describe acima, este só começa depois que `limpar()`
 * já tirou U.gestor/gestor2/ana/semCelula e o grupo `CFG E2E Novo` do banco.
 * Sem isso, "0 staff ACTIVE sem grupo" dependeria do estado que os outros
 * `it`s deixaram (ex.: `U.gestor2` nunca entra em grupo nenhum) — frágil e
 * fora do meu controle.
 *
 * O marcador já vem SEMEADO 'done' neste banco (para o gate de boot/e2e de
 * outro arquivo) — por isso cada teste APAGA o marcador antes de rodar (senão
 * `reportRollout` para em "já é done" e nunca mede nada), e o `afterAll`
 * restaura o valor ORIGINAL (não um 'done' fixo) — o `beforeAll` lê e guarda.
 */
describe('F12 — marcador de rollout (iam.rollout_state) via iam-config-import --execute', () => {
  const KEY = 'permission_groups_migrated';
  const admin = new Pool({ connectionString: DATABASE_URL });
  let original: { value: string; note: string | null } | null = null;

  async function lerMarcador(): Promise<{ value: string; note: string | null } | null> {
    const r = await admin.query<{ value: string; note: string | null }>(`SELECT value, note FROM iam.rollout_state WHERE key = $1`, [KEY]);
    return r.rows[0] ?? null;
  }
  async function apagarMarcador(): Promise<void> {
    await admin.query(`DELETE FROM iam.rollout_state WHERE key = $1`, [KEY]);
  }
  async function contaSemGrupo(): Promise<number> {
    const r = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM users u
        WHERE u.status = 'ACTIVE' AND u.role IN ('admin', 'recruiter', 'community_manager')
          AND NOT EXISTS (
            SELECT 1 FROM iam.user_groups ug JOIN iam.permission_groups g ON g.id = ug.group_id AND g.archived_at IS NULL
             WHERE ug.user_id = u.firebase_uid AND ug.removed_at IS NULL)`,
    );
    return r.rows[0].n;
  }
  async function contaAtivos(): Promise<number> {
    const r = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE' AND role IN ('admin', 'recruiter', 'community_manager')`,
    );
    return r.rows[0].n;
  }
  function runScript(script: string, args: string[]) {
    return execFileSync('npx', ['ts-node', '-r', 'dotenv/config', '-r', 'tsconfig-paths/register', script, ...args], {
      env: { ...process.env, DATABASE_URL },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  beforeAll(async () => {
    original = await lerMarcador();
  }, 30000);

  afterAll(async () => {
    await apagarMarcador();
    if (original) await admin.query(`INSERT INTO iam.rollout_state (key, value, note) VALUES ($1, $2, $3)`, [KEY, original.value, original.note]);
    await admin.end();
  });

  it('todo staff ACTIVE em grupo → --execute grava o marcador done, com a contagem real no log e na nota', async () => {
    await apagarMarcador();
    const uid = 'f12-e2e-comgrupo';
    const mail = `${uid}@e2e.local`;
    await admin.query(`DELETE FROM users WHERE firebase_uid = $1`, [uid]);
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1, $2, 'recruiter', 'ACTIVE', true, $3)`,
      [uid, mail, TENANT],
    );
    const g = await admin.query<{ id: string }>(`INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, 'F12 E2E Grupo', 'f12') RETURNING id`, [TENANT]);
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [uid, g.rows[0].id, TENANT]);

    try {
      expect(await contaSemGrupo()).toBe(0); // pré-condição do cenário — se falhar, o teste não prova o que diz provar
      const totalEsperado = await contaAtivos();

      const dir = mkdtempSync(join(tmpdir(), 'iam-config-f12-'));
      const file = join(dir, 'cfg.json');
      runScript('scripts/iam-config-export.ts', ['--out', file]);
      const out = runScript('scripts/iam-config-import.ts', ['--file', file, '--actor-email', mail, '--execute']);

      expect(out).toContain(`marcador ${KEY} = done (${totalEsperado} staff ativos, 0 sem grupo)`);
      const marcador = await lerMarcador();
      expect(marcador?.value).toBe('done');
      expect(marcador?.note).toMatch(/^iam-config-import cfg\.json@[0-9a-f]{12} \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      await admin.query(`DELETE FROM iam.user_groups WHERE group_id = $1`, [g.rows[0].id]);
      await admin.query(`DELETE FROM iam.permission_groups WHERE id = $1`, [g.rows[0].id]);
      await admin.query(`DELETE FROM users WHERE firebase_uid = $1`, [uid]);
    }
  }, 60000);

  it('1 staff ACTIVE sem grupo → --execute NÃO grava o marcador e sai com código 2', async () => {
    await apagarMarcador();
    const uid = 'f12-e2e-semgrupo';
    const mail = `${uid}@e2e.local`;
    await admin.query(`DELETE FROM users WHERE firebase_uid = $1`, [uid]);
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1, $2, 'recruiter', 'ACTIVE', true, $3)`,
      [uid, mail, TENANT],
    );

    try {
      const semGrupoEsperado = await contaSemGrupo();
      expect(semGrupoEsperado).toBeGreaterThan(0); // pré-condição — este uid, sem nenhum grupo

      const dir = mkdtempSync(join(tmpdir(), 'iam-config-f12-'));
      const file = join(dir, 'cfg.json');
      runScript('scripts/iam-config-export.ts', ['--out', file]);

      let erro: (Error & { status?: number | null; stdout?: string; stderr?: string }) | undefined;
      try {
        runScript('scripts/iam-config-import.ts', ['--file', file, '--actor-email', mail, '--execute']);
      } catch (e) {
        erro = e as typeof erro;
      }
      expect(erro).toBeDefined();
      expect(erro?.status).toBe(2);
      expect(`${erro?.stdout ?? ''}${erro?.stderr ?? ''}`).toContain(`marcador ${KEY} NÃO marcado — ${semGrupoEsperado} staff ativo(s) ainda sem grupo`);
      expect(await lerMarcador()).toBeNull();
    } finally {
      await admin.query(`DELETE FROM users WHERE firebase_uid = $1`, [uid]);
    }
  }, 60000);
});
