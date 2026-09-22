/**
 * anacare-horas-feedback-visual-sync.integration.e2e.ts @integration
 *
 * E2E de TELA (clique + leitura do DOM renderizado, nunca fill()/PUT direto) dos 4 requisitos da
 * change `anacare-horas-feedback-visual-sync` (openspec/changes/anacare-horas-feedback-visual-sync/
 * specs/anacare-hours-sync-feedback-visual/spec.md):
 *
 *   1. contagem "X de Y reservas" durante a corrida (reservationsDone/reservationsTotal)
 *   2. botão "Sincronizar" nunca vira só "Cargando…"
 *   3. erro de rede E 409 de colisão viram mensagem em espanhol por CÓDIGO — nunca texto técnico
 *      cru nem identificador de paciente
 *   4. "Actualizar" do detalhe mostra spinner + disabled mesmo com snapshot já carregado
 *
 * Molde/stack: `anacare-hours-conclusao-de-corrida.integration.e2e.ts` (login humano, helpers de
 * Postgres, stub local do Ana Care). MESMO stack local:
 *
 *   API      http://localhost:8080  (ANACARE_HOURS_SOURCE=real, ANACARE_BASE_URL apontando pro
 *            stub local desta porta — ver `docker-compose.anacare-hours-real-stub-local.yml`)
 *   Postgres postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e
 *   Vite     http://localhost:5173
 *
 * Comando de stack usado nesta sessão (worker-functions/):
 *   docker compose -p anacare-feedback -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.anacare-hours.yml -f docker-compose.anacare-hours-min-absolute.yml \
 *     -f docker-compose.anacare-hours-real-stub-local.yml up -d --build postgres api
 *   (+ seed de iam.rollout_state.permission_groups_migrated='done' e restart do container `api`
 *   — PERMISSION_ENGINE_ENABLED=true exige a migração de dados de grupos marcada.)
 *
 * DIFERENÇA DELIBERADA do molde: os requisitos 1/2/3 não dependem de uma corrida REAL de várias
 * rodadas (o orçamento por rodada do hook é 30s — forçar um corte de orçamento de verdade tornaria
 * o teste lento/frágil). Em vez disso, uso `page.route` para interceptar SÓ o `POST .../sync` e
 * controlar o CONTEÚDO e a LATÊNCIA da resposta — autorizado explicitamente pelo brief da task
 * ("page.route é permitido para simular erro de rede/409 e para atrasar respostas"). O resto do
 * fluxo (app real, Vite real, DOM real, clique real) não é mockado. O requisito 4 usa o backend
 * REAL (sem interceptar o corpo) e só ATRASA a resposta via `route.continue()` depois de um
 * `setTimeout` — a latência é controlada, o dado é real.
 */
import { execFileSync } from 'child_process';
import * as http from 'http';
import { test, expect, type Page, type Route } from '@playwright/test';

