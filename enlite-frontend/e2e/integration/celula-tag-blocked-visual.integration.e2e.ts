/**
 * celula-tag-blocked-visual.integration.e2e.ts @integration
 *
 * Spec 024 (D1/D2/D401, 21/09/2026) — prova, contra o backend e o banco REAIS
 * (engine ABAC ligado, catálogo sincronizado), que o corte de células funciona
 * de ponta a ponta:
 *
 *   (a) /admin/tags é gateada por `tag:*`, não mais `worker:*`:
 *       - só `tag:read`  → lista sem NENHUM botão de ação;
 *       - + `tag:update` → edita (clique + teclado, sem fill cru) mas NÃO vê excluir;
 *       - + `tag:delete` → exclui mas NÃO vê editar.
 *   (b) /admin/recruitment/blocked-attempts é gateada por `recruitment_blocked:read`:
 *       - sem a célula → redirecionada para /admin (mesmo padrão de `useContainerAccess`);
 *       - com a célula → a tela abre.
 *   (c) A tela de Acessos e permissões mostra "Etiquetas" como tópico PRÓPRIO
 *       (4 caixas: Ver/Crear/Editar/Eliminar) e "Postulaciones bloqueadas" com
 *       título próprio, SEM o marcador "también en" — prova de que a célula
 *       não está compartilhada com nenhuma outra tela.
 *
 * Molde de auth e helpers: `admin-access-cells-visual.integration.e2e.ts`
 * (mesma família de stack — Postgres + API Docker, mock auth via `mock_<b64>`,
 * SEM Firebase Emulator). Stack local usada nesta corrida (ver
 * `stack-e2e-abac-ligado`/`stack-e2e-isolado-por-projeto-docker` na memória):
 *
 *   cd worker-functions
 *   docker compose -p celulatag -f docker-compose.yml -f docker-compose.test.yml \
 *     -f <override com container_name/ports próprios, CORS_ALLOWED_ORIGINS,
 *        PERMISSION_ENGINE_ENABLED=true, PERMISSION_ENFORCED_ROUTES=<12 famílias>,
 *        PERMISSION_CATALOG_SYNC_ENABLED=true> \
 *     up -d --build postgres api
 *   # gate D117 (fail-closed): marcar a migração de grupos ANTES do 1º boot com engine ligado
 *   psql ... -c "INSERT INTO iam.rollout_state (key,value,note,updated_by)
 *     VALUES ('permission_groups_migrated','done','...','e2e:local') ON CONFLICT (key) DO UPDATE SET value='done'"
 *   docker restart celulatag-api
 *
 *   cd enlite-frontend && cp <repos/infra>/.env .env   # worktree nasce sem .env (pageerror branco)
 *   VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8091 npx vite --port 5176 --strictPort
 *   PW_BASE_URL=http://localhost:5176 npx playwright test celula-tag-blocked-visual --project=integration
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route } from '@playwright/test';

const DB_URL = process.env.CELULATAG_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5441/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const PASSWORD = 'TestAdmin123!';
const GRUPO_PREFIX = `E2E Celula024 ${RUN_ID}`;

function psql(sql: string): string {
  try {
    return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`DB error: ${e.stderr?.toString() ?? e.message} | sql=${sql}`);
  }
}
const scalar = (sql: string): string => psql(sql).trim().split('\n')[0] ?? '';
function safeSql(sql: string): void {
  try { psql(sql); } catch { /* limpeza best-effort */ }
}

interface MockUser { uid: string; email: string; role: string; country: string }

const tokenFor = (u: MockUser): string =>
  'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');

const fakeIdToken = (u: MockUser): string =>
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(JSON.stringify({
    sub: u.uid, uid: u.uid, email: u.email,
    iss: 'https://securetoken.google.com/enlite-prd', aud: 'enlite-prd',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url') + '.';

async function loginAs(page: Page, u: MockUser): Promise<void> {
  const idToken = fakeIdToken(u);
  const mockToken = tokenFor(u);

  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    const body = url.includes('signInWithPassword') || url.includes('signUp')
      ? { kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.uid, email: u.email, idToken, refreshToken: 'fake-refresh', expiresIn: '3600', registered: true }
      : { users: [{ localId: u.uid, email: u.email, emailVerified: true }] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ access_token: idToken, id_token: idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh' }),
    });
  });
  const swap = async (route: Route): Promise<void> => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${mockToken}` } });
  };
  await page.route('**/api/**', swap);
  await page.route('**/v1/me/authz', swap);

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(u.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

/** Dá as células a um grupo, por chave `recurso:ação`. */
function daCelulas(gid: string, chaves: string[]): void {
  for (const chave of chaves) {
    const [resource, action] = chave.split(':');
    const ok = scalar(`INSERT INTO iam.group_permissions (group_id, permission_id)
        SELECT '${gid}', id FROM iam.permissions WHERE resource='${resource}' AND action='${action}'
        RETURNING permission_id`);
    if (!ok) throw new Error(`célula ${chave} não existe em iam.permissions`);
  }
}

/** Cria staff + grupo com as células dadas, escopado no país AR, e devolve o MockUser. */
function seedStaffComCelulas(nome: string, chaves: string[]): MockUser {
  const uid = `e2e-c024-${nome}-${RUN_ID}`;
  const email = `${uid}@e2e.test`;
  psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
        VALUES ('${uid}', '${email}', 'E2E ${nome}', 'admin', true, 'ACTIVE', '${TENANT}')`);
  const gid = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
        VALUES ('${TENANT}', '${GRUPO_PREFIX} — ${nome}', 'e2e spec 024 — nao mexer manual') RETURNING id`);
  daCelulas(gid, chaves);
  psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
        VALUES ('${gid}', 'AR', 'e2e:local', 'e2e setup')`);
  psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${uid}', '${gid}', '${TENANT}')`);
  return { uid, email, role: 'admin', country: 'AR' };
}

