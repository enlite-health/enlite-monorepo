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
 * RODADA 2 (gate `revisao-pr`, achado do skill): `grep -n "page.route" e2e/integration/` tem de
 * voltar VAZIO — mock de DADO dentro de e2e bloqueia em qualquer modo. A retomada 1 usava
 * `page.route` pra fabricar o corpo/erro do `POST /sync` e pra atrasar o GET do detalhe. Esta
 * versão substitui os 4 casos por caminho REAL — NENHUMA exceção nomeada foi necessária:
 *
 *   - Requisitos 1+2 (contagem + rótulo): corrida REAL contra o `AnaCareHoursSyncRunner` de
 *     verdade, com o stub local do Ana Care (porta 9913) respondendo `/admin/accounts/` com 4
 *     contas e atrasando cada `/api/shifts/?reservation_id=...` em 12s — o orçamento de 30s da
 *     rodada (`SYNC_ROUND_BUDGET_MS`, `useAnaCareHoursSync.ts`, produção, INTOCADO) corta
 *     sozinho depois da 3ª conta, gerando um `nextCursor` real e uma 2ª rodada real. Nenhum byte
 *     da resposta do `POST /sync` é fabricado — `reservationsTotal`/`reservationsDone` vêm do
 *     runner de verdade.
 *   - Requisito 3b (409 sem vazar id): provoca a colisão REAL
 *     (`AnaCarePatientMonthCollisionError`, `AnaCarePatientMonthRepository.ts:259`) — 2 contas no
 *     diretório do stub cujos turnos apontam para o MESMO `patient.id`; a 2ª reserva processada
 *     na MESMA corrida encontra a linha que a 1ª acabou de gravar (`fetched_at >= runStartedAt`)
 *     e o repositório reCUSA com 409 de verdade (`AnaCareHoursSyncController.ts:206-210`).
 *   - Requisito 4 (spinner do "Actualizar"): o atraso mora DENTRO do stub do Ana Care (porta
 *     9913, `scenario.detailDelayMs`, só a partir da 2ª chamada) — o request do browser é 100%
 *     real (`fetch` de verdade pro backend, que chama o stub de verdade), só a RESPOSTA do stub
 *     demora. Nenhum `page.route` no caminho.
 *   - Requisito 3a (erro de rede): medido nesta sessão que `docker stop enlite-api` derruba a
 *     porta 8080 de verdade em ~0,5s (o `fetch` do browser bate em `ECONNREFUSED` real, produzindo
 *     `TypeError: Failed to fetch` de verdade — não simulado) e `docker start` + poll de `/health`
 *     volta em ~1,5s (migrations idempotentes, boot não repete trabalho) — religado no `finally`
 *     do próprio teste. Nenhuma exceção nomeada precisou ser pedida: o caminho real existia e é
 *     barato.
 *
 * `page.route` continua usado SÓ dentro de `loginAs` (linhas ~279-298) — o MESMO padrão de MOCK
 * DE IDENTIDADE (Firebase/authz) que todo `@integration` spec deste diretório usa, inclusive o
 * molde `anacare-hours-conclusao-de-corrida...ts` (controle: `grep -c "page.route"` nos dois
 * arquivos dá 4 em ambos) — não é mock de DADO da aplicação, é o mecanismo de login humano local.
 *
 * Stack local (mesmo comando desde a retomada 1, projeto `-p anacare-feedback`):
 *   docker compose -p anacare-feedback -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.anacare-hours.yml -f docker-compose.anacare-hours-min-absolute.yml \
 *     -f docker-compose.anacare-hours-real-stub-local.yml up -d --build postgres api
 *   (+ seed de iam.rollout_state.permission_groups_migrated='done' e restart do container `api`)
 *
 *   API      http://localhost:8080  (ANACARE_HOURS_SOURCE=real, ANACARE_BASE_URL → stub :9913)
 *   Postgres postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e
 *   Vite     http://localhost:5173
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

// `AnaCareEnliteDirectory.ACCOUNT_ID_RE` (`/\/accounts\/(\d+)\//g`) só casa DÍGITOS — o `RUN_ID`
// completo (usado no resto do arquivo pra unicidade humana/DB) tem letras (base36), então as
// contas/reservas precisam de uma tag NUMÉRICA própria (medido: com letras, a raspagem lê "zero
// contas" e o backend responde erro em 36ms — a tela ficava presa em "Ronda 0 · 0" porque o teste
// esperava por um estado de progresso que nunca ia existir, não porque o request travou).
const RUN_ID_NUMERIC = String(Date.now()).slice(-7);