const DB_URL = process.env.ANACARE_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const UID = `ach-feedback-e2e-${RUN_ID}`;
const EMAIL = `${UID}@e2e.test`;
const GRUPO = `ACH Feedback Visual E2E ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
/** Mesma régua de `selectors.ts` `currentMonthIso` — fuso LOCAL, nunca `getUTC*`. */
function currentMonthIsoForE2E(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}
const MONTH_CURRENT = currentMonthIsoForE2E();

const PATIENT_ID = `E2E-FEEDBACK-PATIENT-${RUN_ID}`;

/** Porta do stub local do Ana Care — MESMA porta que o container `api` desta sessão tem configurada
 * em `ANACARE_BASE_URL` (`docker-compose.anacare-hours-real-stub-local.yml`, fixo em 9913, mesmo
 * precedente de 9911/Periskope e 9912/Axonico). Só o suficiente para `getPatientMonth` (requisito
 * 4) resolver: login por cookie + `/api/shifts/`. Nenhuma rota de diretório — esta spec nunca
 * clica em "Sincronizar" contra o backend de verdade (requisitos 1/2/3 interceptam o POST /sync
 * via `page.route`, nunca chegam ao runner real).
 */
const ANACARE_STUB_PORT = 9913;

interface AnaCareStub {
  server: http.Server;
  close: () => Promise<void>;
}

function startAnaCareStub(port: number): Promise<AnaCareStub> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      if (req.method === 'GET' && url.pathname === '/users/admin/login/') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'csrftoken=e2e-stub-csrf' });
        res.end('<html></html>');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/users/admin/login/') {
        req.resume();
        req.on('end', () => {
          res.writeHead(302, { 'Set-Cookie': 'sessionid=e2e-stub-session', Location: '/admin/' });
          res.end();
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/shifts/') {
        const patientId = url.searchParams.get('patient') ?? 'E2E-STUB-SEM-PATIENT-ID';
        const minDate = url.searchParams.get('min_date') ?? `${MONTH_CURRENT}-01`;
        const start = `${minDate}T13:00:00-06:00`;
        const end = `${minDate}T17:00:00-06:00`;
        const raw = {
          id: `E2E-STUB-SHIFT-${patientId}`,
          start,
          end,
          checkin: start,
          checkout: end,
          checkin_source: 'web_admin',
          checkout_source: 'web_admin',
          checkin_delay: null,
          duration: 4,
          is_finalized: true,
          month: minDate.slice(0, 7),
          patient: { id: patientId, agency: 116, identification_type: null, identification_number: null, first_name: 'E2E', last_name: 'Feedback', surname: 'Feedback' },
          nurse: { id: 'E2E-STUB-NURSE-1', agency: 116, first_name: 'Enfermera', last_name: 'Stub', surname: 'Stub' },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 1, next: null, previous: null, results: [raw] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('stub: rota nao implementada');
    });
    server.listen(port, '0.0.0.0', () => resolve({ server, close: () => new Promise<void>((r) => server.close(() => r())) }));
  });
}

let anaCareStub: AnaCareStub | null = null;

function psql(sql: string): string {
  try {
    return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`DB error: ${e.stderr?.toString() ?? e.message} | sql=${sql}`);
  }
}
function safeSql(sql: string): void {
  try {
    psql(sql);
  } catch (err) {
    console.error(`[cleanup] falhou (seguindo): ${(err as Error).message}`);
  }
}

/** Garante >=1 linha em `anacare_patient_month` para o mês — senão `naoConstruido` mascara os outros estados/some com a linha do paciente na lista. */
function ensurePatientMonthRow(patientId: string, month: string): void {
  psql(
    `INSERT INTO anacare_patient_month (
       source, ana_care_patient_id, period_month, patient_first_name, patient_last_name,
       providers_count, shifts_count, hours_actual_sum, hours_scheduled_sum_missing_actual,
       origin_sin_checkin, origin_web_admin, origin_app, fetched_at, updated_at
     ) VALUES (
       'anacare', '${patientId}', '${month}-01'::date, 'E2E', 'Feedback',
       1, 1, 4, 0,
       0, 1, 0, NOW(), NOW()
     )
     ON CONFLICT (source, ana_care_patient_id, period_month) DO NOTHING`,
  );
}

interface MockUser {
  uid: string;
  email: string;
  role: string;
  country: string;
}
const USER: MockUser = { uid: UID, email: EMAIL, role: 'admin', country: 'AR' };

const tokenFor = (u: MockUser): string => 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');

function fakeIdToken(u: MockUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: u.uid,
    uid: u.uid,
    email: u.email,
    iss: 'https://securetoken.google.com/enlite-prd',
    aud: 'enlite-prd',
    iat: now,
    exp: now + 3600,
  };
  return 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.';
}

/** Login HUMANO (click + keyboard.type, `e2e-humano-nao-e-fill`) — mesmo padrão do molde. */
async function loginAs(page: Page, u: MockUser): Promise<void> {
  const idToken = fakeIdToken(u);
  const mockToken = tokenFor(u);

  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    const body =
      url.includes('signInWithPassword') || url.includes('signUp')
        ? { kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.uid, email: u.email, idToken, refreshToken: 'fake-refresh', expiresIn: '3600', registered: true }
        : { users: [{ localId: u.uid, email: u.email, emailVerified: true }] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: idToken, id_token: idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh' }),
    });
  });
  const swap = async (route: Route): Promise<void> => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${mockToken}` } });
  };
  await page.route('**/api/**', swap);
  await page.route('**/v1/me/authz', swap);

  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  const email = page.locator('input[type="email"]');
  await email.click();
  await expect(email).toBeFocused();
  await page.keyboard.type(u.email);
  const password = page.locator('input[type="password"]');
  await password.click();
  await expect(password).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
  await page.waitForTimeout(1_200); // 2º redirect da tela de login (mesma pegadinha do molde)
}

