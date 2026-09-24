/**
 * group-simulation.integration.e2e.ts @integration
 *
 * Simulação de grupo de acesso (spec 026, F3/T3.6) — Playwright SEM MOCK contra
 * o backend e o Postgres REAIS. Molde: `admin-access-v3.integration.e2e.ts`
 * (login por JWT fake + troca por `mock_*`) — mas reaproveitado via
 * `../helpers/abac-stack-helper` (`psql`/`scalar`/`safeSql`/`grantCell`/
 * `loginAs`/`meAuthz`/`pollAuthz`/`tokenFor`), que já existia para os specs
 * `admin-access-*`/`admin-menu-por-celula`. `installAuthInterceptors`/`loginAs`
 * ganharam `**\/v1/me/simulation**` no swap de token (ajuste B do Gabriel,
 * 23/09) — sem isso a API rejeitaria a chamada por falta de Authorization.
 *
 * Fixture de grupo/célula/Master: `worker-functions/tests/e2e/me-simulation-
 * route.e2e.test.ts` (T2.6) — `MASTER_ID` fixo
 * `a0000000-0000-0000-0000-000000000001`; virar Master é
 * `INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES (uid,
 * MASTER_ID, tenant)`; POST `/v1/me/simulation` `{groupId}` → 201
 * `{id,groupId,groupName,startedAt,expiresAt}`; DELETE → 204 sempre; 403
 * `{code:'not_master_member'}`; 422 `{code:'group_not_simulable'}`.
 *
 * COMO SUBIR O STACK (já em pé para esta rodada — documentado para a próxima):
 *   cd worker-functions
 *   docker compose -p wf026 -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.group-simulation.yml up -d postgres api
 *   # engine ligado nas 12 famílias (ver docker-compose.group-simulation.yml),
 *   # API em :8080, Postgres em :5433 (NÃO 8089/5439 — esses são do stack
 *   # `abac` compartilhado de outra rodada; aqui é projeto docker próprio).
 *   psql postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e -c \
 *     "INSERT INTO iam.rollout_state (key,value,note) VALUES
 *      ('permission_groups_migrated','done','wf026') ON CONFLICT (key) DO UPDATE SET value='done'"
 *
 * Dev server IGUAL ao CI, sem `.env` na worktree:
 *   env -u VITE_FIREBASE_AUTH_EMULATOR VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8080 \
 *     VITE_FIREBASE_API_KEY=fake-api-key-for-e2e VITE_FIREBASE_AUTH_DOMAIN=demo-e2e.firebaseapp.com \
 *     VITE_FIREBASE_PROJECT_ID=demo-e2e VITE_FIREBASE_STORAGE_BUCKET=demo-e2e.appspot.com \
 *     VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000 \
 *     VITE_FIREBASE_APP_ID=1:000000000000:web:0000000000000000000000 \
 *     pnpm exec vite --port 5173 --strictPort
 *
 * Rodar: ABAC_API_URL=http://localhost:8080 ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e \
 *   PW_BASE_URL=http://localhost:5173 pnpm exec playwright test --project=integration \
 *   e2e/integration/group-simulation.integration.e2e.ts
 * (as mesmas duas env vars valem para este arquivo — `BACKEND_URL`/`DB_URL`
 * abaixo leem `ABAC_API_URL`/`ABAC_TEST_DB_URL`, os MESMOS nomes que
 * `abac-stack-helper.ts` já usa internamente para `loginAs`/`meAuthz` — dois
 * nomes de env diferentes para o mesmo backend seria um jeito fácil de rodar
 * a metade do teste contra um stack e a outra metade contra outro sem
 * perceber.)
 *
 * ⚠️ ACHADO (medido 23/09, evidência colada no relatório da rodada, não aqui
 * para não inflar o arquivo): `shouldShowWelcomeNoGroup` (Authz.ts) só olha
 * `groups.length === 0`. Simular um grupo VIVO com ZERO células ainda põe
 * ESSE grupo em `groups` (a função `iam.acting_groups`/o JOIN em
 * `PgEffectiveAuthzRepository` não filtram por ter permissão) — `groups`
 * fica com 1 item, não 0. Ou seja: **"simular grupo com zero células" NUNCA
 * mostra `WelcomeNoGroupPage`** — mostra o painel normal com o menu vazio.
 * O teste 4 abaixo prova o que REALMENTE acontece (isso é o real e2e SEM
 * MOCK fazendo o trabalho — pegou uma premissa do spec.md que não bate com o
 * código construído) e documenta a lacuna: a pessoa não fica presa (o
 * `GroupSimulationSelect` mora no rodapé de QUALQUER `AdminLayout`, inclusive
 * um com menu vazio), mas a TELA que o spec.md/plan.md previa
 * (`WelcomeNoGroupPage`) não é a que aparece.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import {
  ABAC_TENANT,
  psql,
  scalar,
  safeSql,
  grantCell,
  loginAs,
  meAuthz,
  pollAuthz,
  tokenFor,
  type MockUser,
} from '../helpers/abac-stack-helper';

const BACKEND_URL = process.env.ABAC_API_URL ?? process.env.BACKEND_URL ?? 'http://localhost:8080';
const DB_URL =
  process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';
const MASTER_ID = 'a0000000-0000-0000-0000-000000000001';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const MASTER: MockUser = { uid: `e2e-simmaster-${RUN_ID}`, email: `e2e-simmaster-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };
const REAL_MEMBER: MockUser = { uid: `e2e-simreal-${RUN_ID}`, email: `e2e-simreal-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };

const GROUP_LIMITADO_NAME = `QA Sim Group Limitado ${RUN_ID}`;
const GROUP_REDACAO_NAME = `QA Sim Group Redaccion ${RUN_ID}`;
const GROUP_CERO_NAME = `QA Sim Group Cero ${RUN_ID}`;
// Sem RUN_ID — só o teste 5 (screenshot) usa; nome fixo para a baseline não mudar a cada corrida.
const GROUP_SCREENSHOT_NAME = 'QA Screenshot Grupo Simulacion';

let groupLimitadoId = '';
let groupRedacaoId = '';
let groupCeroId = '';
let groupScreenshotId = '';
let workerId = '';

const uids = [MASTER.uid, REAL_MEMBER.uid];

function createStaff(u: MockUser): void {
  psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
        VALUES ('${u.uid}', '${u.email}', 'E2E ${u.uid}', 'recruiter', true, 'ACTIVE', '${ABAC_TENANT}')`);
}
function createGroup(name: string, country = 'AR'): string {
  const groupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
        VALUES ('${ABAC_TENANT}', '${name}', 'e2e 026 T3.6 — nao mexer manual') RETURNING id`);
  psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
        VALUES ('${groupId}', '${country}', '${MASTER.uid}', 'e2e T3.6 setup')`);
  return groupId;
}
function joinGroup(uid: string, groupId: string): void {
  psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${uid}', '${groupId}', '${ABAC_TENANT}')`);
}
/** KMSEncryptionService em test mode só decodifica base64 (mesmo padrão de admin-access-buttons-workers). */
function enc(v: string): string {
  return `'${Buffer.from(v, 'utf8').toString('base64')}'`;
}