// Requisitos 1+2: 4 contas/reservas distintas, cada uma com paciente PRÓPRIO (sem colisão) — o
// orçamento de 30s do hook (produção, intocado) corta depois de ~3 contas com 12s de atraso cada.
const SYNC_RESERVATIONS = ['1', '2', '3', '4'].map((n) => `9${RUN_ID_NUMERIC}${n}`);
const SYNC_RESERVATION_DELAY_MS = 12_000;
function syncPatientFor(reservationId: string): string {
  return `E2E-SYNC-${RUN_ID}-${reservationId}`;
}

// Requisito 3b: 2 contas/reservas DISTINTAS que apontam para o MESMO paciente — a 2ª escrita
// nesta MESMA corrida colide de verdade com a 1ª (`fetched_at >= runStartedAt`).
const COLLISION_RESERVATIONS = ['1', '2'].map((n) => `8${RUN_ID_NUMERIC}${n}`);
const COLLISION_PATIENT_ID = `E2E-COLLISION-${RUN_ID}`;

/**
 * Porta do stub local do Ana Care — MESMA porta que o container `api` desta sessão tem
 * configurada em `ANACARE_BASE_URL` (`docker-compose.anacare-hours-real-stub-local.yml`, fixo em
 * 9913, mesmo precedente de 9911/Periskope e 9912/Axonico).
 */
const ANACARE_STUB_PORT = 9913;

/**
 * Religa a API (`docker start`) e espera `/health` responder OK, com deadline de 30s.
 * Extraída para fora do `try/finally` do teste (era `throw` dentro do `finally` — ESLint
 * `no-unsafe-finally`, essa exceção podia mascarar a que já estava em voo no `try`). Mesma
 * semântica: religa sempre, e falha ruidosa (`throw`) se a API não voltar saudável a tempo.
 */
async function restartApiAndWaitHealthy(): Promise<void> {
  execFileSync('docker', ['start', 'enlite-api']);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch('http://localhost:8080/health');
      if (res.ok) break;
    } catch {
      // ainda subindo — tenta de novo até o deadline.
    }
    if (Date.now() > deadline) throw new Error('API não voltou a /health saudável a tempo depois do docker start');
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Estado mutável do stub — cada teste ajusta ANTES de agir, mesmo precedente de `setDirectoryFailing` no molde `anacare-hours-conclusao-de-corrida`. */
interface StubScenario {
  /** Contas/reservas que `/admin/accounts/` devolve (a raspagem do diretório real do runner). */
  accounts: string[];
  /** Atraso (ms) de CADA resposta a `/api/shifts/?reservation_id=...` — é isto que força o corte de orçamento real (requisito 1+2). */
  reservationDelayMs: number;
  /** `patient.id` que o turno devolve para cada `reservation_id` — 2 reservas podem apontar pro MESMO paciente (requisito 3b, colisão real). */
  patientIdByReservation: Map<string, string>;
  /** Atraso (ms) da 2ª chamada em diante a `/api/shifts/?patient=...` (caminho do DETALHE, requisito 4) — a 1ª carga nunca é atrasada. */
  detailDelayMs: number;
}
const scenario: StubScenario = {
  accounts: [],
  reservationDelayMs: 0,
  patientIdByReservation: new Map(),
  detailDelayMs: 0,
};
let detailCallCount = 0;

