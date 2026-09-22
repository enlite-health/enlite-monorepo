/**
 * adminPresence.e2e.test.ts — heartbeat de presença (change 022-ux-mencao-e-notificacao,
 * Rodada 2). HTTP real (app em processo, `permissionFamilyHarness.ts`), Postgres real,
 * engine ABAC LIGADO (`PERMISSION_ENGINE_ENABLED=true` + família `admin.users`). Molde:
 * `adminStaffDirectory.e2e.test.ts`/`adminNotifications.e2e.test.ts` (mesma classe "own_*").
 *
 * Cobre o ciclo completo: `POST /api/admin/me/presence` grava `last_seen_at` em `staff_presence`
 * (tabela PRÓPRIA, reescrita 22/09/2026 — NUNCA `users`); `GET /api/admin/staff-directory` calcula
 * `isOnline` sobre o que o heartbeat gravou por LEFT JOIN — não são 2 features testadas em
 * paralelo, é o MESMO dado (`staff_presence.last_seen_at`) visto pelas duas pontas (testes 5/6
 * fazem o round-trip real pelas duas rotas). Teste 7 prova a razão de existir da tabela própria:
 * `users.updated_at` NUNCA muda por causa de heartbeat (o defeito da versão anterior, que gravava
 * `users.last_seen_at` e disparava o trigger `update_users_updated_at`).
 *
 * Nenhuma PII real — uid/e-mail/nome sintéticos (`e022-presence-*`, `@e2e.local`).
 */
import { Pool } from 'pg';
import {
  montarAppDeFamilia,
  tokenMock,
  grupoComCelulas,
  limparIamFixtures,
  garantirCelula,
  TENANT_E2E,
  type AppDeFamilia,
} from '../helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022';

