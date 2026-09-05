/**
 * admin-access-cells-visual.integration.e2e.ts @integration
 *
 * Prova VISUAL da seção de células e da seção de membros do grupo, contra o
 * backend e o banco REAIS (mesmo stack de `admin-access-panel`: API 8089,
 * Postgres 5439, engine LIGADO).
 *
 * Por que um arquivo separado: `admin-access-panel` prova o COMPORTAMENTO
 * (salvou? o 403 virou 200?). Este prova o que a pessoa VÊ — que a matriz não
 * é um muro de colunas vazias, que o dossiê mostra a definição, que em `read`
 * não há caixa. Screenshot é o único instrumento que pega regressão de layout;
 * `toBeVisible()` passa numa tela ilegível.
 *
 * COMO SUBIR O STACK (não estava escrito em lugar nenhum — reconstruído em
 * 04/09 e anotado aqui para o próximo):
 *
 *   cd worker-functions
 *   # override com projeto docker PRÓPRIO — o stack de outra worktree usa
 *   # 5432/8080 e o Postgres é compartilhado; subir por cima estraga a
 *   # corrida dela. Portas 8089/5439 NÃO são escolha: os 5 specs de access
 *   # têm BACKEND_URL fixo no arquivo.
 *   cat > /tmp/abac.yml <<'EOF'
 *   services:
 *     postgres: { container_name: abac-postgres, ports: !override ["5439:5432"] }
 *     api:
 *       container_name: abac-api
 *       ports: !override ["8089:8080"]
 *       environment:
 *         # ⚠️ é CORS_ALLOWED_ORIGINS. O `ALLOWED_ORIGIN` do docker-compose.yml
 *         # é config MORTA — ninguém no `src` o lê (grep). A 5173 só funciona
 *         # porque está hardcoded em `corsConfig.ts:defaultAllowedOrigins`.
 *         CORS_ALLOWED_ORIGINS: "http://localhost:5174"
 *         PERMISSION_ENGINE_ENABLED: "true"
 *         PERMISSION_ENFORCED_ROUTES: "<as 12 famílias de permissionFamilies.ts>"
 *         PERMISSION_CATALOG_SYNC_ENABLED: "true"
 *   EOF
 *   docker compose -p abac -f docker-compose.yml -f docker-compose.test.yml \
 *     -f /tmp/abac.yml up -d --build postgres api
 *
 *   # o engine RECUSA subir sem o marcador da migração de grupos (D117,
 *   # fail-closed). Em banco virgem a condição do gate ("zero staff ativo sem
 *   # grupo") vale trivialmente — CONFIRA antes de marcar:
 *   psql ... -c "SELECT count(*) FROM users WHERE status='ACTIVE' AND role IN
 *     ('admin','recruiter','community_manager') AND NOT EXISTS (...)"   -- tem que dar 0
 *   psql ... -c "INSERT INTO iam.rollout_state (key,value,note,updated_by)
 *     VALUES ('permission_groups_migrated','done','stack e2e local','e2e:local')
 *     ON CONFLICT (key) DO UPDATE SET value='done'"
 *
 *   # frontend: precisa de .env com as VITE_FIREBASE_* (sem elas o app monta
 *   # BRANCO e o teste falha em `input[type=email]` — `curl 200` não prova nada)
 *   cd enlite-frontend && npx vite --port 5174 --strictPort
 *   PW_BASE_URL=http://localhost:5174 npx playwright test <spec> --project=integration
 *
 * Padrão de auth: idêntico a `admin-access-panel` — Identity Toolkit
 * interceptado, `/api/**` e `/v1/me/authz` com Authorization trocado por
 * `mock_*`. `/api/admin/auth/profile` e `/v1/me/authz` NÃO são mockados: são
 * contrato real.
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route } from '@playwright/test';

const DB_URL = process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const GESTORA_UID = `e2e-vis-gestora-${RUN_ID}`;
const GESTORA_EMAIL = `${GESTORA_UID}@e2e.test`;
const LEITORA_UID = `e2e-vis-leitora-${RUN_ID}`;
const LEITORA_EMAIL = `${LEITORA_UID}@e2e.test`;
const COLEGA_UID = `e2e-vis-colega-${RUN_ID}`;
const COLEGA_EMAIL = `${COLEGA_UID}@e2e.test`;

const GRUPO = `E2E Visual Celulas ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

let grupoId = '';

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
  // `/v1/me/authz` não cai sob `/api/**` — contrato versionado à parte (D115 §7).
  await page.route('**/api/**', swap);
  await page.route('**/v1/me/authz', swap);

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(u.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

const GESTORA: MockUser = { uid: GESTORA_UID, email: GESTORA_EMAIL, role: 'admin', country: 'AR' };
const LEITORA: MockUser = { uid: LEITORA_UID, email: LEITORA_EMAIL, role: 'admin', country: 'AR' };

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

/**
 * Captura a seção INTEIRA — e é aqui que morava o defeito do portão.
 *
 * O `Desktop Chrome` do Playwright tem viewport 1280x720, e o element
 * screenshot NÃO rola: ele pinta o que cabe e devolve branco no resto. Medido em
 * 05/09: a seção de células tem ~1700px de DOM e a captura pintava 720 —
 * 57,6% de branco puro, com `Trabajadores` e `Vacantes` FORA da foto. Somado ao
 * `maxDiffPixelRatio: 0.02` de antes, uma seção inteira mudou de posição e o
 * teste passou verde (13.045px, ratio 0,00574).
 *
 * O conserto é a altura do viewport, não o teto: com a seção inteira na foto o
 * teto pode ser apertado para 0,002, que é ruído de antialias e não mudança.
 *
 * A máscara é o que torna isso possível: o `RUN_ID` entra no nome do grupo e nos
 * e-mails, então esse texto MUDA a cada corrida. Sem mascarar, o baseline nunca
 * seria determinístico e o teto teria de ficar frouxo de novo — que é como o
 * portão ficou cego na primeira vez.
 */
async function capturaSecao(
  page: Page,
  alvo: ReturnType<Page['locator']>,
  nome: string,
  mascaras: ReturnType<Page['locator']>[] = [],
): Promise<void> {
  const antes = page.viewportSize() ?? { width: 1280, height: 720 };
  const caixa = await alvo.boundingBox();
  if (!caixa) throw new Error(`sem boundingBox para ${nome}`);
  await page.setViewportSize({ width: antes.width, height: Math.ceil(caixa.height) + 120 });
  await page.waitForTimeout(200); // o layout reflui depois do resize
  await expect(alvo).toHaveScreenshot(nome, { maxDiffPixelRatio: 0.002, mask: mascaras });
  await page.setViewportSize(antes);
}

test.describe('Células e membros — prova VISUAL @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    for (const [uid, email, nome, papel] of [
      [GESTORA_UID, GESTORA_EMAIL, 'E2E Vis Gestora', 'admin'],
      [LEITORA_UID, LEITORA_EMAIL, 'E2E Vis Leitora', 'admin'],
      [COLEGA_UID, COLEGA_EMAIL, 'E2E Vis Colega', 'recruiter'],
    ]) {
      psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
            VALUES ('${uid}', '${email}', '${nome}', '${papel}', true, 'ACTIVE', '${TENANT}')`);
    }

    grupoId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO}', 'e2e visual — nao mexer manual') RETURNING id`);

    // A gestora precisa de escrita no painel (para ver caixas) e de
    // `user_management:read` (para a coluna "Resto del equipo" ser buscada).
    // As demais são o RECORTE que a tela desenha: uma categoria com grade de
    // verdade (worker, worker_document) e os dois avulsos que motivaram a poda
    // (worker_contact e worker_pii, uma célula cada).
    daCelulas(grupoId, [
      'permission_management:read', 'permission_management:write', 'user_management:read',
      'worker:read', 'worker_contact:read', 'vacancy:read',
    ]);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${grupoId}', 'AR', '${GESTORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${GESTORA_UID}', '${grupoId}', '${TENANT}')`);

    // A leitora entra num grupo SÓ de leitura do painel — é ela quem prova a
    // vista `read` (sem caixa, sem coluna "Resto del equipo").
    const leituraId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO} (solo lectura)', 'e2e visual') RETURNING id`);
    daCelulas(leituraId, ['permission_management:read']);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${leituraId}', 'AR', '${GESTORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${LEITORA_UID}', '${leituraId}', '${TENANT}')`);
  });

  test.afterAll(() => {
    const uids = [GESTORA_UID, LEITORA_UID, COLEGA_UID];
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id IN ('${uids.join("','")}')`);
    safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE '${GRUPO}%')`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE '${GRUPO}%')`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE '${GRUPO}%')`);
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE '${GRUPO}%'`);
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  test('1. a matriz de células, em edição: colunas por categoria, todo recurso é linha', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${grupoId}`);
    await expect(page.getByRole('heading', { name: GRUPO })).toBeVisible({ timeout: 15_000 });

    const secao = page.locator('section[aria-labelledby="sec-cells"]');
    await expect(secao.getByTestId('cell-matrix')).toBeVisible({ timeout: 10_000 });

    // A poda em números, na TELA: Vacantes não herda as colunas de
    // Trabajadores. Se alguém voltar às colunas globais, isto fica vermelho.
    const trabajadores = secao.getByRole('region', { name: 'Trabajadores' });
    const vacantes = secao.getByRole('region', { name: 'Vacantes y embudo' });
    const colunas = async (r: typeof trabajadores): Promise<string[]> =>
      (await r.getByRole('columnheader').allTextContents()).slice(1);
    // As colunas de CADA categoria, medidas no catálogo real deste banco:
    //   Trabalhadores → worker(disable,export,read,write) + worker_document(delete,read,validate,write)
    //   Vagas e Funil → funnel/interview/match/vacancy, com `match:execute`
    // Vacantes NÃO tem Expor./Valid./Dar de baja; Trabajadores NÃO tem Ejecutar.
    // Se alguém voltar às colunas globais, as duas listas viram a mesma e isto
    // fica vermelho.
    expect(await colunas(trabajadores)).toEqual(['Ver', 'Crear y editar', 'Elim.', 'Expor.', 'Valid.', 'Dar de baja']);
    expect(await colunas(vacantes)).toEqual(['Ver', 'Crear y editar', 'Elim.', 'Ejecutar']);

    // O dossiê é LINHA da grade, com a caixa embaixo de um cabeçalho nomeado.
    // Tirá-lo da grade (#296) deixava a caixa solta e sem coluna — "não se sabe
    // o que faz", nas palavras do Gabriel ao abrir a tela. Revertido.
    await expect(trabajadores.getByRole('row', { name: /worker_pii/ })).toHaveCount(1);
    await expect(trabajadores.getByRole('rowheader', { name: /worker_pii/ })).toBeVisible();
    // A definição continua no rótulo acessível da caixa — mas agora vem do
    // texto CURADO em es-AR, não da `description` do catálogo (condição do
    // parecer do `lex`, 05/09: ajuda certa não pode conviver com tooltip errado
    // no mesmo controle). Medido no banco deste stack: a do seed para
    // `worker_pii` é correta PORÉM está em português numa tela em espanhol; a de
    // `worker:export` diz "Exportar listagem" e entrega o dossiê descriptografado.
    await expect(trabajadores.getByRole('checkbox', { name: /^worker_pii:read — Ver el dossier completo.*DNI\/CUIL.*protege de forma especial/ })).toHaveCount(1);
    // e o "?" abre o painel daquela permissão
    await expect(trabajadores.getByRole('button', { name: /Dossier.*Qué hace este permiso/ })).toHaveCount(1);

    // A ORDEM é alfabética pelo RÓTULO visível, não pela chave crua (decisão do
    // Gabriel, 05/09). É por isto que a asserção não pode ser sobre a chave: em
    // Operaciones as chaves já vinham ordenadas (dashboard · dedup ·
    // integration · test_fixtures) e o que a pessoa lia, não.
    // o `th` tem o par [rótulo + "?"] e a chave crua embaixo; o rótulo é o
    // primeiro span DENTRO do primeiro span — pegar o de fora arrasta o "?"
    const rotulos = async (r: typeof trabajadores): Promise<string[]> =>
      r.locator('th[scope="row"] > span:first-child > span:first-child').allTextContents();
    expect(await rotulos(secao.getByRole('region', { name: 'Operaciones' })))
      .toEqual(['Datos de prueba', 'Duplicados', 'Integraciones', 'Tablero']);
    // e em Trabajadores o dossiê sobe para 3º — o custo aceito da mudança
    expect(await rotulos(trabajadores)).toEqual([
      'Contacto: nombre, teléfono', 'Documentos',
      'Dossier: DNI, domicilio, datos sensibles', 'Prestador en operación',
    ]);

    // O contador da linha do título conta as caixas MARCADAS: o grupo tem 6
    // células e todas as 6 existem no catálogo deste banco.
    await expect(secao.getByText(/^Seleccionadas: 6$/)).toBeVisible();

    // A captura VOLTOU a ser portão: `capturaSecao` põe a seção inteira na foto
    // e o teto caiu de 0,02 para 0,002. Antes disto ela era cega — o número e o
    // porquê estão no docblock do helper.
    await capturaSecao(page, secao, 'celulas-edicao.png');
  });

  test('2. marcar uma célula acende o diff e o botão — e o rodapé diz quantas pessoas sente', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${grupoId}`);
    const secao = page.locator('section[aria-labelledby="sec-cells"]');
    await expect(secao.getByTestId('cell-matrix')).toBeVisible({ timeout: 15_000 });

    // sem mudança: "Sin cambios" e o Guardar morto
    await expect(secao.getByText('Sin cambios')).toBeVisible();
    await expect(secao.getByRole('button', { name: 'Guardar células' })).toBeDisabled();

    // O input do atom `Checkbox` é `sr-only` (a caixa visível é um <div>
    // estilizado): `.check()` espera visibilidade e estoura. Quem a pessoa
    // clica é o <label> — e é isso que o teste tem que fazer.
    await secao.locator('label[for="cell-worker:write"]').click();
    await expect(secao.getByText(/\+1 célula\(s\)/)).toBeVisible();
    await expect(secao.getByRole('button', { name: 'Guardar células' })).toBeEnabled();

    await capturaSecao(page, secao, 'celulas-com-diff.png');
  });

  test('3. a seção de membros: duas colunas, seleção acende UMA seta', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${grupoId}`);
    const secao = page.locator('section[aria-labelledby="sec-members"]');
    await expect(secao.getByTestId('member-transfer')).toBeVisible({ timeout: 15_000 });

    // Filtra pelo RUN_ID ANTES de fotografar: "Resto del equipo" é o time
    // INTEIRO, e outros specs @integration semeiam usuários no mesmo Postgres
    // — sem isto a altura da seção muda conforme quem mais rodou (medido: 345px
    // sozinho, 425px junto com `admin-access-panel`).
    await secao.getByLabel('Filtrar el equipo…').fill(RUN_ID);

    const miembros = secao.getByRole('listbox', { name: 'Miembros' });
    const resto = secao.getByRole('listbox', { name: 'Resto del equipo' });
    await expect(miembros.getByRole('option')).toHaveCount(1); // a própria gestora
    await expect(resto.getByRole('option', { name: new RegExp(COLEGA_EMAIL) })).toBeVisible();

    // as duas setas nascem mortas; marcar de um lado acende SÓ uma
    await expect(secao.getByRole('button', { name: 'Agregar a los miembros' })).toBeDisabled();
    await expect(secao.getByRole('button', { name: 'Quitar de los miembros' })).toBeDisabled();
    await resto.getByRole('option', { name: new RegExp(COLEGA_EMAIL) }).click();
    await expect(secao.getByRole('button', { name: 'Agregar a los miembros' })).toBeEnabled();
    await expect(secao.getByRole('button', { name: 'Quitar de los miembros' })).toBeDisabled();

    // os cards trazem nome e e-mail com o RUN_ID — texto novo a cada corrida
    await capturaSecao(page, secao, 'membros-selecionado.png', [secao.getByRole('option')]);
  });

  test('4. read: a matriz vira ✓/· sem uma única caixa, e a coluna "Resto del equipo" não existe', async ({ page }) => {
    await loginAs(page, LEITORA);
    await page.goto(`/admin/access/groups/${grupoId}`);
    await expect(page.getByRole('heading', { name: GRUPO })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('read-only-notice')).toBeVisible();

    // nenhuma caixa na página inteira — a régua do D269 aplicada à matriz
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('listbox', { name: 'Resto del equipo' })).toHaveCount(0);
    await expect(page.getByTestId('members-readonly')).toBeVisible();

    // e o que o grupo DÁ continua legível: ✓ no que tem
    const secao = page.locator('section[aria-labelledby="sec-cells"]');
    await expect(secao.getByLabel(/^worker:read/)).toHaveText('✓');
    await expect(secao.getByLabel(/^worker:write/)).toHaveText('·');

    await capturaSecao(page, page.locator('div.space-y-8'), 'grupo-modo-leitura.png', [
      page.locator('#sec-id'), page.getByTestId('g-name-readonly'),
      page.getByTestId('g-desc-readonly'), page.getByRole('listitem'),
    ]);
  });
});