let TAG_LEITORA: MockUser;
let TAG_EDITORA: MockUser;
let TAG_DELETORA: MockUser;
let BLOQ_SEM: MockUser;
let BLOQ_COM: MockUser;
let GESTORA: MockUser;
let grupoParaArvoreId = '';

test.describe('Spec 024 — célula por dado (tag:* / recruitment_blocked:read) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    TAG_LEITORA = seedStaffComCelulas('tag-leitora', ['tag:read']);
    TAG_EDITORA = seedStaffComCelulas('tag-editora', ['tag:read', 'tag:update']);
    TAG_DELETORA = seedStaffComCelulas('tag-deletora', ['tag:read', 'tag:delete']);
    // BLOQ_SEM tem UMA célula qualquer (não `recruitment_blocked:read`) — prova que
    // "ter grupo" não basta, tem que ser A célula certa.
    BLOQ_SEM = seedStaffComCelulas('bloq-sem', ['dedup:read']);
    BLOQ_COM = seedStaffComCelulas('bloq-com', ['recruitment_blocked:read']);
    GESTORA = seedStaffComCelulas('gestora', ['permission_management:read', 'permission_management:write', 'user_management:read']);

    // Grupo à parte só para abrir a árvore de células na tela de Acessos (c) —
    // o conteúdo dele é irrelevante, é só o alvo da navegação de edição.
    grupoParaArvoreId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO_PREFIX} — arvore', 'e2e spec 024 — nao mexer manual') RETURNING id`);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${grupoParaArvoreId}', 'AR', 'e2e:local', 'e2e setup')`);

    // Uma tag real no catálogo — sem ela a lista fica vazia e não há botão
    // nenhum para provar ausência/presença.
    scalar(`INSERT INTO worker_tag_catalog (name, color, description, created_by)
          VALUES ('E2E Etiqueta ${RUN_ID}', '#4F46E5', 'seed spec 024', 'e2e:local') RETURNING id`);
  });

  test.afterAll(() => {
    const uids = [TAG_LEITORA, TAG_EDITORA, TAG_DELETORA, BLOQ_SEM, BLOQ_COM, GESTORA].map((u) => u.uid);
    safeSql(`DELETE FROM worker_tag_catalog WHERE name LIKE 'E2E Etiqueta ${RUN_ID}%'`);
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id IN ('${uids.join("','")}')`);
    safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE '${GRUPO_PREFIX}%')`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE '${GRUPO_PREFIX}%')`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE '${GRUPO_PREFIX}%')`);
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE '${GRUPO_PREFIX}%'`);
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  // ── (a) Tags ────────────────────────────────────────────────────────────────

  test('a1. só tag:read — vê a lista, SEM nenhum botão de ação', async ({ page }) => {
    await loginAs(page, TAG_LEITORA);
    await page.goto('/admin/tags');
    await expect(page).toHaveURL(/\/admin\/tags/, { timeout: 20_000 });

    await expect(page.getByText(`E2E Etiqueta ${RUN_ID}`, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Nueva Etiqueta' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Editar Etiqueta' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Eliminar Etiqueta' })).toHaveCount(0);
  });

  test('a2. tag:read + tag:update — edita (clique + teclado) mas NÃO vê excluir', async ({ page }) => {
    await loginAs(page, TAG_EDITORA);
    await page.goto('/admin/tags');
    await expect(page.getByText(`E2E Etiqueta ${RUN_ID}`, { exact: true })).toBeVisible({ timeout: 20_000 });

    // "Nueva Etiqueta" também depende de `tag:create`, que este grupo NÃO tem.
    await expect(page.getByRole('button', { name: 'Nueva Etiqueta' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Eliminar Etiqueta' })).toHaveCount(0);

    const editBtn = page.getByRole('button', { name: 'Editar Etiqueta' });
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    const nameInput = page.locator('#tag-name');
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    // Humano: clica pra focar, seleciona tudo por TRIPLE-CLICK (o gesto humano padrão
    // num input de linha única) e digita por cima — nunca `.fill()`.
    await nameInput.click({ clickCount: 3 });
    await expect(nameInput).toBeFocused();
    const novoNome = `E2E Etiqueta Editada ${RUN_ID}`;
    await page.keyboard.type(novoNome);
    await expect(nameInput).toHaveValue(novoNome);

    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText(novoNome, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`E2E Etiqueta ${RUN_ID}`, { exact: true })).toHaveCount(0);
  });

  test('a3. tag:read + tag:delete — exclui mas NÃO vê editar', async ({ page }) => {
    await loginAs(page, TAG_DELETORA);
    await page.goto('/admin/tags');
    // O nome mudou no teste a2 (mesma linha do catálogo) — busca pelo texto atual.
    const linhaAtual = page.getByText(new RegExp(`E2E Etiqueta (Editada )?${RUN_ID}`));
    await expect(linhaAtual.first()).toBeVisible({ timeout: 20_000 });

    await expect(page.getByRole('button', { name: 'Editar Etiqueta' })).toHaveCount(0);
    const delBtn = page.getByRole('button', { name: 'Eliminar Etiqueta' });
    await expect(delBtn).toBeVisible();
    await delBtn.click();

    await expect(page.getByText(/eliminar esta etiqueta/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Confirmar' }).click();

    await expect(linhaAtual.first()).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('No hay etiquetas creadas', { exact: false })).toBeVisible({ timeout: 10_000 });
  });

  // ── (b) Postulaciones bloqueadas ───────────────────────────────────────────

  test('b1. sem recruitment_blocked:read — redireciona para /admin', async ({ page }) => {
    await loginAs(page, BLOQ_SEM);
    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page).not.toHaveURL(/blocked-attempts/, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 20_000 });
  });

  test('b2. com recruitment_blocked:read — a tela abre', async ({ page }) => {
    await loginAs(page, BLOQ_COM);
    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page).toHaveURL(/blocked-attempts/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Intentos de postulación bloqueados', level: 1 })).toBeVisible({ timeout: 20_000 });
  });

  // ── (c) Acessos e permissões — Etiquetas em tópico próprio, sem "también en" ─

  test('c1. Etiquetas é tópico próprio com 4 caixas; Postulaciones bloqueadas sem "también en"', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${grupoParaArvoreId}`);
    const secao = page.locator('section[aria-labelledby="sec-cells"]');
    await expect(secao.getByTestId('screen-tree')).toBeVisible({ timeout: 15_000 });

    // "Etiquetas" é o próprio bloco/tela (D1) — não uma linha dentro de Prestadores.
    const etiquetas = secao.getByRole('region', { name: 'Etiquetas' });
    await expect(etiquetas).toBeVisible();
    await expect(etiquetas.getByRole('checkbox', { name: /^tag:read/ })).toHaveCount(1);
    await expect(etiquetas.getByRole('checkbox', { name: /^tag:create/ })).toHaveCount(1);
    await expect(etiquetas.getByRole('checkbox', { name: /^tag:update/ })).toHaveCount(1);
    await expect(etiquetas.getByRole('checkbox', { name: /^tag:delete/ })).toHaveCount(1);
    // Célula não é mais compartilhada com "Prestadores: Detalles" nem "Prestadores: Lista".
    await expect(etiquetas.getByText(/también en/i)).toHaveCount(0);

    // "Postulaciones bloqueadas" é bloco PRÓPRIO, fora de Recrutamento/Pacientes/Vagas/Prestadores.
    //
    // ⚠️ ACHADO (fora do escopo desta spec, NÃO consertado aqui — ver bloco
    // FALHAS/PENDENTE do relatório): o `<section>` deste bloco tem nome
    // acessível "recruitment.blocked" CRU, não "Postulaciones bloqueadas" — o
    // `t('admin.access.screens.recruitment.blocked.label', id)` do i18next
    // desce em `screens.recruitment` (que EXISTE como objeto próprio, da tela
    // `recruitment`) e não acha `.blocked.label` ali, caindo no fallback (o
    // id cru). Mesmo defeito, pré-existente, em `recruitment.health` (a tela
    // de saúde do recrutamento) — não é este corte que o criou, e corrigi-lo
    // exigiria mexer no esquema de chaves i18n de TODAS as telas com id
    // pontuado, fora do escopo aprovado (célula de tag/bloqueadas). Por isso a
    // localização abaixo usa a LINHA (que mostra o rótulo certo, resolvido por
    // outra chave), não a região.
    const linhaBloqueadas = secao.getByRole('row', { name: /^Postulaciones bloqueadas/ });
    await expect(linhaBloqueadas).toBeVisible();
    await expect(linhaBloqueadas.getByRole('checkbox', { name: /^recruitment_blocked:read/ })).toHaveCount(1);
    // A prova exigida pelo contrato: SEM "también en" — a célula não é mais
    // compartilhada com nenhuma outra tela (D2/D401).
    await expect(linhaBloqueadas.getByText(/también en/i)).toHaveCount(0);
  });
});