describe('Presença — heartbeat (change 022-ux-mencao-e-notificacao R2-B) — HTTP real, Postgres real, engine ABAC ligado', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const COUNTRY = 'AR';

  const U = {
    comCelula: 'e022-presence-com-celula',
    outro: 'e022-presence-outro',
    semCelula: 'e022-presence-sem-celula',
  };
  const GRUPO = 'E022 Presence Completa';
  const GRUPO_OUTRO = 'E022 Presence Outro';
  const CELULA: [string, string] = ['own_presence', 'update'];
  // `outro` também precisa de `staff_directory:read` (testes 5/6 — round-trip real: ele é quem
  // LÊ o diretório para conferir o `isOnline` que o heartbeat de comCelula gravou).
  const CELULA_DIRETORIO: [string, string] = ['staff_directory', 'read'];
  const celulasCriadas: Array<[string, string]> = [];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: [GRUPO, GRUPO_OUTRO] });
  }

  async function limparCelulasCriadas(): Promise<void> {
    for (const [resource, action] of celulasCriadas) {
      await pool.query(
        `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`,
        [resource, action],
      );
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
  }

  async function heartbeat(uid: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${app.url}/api/admin/me/presence`, {
      method: 'POST',
      headers: { Authorization: tokenMock(uid, 'admin', COUNTRY) },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function staffDirectory(uid: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}/api/admin/staff-directory`, {
      headers: { Authorization: tokenMock(uid, 'admin', COUNTRY) },
    });
    return { status: res.status, body: await res.json() };
  }

  async function lastSeenAt(uid: string): Promise<Date | null> {
    const r = await pool.query(`SELECT last_seen_at FROM staff_presence WHERE firebase_uid = $1`, [uid]);
    return r.rows[0]?.last_seen_at ?? null;
  }

  async function usersUpdatedAt(uid: string): Promise<Date | null> {
    const r = await pool.query(`SELECT updated_at FROM users WHERE firebase_uid = $1`, [uid]);
    return r.rows[0]?.updated_at ?? null;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, tenant_id) VALUES
         ($1, 'e022-presence-com-celula@e2e.local', 'Presence QA ComCelula', 'admin', 'ACTIVE', $4),
         ($2, 'e022-presence-outro@e2e.local', 'Presence QA Outro', 'admin', 'ACTIVE', $4),
         ($3, 'e022-presence-sem-celula@e2e.local', 'Presence QA SemCelula', 'admin', 'ACTIVE', $4)`,
      [U.comCelula, U.outro, U.semCelula, TENANT_E2E],
    );

    // Célula NOVA (`own_presence:update`) — não veio do seed da mig 206; garantida antes de
    // `grupoComCelulas` (que falha alto se a célula não existir). Em prd ela nasce pela migration
    // 466 (grant a TODO grupo ativo) — aqui, no e2e, cada uid recebe explicitamente, mesmo padrão
    // da matriz de `own_notifications` em `adminNotifications.e2e.test.ts`.
    const { criada } = await garantirCelula(pool, { resource: CELULA[0], action: CELULA[1], category: 'Administração' });
    if (criada) celulasCriadas.push(CELULA);
    const { criada: criadaDiretorio } = await garantirCelula(pool, {
      resource: CELULA_DIRETORIO[0],
      action: CELULA_DIRETORIO[1],
      category: 'Administração',
    });
    if (criadaDiretorio) celulasCriadas.push(CELULA_DIRETORIO);

    // U.semCelula fica FORA de qualquer grupo (0 grupos) — cenário `no_group`, 403.
    await grupoComCelulas(pool, { nome: GRUPO, uid: U.comCelula, celulas: [CELULA] });
    // `outro` recebe as DUAS: precisa mandar o PRÓPRIO heartbeat (isolamento, teste 4) e ler o
    // diretório para o round-trip real (testes 5/6).
    await grupoComCelulas(pool, { nome: GRUPO_OUTRO, uid: U.outro, celulas: [CELULA, CELULA_DIRETORIO] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createAdminPresenceRoutes } = await import(
      '../../../src/modules/presence/interfaces/routes/adminPresenceRoutes'
    );
    const { createAdminStaffDirectoryRoutes } = await import(
      '../../../src/modules/identity/interfaces/routes/adminStaffDirectoryRoutes'
    );
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users',
      montarRotas: ({ app: express, auth, permissions }) => {
        express.use('/api/admin', createAdminPresenceRoutes(auth, permissions));
        express.use('/api/admin', createAdminStaffDirectoryRoutes(auth, permissions));
      },
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await limparCelulasCriadas();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('1. sem célula — 403 (grupo vazio, cenário no_group)', async () => {
    const res = await heartbeat(U.semCelula);
    expect(res.status).toBe(403);
  });

  it('2. com célula — 204 sem corpo, e last_seen_at é gravado no PRÓPRIO uid', async () => {
    const antes = await lastSeenAt(U.comCelula);
    const res = await heartbeat(U.comCelula);

    expect(res.status).toBe(204);
    expect(res.body).toBeNull();

    const depois = await lastSeenAt(U.comCelula);
    expect(depois).not.toBeNull();
    if (antes) expect(depois!.getTime()).toBeGreaterThan(antes.getTime());
  });

  it('3. throttle: 2ª chamada em menos de 30s NÃO regrava last_seen_at (mesmo valor, sempre 204)', async () => {
    const r1 = await heartbeat(U.comCelula);
    expect(r1.status).toBe(204);
    const primeiro = await lastSeenAt(U.comCelula);

    const r2 = await heartbeat(U.comCelula);
    expect(r2.status).toBe(204); // throttle é transparente ao cliente — sempre 204
    const segundo = await lastSeenAt(U.comCelula);

    expect(segundo!.getTime()).toBe(primeiro!.getTime());
  });

  it('4. isolamento: heartbeat de um uid nunca move last_seen_at de OUTRO', async () => {
    const outroAntes = await lastSeenAt(U.outro);
    await heartbeat(U.comCelula);
    const outroDepois = await lastSeenAt(U.outro);
    expect(outroDepois?.getTime() ?? null).toBe(outroAntes?.getTime() ?? null);
  });

  it('5. round-trip real: heartbeat de comCelula → staff-directory (visto por OUTRO) mostra isOnline=true', async () => {
    const hb = await heartbeat(U.comCelula);
    expect(hb.status).toBe(204);

    const dir = await staffDirectory(U.outro);
    expect(dir.status).toBe(200);
    const linha = dir.body.data.find((e: { uid: string }) => e.uid === U.comCelula);
    expect(linha).toBeDefined();
    expect(linha.isOnline).toBe(true);
  });

  it('6. last_seen_at de mais de 5 min atrás (ajustado via SQL, sem tocar o heartbeat) → isOnline=false', async () => {
    await pool.query(
      `UPDATE staff_presence SET last_seen_at = now() - interval '10 minutes' WHERE firebase_uid = $1`,
      [U.comCelula],
    );

    const dir = await staffDirectory(U.outro);
    expect(dir.status).toBe(200);
    const linha = dir.body.data.find((e: { uid: string }) => e.uid === U.comCelula);
    expect(linha).toBeDefined();
    expect(linha.isOnline).toBe(false);
  });

  it('7. heartbeat NUNCA altera users.updated_at (a razão de existir de staff_presence como tabela própria)', async () => {
    const antes = await usersUpdatedAt(U.comCelula);
    // Espera >1s para não empatar com timestamps de setup no mesmo milissegundo em CI rápido.
    await new Promise((r) => setTimeout(r, 1100));

    const res = await heartbeat(U.comCelula);
    expect(res.status).toBe(204);

    const depois = await usersUpdatedAt(U.comCelula);
    expect(depois?.getTime()).toBe(antes?.getTime());
  });

  it('8. 2 "abas" (2 chamadas em rajada, <30s de intervalo) gravam APENAS 1 linha/1 valor em staff_presence', async () => {
    await pool.query(`DELETE FROM staff_presence WHERE firebase_uid = $1`, [U.comCelula]);

    const r1 = await heartbeat(U.comCelula); // aba 1
    expect(r1.status).toBe(204);
    const primeiro = await lastSeenAt(U.comCelula);
    expect(primeiro).not.toBeNull();

    const r2 = await heartbeat(U.comCelula); // aba 2, milissegundos depois — throttle deve segurar
    expect(r2.status).toBe(204);
    const segundo = await lastSeenAt(U.comCelula);

    expect(segundo!.getTime()).toBe(primeiro!.getTime());
    const contagem = await pool.query(
      `SELECT COUNT(*)::int AS n FROM staff_presence WHERE firebase_uid = $1`,
      [U.comCelula],
    );
    expect(contagem.rows[0].n).toBe(1);
  });
});