async function apiSimulation(
  request: APIRequestContext,
  method: 'POST' | 'DELETE' | 'GET',
  path: string,
  u: MockUser,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await request.fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokenFor(u)}`, 'Content-Type': 'application/json' },
    data: data ? JSON.stringify(data) : undefined,
    failOnStatusCode: false,
  });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

/** Escolhe a opção no `<select>` nativo pelo TECLADO (click + digitar o começo do nome + Enter);
 *  se o valor não mudar (Chromium headless às vezes não aplica type-ahead), cai para `selectOption`
 *  e devolve qual caminho funcionou — vira parte da evidência, não fica escondido. */
async function escolherGrupoPorTeclado(
  page: Page,
  groupName: string,
  groupId: string,
): Promise<'teclado' | 'selectOption'> {
  const select = page.getByRole('combobox', { name: /Ver como grupo|Simular como grupo|access\.simulation\.select/i });
  await select.click();
  await page.keyboard.type(groupName.slice(0, 18), { delay: 30 });
  await page.keyboard.press('Enter');
  const valorPosTeclado = await select.inputValue();
  if (valorPosTeclado === groupId) return 'teclado';
  await select.selectOption(groupId);
  return 'selectOption';
}

test.describe('Simulação de grupo de acesso (spec 026, F3/T3.6) — integração real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeAll(() => {
    createStaff(MASTER);
    joinGroup(MASTER.uid, MASTER_ID);
    createStaff(REAL_MEMBER);

    groupLimitadoId = createGroup(GROUP_LIMITADO_NAME);
    grantCell(groupLimitadoId, 'patient', 'read');

    groupRedacaoId = createGroup(GROUP_REDACAO_NAME);
    grantCell(groupRedacaoId, 'worker', 'read');
    // Deliberadamente SEM worker_contact:read — é o container que o teste 3 prova redigido.
    joinGroup(REAL_MEMBER.uid, groupRedacaoId);

    groupCeroId = createGroup(GROUP_CERO_NAME);
    // zero células de propósito — teste 4.

    // Prestador mínimo (sem dado clínico — workers não têm campo clínico) para abrir a ficha.
    const authUid = `e2e-simworker-${RUN_ID}`;
    const email = `e2e.simworker.${RUN_ID}@test.local`;
    workerId = scalar(`INSERT INTO workers (
        auth_uid, email, phone, status, country, occupation,
        first_name_encrypted, last_name_encrypted, created_at, updated_at
      ) VALUES (
        '${authUid}', '${email}', '+5491100000000', 'REGISTERED', 'AR', 'AT',
        ${enc('QA')}, ${enc(`Sim Worker ${RUN_ID}`)}, NOW(), NOW()
      ) RETURNING id`);
    if (!workerId) throw new Error('prestador e2e não foi inserido');
  });

  test.afterAll(async () => {
    // Encerra qualquer simulação ainda aberta do Master (ex.: um teste falhou antes do seu
    // próprio DELETE) — senão a FK de permission_audit_log.simulation_id trava a limpeza abaixo.
    safeSql(
      `UPDATE iam.group_simulations SET ended_at = now(), ended_reason = 'USER' WHERE user_id = '${MASTER.uid}' AND ended_at IS NULL`,
    );
    // ORDEM da FK: audit_log (referencia group_simulations) ANTES de group_simulations.
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY(ARRAY['${uids.join("','")}'])`);
    safeSql(`DELETE FROM iam.group_simulations WHERE user_id = ANY(ARRAY['${uids.join("','")}'])`);
    safeSql(`DELETE FROM workers WHERE id = '${workerId}'`);
    for (const gid of [groupLimitadoId, groupRedacaoId, groupCeroId]) {
      if (!gid) continue;
      safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id = '${gid}'`);
      safeSql(`DELETE FROM iam.user_groups WHERE group_id = '${gid}'`);
      safeSql(`DELETE FROM iam.group_permissions WHERE group_id = '${gid}'`);
      safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id = '${gid}'`);
      safeSql(`DELETE FROM iam.permission_groups WHERE id = '${gid}'`);
    }
    // A filiação do Master ao PRÓPRIO Master é a última a sair — `trg_users_guard_last_manager`
    // (mig 410) recusa `DELETE FROM users` se isso deixasse ZERO gestores com
    // `permission_management:write` neste banco de e2e isolado (achado: MASTER é o único aqui).
    safeSql(`DELETE FROM iam.user_groups WHERE user_id = '${MASTER.uid}' AND group_id = '${MASTER_ID}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid = ANY(ARRAY['${uids.join("','")}'])`);
    if (groupScreenshotId) {
      safeSql(`DELETE FROM iam.group_simulations WHERE group_id = '${groupScreenshotId}'`);
      safeSql(`DELETE FROM iam.group_permissions WHERE group_id = '${groupScreenshotId}'`);
      safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id = '${groupScreenshotId}'`);
      safeSql(`DELETE FROM iam.permission_groups WHERE id = '${groupScreenshotId}'`);
    }
  });

  test('0. pré-condição: contrato real diz enforcement=on, canSimulate=true, simulation=null', async ({ request }) => {
    const { status, body } = await meAuthz(request, MASTER);
    expect(status).toBe(200);
    expect(body.enforcement).toBe('on');
    expect(body.canSimulate).toBe(true);
    expect(body.simulation).toBeNull();
  });

  test('1. FELIZ — Master escolhe o Select no rodapé; o menu perde item, o banner mostra o grupo', async ({ page }) => {
    await loginAs(page, MASTER);
    // Antes de simular: Master enxerga tudo — "Vacantes" está lá.
    const nav = page.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Vacantes' })).toBeVisible({ timeout: 15_000 });

    const via = await escolherGrupoPorTeclado(page, GROUP_LIMITADO_NAME, groupLimitadoId);

    console.log(`[prova] escolha do Select via: ${via}`);

    // O front chama startSimulation → refetch de /v1/me/authz (cache ~30s no backend: já é
    // resposta síncrona do POST, mas o `useEffect` do banner só re-renderiza depois do fetch).
    await expect(page.getByTestId('group-simulation-banner')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('group-simulation-banner')).toContainText(GROUP_LIMITADO_NAME);

    // Depois de simular: perdeu "Vacantes" (patient:read não abre isso), ganhou "Pacientes".
    await expect(nav.getByRole('link', { name: 'Vacantes' }), '"Vacantes" deveria sumir sob a simulação').toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Pacientes' })).toBeVisible();
  });

  test('2. 403 — em simulação, rota que o grupo não cobre nega, com status capturado', async ({ page }) => {
    await loginAs(page, MASTER);
    await escolherGrupoPorTeclado(page, GROUP_LIMITADO_NAME, groupLimitadoId);
    await expect(page.getByTestId('group-simulation-banner')).toBeVisible({ timeout: 20_000 });

    const respostaPromise = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/admin/workers' && r.request().method() === 'GET',
    );
    await page.goto('/admin/workers');
    const resposta = await respostaPromise;
    expect(resposta.status()).toBe(403);

    // A tela mostra negativa visível: heading "Error al cargar prestadores" + "Access denied"
    // (medido nesta mesma corrida — error-context.md do 1º run; texto real da tela, não suposto).
    await expect(page.getByRole('heading', { name: /Error al cargar/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Access denied/i)).toBeVisible();

    // encerra para não vazar simulação aberta para o próximo teste `serial`.
    await apiSimulation(page.request, 'DELETE', '/v1/me/simulation', MASTER);
  });

  test('3. REDAÇÃO — container sem célula fica ausente sob simulação, e o texto visível bate com quem é membro real', async ({ page, browser }) => {
    await loginAs(page, MASTER);
    await escolherGrupoPorTeclado(page, GROUP_REDACAO_NAME, groupRedacaoId);
    await expect(page.getByTestId('group-simulation-banner')).toBeVisible({ timeout: 20_000 });

    const respostaSimulado = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/admin/workers/${workerId}` && r.request().method() === 'GET',
    );
    await page.goto(`/admin/workers/${workerId}`);
    expect((await respostaSimulado).status()).toBe(200);
    // Página carregou (landmark independente da célula em falta: o card de
    // "Información personal" nunca é gated — só o contato é).
    await expect(page.getByRole('heading', { name: 'Información personal:' })).toBeVisible({ timeout: 15_000 });
    // worker_contact:read AUSENTE no grupo → a resposta da API já vem PROJETADA
    // (D286: "o dado nem viajou") — o header vira o placeholder de contato
    // restrito em vez do nome real (medido nesta corrida, error-context.md).
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /restrit/i })).toBeVisible();
    await expect(page.getByText(`Sim Worker ${RUN_ID}`)).toHaveCount(0);
    const textoSimulado = normalizarTexto(await page.locator('main').first().innerText());

    await apiSimulation(page.request, 'DELETE', '/v1/me/simulation', MASTER);

    // Segundo staff, membro REAL do MESMO grupo — sessão separada (browser novo).
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await loginAs(page2, REAL_MEMBER);
    await page2.goto(`/admin/workers/${workerId}`);
    await expect(page2.getByRole('heading', { name: 'Información personal:' })).toBeVisible({ timeout: 15_000 });
    const textoReal = normalizarTexto(await page2.locator('main').first().innerText());
    await ctx2.close();

    expect(textoSimulado, 'texto visível simulando deveria ser IGUAL ao de um membro real do mesmo grupo').toBe(textoReal);
  });

  test('4. HISTÓRIA 2 — grupo com ZERO células: o "sair" nunca some (achado: NÃO é a WelcomeNoGroupPage — ver cabeçalho)', async ({ page }) => {
    // ⚠️ Este teste NÃO reproduz o "Dado/Quando" literal de spec.md História 2
    // ("a tela de boas-vindas 'sem grupo' renderiza"). Medido (curl direto,
    // sem UI, ver relatório da rodada): simular um grupo VIVO com zero
    // células ainda põe ESSE grupo em `authz.groups` (length 1) — `iam.acting_
    // groups`/o JOIN de `PgEffectiveAuthzRepository` não filtram por ter
    // permissão. `shouldShowWelcomeNoGroup` só olha `groups.length === 0`,
    // então ela nunca dispara aqui. O que este teste prova é a garantia que
    // REALMENTE importa (História 2, "o controle de sair nunca some"): a
    // pessoa não fica presa — vê o painel normal com o menu quase vazio, e o
    // botão de sair segue ali e funciona.
    await loginAs(page, MASTER);
    await escolherGrupoPorTeclado(page, GROUP_CERO_NAME, groupCeroId);
    await expect(page.getByTestId('group-simulation-banner')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('group-simulation-banner')).toContainText(GROUP_CERO_NAME);

    // Navegação de verdade para `/admin` — não a tela ainda-montada de antes de simular (uma
    // pessoa real trocaria de tela ou recarregaria; ficar na tela velha não prova nada sobre
    // o que o grupo simulado DECIDE agora).
    await page.goto('/admin');

    // NÃO é a WelcomeNoGroupPage (o achado — confirmação negativa, não esquecimento):
    await expect(page.getByText(/no tiene un grupo de acceso|não tem um grupo de acesso/i)).toHaveCount(0);
    // É o painel normal, com o menu quase vazio (só o que independe de célula):
    await expect(page.getByRole('navigation').first().getByRole('link', { name: 'API Docs' })).toBeVisible({ timeout: 15_000 });
    for (const nome of ['Pacientes', 'Vacantes', 'Prestadores', 'Usuarios']) {
      await expect(page.getByRole('navigation').first().getByRole('link', { name: nome }), `"${nome}" apareceu sem nenhuma célula`).toHaveCount(0);
    }

    // A propriedade que REALMENTE importa (ninguém fica preso): o botão de sair segue alcançável
    // e funciona, mesmo com o menu vazio.
    const sair = page.getByRole('button', { name: /Salir de la simulación|access\.simulation\.exit/i });
    await expect(sair).toBeVisible({ timeout: 10_000 });
    await sair.click();
    await expect(page.getByTestId('group-simulation-banner')).toHaveCount(0, { timeout: 15_000 });
    // Volta ao painel normal — menu completo do Master de novo (não fica preso no vazio).
    await page.goto('/admin');
    await expect(page.getByRole('navigation').first().getByRole('link', { name: 'Vacantes' })).toBeVisible({ timeout: 15_000 });
  });

  test('5. SCREENSHOT — banner em estado estável', async ({ page }) => {
    groupScreenshotId = scalar(
      `SELECT id FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name = '${GROUP_SCREENSHOT_NAME}'`,
    );
    if (!groupScreenshotId) {
      groupScreenshotId = createGroup(GROUP_SCREENSHOT_NAME);
    }
    await apiSimulation(page.request, 'POST', '/v1/me/simulation', MASTER, { groupId: groupScreenshotId });
    await pollAuthz(page.request, MASTER, (b) => b?.simulation?.groupId === groupScreenshotId);

    await loginAs(page, MASTER);
    const banner = page.getByTestId('group-simulation-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText(GROUP_SCREENSHOT_NAME);

    await expect(banner).toHaveScreenshot('group-simulation-banner.png', { animations: 'disabled', maxDiffPixelRatio: 0.002 });

    await apiSimulation(page.request, 'DELETE', '/v1/me/simulation', MASTER);
  });

  // ── F2 (troca-de-grupo-simulado-com-feedback-e-cache-versionado) ──
  //
  // Dor do Gabriel (24/09): "escolho o grupo no select e demora, não sei se
  // está mudando ou travado". `startSimulation`/`endSimulation` (adminAuthStore)
  // agora CONFIRMAM a troca antes de soltar o overlay (refazem `fetchAuthz()`
  // em loop até o contrato refletir) — os 3 testes abaixo provam isso contra o
  // backend/Postgres reais, sem mock.

  test('6. FEEDBACK — overlay de tela inteira aparece ao escolher o grupo e some antes de 5s', async ({ page }) => {
    await loginAs(page, MASTER);
    const nav = page.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Vacantes' })).toBeVisible({ timeout: 15_000 });

    const overlay = page.getByTestId('group-switch-overlay');
    const inicio = Date.now();
    const via = await escolherGrupoPorTeclado(page, GROUP_LIMITADO_NAME, groupLimitadoId);
    console.log(`[prova] escolha do Select via: ${via}`);

    await expect(overlay).toBeVisible({ timeout: 5_000 });
    await expect(overlay).toContainText(GROUP_LIMITADO_NAME);
    await expect(overlay).toBeHidden({ timeout: 10_000 });
    const decorrido = Date.now() - inicio;
    console.log(`[prova] escolha → overlay some: ${decorrido}ms`);
    expect(decorrido, 'overlay deveria confirmar a troca em menos de 5s').toBeLessThan(5_000);

    // O item que o grupo não tem já sumiu quando o overlay some (mesma asserção do teste 1) —
    // e o banner já reflete o grupo novo, não o estado velho.
    await expect(nav.getByRole('link', { name: 'Vacantes' }), '"Vacantes" deveria sumir sob a simulação').toHaveCount(0);
    await expect(page.getByTestId('group-simulation-banner')).toContainText(GROUP_LIMITADO_NAME);
  });

  test('7. FEEDBACK — sair: overlay "Volviendo…" aparece e some, banner some, sem "expiró" (L37)', async ({ page }) => {
    // Simulação segue ativa do teste 6 (serial, mesmo backend) — página nova + login
    // reflete o estado real, não o componente já montado do teste anterior.
    await loginAs(page, MASTER);
    await expect(page.getByTestId('group-simulation-banner')).toContainText(GROUP_LIMITADO_NAME);

    const overlay = page.getByTestId('group-switch-overlay');
    const sair = page.getByRole('button', { name: /Salir de la simulación|access\.simulation\.exit/i });
    await sair.click();

    await expect(overlay).toBeVisible({ timeout: 5_000 });
    await expect(overlay).toContainText(/Volviendo|access\.simulation\.switchingBack/i);
    await expect(overlay).toBeHidden({ timeout: 10_000 });

    await expect(page.getByTestId('group-simulation-banner')).toHaveCount(0, { timeout: 10_000 });
    // L37 — troca EXPLÍCITA nunca é lida como "expiró" (nem o texto es, nem o pt-BR de fallback).
    await expect(page.getByText(/expiró|expirou/i)).toHaveCount(0);
  });

  test('8. SCREENSHOT — overlay de troca de grupo (visível) e banner pós-troca', async ({ page }) => {
    await loginAs(page, MASTER);
    const overlay = page.getByTestId('group-switch-overlay');
    const banner = page.getByTestId('group-simulation-banner');

    // `page.screenshot()` (não `locator.screenshot()`): o overlay confirma e some em
    // ~1s (medido nos testes 6/7) — `locator.screenshot()` faz scroll-into-view +
    // espera de estabilidade ANTES de capturar, e essa espera sozinha já estourou a
    // janela numa 1ª tentativa (achado: "Element is not attached to the DOM",
    // retry #1/#2). `page.screenshot()` captura o viewport na hora, sem essa dança.
    await escolherGrupoPorTeclado(page, GROUP_REDACAO_NAME, groupRedacaoId);
    await expect(overlay).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: 'evidencias/troca-de-grupo/f2-overlay-cambiando.png' });
    await expect(overlay).toBeHidden({ timeout: 10_000 });

    // Banner: estável (não some sozinho como o overlay) — `locator.screenshot()`
    // aqui é seguro e mais fiel (espera a pintura assentar antes de capturar;
    // achado: `page.screenshot()` bateu ANTES do repaint do banner nesta mesma
    // rodada — texto ausente no PNG apesar do `toContainText` já ter passado).
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(GROUP_REDACAO_NAME);
    await banner.screenshot({ path: 'evidencias/troca-de-grupo/f2-banner-pos-troca.png' });

    await apiSimulation(page.request, 'DELETE', '/v1/me/simulation', MASTER);
  });
});

/** Normaliza espaço em branco pra comparar innerText de duas sessões sem ruído de layout. */
function normalizarTexto(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
