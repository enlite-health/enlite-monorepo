/**
 * adminStaffDirectory.e2e.test.ts — spec 022, Bloco 1 (T127). HTTP real (app em processo,
 * mesmo harness de família única — `permissionFamilyHarness.ts`), Postgres real, engine ABAC
 * LIGADO (`PERMISSION_ENGINE_ENABLED=true` + família `admin.users`).
 *
 * Contrato: `specs/022-chat-interno-por-paciente/contracts/openapi-staff-directory.md`.
 * Alimenta o autocomplete de menção (`<@uid>`) do chat interno — NÃO é uma API de diretório de
 * pessoal: resposta é `{ uid, displayName, isOnline }[]`, nunca `email` nem `role` (D-06).
 * `isOnline`/`limit`/exclusão do próprio requester — change 022-ux-mencao-e-notificacao,
 * Rodada 2/R2-B.
 *
 * Nenhuma PII real — uid/e-mail/nome sintéticos (`e022-staffdir-*`, `@e2e.local`).
 *
 * Como rodar (RED, antes de T128 existir):
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022 \
 *     npx jest --config jest.config.e2e.js tests/e2e/staffDirectory/adminStaffDirectory.e2e.test.ts
 *
 * (GREEN, com engine ligado — mesma env que o beforeAll já declara.)
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

describe('Diretório de staff (spec 022, Bloco 1) — HTTP real, Postgres real, engine ABAC ligado', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const COUNTRY = 'AR';

  const U = {
    comCelula: 'e022-staffdir-com-celula',
    comCelula2: 'e022-staffdir-com-celula-2',
    semCelula: 'e022-staffdir-sem-celula',
    inativo: 'e022-staffdir-inativo',
  };
  const GRUPO_COMPLETA = 'E022 StaffDirectory Completa';
  const CELULA: [string, string] = ['staff_directory', 'read'];
  const celulasCriadas: Array<[string, string]> = [];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: [GRUPO_COMPLETA, `${GRUPO_COMPLETA} 2`] });
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

  async function chamar(caminho: string, uid: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      headers: { Authorization: tokenMock(uid, 'admin', COUNTRY) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    // `status='ACTIVE'` para comCelula/semCelula (a diferença entre eles é a CÉLULA, não o
    // account status) — `is_active` é DERIVADO de `status` pelo trigger
    // `sync_user_status_to_is_active` (`NEW.is_active := (NEW.status = 'ACTIVE')`), então não é
    // passado à mão. `inativo` é o dado de CONTROLE: staff com `status='DEACTIVATED'`
    // (único valor do CHECK que garante `is_active=false`) — sem ele, o teste "inativo não
    // aparece" não prova nada (poderia estar filtrando por outra coisa e passar por acidente).
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, tenant_id) VALUES
         ($1, 'e022-staffdir-com-celula@e2e.local', 'Staffdir QA ComCelula', 'admin', 'ACTIVE', $5),
         ($2, 'e022-staffdir-com-celula-2@e2e.local', 'Staffdir QA ComCelula2', 'admin', 'ACTIVE', $5),
         ($3, 'e022-staffdir-sem-celula@e2e.local', 'Staffdir QA SemCelula', 'admin', 'ACTIVE', $5),
         ($4, 'e022-staffdir-inativo@e2e.local', 'Staffdir QA Inativo', 'admin', 'DEACTIVATED', $5)`,
      [U.comCelula, U.comCelula2, U.semCelula, U.inativo, TENANT_E2E],
    );

    // R2-B (reescrito 22/09 para tabela própria): comCelula tem heartbeat RECENTE (isOnline=true
    // visto por outro) — linha em `staff_presence`; comCelula2 nunca mandou heartbeat (nenhuma
    // linha em `staff_presence` → isOnline=false, controle, por AUSÊNCIA de linha, não `NULL`
    // numa coluna).
    await pool.query(
      `INSERT INTO staff_presence (firebase_uid, last_seen_at) VALUES ($1, now())`,
      [U.comCelula],
    );

    // Célula NOVA (`staff_directory:read`) — não veio do seed da mig 206, então precisa ser
    // garantida antes de `grupoComCelulas` (que falha alto se a célula não existir).
    const { criada } = await garantirCelula(pool, { resource: CELULA[0], action: CELULA[1], category: 'Usuários' });
    if (criada) celulasCriadas.push([CELULA[0], CELULA[1]]);

    // U.semCelula fica FORA de qualquer grupo (0 grupos) — cenário `no_group` do
    // PermissionMiddleware, 403 por falta de célula.
    await grupoComCelulas(pool, { nome: GRUPO_COMPLETA, uid: U.comCelula, celulas: [CELULA] });
    await grupoComCelulas(pool, { nome: `${GRUPO_COMPLETA} 2`, uid: U.comCelula2, celulas: [CELULA] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createAdminStaffDirectoryRoutes } = await import(
      '../../../src/modules/identity/interfaces/routes/adminStaffDirectoryRoutes'
    );
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', createAdminStaffDirectoryRoutes(auth, permissions)),
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

  it('1. q com 1 caractere — 400', async () => {
    const res = await chamar('/api/admin/staff-directory?q=S', U.comCelula);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('2. busca parcial por nome — devolve staff ATIVO (comCelula2, visto por comCelula)', async () => {
    const res = await chamar('/api/admin/staff-directory?q=Staffdir', U.comCelula);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // R2-B: o requester (comCelula) nunca aparece na PRÓPRIA lista — a linha de controle
    // positivo agora é o OUTRO staff com célula (comCelula2), não o próprio requester.
    const linha = res.body.data.find((e: { uid: string }) => e.uid === U.comCelula2);
    expect(linha).toBeDefined();
    expect(linha.displayName).toBe('Staffdir QA ComCelula2');
  });

  it('3. staff INATIVO não aparece (dado de controle: mesma busca, is_active=false)', async () => {
    const res = await chamar('/api/admin/staff-directory?q=Staffdir', U.comCelula);
    expect(res.status).toBe(200);

    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    // Controle positivo: o ATIVO com o MESMO prefixo de busca aparece — prova que a query
    // realmente casa o termo. Se os dois lados estivessem ausentes, provaria filtro quebrado,
    // não a régua de `is_active`.
    expect(uids).toContain(U.comCelula2);
    expect(uids).not.toContain(U.inativo);
  });

  it('4. resposta NUNCA contém email nem role — só uid/displayName/isOnline (R2-B)', async () => {
    const res = await chamar('/api/admin/staff-directory?q=Staffdir', U.comCelula);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);

    for (const entrada of res.body.data) {
      expect(Object.keys(entrada).sort()).toEqual(['displayName', 'isOnline', 'uid']);
      expect(entrada).not.toHaveProperty('email');
      expect(entrada).not.toHaveProperty('role');
      expect(entrada).not.toHaveProperty('lastSeenAt');
      expect(entrada).not.toHaveProperty('last_seen_at');
    }
  });

  it('5. sem célula — 403; com célula (MESMA rota, MESMO run) — 200', async () => {
    const semCelula = await chamar('/api/admin/staff-directory?q=Staffdir', U.semCelula);
    expect(semCelula.status).toBe(403);
    expect(semCelula.body.code).toBe('no_group');

    // Controle positivo NA MESMA rota: se os dois lados dessem 403, provaria stack quebrada,
    // não ABAC.
    const comCelula = await chamar('/api/admin/staff-directory?q=Staffdir', U.comCelula);
    expect(comCelula.status).toBe(200);
    expect(comCelula.body.success).toBe(true);
  });

  // Item 1 da change 022-ux-mencao-e-notificacao (revoga D-06, `fatos-medidos.md` F2): `q`
  // ausente/vazio deixa de ser 400 e passa a listar os primeiros N do diretório.
  it('6. q AUSENTE — 200 com os primeiros resultados (revoga D-06)', async () => {
    const res = await chamar('/api/admin/staff-directory', U.comCelula);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);

    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    expect(uids).toContain(U.comCelula2); // R2-B: comCelula (requester) nunca aparece na própria lista
    expect(uids).not.toContain(U.inativo); // mesma régua de is_active=false
  });

  it('7. q VAZIO (?q=) — mesmo comportamento de q ausente, 200 com a lista', async () => {
    const res = await chamar('/api/admin/staff-directory?q=', U.comCelula);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    expect(uids).toContain(U.comCelula2);
  });

  it('8. resposta de q ausente também NUNCA contém email nem role (mesma forma da busca com texto)', async () => {
    const res = await chamar('/api/admin/staff-directory', U.comCelula);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const entrada of res.body.data) {
      expect(Object.keys(entrada).sort()).toEqual(['displayName', 'isOnline', 'uid']);
    }
  });

  // ── R2-B (change 022-ux-mencao-e-notificacao, Rodada 2) ──────────────────────────────────────

  it('9. isOnline: true para quem mandou heartbeat há pouco, false para quem nunca mandou', async () => {
    const res = await chamar('/api/admin/staff-directory?q=Staffdir', U.comCelula);
    expect(res.status).toBe(200);

    // comCelula mandou heartbeat no beforeAll (last_seen_at = now()); comCelula2 nunca mandou
    // (last_seen_at NULL). Visto pelo OUTRO requester (comCelula2), para não depender da
    // auto-exclusão de quem está sendo medido.
    const res2 = await chamar('/api/admin/staff-directory?q=Staffdir', U.comCelula2);
    const linhaComCelula = res2.body.data.find((e: { uid: string }) => e.uid === U.comCelula);
    expect(linhaComCelula).toBeDefined();
    expect(linhaComCelula.isOnline).toBe(true);

    const linhaComCelula2 = res.body.data.find((e: { uid: string }) => e.uid === U.comCelula2);
    expect(linhaComCelula2).toBeDefined();
    expect(linhaComCelula2.isOnline).toBe(false);
  });

  it('10. o requester NUNCA aparece na própria lista, com ou sem `q`', async () => {
    const semQ = await chamar('/api/admin/staff-directory', U.comCelula);
    expect(semQ.body.data.map((e: { uid: string }) => e.uid)).not.toContain(U.comCelula);

    const comQ = await chamar('/api/admin/staff-directory?q=Staffdir', U.comCelula);
    expect(comQ.body.data.map((e: { uid: string }) => e.uid)).not.toContain(U.comCelula);
  });

  it('11. limit: respeitado (limit=1 devolve no máximo 1 entrada); acima do teto (201) — 400', async () => {
    const limitado = await chamar('/api/admin/staff-directory?limit=1', U.comCelula);
    expect(limitado.status).toBe(200);
    expect(limitado.body.data.length).toBeLessThanOrEqual(1);

    const acimaDoTeto = await chamar('/api/admin/staff-directory?limit=201', U.comCelula);
    expect(acimaDoTeto.status).toBe(400);
  });
});
