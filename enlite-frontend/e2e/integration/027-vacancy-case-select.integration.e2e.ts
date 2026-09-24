/**
 * 027-vacancy-case-select.e2e.ts @integration
 *
 * Rodada de fecho do gate `revisao-pr` (spec 027, item 3.1 — BLOQUEIO por
 * ausência de e2e de TELA). Cobre o seletor de caso do form "Nueva Vacante"
 * (`/admin/vacancies/new`, `VacancyFormLeftColumn.tsx`, `data-testid="case-select"`
 * envolvendo um `SearchableSelect`) — o ponto onde a T061/T062 passou a exibir
 * `EN####` para caso NATIVO (case_number >= 1000) e número cru para caso LEGADO
 * (< 1000).
 *
 * SEM MOCK de rede: frontend real (Vite dev server) + backend real
 * (worker-functions, USE_MOCK_AUTH=true) + Postgres real (própria worktree,
 * container/porta próprios — docker-compose.027fase4-ports.yml). A única coisa
 * substituída é a IDENTIDADE (mock_<base64> — mesmo mecanismo de
 * `e2e/helpers/worker-auth-helper.ts`, adaptado para staff/admin): sem isso
 * seria preciso Firebase real ou o Firebase Emulator (firebase-tools, pesado,
 * rede) só para logar — a sessão em si nunca é o que este teste prova.
 *
 * "Prova que a seleção de fato aconteceu": não basta o rótulo do botão mudar —
 * o teste também confere que os dados do PACIENTE hidratam (endereço real do
 * Postgres aparece e fica clicável, `patientSelected` libera os campos
 * cinza). Interação humana: click no botão do SearchableSelect, digitar no
 * campo de busca (`fill` só no input de busca, nunca no formulário via DOM),
 * click na opção — nunca `selectOption`/`forceFill` num componente que não é
 * um `<select>` nativo.
 *
 * Seed (docker exec 027fase4-postgres, ver comentário de setup): dois
 * pacientes com `case_number` grafados à mão —
 *   - 42007 (>= 1000 → exibição "EN42007", caso NATIVO)
 *   - 88    (< 1000  → exibição "88", caso LEGADO)
 * cada um com 1 endereço ativo — é exatamente o que `getCasesForSelect`
 * (`VacanciesController.ts:324`) exige (status IN ACTIVE/PENDING_ADMISSION/
 * ADMISSION, deleted_at NULL, >=1 patient_addresses.archived_at NULL).
 *
 * Pré-condições (ver "## Não consegui" no relatório se algo faltar):
 *   docker compose -p 027fase4 -f worker-functions/docker-compose.yml \
 *     -f worker-functions/docker-compose.027fase4-ports.yml up -d postgres api
 *   cd enlite-frontend && pnpm dev   (porta 5173, .env local aponta
 *     VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8479, e precisa também
 *     das VITE_FIREBASE_* — sem elas o app monta BRANCO e o teste falha em
 *     `input[type=email]` como timeout opaco, não como o erro de fato)
 * Run:
 *   E2E_PG_CONTAINER=027fase4-postgres PW_BASE_URL=http://localhost:5173 \
 *     pnpm test:e2e:integration --grep "case-select"
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { execSync } from 'child_process';

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  return execSync(`docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -c '${escaped}'`, {
    stdio: 'pipe',
  }).toString();
}

// ── Seed: admin mock user + 2 pacientes (caso nativo / caso legado) ───────────

const ADMIN_UID = 'e2e-admin-027-case-select';
const ADMIN_EMAIL = 'e2e.admin.027.case-select@enlite.health';
const NATIVE_CASE = 420071; // >= 1000 → "EN420071"
const LEGACY_CASE = 887;    // < 1000  → "887"
const NATIVE_TASK = 'E2E-027-CS-NATIVO';
const LEGACY_TASK = 'E2E-027-CS-LEGADO';

function seed(): void {
  runSQL(`
    INSERT INTO users (firebase_uid, email, display_name, role, is_active, account_type, status)
    VALUES ('${ADMIN_UID}', '${ADMIN_EMAIL}', 'E2E Admin CaseSelect', 'admin', true, 'staff', 'ACTIVE')
    ON CONFLICT (firebase_uid) DO NOTHING;
  `);
  runSQL(`
    INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, case_number, created_at, updated_at)
    VALUES ('${NATIVE_TASK}', 'Nativo', 'CaseSelectE2E', 'ACTIVE', 'TEA', 'MODERATE', 'AR', ${NATIVE_CASE}, NOW(), NOW());
  `);
  runSQL(`
    INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, case_number, created_at, updated_at)
    VALUES ('${LEGACY_TASK}', 'Legado', 'CaseSelectE2E', 'ACTIVE', 'Down', 'MILD', 'AR', ${LEGACY_CASE}, NOW(), NOW());
  `);
  runSQL(`
    INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
    SELECT id, 'Av. Nativo ${NATIVE_CASE}, CABA', 'Av. Nativo ${NATIVE_CASE}', -34.6037, -58.3816, 1, 'manual', NOW(), NOW()
    FROM patients WHERE clickup_task_id = '${NATIVE_TASK}';
  `);
  runSQL(`
    INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
    SELECT id, 'Calle Legado ${LEGACY_CASE}, CABA', 'Calle Legado ${LEGACY_CASE}', -34.6, -58.4, 1, 'manual', NOW(), NOW()
    FROM patients WHERE clickup_task_id = '${LEGACY_TASK}';
  `);
}

function cleanup(): void {
  runSQL(`DELETE FROM patient_addresses WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id IN ('${NATIVE_TASK}', '${LEGACY_TASK}'));`);
  runSQL(`DELETE FROM patients WHERE clickup_task_id IN ('${NATIVE_TASK}', '${LEGACY_TASK}');`);
  runSQL(`DELETE FROM users WHERE firebase_uid = '${ADMIN_UID}';`);
}

// ── Admin mock auth — MESMO mecanismo de worker-auth-helper.ts (mock_<base64>,
// injeção em localStorage via addInitScript), adaptado para staff/admin. Não
// depende de Firebase real nem do Firebase Emulator: `req.user` no backend
// (USE_MOCK_AUTH=true) vem direto do token, e `/api/admin/auth/profile`
// resolve contra a linha de `users` semeada acima (sem chamar o Firebase
// Admin SDK — ver GetAdminProfileUseCase.execute, que só entra no
// auto-provisionamento quando NÃO acha a linha por firebase_uid). ─────────────

function buildMockToken(uid: string, email: string, role: string): string {
  return 'mock_' + Buffer.from(JSON.stringify({ uid, email, role }), 'utf-8').toString('base64');
}

function buildFakeIdToken(uid: string, email: string): string {
  return (
    'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
    Buffer.from(
      JSON.stringify({
        sub: uid, uid, email,
        iss: 'https://securetoken.google.com/demo-no-project',
        aud: 'demo-no-project',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url') +
    '.'
  );
}

async function loginAsAdminMock(page: Page, uid: string, email: string): Promise<void> {
  const fakeIdToken = buildFakeIdToken(uid, email);
  const mockToken = buildMockToken(uid, email, 'admin');

  const mockAuthPayload = JSON.stringify({
    uid, email,
    stsTokenManager: { accessToken: fakeIdToken, expirationTime: Date.now() + 3600_000 },
  });
  await page.addInitScript((payload: string) => {
    localStorage.setItem('enlite_e2e_mock_auth', payload);
  }, mockAuthPayload);

  // Firebase Identity Toolkit — nunca sai da máquina; só serve pro submit do
  // form de login não estourar (a sessão real já está no localStorage acima).
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        localId: uid, email, idToken: fakeIdToken,
        refreshToken: 'fake-refresh', expiresIn: '3600', registered: true,
      }),
    });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ id_token: fakeIdToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh' }),
    });
  });

  // TODAS as outras chamadas /api/** E /v1/** (o painel também usa /v1/me/authz
  // — descoberto rodando o teste: sem cobrir /v1/**, a chamada saía com o
  // id_token FALSO do Firebase, MockAuthMiddleware rejeitava com 401
  // "Invalid credentials" porque o token não começa com `mock_`, e o
  // AdminProtectedRoute entrava num loop de re-tentativa) batem no backend
  // REAL (027fase4-api) com o token mock_* — SEM MOCK de payload, a resposta
  // vem do Postgres semeado acima.
  await page.route('**/api/**', async (route: Route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${mockToken}` };
    await route.continue({ headers });
  });
  await page.route('**/v1/**', async (route: Route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${mockToken}` };
    await route.continue({ headers });
  });

  // O mock injeta a sessão via `enlite_e2e_mock_auth` (localStorage) ANTES do
  // primeiro paint (addInitScript) — `/admin/login` já reconheceria a sessão e
  // redirecionaria pra fora do form antes do input existir (medido: timeout
  // esperando `input[type="email"]`, porque a página nunca é a de login).
  // Vai direto pra rota protegida — é exatamente o que `ProtectedRoute` +
  // `FirebaseAuthService.readMockAuth()` existem para permitir.
  await page.goto('/admin/vacancies/new');
  await expect(page).not.toHaveURL(/.*\/(admin\/)?login/, { timeout: 20_000 });
}

// ── SearchableSelect helpers — button + input de busca reais, nunca fill()
//    direto no DOM sem passar pela interação de usuário. ──────────────────────

function caseSelectButton(page: Page) {
  return page.locator('[data-testid="case-select"] button');
}

async function openCaseSelectAndSearch(page: Page, term: string): Promise<void> {
  await caseSelectButton(page).click();
  const searchInput = page.locator('[data-testid="case-select"] input[type="text"]');
  await searchInput.click();
  await searchInput.type(term, { delay: 20 }); // digitar tecla a tecla, não .fill()
}

test.describe('@integration Modal Nueva Vacante — seleção de caso (nativo × legado × inexistente)', () => {
  // fullyParallel do projeto espalharia os 3 testes deste arquivo em workers
  // diferentes, cada um rodando beforeAll()/seed() em paralelo contra a MESMA
  // linha (unique constraint em users.email) — serial força 1 worker, 1 seed.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60_000);

  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(() => {
    cleanup();
  });

  test('feliz — caso NATIVO (EN420071): buscar, selecionar e ver o endereço real do paciente hidratar', async ({ page }) => {
    await loginAsAdminMock(page, ADMIN_UID, ADMIN_EMAIL);
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 15_000 });

    // Antes de selecionar: hint de "selecione um caso primeiro" visível.
    await expect(page.getByText(/seleccion[aá] un caso primero/i)).toBeVisible();

    await openCaseSelectAndSearch(page, String(NATIVE_CASE));
    await expect(page.getByRole('option', { name: new RegExp(`EN${NATIVE_CASE}`) })).toBeVisible({ timeout: 5_000 });
    await page.getByRole('option', { name: new RegExp(`EN${NATIVE_CASE}`) }).click();

    // Prova de seleção #1: o botão passa a exibir o rótulo formatado (EN prefix).
    await expect(caseSelectButton(page)).toContainText(`EN${NATIVE_CASE}`);

    // Prova de seleção #2 (a que importa): dado REAL do Postgres hidratado —
    // o endereço do paciente semeado aparece e é clicável.
    const addressBtn = page.locator(`[data-testid^="address-option-"]`).first();
    await expect(addressBtn).toBeVisible({ timeout: 10_000 });
    await expect(addressBtn).toContainText(`Av. Nativo ${NATIVE_CASE}, CABA`);
    await addressBtn.click();
    await expect(addressBtn).toHaveClass(/border-primary/);

    // Hint "selecione um caso" some — os campos do paciente liberaram.
    await expect(page.getByText(/seleccion[aá] un caso primero/i)).not.toBeVisible();
  });

  test('alt — caso LEGADO (887, sem prefixo EN): seleção também hidrata o paciente certo', async ({ page }) => {
    await loginAsAdminMock(page, ADMIN_UID, ADMIN_EMAIL);
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 15_000 });

    await openCaseSelectAndSearch(page, String(LEGACY_CASE));
    // Rótulo real é "CASO {{caseNumber}}" (es.json caseOptionLabel) — o `\b`
    // ANTES do número (não `^`) garante casar "CASO 887", nunca "CASO EN887"
    // se existisse: a opção do legado aparece SEM "EN" — regex negativo abaixo
    // confirma que não é o prefixo que formatCaseNumber(>=1000) produziria.
    const option = page.getByRole('option', { name: new RegExp(`\\b${LEGACY_CASE}\\b`) });
    await expect(option).toBeVisible({ timeout: 5_000 });
    await expect(option).not.toContainText('EN');
    await option.click();

    await expect(caseSelectButton(page)).toContainText(String(LEGACY_CASE));
    await expect(caseSelectButton(page)).not.toContainText(`EN${LEGACY_CASE}`);

    const addressBtn = page.locator(`[data-testid^="address-option-"]`).first();
    await expect(addressBtn).toBeVisible({ timeout: 10_000 });
    await expect(addressBtn).toContainText(`Calle Legado ${LEGACY_CASE}, CABA`);
  });

  test('alt — busca sem match (caso inexistente): "Sin resultados", nada selecionável, hint permanece', async ({ page }) => {
    await loginAsAdminMock(page, ADMIN_UID, ADMIN_EMAIL);
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 15_000 });

    await openCaseSelectAndSearch(page, '999999999');
    await expect(page.locator('[data-testid="searchable-select-empty"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="case-select"] [role="option"]')).toHaveCount(1); // só a opção "Todos"/placeholder, nenhum caso

    // Nada foi selecionado: sem endereço, hint continua visível, botão continua no placeholder.
    await expect(page.locator('[data-testid^="address-option-"]')).toHaveCount(0);
    await expect(page.getByText(/seleccion[aá] un caso primero/i)).toBeVisible();
  });
});