interface AnaCareStub {
  server: http.Server;
  requestsLog: string[];
  close: () => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function shiftPayload(shiftId: string, patientId: string): unknown {
  const start = `${MONTH_CURRENT}-01T13:00:00-06:00`;
  const end = `${MONTH_CURRENT}-01T17:00:00-06:00`;
  return {
    id: shiftId,
    start,
    end,
    checkin: start,
    checkout: end,
    checkin_source: 'web_admin',
    checkout_source: 'web_admin',
    checkin_delay: null,
    duration: 4,
    is_finalized: true,
    month: MONTH_CURRENT,
    patient: { id: patientId, agency: 116, identification_type: null, identification_number: null, first_name: 'E2E', last_name: 'Feedback', surname: 'Feedback' },
    nurse: { id: 'E2E-STUB-NURSE-1', agency: 116, first_name: 'Enfermera', last_name: 'Stub', surname: 'Stub' },
  };
}

/**
 * Stub HTTP local do Ana Care (login por cookie Django + `/admin/accounts/` + `/api/shifts/`) —
 * MESMO precedente de `startAnaCareStub` no molde `anacare-hours-conclusao-de-corrida...ts`
 * (login + diretório + turnos), reduzido ao que os 3 casos reais desta spec precisam. Todo
 * conteúdo (contas, atraso, mapeamento paciente) vem de `scenario` — cada teste ajusta ANTES de
 * agir; nada aqui fabrica um número que a TELA lê (os números lidos vêm do runner de verdade,
 * processando o que este stub devolve).
 */
function startAnaCareStub(port: number): Promise<AnaCareStub> {
  const requestsLog: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      requestsLog.push(`${req.method} ${url.pathname}${url.search}`);

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
      if (req.method === 'GET' && url.pathname === '/admin/accounts/') {
        const links = scenario.accounts.map((id) => `<a href="/accounts/${id}/">Cuenta ${id}</a>`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body>${links}</body></html>`);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/admin/accounts/terminated_services') {
        // 404 de propósito — `AnaCareEnliteDirectory.fetch()` trata isso como `partial:true` e
        // segue só com os ATIVOS (mesmo comportamento do molde `conclusao-de-corrida`).
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('stub: terminados nao implementado');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/shifts/') {
        const reservationId = url.searchParams.get('reservation_id');
        const patientParam = url.searchParams.get('patient');

        if (reservationId) {
          const patientId = scenario.patientIdByReservation.get(reservationId) ?? `E2E-PATIENT-${reservationId}`;
          delay(scenario.reservationDelayMs).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ count: 1, next: null, previous: null, results: [shiftPayload(`E2E-STUB-SHIFT-${reservationId}`, patientId)] }));
          });
          return;
        }

        // Caminho do DETALHE (requisito 4) — `patient=<id>`, sem `reservation_id`. Atraso só a
        // partir da 2ª chamada (o refetch do "Actualizar"); a 1ª carga nunca espera.
        detailCallCount += 1;
        const thisDelay = detailCallCount > 1 ? scenario.detailDelayMs : 0;
        const pid = patientParam ?? 'E2E-STUB-SEM-PATIENT-ID';
        delay(thisDelay).then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ count: 1, next: null, previous: null, results: [shiftPayload(`E2E-STUB-SHIFT-${pid}`, pid)] }));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('stub: rota nao implementada');
    });
    server.listen(port, '0.0.0.0', () => resolve({ server, requestsLog, close: () => new Promise<void>((r) => server.close(() => r())) }));
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

    // Reset da linha-base do alarme de queda do diretório (`anacare_directory_snapshot`, migration
    // 439) — esta spec roda VÁRIAS corridas reais com contagens DIFERENTES (4 contas depois 2),
    // e o piso relativo (80% da última contagem conhecida) rejeitaria a 2ª se não resetasse.
    // Container/Postgres desta worktree são ISOLADOS (projeto docker `-p anacare-feedback`) —
    // este DELETE não afeta nenhum outro stack.
    safeSql('DELETE FROM anacare_directory_snapshot');

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
    for (const r of SYNC_RESERVATIONS) safeSql(`DELETE FROM anacare_patient_month WHERE ana_care_patient_id = '${syncPatientFor(r)}'`);
    safeSql(`DELETE FROM anacare_patient_month WHERE ana_care_patient_id = '${COLLISION_PATIENT_ID}'`);
    safeSql(`DELETE FROM anacare_patient_month_provider WHERE ana_care_patient_id IN ('${PATIENT_ID}', '${COLLISION_PATIENT_ID}')`);
    for (const r of SYNC_RESERVATIONS) safeSql(`DELETE FROM anacare_patient_month_provider WHERE ana_care_patient_id = '${syncPatientFor(r)}'`);
    // `anacare_sync_run`/`anacare_directory_snapshot` deixados de propósito (mesmo motivo do
    // molde `conclusao-de-corrida`: são estado de infraestrutura, não dado de teste por RUN_ID).
    if (anaCareStub) {
      console.log(`[anacare-stub] rotas batidas nesta corrida: ${JSON.stringify(anaCareStub.requestsLog)}`);
      await anaCareStub.close();
      anaCareStub = null;
    }
  });

  test('REQUISITOS 1+2 — corrida REAL de várias rodadas: a tela mostra "X de Y reservas" (real) crescente, e o botão nunca vira só "Cargando…"', async ({ page }) => {
    test.setTimeout(120_000);
    scenario.accounts = SYNC_RESERVATIONS;
    scenario.reservationDelayMs = SYNC_RESERVATION_DELAY_MS;
    scenario.patientIdByReservation = new Map(SYNC_RESERVATIONS.map((r) => [r, syncPatientFor(r)]));

    await loginAs(page, USER);
    await abrirPeloMenu(page);

    const botaoSync = page.getByTestId('anacare-hours-sync-button');
    await expect(botaoSync).toBeVisible({ timeout: 15_000 });
    await botaoSync.click();

    // Requisito 2 — enquanto a rodada 1 está em voo (real, ~36s: 3 contas × 12s até o orçamento de
    // 30s cortar), o botão já está desabilitado e o texto renderizado NUNCA é só o genérico de
    // loading (`common.loading` = "Cargando..."). Lido do DOM, não do código.
    await expect(botaoSync).toBeDisabled();
    const textoEmVoo = (await botaoSync.textContent())?.trim() ?? '';
    expect(textoEmVoo).not.toBe('Cargando...');
    expect(textoEmVoo.toLowerCase()).not.toContain('cargando');
    expect(textoEmVoo).toBe('Sincronizando…');

    // Requisito 1 — rodada 1 REAL corta por orçamento de tempo (30s, produção, intocado) depois de
    // processar 3 das 4 contas (12s cada) — `reservationsDone=3`/`reservationsTotal=4` vêm do
    // `AnaCareHoursSyncRunner` de verdade, não fabricados. Timeout generoso (a rodada em si já
    // consome ~36s reais).
    const progresso = page.getByTestId('anacare-hours-sync-progress');
    await expect(progresso).toHaveText(/3 de 4 reservas/, { timeout: 55_000 });

    // Rodada 2 REAL processa a 4ª conta restante (mais ~12s) e termina a corrida.
    await expect(page.getByTestId('anacare-hours-sync-done')).toBeVisible({ timeout: 25_000 });

    // Prova adicional, direto do Postgres (o que o CONTROLLER real gravou, não o que o teste supôs):
    const [status, total, done] = psql(
      `SELECT status || '|' || reservations_total || '|' || reservations_done
         FROM anacare_sync_run WHERE source='anacare' AND period_month='${MONTH_CURRENT}-01'::date`,
    )
      .trim()
      .split('|');
    expect(status).toBe('done');
    expect(total).toBe('4');
    expect(done).toBe('4');
  });

  test('REQUISITO 3b — 409 de colisão REAL (AnaCarePatientMonthCollisionError) não vaza identificador de paciente para a tela', async ({ page }) => {
    // Reset do piso do diretório: a corrida anterior deixou lastKnown=4; esta usa só 2 contas — sem
    // resetar, o piso relativo (80% de 4 = 3) rejeitaria por "queda", mascarando a colisão que
    // queremos provar.
    safeSql('DELETE FROM anacare_directory_snapshot');
    scenario.accounts = COLLISION_RESERVATIONS;
    scenario.reservationDelayMs = 0; // rápido — as 2 reservas cabem na mesma rodada, é isso que faz a colisão acontecer NESTA corrida.
    scenario.patientIdByReservation = new Map(COLLISION_RESERVATIONS.map((r) => [r, COLLISION_PATIENT_ID])); // MESMO paciente nas 2 reservas — a 2ª escrita colide de verdade com a 1ª.

    await loginAs(page, USER);
    await abrirPeloMenu(page);

    const botaoSync = page.getByTestId('anacare-hours-sync-button');
    await expect(botaoSync).toBeVisible({ timeout: 15_000 });
    await botaoSync.click();

    const erro = page.getByTestId('anacare-hours-sync-error');
    await expect(erro).toBeVisible({ timeout: 20_000 });
    const textoErro = (await erro.textContent()) ?? '';
    expect(textoErro).not.toContain(COLLISION_PATIENT_ID);
    expect(textoErro).not.toContain('anaCarePatientIds');
    // Tradução por CÓDIGO (fallback genérico de `DESCONHECIDO`, es.json) — nunca o `error` cru do
    // corpo HTTP (que o backend REAL mandou com o id do paciente embutido — prova abaixo, via DB).
    expect(textoErro).toContain('Ocurrió un error inesperado');

    // Prova de que a colisão foi REAL (não fabricada): `last_error` gravado pelo CONTROLLER real é
    // o código ESTÁVEL da classe do erro (nunca a mensagem, regra dura da migration 457).
    const lastError = psql(
      `SELECT last_error FROM anacare_sync_run WHERE source='anacare' AND period_month='${MONTH_CURRENT}-01'::date`,
    ).trim();
    expect(lastError).toContain('AnaCarePatientMonthCollisionError');
    // E o paciente REALMENTE colidiu (só 1 linha gravada para ele, a da 1ª reserva) — a 2ª nunca
    // sobrescreveu porque a transação deu ROLLBACK antes do INSERT.
    const linhas = psql(`SELECT count(*) FROM anacare_patient_month WHERE ana_care_patient_id = '${COLLISION_PATIENT_ID}'`).trim();
    expect(linhas).toBe('1');
  });

  test('REQUISITO 4 — "Actualizar" do detalhe mostra spinner + fica desabilitado mesmo com snapshot já carregado (atraso REAL no stub, sem page.route), sem regredir a 1ª carga', async ({ page }) => {
    detailCallCount = 0;
    scenario.detailDelayMs = 1_200;

    await loginAs(page, USER);
    await abrirPeloMenu(page);

    const linha = page.getByTestId(`anacare-hours-patient-row-${PATIENT_ID}`);
    await expect(linha).toBeVisible({ timeout: 15_000 });
    await linha.click();
    await expect(page).toHaveURL(new RegExp(`/admin/anacare/horas/${PATIENT_ID}$`));

    // Regressão (task 6.2) — 1ª carga (sem snapshot ainda) continua mostrando a tela de loading de
    // página inteira como antes; ela já se foi por aqui (detailCallCount===1, sem atraso — ver stub).
    await expect(page.getByTestId('anacare-hours-detail-loading')).toHaveCount(0, { timeout: 15_000 });

    const botaoActualizar = page.getByTestId('anacare-hours-refresh');
    await expect(botaoActualizar).toBeVisible({ timeout: 15_000 });
    await expect(botaoActualizar).not.toBeDisabled();

    await botaoActualizar.click();

    // Requisito 4 — EM VOO (atraso REAL de 1.2s dentro do stub — `route.continue()`/`page.route`
    // nenhum: o request sai de verdade, o backend chama de verdade, só a RESPOSTA DO STUB demora):
    // spinner + disabled, com o snapshot ANTERIOR ainda na tela (nunca a tela de loading de página
    // inteira — essa condição continua sendo só `isLoading && !snapshot`, e aqui `snapshot` já existe).
    await expect(botaoActualizar).toBeDisabled();
    const spinner = page.getByTestId('anacare-hours-refresh-spinner');
    await expect(spinner).toHaveAttribute('data-spinning', 'true');
    await expect(page.getByTestId('anacare-hours-detail-loading')).toHaveCount(0);
    // O rótulo "Actualizar" continua visível — nunca virou só "Cargando..." (mesma disciplina do
    // botão de sync, decisão de design #2/#4: `isLoading={false}` no `Button.tsx`).
    await expect(botaoActualizar).toContainText('Actualizar');

    // Depois que a resposta (atrasada, mas real) chega: volta ao normal.
    await expect(botaoActualizar).not.toBeDisabled({ timeout: 5_000 });
    await expect(spinner).toHaveAttribute('data-spinning', 'false');
    expect(detailCallCount).toBeGreaterThanOrEqual(2);
  });

  test('REQUISITO 3a — erro de REDE real (API fora do ar via `docker stop`) mostra mensagem em espanhol legível, NUNCA "Failed to fetch"/stack técnico', async ({ page }) => {
    // SEM page.route — login e navegação com a API de pé (senão nem o login/authz resolveriam).
    await loginAs(page, USER);
    await abrirPeloMenu(page);

    const botaoSync = page.getByTestId('anacare-hours-sync-button');
    await expect(botaoSync).toBeVisible({ timeout: 15_000 });

    // Derruba a API DE VERDADE — o `fetch` do browser para `http://localhost:8080/...` bate em
    // ECONNREFUSED real (medido nesta sessão: `docker stop` leva ~0,5s, e a porta já responde
    // "Connection refused" no `curl` no instante seguinte — sem hang, sem timeout artificial).
    // É o próprio mecanismo do browser que produz `TypeError: Failed to fetch`, não uma simulação.
    execFileSync('docker', ['stop', 'enlite-api']);
    try {
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
    } finally {
      // Religa a API — medido nesta sessão: `docker start` + poll de `/health` fica pronto em
      // ~1,5s (migrations são idempotentes, o boot não repete trabalho). Este é o ÚLTIMO teste do
      // arquivo, mas religar deixa o ambiente limpo para o `afterAll`/uma nova rodada da suíte.
      await restartApiAndWaitHealthy();
    }
  });
});