async function abrirPeloMenu(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Horas Ana Care' }).click();
  await expect(page).toHaveURL(/\/admin\/anacare\/horas$/);
  await expect(page.getByRole('heading', { name: 'Horas Ana Care' })).toBeVisible({ timeout: 15_000 });
}

function syncResultBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    deduped: false,
    shiftsRead: 0,
    reservationsProcessed: 0,
    shiftsWritten: 0,
    nextCursor: null,
    runStartedAt: new Date().toISOString(),
    reservationsTotal: 0,
    reservationsDone: 0,
    shiftsSkippedNoProvider: 0,
    shiftsSkippedNoPatient: 0,
    ...overrides,
  };
}

test.describe('Feedback visual do sync — Horas Ana Care — E2E real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(async () => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${UID}', '${EMAIL}', 'E2E Feedback AnaCare', 'admin', true, 'ACTIVE', '${TENANT}')`);
    const grupoId = psql(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO}', 'e2e anacare-horas-feedback-visual-sync — nao mexer manual') RETURNING id`)
      .trim()
      .split('\n')[0];
    psql(`INSERT INTO iam.group_permissions (group_id, permission_id)
          SELECT '${grupoId}', id FROM iam.permissions WHERE resource='anacare_hours' AND action IN ('read','validate')`);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${grupoId}', 'AR', '${UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${UID}', '${grupoId}', '${TENANT}')`);

    ensurePatientMonthRow(PATIENT_ID, MONTH_CURRENT);

    anaCareStub = await startAnaCareStub(ANACARE_STUB_PORT);
  });

  test.afterAll(async () => {
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id = '${UID}'`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id = '${UID}'`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = '${GRUPO}')`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = '${GRUPO}')`);
    safeSql(`DELETE FROM iam.permission_groups WHERE name = '${GRUPO}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid = '${UID}'`);
    safeSql(`DELETE FROM anacare_patient_month WHERE ana_care_patient_id = '${PATIENT_ID}'`);
    if (anaCareStub) {
      await anaCareStub.close();
      anaCareStub = null;
    }
  });

  test('REQUISITOS 1+2 — durante a corrida a tela mostra "X de Y reservas" crescente, e o botão nunca vira só "Cargando…"', async ({ page }) => {
    await loginAs(page, USER);

    // Registrado DEPOIS de `loginAs` de propósito: `loginAs` já registra `page.route('**/api/**',
    // swap)`, que faz `route.continue()` (vai DIRETO pra rede, nunca cai num handler registrado
    // ANTES dele — regra do Playwright: quando duas rotas casam a MESMA request, quem foi
    // registrado por ÚLTIMO roda primeiro; `continue()` segue pra rede, só `fallback()` passaria
    // pro handler anterior). Registrar esta rota ESPECÍFICA depois garante que ELA é a que roda
    // primeiro para o POST de sync — medido: sem este reordenamento, o clique batia direto no
    // backend real e o progresso nunca saía de "Ronda 0 · 0 reservas procesadas".
    let syncCall = 0;
    await page.route('**/anacare-hours/sync', async (route) => {
      syncCall += 1;
      const body =
        syncCall === 1
          ? syncResultBody({ reservationsProcessed: 120, nextCursor: 120, reservationsTotal: 285, reservationsDone: 120 })
          : syncResultBody({ reservationsProcessed: 165, nextCursor: null, reservationsTotal: 285, reservationsDone: 285 });
      // Latência CONTROLADA (autorizada pelo brief) — dá tempo de ler o DOM em cada estado
      // intermediário, sem depender de um corte de orçamento real (30s) do runner de verdade.
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await abrirPeloMenu(page);

    const botaoSync = page.getByTestId('anacare-hours-sync-button');
    await expect(botaoSync).toBeVisible({ timeout: 15_000 });
    await botaoSync.click();

    // Requisito 2 — enquanto a rodada 1 está em voo, o botão já está desabilitado e o texto
    // renderizado NUNCA é só o genérico de loading (`common.loading` = "Cargando..."). Lido do DOM,
    // não do código.
    await expect(botaoSync).toBeDisabled();
    const textoEmVoo = (await botaoSync.textContent())?.trim() ?? '';
    expect(textoEmVoo).not.toBe('Cargando...');
    expect(textoEmVoo.toLowerCase()).not.toContain('cargando');
    expect(textoEmVoo).toBe('Sincronizando…');

    // Requisito 1 — rodada 1 resolveu: contagem "120 de 285 reservas" no DOM (não "Ronda N · X
    // reservas procesadas", que é o texto ANTIGO sem o total).
    const progresso = page.getByTestId('anacare-hours-sync-progress');
    await expect(progresso).toHaveText(/120 de 285 reservas/, { timeout: 5_000 });

    // Requisito 1 (cresce, nunca diminui) — rodada 2 resolveu: "285 de 285", depois status done.
    await expect(page.getByTestId('anacare-hours-sync-done')).toBeVisible({ timeout: 5_000 });
    expect(syncCall).toBe(2);
  });

  test('REQUISITO 3a — erro de REDE real (fetch falhando) mostra mensagem em espanhol legível, NUNCA "Failed to fetch"/stack técnico', async ({ page }) => {
    await loginAs(page, USER);

    // Registrado DEPOIS de `loginAs` — mesmo motivo do teste anterior (precedência do Playwright).
    await page.route('**/anacare-hours/sync', async (route) => {
      // `route.abort()` faz o `fetch()` do browser REJEITAR de verdade com
      // `TypeError: Failed to fetch` — não é um mock de resposta, é uma falha de REDE real do
      // ponto de vista do código da aplicação (autorizado pelo brief: "page.route é permitido
      // para simular erro de rede").
      await route.abort('failed');
    });

    await abrirPeloMenu(page);

    const botaoSync = page.getByTestId('anacare-hours-sync-button');
    await expect(botaoSync).toBeVisible({ timeout: 15_000 });
    await botaoSync.click();

    const erro = page.getByTestId('anacare-hours-sync-error');
    await expect(erro).toBeVisible({ timeout: 15_000 });
    const textoErro = (await erro.textContent()) ?? '';
    expect(textoErro).not.toContain('Failed to fetch');
    expect(textoErro).not.toMatch(/^TypeError/);
    expect(textoErro).not.toMatch(/^Error:/);
    // Mensagem REAL do es.json (`admin.anacareHours.error.byCode.NETWORK_ERROR`) — prova que a
    // tela mostra texto compreensível, não só a ausência do texto técnico.
    expect(textoErro).toContain('No se pudo conectar con el servidor');
  });

  test('REQUISITO 3b — 409 de colisão de paciente (AnaCarePatientMonthCollisionError) não vaza identificador de paciente para a tela', async ({ page }) => {
    await loginAs(page, USER);

    const idVazado = 'E2E-LEAK-PATIENT-ID-999';
    // Registrado DEPOIS de `loginAs` — mesmo motivo dos dois testes anteriores.
    await page.route('**/anacare-hours/sync', async (route) => {
      // MESMO formato que `AnaCareHoursSyncController.ts:209` devolve de verdade no 409: `error`
      // carrega a mensagem CRUA de `AnaCarePatientMonthCollisionError` (com `anaCarePatientIds`),
      // `code: 'ANACARE_PATIENT_MONTH_COLLISION'` (fora de `KNOWN_ERROR_CODES`, mapeado para
      // `DESCONHECIDO` pelo `AnaCareHoursHttpService.mapErrorCode`).
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: `No se puede sincronizar: ya existe una escritura en curso para anaCarePatientIds=["${idVazado}"]`,
          code: 'ANACARE_PATIENT_MONTH_COLLISION',
        }),
      });
    });

    await abrirPeloMenu(page);

    const botaoSync = page.getByTestId('anacare-hours-sync-button');
    await expect(botaoSync).toBeVisible({ timeout: 15_000 });
    await botaoSync.click();

    const erro = page.getByTestId('anacare-hours-sync-error');
    await expect(erro).toBeVisible({ timeout: 15_000 });
    const textoErro = (await erro.textContent()) ?? '';
    expect(textoErro).not.toContain(idVazado);
    expect(textoErro).not.toContain('anaCarePatientIds');
    // Tradução por CÓDIGO (fallback genérico de `DESCONHECIDO`, es.json) — nunca o `error` cru do
    // corpo HTTP.
    expect(textoErro).toContain('Ocurrió un error inesperado');
  });

  test('REQUISITO 4 — "Actualizar" do detalhe mostra spinner + fica desabilitado mesmo com snapshot já carregado, sem regredir a 1ª carga', async ({ page }) => {
    await loginAs(page, USER);

    // Registrado DEPOIS de `loginAs` (mesmo motivo dos testes 1+2/3a/3b: precedência do
    // Playwright vai pro handler registrado por ÚLTIMO) — MAS como esta rota TAMBÉM `continue()`
    // (não fulfill), ela precisa REFAZER o mesmo swap de header que o `swap` de `loginAs` faria
    // (`authorization: Bearer <mock token>`) — senão o request segue com o token REAL do Firebase
    // (que `USE_MOCK_AUTH` no backend rejeita como "Invalid credentials"), porque esta rota
    // (registrada por último) intercepta ANTES do `swap` conseguir rodar.
    const mockToken = tokenFor(USER);
    let patientCalls = 0;
    await page.route('**/anacare-hours/months/*/patients/*', async (route) => {
      patientCalls += 1;
      if (patientCalls > 1) {
        // Latência CONTROLADA só na 2ª chamada em diante (o refetch do "Actualizar") — a 1ª carga
        // (que já tem seu PRÓPRIO teste de regressão abaixo) não é afetada. O request segue REAL
        // (`route.continue()`), só atrasado — dado real do backend/stub, timing controlado.
        await new Promise((r) => setTimeout(r, 1_200));
      }
      await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${mockToken}` } });
    });

    await abrirPeloMenu(page);

    const linha = page.getByTestId(`anacare-hours-patient-row-${PATIENT_ID}`);
    await expect(linha).toBeVisible({ timeout: 15_000 });
    await linha.click();
    await expect(page).toHaveURL(new RegExp(`/admin/anacare/horas/${PATIENT_ID}$`));

    // Regressão (task 6.2) — 1ª carga (sem snapshot ainda) continua mostrando a tela de loading de
    // página inteira como antes; ela já se foi por aqui (patientCalls===1, sem delay).
    await expect(page.getByTestId('anacare-hours-detail-loading')).toHaveCount(0, { timeout: 15_000 });

    const botaoActualizar = page.getByTestId('anacare-hours-refresh');
    await expect(botaoActualizar).toBeVisible({ timeout: 15_000 });
    await expect(botaoActualizar).not.toBeDisabled();

    await botaoActualizar.click();

    // Requisito 4 — EM VOO (delay de 1.2s): spinner + disabled, com o snapshot ANTERIOR ainda na
    // tela (nunca a tela de loading de página inteira — essa condição continua sendo só
    // `isLoading && !snapshot`, e aqui `snapshot` já existe).
    await expect(botaoActualizar).toBeDisabled();
    const spinner = page.getByTestId('anacare-hours-refresh-spinner');
    await expect(spinner).toHaveAttribute('data-spinning', 'true');
    await expect(page.getByTestId('anacare-hours-detail-loading')).toHaveCount(0);
    // O rótulo "Actualizar" continua visível — nunca virou só "Cargando..." (mesma disciplina do
    // botão de sync, decisão de design #2/#4: `isLoading={false}` no `Button.tsx`).
    await expect(botaoActualizar).toContainText('Actualizar');

    // Depois que a resposta (atrasada) chega: volta ao normal.
    await expect(botaoActualizar).not.toBeDisabled({ timeout: 5_000 });
    await expect(spinner).toHaveAttribute('data-spinning', 'false');
    expect(patientCalls).toBeGreaterThanOrEqual(2);
  });
});
